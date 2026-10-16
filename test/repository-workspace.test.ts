import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectRepository, prepareRepository, readRepositoryDiff } from "../repository/workspace.ts";
import { runRepositoryProcess } from "../repository/process.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-repositories-"));
after(() => fs.rm(temporary, { recursive: true, force: true }));
function git(cwd: string, args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
async function fixture(name: string) {
  const repo = path.join(temporary, name); await fs.mkdir(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(repo, "hello.txt"), "original\n"); git(repo, ["add", "."]); git(repo, ["commit", "-m", "baseline"]);
  return repo;
}
const signal = () => new AbortController().signal;

test("isolated task worktree has its own codex branch, binary snapshots, and disabled Git hooks", async () => {
  const repo = await fixture("isolation"); const base = git(repo, ["rev-parse", "HEAD"]);
  const marker = path.join(temporary, "hook-ran");
  for (const name of ["post-checkout", "pre-commit"]) await fs.writeFile(path.join(repo, ".git", "hooks", name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const workspace = await prepareRepository({ path: repo, sessionDir: path.join(temporary, "session-one") }, signal());
  assert.match(workspace.manifest.branch, /^codex\/peergrading-/);
  assert.notEqual(workspace.manifest.worktreePath, repo);
  await fs.writeFile(path.join(workspace.manifest.worktreePath, "hello.txt"), "edited\n");
  await fs.writeFile(path.join(workspace.manifest.worktreePath, "binary.dat"), Buffer.from([0, 1, 2, 0, 255]));
  const unicode = "汉字与代码".repeat(10_000);
  await fs.writeFile(path.join(workspace.manifest.worktreePath, "中文.txt"), unicode + "\n");
  const snapshot = await workspace.snapshot(1, "A", "Changed files", [], signal());
  const patch = await fs.readFile(path.join(workspace.artifactDir, snapshot.patchFile), "utf8");
  assert.match(patch, /GIT binary patch/); assert.match(patch, /\+edited/);
  assert.ok(patch.includes("+" + unicode), "UTF-8 file content must survive subprocess chunk boundaries");
  assert.equal(await readRepositoryDiff(workspace.manifest.worktreePath, base), patch);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), base); assert.equal(git(repo, ["branch", "--show-current"]), "main");
  assert.equal(await fs.readFile(path.join(repo, "hello.txt"), "utf8"), "original\n");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
  await workspace.close("approved");
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace.artifactDir, "manifest.json"), "utf8")).status, "approved");
  assert.equal(git(repo, ["rev-parse", workspace.manifest.branch]), snapshot.commit);
  assert.equal(await fs.stat(workspace.manifest.worktreePath).then((s) => s.isDirectory()), true);
  await assert.rejects(prepareRepository({ path: repo, sessionDir: path.join(temporary, "session-one") }, signal()), /避免覆盖现有成果/);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspace.artifactDir, "manifest.json"), "utf8")).status, "approved");
});

test("dirty source changes are rejected without resetting, staging or switching branches", async () => {
  const repo = await fixture("dirty");
  await fs.writeFile(path.join(repo, "hello.txt"), "user work\n"); await fs.writeFile(path.join(repo, "untracked.txt"), "precious");
  const before = git(repo, ["status", "--porcelain"]);
  const inspected = await inspectRepository(repo); assert.equal(inspected.dirty, true);
  await assert.rejects(prepareRepository({ path: repo, sessionDir: path.join(temporary, "dirty-session") }, signal()), /未提交或未跟踪/);
  assert.equal(git(repo, ["status", "--porcelain"]), before);
  assert.equal(await fs.readFile(path.join(repo, "hello.txt"), "utf8"), "user work\n");
  assert.equal(git(repo, ["branch", "--show-current"]), "main");
});

test("one task per common Git directory; closing releases its lock and preserves the worktree", async () => {
  const repo = await fixture("locking");
  const one = await prepareRepository({ path: repo, sessionDir: path.join(temporary, "lock-one") }, signal());
  await assert.rejects(prepareRepository({ path: repo, sessionDir: path.join(temporary, "lock-two") }, signal()), /已有双 Agent 任务/);
  await one.close("cancelled");
  const two = await prepareRepository({ path: repo, sessionDir: path.join(temporary, "lock-two") }, signal());
  await two.close("max_rounds");
  assert.notEqual(one.manifest.branch, two.manifest.branch);
});

test("checks preserve literal argv, report nonzero exit and timeout, and never use a shell", async () => {
  const repo = await fixture("checks");
  const literal = `literal; $(touch NO) & | ' "`;
  const workspace = await prepareRepository({ path: repo, sessionDir: path.join(temporary, "checks-session"), checks: [
    { argv: [process.execPath, "-e", "console.log(process.argv[1]); process.exit(3)", literal] },
    { argv: [process.execPath, "-e", "setInterval(()=>{}, 1000)"], timeoutMs: 100 },
  ] }, signal());
  const results = await workspace.runChecks(1, signal());
  assert.equal(results[0].stdout.trim(), literal); assert.equal(results[0].code, 3); assert.equal(results[0].ok, false);
  assert.equal(results[1].timedOut, true); assert.equal(results[1].ok, false);
  assert.equal(await fs.stat(path.join(repo, "NO")).then(() => true, () => false), false);
  await workspace.close("max_rounds");
});

test("pre-aborted tasks spawn nothing; cancelling a command kills its process group", async () => {
  const repo = await fixture("cancel");
  const pre = new AbortController(); pre.abort();
  await assert.rejects(prepareRepository({ path: repo, sessionDir: path.join(temporary, "never-started") }, pre.signal), /aborted/);
  assert.equal(git(repo, ["branch", "--list", "codex/*"]), "");
  const controller = new AbortController();
  const pidFile = path.join(temporary, "descendant.pid");
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); process.on('SIGTERM',()=>{}); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
  const running = runRepositoryProcess([process.execPath, "-e", script], repo, { signal: controller.signal });
  // Attach the rejection handler before waiting for the subprocess to become ready.
  const stopped = assert.rejects(running, /aborted/);
  let descendant = 0;
  try {
    for (let tries = 0; tries < 200; tries++) {
      descendant = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
      if (descendant) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(descendant > 0, "descendant must start before cancellation");
    controller.abort(); await stopped;
    assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" }, "cancellation must kill tool descendants too");
  } finally { controller.abort(); if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch {} } }
});

test("artifacts cannot be placed inside the original checkout and invalid check arguments fail early", async () => {
  const repo = await fixture("invalid");
  await assert.rejects(prepareRepository({ path: repo, sessionDir: path.join(repo, "sessions") }, signal()), /仓库之外/);
  await assert.rejects(prepareRepository({ path: repo, sessionDir: path.join(temporary, "invalid-session"), checks: [{ argv: ["npm\0test"] }] }, signal()), /argv/);
  await assert.rejects(readRepositoryDiff(repo, "--help"), /无效/);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});
