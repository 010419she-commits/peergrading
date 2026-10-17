import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Every scenario imports the real detector in a fresh process. No host credentials,
// installed CLI, actual model server, .env loader or real user configuration is used.
const childProgram = `
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
childProcess.spawn = childProcess.execFile = childProcess.execFileSync = () => {
  throw new Error("Cache regression tests must never execute an installed program");
};
syncBuiltinESMExports();
const { saveLocalConnection, removeLocalConnection } = await import(${JSON.stringify(new URL("../agents/local-connections.ts", import.meta.url).href)});

const firstBase = "http://127.0.0.1:19080/v1";
const secondBase = "http://127.0.0.1:19081/v1";
const models = new Map([[firstBase, "first-model"], [secondBase, "second-model"]]);
let modelRequests = 0;
let blockFirst;
globalThis.fetch = async (input, init) => {
  assert.ok(!init?.method || init.method === "GET", "discovery must not generate text");
  const url = String(input);
  const base = url.endsWith("/models") ? url.slice(0, -7) : "";
  if (!models.has(base)) throw new Error("Offline fixture endpoint");
  modelRequests++;
  if (base === firstBase && blockFirst) await blockFirst();
  return Response.json({ data: [{ id: models.get(base) }] });
};
const { detectAgents, getCachedAgent, invalidateAgentCache } = await import(${JSON.stringify(new URL("../agents/detect.ts", import.meta.url).href)});
const directory = process.env.DATA_DIR;
const at = (agents, base) => agents.find((agent) => agent.kind === "local" && agent.runner.type === "openai" && agent.runner.baseUrl === base);
const first = saveLocalConnection(directory, { name: "NInfer", baseUrl: firstBase, model: "first-model", apiKey: "first-fixture-key" });

if (process.argv[1] === "mutations") {
  const original = at(await detectAgents(), firstBase);
  assert.ok(original, "the saved connection must be discovered");
  assert.equal(getCachedAgent(original.id)?.runner.apiKey, "first-fixture-key");

  saveLocalConnection(directory, { id: first.id, name: "Strata", baseUrl: secondBase, model: "second-model", apiKey: "replacement-fixture-key" });
  invalidateAgentCache();
  assert.equal(getCachedAgent(original.id), undefined, "an address/model/key update invalidates the old runner immediately");
  const updatedAgents = await detectAgents();
  const updated = at(updatedAgents, secondBase);
  assert.ok(updated);
  assert.ok(!updatedAgents.some((agent) => agent.id === original.id));
  assert.equal(updated.runner.model, "second-model");
  assert.equal(updated.runner.apiKey, "replacement-fixture-key");

  saveLocalConnection(directory, { id: first.id, name: "Strata", baseUrl: secondBase, model: "second-model", apiKey: "" });
  invalidateAgentCache();
  assert.equal(getCachedAgent(updated.id), undefined, "clearing a key cannot leave its prior cached runner usable");
  const cleared = at(await detectAgents(), secondBase);
  assert.ok(cleared);
  assert.equal(cleared.runner.apiKey, "");
  assert.equal(getCachedAgent(cleared.id)?.runner.apiKey, "");

  assert.equal(removeLocalConnection(directory, first.id), true);
  invalidateAgentCache();
  assert.equal(getCachedAgent(cleared.id), undefined, "deletion revokes the cached runner before another scan");
  assert.equal(at(await detectAgents(), secondBase), undefined);
  assert.equal(getCachedAgent(cleared.id), undefined);
} else if (process.argv[1] === "inflight") {
  const original = at(await detectAgents(), firstBase);
  assert.ok(original);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  blockFirst = async () => { started(); await gate; };
  invalidateAgentCache();
  const staleScan = detectAgents();
  await entered;

  removeLocalConnection(directory, first.id);
  saveLocalConnection(directory, { name: "Strata", baseUrl: secondBase, model: "second-model", apiKey: "new-generation-key" });
  invalidateAgentCache();
  assert.equal(getCachedAgent(original.id), undefined);
  const currentScan = detectAgents();
  release();
  const [olderResult, currentResult] = await Promise.all([staleScan, currentScan]);
  const current = at(currentResult, secondBase);
  assert.ok(current, "a scan after invalidation sees the replacement connection");
  for (const result of [olderResult, currentResult, await detectAgents()]) {
    assert.ok(!result.some((agent) => agent.id === original.id), "a pre-deletion scan must not return or repopulate the deleted runner");
    assert.equal(at(result, secondBase)?.id, current.id, "in-flight callers follow the current generation");
  }
  assert.equal(getCachedAgent(original.id), undefined);
  assert.equal(getCachedAgent(current.id)?.runner.apiKey, "new-generation-key");
} else if (process.argv[1] === "ttl") {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const original = at(await detectAgents(), firstBase);
    assert.ok(original);
    const requestsBeforeExpiry = modelRequests;
    clock += 299999;
    assert.ok(getCachedAgent(original.id), "cache is usable immediately before its five-minute deadline");
    clock += 1;
    assert.equal(getCachedAgent(original.id), undefined, "direct cached lookups respect the same TTL as discovery");
    const refreshed = at(await detectAgents(), firstBase);
    assert.ok(refreshed);
    assert.ok(modelRequests > requestsBeforeExpiry, "expired discovery must probe again");
    assert.ok(getCachedAgent(refreshed.id));
  } finally { Date.now = realNow; }
} else throw new Error("Unknown cache scenario");
console.log("isolated agent cache assertions passed");
`;

function runIsolated(scenario: string) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-agent-cache-"));
  try {
    const result = spawnSync(process.execPath, ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", childProgram, scenario], {
      cwd: temporary,
      windowsHide: true,
      timeout: 15_000,
      encoding: "utf8",
      env: {
        SystemRoot: process.env.SystemRoot,
        TEMP: temporary, TMP: temporary,
        NODE_ENV: "test", SCAN_MODELS: "1",
        HOME: path.join(temporary, "home"), USERPROFILE: path.join(temporary, "home"),
        APPDATA: path.join(temporary, "appdata"), LOCALAPPDATA: path.join(temporary, "localappdata"),
        ProgramFiles: path.join(temporary, "programs"), "ProgramFiles(x86)": path.join(temporary, "programs-x86"), ProgramData: path.join(temporary, "programdata"),
        PATH: path.join(temporary, "bin"), DATA_DIR: path.join(temporary, "data"),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /isolated agent cache assertions passed/);
  } finally {
    assert.equal(path.dirname(temporary), os.tmpdir());
    assert.match(path.basename(temporary), /^pg-agent-cache-/);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test("local connection updates, key clearing and deletion immediately revoke cached runners", () => runIsolated("mutations"));
test("an invalidated in-flight scan cannot return or cache a deleted local connection", () => runIsolated("inflight"));
test("direct cached-agent lookup expires at the same five-minute TTL as discovery", () => runIsolated("ttl"));
