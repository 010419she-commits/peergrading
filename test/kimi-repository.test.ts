import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { buildCliArgs, createBackend } from "../agents/backends.ts";
import { prepareKimiLaunch, kimiAgentDefinition, kimiAccountSummary } from "../agents/kimi.ts";
import type { ChatRequest } from "../agents/types.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pg-kimi-test-"));
after(() => fs.rm(tmp, { recursive: true, force: true }));
const request = (access?: ChatRequest["repositoryAccess"]): ChatRequest => ({ system: "Review the provided patch carefully.", turns: [{ role: "user", text: "PRIVATE_TASK\nCheck the actual files." }], lang: "en", cwd: tmp, repositoryAccess: access, signal: new AbortController().signal, onDelta: () => {} });
async function profile(config: string) {
  const home = await fs.mkdtemp(path.join(tmp, "home-"));
  await fs.writeFile(path.join(home, "config.toml"), config);
  return { ...process.env, KIMI_CODE_HOME: home };
}
const apiProfile = `default_model = "test/model"\n[[hooks]]\nevent = "PreToolUse"\nmatcher = "*"\ncommand = "touch /tmp/should-never-run"\n[providers.test]\ntype = "kimi"\nbase_url = "https://api.example.invalid/v1"\napi_key = "TEST-SECRET-DO-NOT-PERSIST"\n[models."test/model"]\nprovider = "test"\nmodel = "test-model"\nmax_context_size = 10000\ncapabilities = ["tool_use"]\n`;

test("Kimi arguments require a restricted profile and never expose task content or broad approval flags", () => {
  const spec = { type: "kimi-code", bin: "kimi" } as const;
  assert.throws(() => buildCliArgs(spec, "", "", "write"), /受限工具配置/);
  const result = buildCliArgs(spec, "private system", "PRIVATE_TASK", "write", { agentFile: "/tmp/private.md", skillsDir: "/tmp/empty", repositoryDir: "/tmp/repo" });
  assert.equal(result.useStdin, false);
  assert.ok(result.args.includes("--agent-file"));
  assert.ok(result.args.includes("stream-json"));
  assert.ok(result.args.includes("--add-dir"));
  assert.ok(!result.args.some((v) => /PRIVATE_TASK|private system|--yolo|--auto|--print/.test(v)));
});

test("Kimi review and discussion expose only read tools; ordinary turns expose no tools", () => {
  assert.match(kimiAgentDefinition(request("write")), /tools: \[Read, Glob, Grep, Edit, Write\]/);
  assert.match(kimiAgentDefinition(request("read-only")), /tools: \[Read, Glob, Grep\]/);
  assert.match(kimiAgentDefinition(request()), /tools: \[\]/);
  for (const access of ["write", "read-only", undefined] as const) {
    const definition = kimiAgentDefinition(request(access));
    assert.match(definition, /subagents: \[\]/);
    assert.doesNotMatch(definition, /\$\{base_prompt\}|\$\{plugin_sections\}/);
  }
});

test("literal template syntax in repository code is passed as data, without expanding Kimi default prompts", () => {
  const req = request("read-only");
  req.turns = [{ role: "user", text: "Review `const value = '${base_prompt}'` and '$HOME'." }];
  const definition = kimiAgentDefinition(req);
  assert.doesNotMatch(definition, /\$\{base_prompt\}/);
  const payload = JSON.parse(definition.slice(definition.indexOf("{\n  \"system\"")));
  assert.equal(payload.messages[0].text, req.turns[0].text);
});

test("Kimi launches outside the repository with isolated configuration and API keys only in child environment", async () => {
  const env = await profile(apiProfile);
  const original = await fs.readFile(path.join(env.KIMI_CODE_HOME, "config.toml"), "utf8");
  const launch = await prepareKimiLaunch(request("write"), env);
  try {
    const text = await fs.readFile(path.join(launch.env.KIMI_CODE_HOME!, "config.toml"), "utf8");
    const config = parse(text);
    assert.deepEqual(config.hooks, []);
    assert.deepEqual(config.tools.enabled, ["Read", "Glob", "Grep", "Edit", "Write"]);
    assert.equal(config.providers.peergrading.api_key_env, "PEERGRADING_KIMI_PROVIDER_API_KEY");
    assert.doesNotMatch(text, /TEST-SECRET|should-never-run/);
    assert.equal(launch.env.PEERGRADING_KIMI_PROVIDER_API_KEY, "TEST-SECRET-DO-NOT-PERSIST");
    assert.equal(launch.env.KIMI_CODE_NO_AUTO_UPDATE, "1");
    assert.equal(launch.env.KIMI_CODE_WATCH, "false");
    assert.equal(launch.repositoryDir, tmp);
    assert.notEqual(launch.cwd, tmp);
    assert.deepEqual(await fs.readdir(launch.cwd), []);
    assert.deepEqual(await fs.readdir(launch.skillsDir), []);
    assert.match(await fs.readFile(launch.agentFile, "utf8"), /PRIVATE_TASK/);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(launch.agentFile)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(launch.agentFile))).mode & 0o777, 0o700);
    }
  } finally { await launch.cleanup(); }
  assert.equal(await fs.stat(launch.agentFile).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(env.KIMI_CODE_HOME, "config.toml"), "utf8"), original);
});

test("OAuth credentials use disposable copies so CLI refreshes cannot change the user's login", async () => {
  const env = await profile(apiProfile.replace('api_key = "TEST-SECRET-DO-NOT-PERSIST"', 'oauth = { storage = "file", key = "oauth/kimi-code" }'));
  const source = path.join(env.KIMI_CODE_HOME, "credentials", "kimi-code.json");
  await fs.mkdir(path.dirname(source));
  await fs.writeFile(source, '{"access_token":"original-test-token"}');
  assert.deepEqual(await kimiAccountSummary(env), { ready: true, model: "test/model" });
  const launch = await prepareKimiLaunch(request("read-only"), env);
  const dest = path.join(launch.env.KIMI_CODE_HOME!, "credentials", "kimi-code.json");
  try {
    assert.equal(await fs.readFile(dest, "utf8"), await fs.readFile(source, "utf8"));
    assert.equal((await fs.lstat(dest)).isSymbolicLink(), false);
    await fs.writeFile(dest, "refreshed-copy-only");
    assert.match(await fs.readFile(source, "utf8"), /original-test-token/);
    const config = parse(await fs.readFile(path.join(launch.env.KIMI_CODE_HOME!, "config.toml"), "utf8"));
    assert.deepEqual(config.tools.enabled, ["Read", "Glob", "Grep"]);
    assert.doesNotMatch(JSON.stringify(config), /original-test-token/);
  } finally { await launch.cleanup(); }
});

test("invalid credential traversal and malformed configuration fail closed without echoing secrets", async () => {
  const env = await profile(apiProfile.replace('api_key = "TEST-SECRET-DO-NOT-PERSIST"', 'oauth = { storage = "file", key = "../outside" }'));
  await assert.rejects(prepareKimiLaunch(request("write"), env), /认证引用无效/);
  await fs.writeFile(path.join(env.KIMI_CODE_HOME, "config.toml"), 'api_key = "DO-NOT-ECHO-SECRET"\n???');
  await assert.rejects(prepareKimiLaunch(request("write"), env), (e: Error) => /检查/.test(e.message) && !e.message.includes("DO-NOT-ECHO-SECRET"));
});

test("Kimi role/content JSONL returns the final assistant reply and disposes runtime files", async () => {
  const env = await profile(apiProfile);
  const script = path.join(tmp, "fake-kimi.mjs");
  const bin = process.platform === "win32" ? path.join(tmp, "fake-kimi.cmd") : script;
  const recorder = path.join(tmp, "runtime-path.txt");
  await fs.writeFile(script, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);\nconst file=args[args.indexOf('--agent-file')+1];\nif(args.join(' ').includes('PRIVATE_TASK')) throw Error('leaked prompt');\nif(!fs.readFileSync(file,'utf8').includes('PRIVATE_TASK')) throw Error('missing task');\nfs.writeFileSync(${JSON.stringify(recorder)},file);\nconsole.log(JSON.stringify({role:'assistant',content:'intermediate',tool_calls:[{id:'t'}]}));\nconsole.log(JSON.stringify({role:'tool',content:'UNTRUSTED_TOOL_TEXT'}));\nprocess.stdout.write(JSON.stringify({role:'assistant',content:'VERDICT: APPROVE'}));\n`, { mode: 0o700 });
  // The Windows launcher resolves this npm-style shim to Node + script without a shell.
  if (process.platform === "win32") await fs.writeFile(bin, '@echo off\r\nnode "%~dp0\\fake-kimi.mjs" %*\r\n');
  const before = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = env.KIMI_CODE_HOME;
  try {
    const backend = createBackend({ type: "kimi-code", bin }, { emit: () => {} });
    const result = await backend.chat(request("read-only"));
    assert.equal(result.text, "VERDICT: APPROVE");
    const runtime = await fs.readFile(recorder, "utf8");
    assert.equal(await fs.stat(runtime).then(() => true, () => false), false);
  } finally {
    if (before === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = before;
  }
});
