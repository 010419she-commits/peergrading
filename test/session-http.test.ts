// Real local server.ts + HTTP with isolated Agent discovery and chat fixtures.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { LOCAL_OWNER_ID, SessionStore } from "../session-store.ts";
import type { RunConfig } from "../orchestrator.ts";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-session-http-"));
const sessions = path.join(temporary, "sessions");
let child: ChildProcess | undefined, origin = "", diagnostics = "";

async function request(route: string, options: RequestInit = {}) {
  return fetch(origin + route, { ...options, redirect: "manual", signal: options.signal ?? AbortSignal.timeout(10000) });
}
async function bootstrap() {
  const response = await request("/api/bootstrap");
  assert.equal(response.status, 200);
  return response.json();
}
async function post(route: string, body: object = {}, headers: Record<string, string> = {}) {
  const current = await bootstrap();
  return request(route, { method: "POST", headers: { "content-type": "application/json", origin, "x-csrf-token": current.csrf, ...headers }, body: JSON.stringify(body) });
}

before(async () => {
  const detectUrl = new URL("../agents/detect.ts", import.meta.url).href;
  const backendUrl = new URL("../agents/backends.ts", import.meta.url).href;
  const serverUrl = new URL("../server.ts", import.meta.url).href;
  const detectSource = `
    const agents = ["author", "reviewer"].map(role => ({
      id: "fake-" + role, kind: "cli", title: "Isolated " + role,
      subtitle: "HTTP test fixture", model: role, local: true, status: "ready", auto: true, icon: "",
      runner: { type: "generic", bin: "not-executed", args: [], promptVia: "stdin", parse: "text", model: role }
    }));
    export const detectAgents = async () => agents;
    export const getCachedAgent = id => agents.find(agent => agent.id === id);
    export const invalidateAgentCache = () => {};
    export const startService = async () => ({ok:false});
    export const loginCommandFor = async () => null;
    export const windowsProcessNames = () => [];
  `;
  const backendSource = `
    export const createBackend = spec => ({ async chat(req) {
      if (req.signal.aborted) throw new Error("aborted");
      if (spec.model === "author") {
        const text = "<deliverable>Completed isolated HTTP version</deliverable>";
        req.onDelta(text); return {text};
      }
      return await new Promise((resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        req.signal.addEventListener("abort", abort, {once:true});
        if (req.signal.aborted) abort();
      });
    }});
  `;
  const loader = `
    import { registerHooks } from "node:module";
    import http from "node:http";
    const replacements = new Map(${JSON.stringify([[detectUrl, detectSource], [backendUrl, backendSource]])});
    registerHooks({ load(url, context, nextLoad) {
      if (replacements.has(url)) return {format:"module",source:replacements.get(url),shortCircuit:true};
      return nextLoad(url, context);
    }});
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function(...args) {
      this.once("listening", () => process.send({type:"ready",port:this.address().port,address:this.address().address}));
      return listen.apply(this,args);
    };
    await import(${JSON.stringify(serverUrl)});
  `;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "SYSTEMDRIVE", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    PATH: path.dirname(process.execPath), HOME: temporary, USERPROFILE: temporary,
    APPDATA: path.join(temporary, "roaming"), LOCALAPPDATA: path.join(temporary, "local"), TEMP: temporary, TMP: temporary,
    NODE_ENV: "test", PORT: "0", HOST: "0.0.0.0", LOCAL_MODE: "1", SCAN_MODELS: "0",
    DATA_DIR: path.join(temporary, "data"), SESSIONS_DIR: sessions,
  });
  child = spawn(process.execPath, ["--input-type=module", "-e", loader], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  for (const stream of [child.stdout!, child.stderr!]) stream.on("data", (data) => { diagnostics = (diagnostics + data.toString()).slice(-6000); });
  const ready = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Isolated server did not become ready: ${diagnostics}`)); }, 15000);
    const listening = (message: any) => { if (message?.type === "ready") { cleanup(); resolve(message); } };
    const exited = () => { cleanup(); reject(new Error(`Isolated server exited: ${diagnostics}`)); };
    const cleanup = () => { clearTimeout(timer); child!.off("message", listening); child!.off("exit", exited); };
    child!.on("message", listening); child!.once("exit", exited); child!.once("error", reject);
  });
  assert.equal(ready.address, "127.0.0.1", "HOST cannot expose the local service on another interface");
  origin = `http://127.0.0.1:${ready.port}`;
}, { timeout: 20000 });

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  fs.rmSync(temporary, { recursive: true, force: true });
});

const fixtureConfig = (): RunConfig => ({ task: "Recover a saved HTTP task", lang: "en", cwd: temporary, maxRounds: 2, discussionTurns: 1,
  agentA: { name: "Author", persona: "", agent: { id: "fake-author", title: "Author", model: "fake", runner: { type: "openai", apiKey: "test-private-key-not-to-save" } } },
  agentB: { name: "Reviewer", persona: "", agent: { id: "fake-reviewer", title: "Reviewer", model: "fake", runner: { type: "openai", apiKey: "test-private-key-not-to-save" } } },
} as any);

test("local bootstrap and third-party Agent settings need no PeerGrading account or cookie", async () => {
  const root = await request("/");
  assert.equal(root.status, 302); assert.equal(root.headers.get("location"), "/app");
  assert.equal((await request("/app")).status, 200);
  const response = await request("/api/bootstrap");
  const data = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ["csrf", "localMode", "repositoryAvailable"]);
  assert.equal(data.localMode, true); assert.equal(data.repositoryAvailable, true);
  assert.ok(data.csrf.length >= 32); assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await request("/api/auth/bootstrap")).status, 404);
  assert.equal((await (await request("/api/agents")).json()).agents.length, 2);
  assert.equal((await (await request("/api/local-models")).json()).available, true);
  assert.equal((await (await request("/api/api-models")).json()).available, true);
  assert.equal((await (await request("/api/media/settings")).json()).canEdit, true);
  assert.equal((await post("/api/agents/login", { id: "fake-author" })).status, 404, "third-party Agent login route remains mounted");
});

test("real server HTTP replays interrupted versions without cookies and enforces write CSRF", async () => {
  const store = new SessionStore(sessions, "interrupted-http", fixtureConfig());
  store.append({ type: "version", n: 1, agent: "A", name: "Author", content: "Completed before interruption" });
  store.append({ type: "message_start", id: "unfinished", agent: "B", name: "Reviewer", model: "fake", source: "Fixture", kind: "review", round: 1 });
  store.append({ type: "delta", id: "unfinished", text: "Review text saved in the journal" });
  const response = await request("/api/sessions/interrupted-http");
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.userId, LOCAL_OWNER_ID);
  assert.equal(saved.status, "interrupted"); assert.equal(saved.partial, true);
  assert.equal(saved.result.approved, false); assert.equal(saved.result.versions[0].content, "Completed before interruption");
  assert.equal(saved.events.find((event: any) => event.type === "delta").text, "Review text saved in the journal");
  assert.doesNotMatch(JSON.stringify(saved.config), /runner|test-private-key/);
  assert.ok((await (await request("/api/sessions")).json()).includes("interrupted-http"));
  assert.equal((await post("/api/stop/interrupted-http")).status, 200);
});

test("legacy user ids remain readable and listable in the single-user local store", async () => {
  const dir = path.join(sessions, "legacy-http"); fs.mkdirSync(dir, { recursive: true });
  const result = { versions: [{ n: 1, agent: "A", name: "Author", content: "Old reviewed version" }], finalVersion: 1, approved: true, reason: "Approved", media: [] };
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ id: "legacy-http", userId: 987654, config: { task: "Old saved task" }, events: [{ type: "version", ...result.versions[0] }], result, versionIds: {} }, null, 2));
  const response = await request("/api/sessions/legacy-http"); assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.userId, 987654); assert.equal(saved.status, "completed"); assert.equal(saved.partial, false); assert.deepEqual(saved.result, result);
  assert.ok((await (await request("/api/sessions")).json()).includes("legacy-http"));
});

test("invalid hosts and writes without valid origin or CSRF are rejected", async () => {
  const http = await import("node:http");
  const withHost = (host: string) => new Promise<number>((resolve, reject) => {
    const req = http.request(origin + "/api/bootstrap", { headers: { host } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", reject); req.end();
  });
  assert.equal(await withHost("attacker.invalid"), 403);
  assert.equal(await withHost("127.0.0.1:1"), 403);
  assert.equal((await post("/api/stop/interrupted-http", {}, { "x-csrf-token": "" })).status, 403);
  assert.equal((await post("/api/stop/interrupted-http", {}, { origin: "https://attacker.invalid" })).status, 403);
  const current = await bootstrap();
  assert.equal((await request("/api/stop/interrupted-http", { method: "POST", headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" }, body: "{}" })).status, 403);
  assert.equal((await request("/api/stop/interrupted-http", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", "x-csrf-token": current.csrf }, body: "{}" })).status, 403);
  const accepted = await request("/api/stop/interrupted-http", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin", "x-csrf-token": current.csrf }, body: "{}" });
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { stopped: false });
});

test("an active run can be read and stopped without an account while retaining version one", { timeout: 15000 }, async () => {
  const response = await post("/api/run", { task: "An isolated mock Agent task", lang: "en", maxRounds: 2, discussionTurns: 1, agentA: { agentId: "fake-author" }, agentB: { agentId: "fake-reviewer" } });
  assert.equal(response.status, 200, await (response.ok ? Promise.resolve("") : response.clone().text()));
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "", runId = "", reviewing = false;
  try {
    while (!reviewing) {
      const chunk = await reader.read(); assert.equal(chunk.done, false, diagnostics);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const record = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        for (const line of record.split("\n")) if (line.startsWith("data: ")) {
          const event = JSON.parse(line.slice(6));
          if (event.type === "run") runId = event.id;
          if (event.type === "message_start" && event.kind === "review") reviewing = true;
        }
      }
    }
    assert.ok(runId);
    const stillRunning = await (await request(`/api/sessions/${runId}`)).json();
    assert.equal(stillRunning.status, "running"); assert.equal(stillRunning.result.versions[0].n, 1);
    const stopped = await post(`/api/stop/${runId}`); assert.equal(stopped.status, 200); assert.equal((await stopped.json()).stopped, true);
    while (!(await reader.read()).done) { /* wait for the real server finally/save path */ }
    const saved = await (await request(`/api/sessions/${runId}`)).json();
    assert.equal(saved.status, "cancelled"); assert.equal(saved.partial, true);
    assert.equal(saved.result.approved, false); assert.equal(saved.result.versions[0].content, "Completed isolated HTTP version");
    assert.ok(saved.versionIds[1], "The completed version was frozen despite an aborted review");
    assert.ok((await (await request("/api/sessions")).json()).includes(runId));
  } finally { await reader.cancel().catch(() => {}); }
});
