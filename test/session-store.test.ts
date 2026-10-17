import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SessionStore, SessionCorruptError, SessionLimitError, LOCAL_OWNER_ID, listSessions, readSession } from "../session-store.ts";
import type { RunConfig, RunResult } from "../orchestrator.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-sessions-"));
after(() => fs.rmSync(temporary, { recursive: true, force: true }));
function config(): RunConfig {
  const slot = (name: string) => ({ name, persona: "Review carefully", agent: {
    id: name, kind: "api", title: name, subtitle: "Test", model: "fake", local: false,
    status: "ready", auto: true, icon: "", runner: { type: "openai", apiKey: "test-private-api-key", baseUrl: "https://example.invalid", model: "fake" },
    extraConnection: { secret: "test-private-extra" },
  } });
  return { task: "A harmless test", lang: "en", agentA: slot("A"), agentB: slot("B"), maxRounds: 3, discussionTurns: 1, cwd: temporary,
    media: { provider: { apiKey: "test-private-provider" }, dir: temporary, images: true, videos: false },
    futureCredentials: { secret: "test-private-future" },
  } as any;
}
const start = { type: "message_start", id: "a-1", agent: "A", name: "Author", model: "fake", source: "Test", kind: "draft", round: 0 } as const;
const version = { type: "version", n: 1, agent: "A", name: "Author", content: "Completed version one" } as const;

test("running sessions use the fixed local owner and never persist connection credentials", () => {
  const store = new SessionStore(temporary, "private", config());
  assert.deepEqual(listSessions(temporary), ["private"]);
  assert.equal(readSession(temporary, "../private"), null);
  assert.equal(readSession(temporary, "private", true)!.status, "running");
  assert.equal(readSession(temporary, "private")!.status, "interrupted");
  assert.equal(readSession(temporary, "private")!.userId, LOCAL_OWNER_ID);
  const checkpoint = fs.readFileSync(path.join(temporary, "private", "session.json"), "utf8");
  assert.doesNotMatch(checkpoint, /test-private|runner|provider|extraConnection|futureCredentials/);
  store.finish("cancelled", null);
  assert.equal(readSession(temporary, "private")!.status, "cancelled");
});

test("a killed writer retains completed versions and the last journaled message, tolerating only a torn tail", { timeout: 20000 }, async () => {
  const moduleUrl = new URL("../session-store.ts", import.meta.url).href;
  const code = `import { SessionStore } from ${JSON.stringify(moduleUrl)};
    const store = new SessionStore(${JSON.stringify(temporary)}, "killed", ${JSON.stringify(config())});
    store.append(${JSON.stringify(version)});
    store.append(${JSON.stringify(start)});
    store.append({type:"delta",id:"a-1",text:"Saved before process exit"});
    process.send("ready"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", (data) => { stderr += data.toString().slice(0, 2000); });
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(stderr || "Writer exited before it was ready"); })]);
    assert.equal(message, "ready");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  const journal = path.join(temporary, "killed", "events.jsonl");
  fs.appendFileSync(journal, '{"seq":4,"event":{"type":"delta","text":"incomplete');
  const saved = readSession(temporary, "killed")!;
  assert.equal(saved.status, "interrupted"); assert.equal(saved.partial, true);
  assert.equal(saved.result!.approved, false); assert.equal(saved.result!.finalVersion, 1);
  assert.equal(saved.result!.versions[0].content, version.content);
  assert.equal(saved.events.find((event) => event.type === "delta")!.text, "Saved before process exit");
  assert.equal(saved.config.task, config().task);
});

test("a malformed middle journal record is reported instead of silently skipped", () => {
  const store = new SessionStore(temporary, "damaged", config());
  store.append({ type: "delta", id: "a-1", text: "first" });
  fs.appendFileSync(path.join(temporary, "damaged", "events.jsonl"), 'damaged-record\n{"seq":2,"event":{"type":"delta","id":"a-1","text":"second"}}\n');
  assert.throws(() => readSession(temporary, "damaged"), SessionCorruptError);
});

test("checkpoint recovery skips already owned sequences and rejects a missing subsequent event", () => {
  const store = new SessionStore(temporary, "checkpoint", config());
  store.append(start);
  store.append({ type: "delta", id: "a-1", text: "first" });
  const journal = path.join(temporary, "checkpoint", "events.jsonl");
  const previous = fs.readFileSync(journal, "utf8");
  store.append(version);
  fs.writeFileSync(journal, previous + JSON.stringify({ seq: 4, event: { type: "delta", id: "a-1", text: " next" } }) + "\n");
  assert.equal(readSession(temporary, "checkpoint")!.events.find((event) => event.type === "delta")!.text, "first next");
  fs.writeFileSync(journal, JSON.stringify({ seq: 5, event: { type: "status", text: "missing" } }) + "\n");
  assert.throws(() => readSession(temporary, "checkpoint"), /missing an event/);
});

test("a failed run preserves completed version events even when the orchestrator returned no result", () => {
  const store = new SessionStore(temporary, "failed", config());
  store.append(version); store.append({ type: "error", message: "Second Agent exited" });
  assert.deepEqual(store.partialResult()!.versions.map((v) => v.n), [1]);
  store.finish("failed", null, { 1: "frozen-v1" });
  const saved = readSession(temporary, "failed")!;
  assert.equal(saved.status, "failed"); assert.equal(saved.partial, true);
  assert.equal(saved.result!.approved, false); assert.equal(saved.result!.versions[0].content, version.content);
  assert.equal(saved.versionIds[1], "frozen-v1");
});

test("normal completion and old session formats with legacy user ids remain compatible", () => {
  const result: RunResult = { versions: [{ n: 1, agent: "A", name: "Author", content: "Reviewed output" }], finalVersion: 1, approved: true, reason: "Approved", media: [] };
  const store = new SessionStore(temporary, "completed", config());
  store.append(version); store.finish("completed", result, { 1: "frozen" });
  const completed = readSession(temporary, "completed")!;
  assert.equal(completed.status, "completed"); assert.equal(completed.partial, false);
  assert.deepEqual(completed.result, result);
  fs.mkdirSync(path.join(temporary, "legacy"));
  fs.writeFileSync(path.join(temporary, "legacy", "session.json"), JSON.stringify({ id: "legacy", userId: 987654, config: { task: "Old task" }, events: [start, { type: "delta", id: "a-1", text: "old " }, { type: "delta", id: "a-1", text: "transcript" }], result, versionIds: {} }));
  const legacy = readSession(temporary, "legacy", 123)!;
  assert.equal(legacy.userId, 987654);
  assert.equal(legacy.status, "completed"); assert.equal(legacy.events.filter((event) => event.type === "delta").length, 1);
  assert.equal(legacy.events.find((event) => event.type === "delta")!.text, "old transcript");
  assert.ok(listSessions(temporary, 123).includes("legacy"));
});

test("streaming tokens are compacted and an explicit storage limit preserves earlier versions", () => {
  const store = new SessionStore(temporary, "bounded", config());
  store.append(version); store.append(start);
  for (let i = 0; i < 2000; i++) {
    store.append({ type: "delta", id: "a-1", text: "x" });
    store.append({ type: "progress", id: "a-1", phase: "running" });
  }
  const saved = readSession(temporary, "bounded")!;
  assert.equal(saved.events.length, 3);
  assert.equal(saved.events.find((event) => event.type === "delta")!.text.length, 2000);
  const largeChunk = "x".repeat(512 * 1024);
  assert.throws(() => { for (let i = 0; i < 20; i++) store.append({ type: "delta", id: "a-1", text: largeChunk }); }, SessionLimitError);
  store.append({ type: "error", message: "Storage limit reached" }); store.finish("failed", null);
  assert.equal(readSession(temporary, "bounded")!.result!.versions[0].content, version.content);
  assert.ok(fs.statSync(path.join(temporary, "bounded", "session.json")).size < 9 * 1024 * 1024);
});
