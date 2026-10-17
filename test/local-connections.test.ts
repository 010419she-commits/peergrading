import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { loadLocalConnections, saveLocalConnection, removeLocalConnection, publicLocalConnections, normalizeLocalBaseUrl } from "../agents/local-connections.ts";
import { createLocalConnectionsRouter, publicAgentInfo } from "../agents/local-connections-routes.ts";

function temporaryStore(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pg-local-models-"));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.match(path.basename(directory), /^pg-local-models-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("manual local connections accept loopback and private LAN API addresses", () => {
  for (const host of ["127.0.0.1", "localhost", "192.168.1.20", "10.0.0.8", "172.16.0.4", "[::1]"]) {
    assert.equal(normalizeLocalBaseUrl(`http://${host}:8080`), `http://${host}:8080/v1`);
    assert.equal(normalizeLocalBaseUrl(`http://${host}:8080/v1/`), `http://${host}:8080/v1`);
  }
  for (const value of ["http://8.8.8.8:8080/v1", "https://cloud.example/v1", "http://172.32.0.1/v1", "http://169.254.169.254/", "file:///models", "http://user:key@localhost:8080/v1", "http://localhost:8080/v1?key=secret", "http://localhost:8080/v1#fragment", "http://localhost:8080/admin"]) assert.throws(() => normalizeLocalBaseUrl(value));
});

test("NInfer and Strata addresses persist separately and credentials are redacted", (t) => {
  const directory = temporaryStore(t);
  const ninfer = saveLocalConnection(directory, { name: "NInfer", baseUrl: "http://127.0.0.1:8086", model: "qwen-ninfer", apiKey: "ninfer-private-key" });
  const strata = saveLocalConnection(directory, { name: "Strata", baseUrl: "http://192.168.1.20:8080/v1", apiKey: "strata-private-key" });
  assert.notEqual(ninfer.id, strata.id);
  assert.equal(loadLocalConnections(directory).length, 2);
  assert.equal(loadLocalConnections(directory)[0].baseUrl, "http://127.0.0.1:8086/v1");
  const metadata = publicLocalConnections(directory);
  assert.ok(metadata.every((entry) => entry.hasApiKey === true && !("apiKey" in entry)));
  assert.doesNotMatch(JSON.stringify(metadata), /ninfer-private-key|strata-private-key/);
  const updated = saveLocalConnection(directory, { id: strata.id, name: "Strata GPU", baseUrl: strata.baseUrl, model: "qwen-strata" });
  assert.equal(updated.apiKey, "strata-private-key", "editing the address does not erase a saved key");
  const cleared = saveLocalConnection(directory, { id: strata.id, name: updated.name, baseUrl: updated.baseUrl, apiKey: "" });
  assert.equal(cleared.apiKey || "", "");
  assert.equal(publicLocalConnections(directory).find((entry) => entry.id === strata.id)?.hasApiKey, false);
  assert.equal(removeLocalConnection(directory, ninfer.id), true);
  assert.equal(removeLocalConnection(directory, ninfer.id), false);
  assert.equal(loadLocalConnections(directory).length, 1);
});

test("invalid input or connection overflow cannot replace existing settings", (t) => {
  const directory = temporaryStore(t);
  saveLocalConnection(directory, { name: "NInfer", baseUrl: "http://localhost:8086/v1" });
  const before = JSON.stringify(loadLocalConnections(directory));
  for (const input of [
    { name: "", baseUrl: "http://localhost:8080" },
    { name: "Strata", baseUrl: "http://cloud.example/v1" },
    { name: "Strata", baseUrl: "http://localhost:8080", model: "x".repeat(257) },
  ]) assert.throws(() => saveLocalConnection(directory, input));
  assert.equal(JSON.stringify(loadLocalConnections(directory)), before);
  for (let index = 1; index < 12; index++) saveLocalConnection(directory, { name: `local-${index}`, baseUrl: `http://127.0.0.1:${8080 + index}/v1` });
  assert.throws(() => saveLocalConnection(directory, { name: "too-many", baseUrl: "http://localhost:9090/v1" }));
  assert.equal(loadLocalConnections(directory).length, 12);
});

test("local connection routes require authentication and CSRF and never return the stored key", async (t) => {
  const directory = temporaryStore(t);
  const app = express();
  let changed = 0;
  app.use(express.json());
  app.use((req, res, next) => req.get("x-test-auth") === "signed-in" ? next() : res.status(401).json({ error: "unauthenticated" }));
  app.use(createLocalConnectionsRouter({ directory, available: true, onChanged: () => { changed++; }, requireCsrf: (req, res, next) => req.get("x-csrf-token") === "test-csrf" ? next() : res.status(403).json({ error: "csrf" }) }));
  const server = await new Promise<any>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${server.address().port}/local-models`;
  const request = (method: string, body?: any, authorized = true, csrf = true, suffix = "") => fetch(base + suffix, { method, headers: { "content-type": "application/json", ...(authorized ? { "x-test-auth": "signed-in" } : {}), ...(csrf ? { "x-csrf-token": "test-csrf" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request("GET", undefined, false)).status, 401);
  assert.equal((await request("POST", { name: "Strata", baseUrl: "http://localhost:8080/v1" }, true, false)).status, 403);
  assert.deepEqual(loadLocalConnections(directory), []);
  assert.equal(changed, 0);
  const response = await request("POST", { name: "Strata", baseUrl: "http://localhost:8080/v1", apiKey: "stored-secret" });
  assert.equal(response.status, 200);
  const created = await response.json();
  assert.equal(created.connection.hasApiKey, true);
  assert.equal(changed, 1);
  assert.doesNotMatch(JSON.stringify(created), /stored-secret|"apiKey"/);
  const listed = await (await request("GET")).json();
  assert.equal(listed.available, true);
  assert.equal(listed.connections[0].name, "Strata");
  assert.doesNotMatch(JSON.stringify(listed), /stored-secret|"apiKey"/);
  assert.equal((await request("DELETE", undefined, true, false, `/${created.connection.id}`)).status, 403);
  assert.equal(loadLocalConnections(directory).length, 1);
  assert.equal(changed, 1);
  assert.equal((await request("DELETE", undefined, true, true, `/${created.connection.id}`)).status, 200);
  assert.equal(loadLocalConnections(directory).length, 0);
  assert.equal(changed, 2);
});

test("public server rejects local connection reads and writes", async (t) => {
  const directory = temporaryStore(t);
  const app = express();
  app.use(express.json());
  app.use(createLocalConnectionsRouter({ directory, available: false, requireCsrf: (_req, _res, next) => next() }));
  const server = await new Promise<any>((resolve) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${server.address().port}/local-models`;
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await fetch(base + (method === "DELETE" ? "/missing" : ""), { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ name: "Strata", baseUrl: "http://localhost:8080" }) } : {}) });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "local_models_local_only");
  }
  assert.deepEqual(loadLocalConnections(directory), []);
});

test("agent response redaction preserves backend credentials only in the internal record", () => {
  for (const runner of [
    { type: "openai", baseUrl: "http://localhost:8080/v1", model: "qwen", apiKey: "backend-only-key" },
    { type: "qwen-code", bin: "qwen", model: "qwen", openai: { baseUrl: "http://localhost:8080/v1", apiKey: "backend-only-key" } },
  ]) {
    const internal = { id: "local-model", kind: "local", title: "Strata", subtitle: "", model: "qwen", local: true, status: "ready", auto: true, icon: "", runner } as any;
    const before = JSON.stringify(internal);
    const metadata = publicAgentInfo(internal);
    assert.doesNotMatch(JSON.stringify(metadata), /backend-only-key|"apiKey"/);
    assert.equal(JSON.stringify(internal), before);
    assert.equal(metadata.runner.type, runner.type);
  }
});
