import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import {
  ApiConnectionError, assertPublicApiEndpoint, isPublicApiAddress, loadApiConnections, normalizeApiBaseUrl,
  publicApiConnections, redactApiConnection, removeApiConnection, saveApiConnection, type ApiConnectionInput, type ApiLookup,
} from "../agents/api-connections.ts";
import { createApiConnectionsRouter } from "../agents/api-connections-routes.ts";

const publicLookup: ApiLookup = async () => [{ address: "8.8.8.8", family: 4 }];
const input = (extra: ApiConnectionInput = {}): ApiConnectionInput => ({ name: "Kimi cloud", provider: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "test-model", apiKey: "test-key-never-sent-to-network", ...extra });
function temporaryStore(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pg-api-models-"));
  t.after(() => {
    assert.equal(path.dirname(directory), os.tmpdir()); assert.match(path.basename(directory), /^pg-api-models-/);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
const errorCode = (code: string) => (error: unknown) => error instanceof ApiConnectionError && error.code === code;

test("cloud URLs retain HTTPS custom API prefixes and reject credentials, insecure URLs and local destinations", () => {
  assert.equal(normalizeApiBaseUrl(" https://API.MOONSHOT.CN/v1/ "), "https://api.moonshot.cn/v1");
  assert.equal(normalizeApiBaseUrl("https://api.example.com:443/custom/compatible/v1/"), "https://api.example.com/custom/compatible/v1");
  assert.equal(normalizeApiBaseUrl("https://api.example.com"), "https://api.example.com");
  assert.equal(normalizeApiBaseUrl("https://8.8.8.8/custom"), "https://8.8.8.8/custom");
  assert.equal(normalizeApiBaseUrl("https://[2001:4860:4860::8888]/v1"), "https://[2001:4860:4860::8888]/v1");
  for (const value of [
    "http://api.moonshot.cn/v1", "file:///private/key", "https://user:key@api.example.com/v1", "https://api.example.com/v1?key=secret", "https://api.example.com/v1#fragment",
    "https://api.example.com\\@127.0.0.1", "https://api.example.com/v1\n", "https://api.example.com/v1%0d%0aAuthorization:key", "https://api.example.com/path%5csecret",
    "https://api.example.com/v1/chat/completions", "https://api.example.com/v1/chat/completions///", "https://api.example.com/v1/CHAT/COMPLETIONS/",
    "https://api.example.com/v1/%63hat/%63ompletions", "https://api.example.com/v1/chat%2fcompletions%2F", "https://api.example.com/v1%2FCHAT%2Fcompletions/",
    "https://localhost/v1", "https://LOCALHOST./v1", "https://foo.localhost/v1", "https://router/v1", "https://api.internal/v1", "https://api.local/v1", "https://models.home.arpa/v1",
    "https://127.0.0.1/v1", "https://127.1/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://10.1.2.3/v1", "https://172.31.0.1/v1", "https://192.168.1.1/v1",
    "https://169.254.169.254/latest/meta-data", "https://100.100.100.200/v1", "https://0.0.0.0/v1", "https://224.0.0.1/v1", "https://192.0.2.1/v1",
    "https://[::1]/v1", "https://[fc00::1]/v1", "https://[fe80::1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://[2001:db8::1]/v1", "https://[2002:7f00:1::]/v1",
  ]) assert.throws(() => normalizeApiBaseUrl(value), undefined, value);
});

test("public DNS must resolve entirely to public addresses without probing a model or sending a key", async () => {
  assert.equal(isPublicApiAddress("8.8.8.8"), true); assert.equal(isPublicApiAddress("2001:4860:4860::8888"), true);
  for (const address of ["127.0.0.1", "192.168.0.1", "::", "::1", "::ffff:8.8.8.8", "64:ff9b::7f00:1", "2001:db8::1", "ff02::1", "not-an-ip"]) assert.equal(isPublicApiAddress(address), false, address);
  let calls = 0;
  await assertPublicApiEndpoint("https://api.example.com/v1", async (host) => { calls++; assert.equal(host, "api.example.com"); return [{ address: "8.8.8.8", family: 4 }]; });
  assert.equal(calls, 1);
  for (const answers of [
    [{ address: "127.0.0.1", family: 4 }], [{ address: "fd00::1", family: 6 }],
    [{ address: "8.8.8.8", family: 4 }, { address: "169.254.169.254", family: 4 }],
  ]) await assert.rejects(assertPublicApiEndpoint("https://public-name.example.com/v1", async () => answers), errorCode("api_model_endpoint_private"));
  await assert.rejects(assertPublicApiEndpoint("https://api.example.com/v1", async () => []), errorCode("api_model_endpoint_unavailable"));
  await assert.rejects(assertPublicApiEndpoint("https://api.example.com/v1", async () => { throw new Error("sensitive resolver message"); }), errorCode("api_model_endpoint_unavailable"));
});

test("cloud profiles persist separately, redact keys, preserve omitted keys only at the same provider and address", async (t) => {
  const directory = temporaryStore(t);
  assert.deepEqual(loadApiConnections(directory), []);
  const saved = await saveApiConnection(directory, input(), { lookup: publicLookup });
  assert.equal(loadApiConnections(directory)[0].apiKey, "test-key-never-sent-to-network");
  assert.equal(fs.existsSync(path.join(directory, "local-models.json")), false);
  const exposed = publicApiConnections(directory);
  assert.equal(exposed[0].hasApiKey, true); assert.doesNotMatch(JSON.stringify(exposed), /test-key|"apiKey"/);
  assert.doesNotMatch(JSON.stringify(redactApiConnection({ ...saved, internalSecret: "not-public" } as any)), /internalSecret|not-public/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(directory, "api-models.json")).mode & 0o777, 0o600);
  const edit = input({ id: saved.id, name: "Kimi renamed", model: "another-model", apiKey: undefined });
  assert.equal((await saveApiConnection(directory, edit, { lookup: publicLookup })).apiKey, saved.apiKey);
  const before = fs.readFileSync(path.join(directory, "api-models.json"), "utf8");
  for (const changed of [
    { ...edit, baseUrl: "https://other.example.com/v1" }, { ...edit, baseUrl: "https://api.moonshot.cn/v2" }, { ...edit, provider: "custom" }, { ...edit, apiKey: "" },
  ]) await assert.rejects(saveApiConnection(directory, changed, { lookup: publicLookup }), errorCode("api_model_key_required"));
  assert.equal(fs.readFileSync(path.join(directory, "api-models.json"), "utf8"), before);
  const moved = await saveApiConnection(directory, { ...edit, baseUrl: "https://other.example.com/compatible/v1", provider: "custom", apiKey: "replacement-key" }, { lookup: publicLookup });
  assert.equal(moved.apiKey, "replacement-key"); assert.equal(moved.id, saved.id);
  assert.equal(removeApiConnection(directory, saved.id), true); assert.equal(removeApiConnection(directory, saved.id), false);
});

test("new profiles require a model, supported provider and nonempty key; invalid input leaves the store unchanged", async (t) => {
  const directory = temporaryStore(t);
  await saveApiConnection(directory, input(), { lookup: publicLookup });
  const before = fs.readFileSync(path.join(directory, "api-models.json"), "utf8");
  for (const invalid of [
    input({ model: "" }), input({ model: "x".repeat(257) }), input({ name: "" }), input({ provider: "unsupported" }), input({ baseUrl: "http://api.example.com/v1" }), input({ apiKey: "key\r\ninjection" }), input({ id: "../../escape" }),
  ]) await assert.rejects(saveApiConnection(directory, invalid, { lookup: publicLookup }));
  for (const missing of [undefined, "", "   "]) await assert.rejects(saveApiConnection(directory, input({ apiKey: missing }), { lookup: publicLookup }), errorCode("api_model_key_required"));
  await assert.rejects(saveApiConnection(directory, input({ baseUrl: "https://rebound.example.com/v1" }), { lookup: async () => [{ address: "10.0.0.1", family: 4 }] }), errorCode("api_model_endpoint_private"));
  assert.equal(fs.readFileSync(path.join(directory, "api-models.json"), "utf8"), before);
});

test("a concurrent endpoint edit cannot move an omitted old key or lose a second new connection", async (t) => {
  const directory = temporaryStore(t), saved = await saveApiConnection(directory, input(), { lookup: publicLookup });
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const delayed = saveApiConnection(directory, input({ id: saved.id, apiKey: undefined }), { lookup: async () => { await waiting; return [{ address: "8.8.8.8", family: 4 }]; } });
  await saveApiConnection(directory, input({ id: saved.id, baseUrl: "https://other.example.com/v1", apiKey: "new-endpoint-key" }), { lookup: publicLookup });
  release(); await assert.rejects(delayed, errorCode("api_model_key_required"));
  assert.equal(loadApiConnections(directory)[0].apiKey, "new-endpoint-key");
  await Promise.all([saveApiConnection(directory, input({ name: "two" }), { lookup: publicLookup }), saveApiConnection(directory, input({ name: "three" }), { lookup: publicLookup })]);
  assert.equal(loadApiConnections(directory).length, 3);
});

test("limits and damaged cloud stores fail closed without overwriting existing records", async (t) => {
  const directory = temporaryStore(t);
  for (let index = 0; index < 12; index++) await saveApiConnection(directory, input({ name: `cloud-${index}` }), { lookup: publicLookup });
  await assert.rejects(saveApiConnection(directory, input(), { lookup: publicLookup }), errorCode("api_models_limit"));
  const file = path.join(directory, "api-models.json");
  const saved = loadApiConnections(directory)[0];
  for (const contents of ["{broken", JSON.stringify([saved, saved]), JSON.stringify([{ ...saved, baseUrl: "https://127.0.0.1/v1" }]), JSON.stringify([{ ...saved, apiKey: "" }])]) {
    fs.writeFileSync(file, contents); assert.throws(() => loadApiConnections(directory), errorCode("invalid_api_models_store"));
    await assert.rejects(saveApiConnection(directory, input(), { lookup: publicLookup }), errorCode("invalid_api_models_store"));
    assert.equal(fs.readFileSync(file, "utf8"), contents);
  }
});

test("cloud routes preserve auth/CSRF boundaries, return presets and never expose keys", async (t) => {
  const directory = temporaryStore(t), app = express(); let changed = 0;
  app.use(express.json());
  app.use((req, res, next) => req.get("x-test-auth") === "signed-in" ? next() : res.status(401).json({ error: "unauthenticated" }));
  app.use(createApiConnectionsRouter({ directory, available: true, lookup: publicLookup, onChanged: () => { changed++; }, requireCsrf: (req, res, next) => req.get("x-csrf-token") === "test-csrf" ? next() : res.status(403).json({ error: "csrf" }) }));
  const server = await new Promise<any>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${server.address().port}/api-models`;
  const request = (method: string, body?: object, auth = true, csrf = true, suffix = "") => fetch(base + suffix, { method, headers: { "content-type": "application/json", ...(auth ? { "x-test-auth": "signed-in" } : {}), ...(csrf ? { "x-csrf-token": "test-csrf" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request("GET", undefined, false)).status, 401);
  assert.equal((await request("POST", input(), true, false)).status, 403); assert.equal(changed, 0);
  const createdResponse = await request("POST", input()); assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json(); assert.equal(created.connection.hasApiKey, true); assert.equal(changed, 1);
  assert.doesNotMatch(JSON.stringify(created), /test-key|"apiKey"/);
  const listed = await (await request("GET")).json(); assert.equal(listed.available, true); assert.equal(listed.connections.length, 1);
  assert.ok(Array.isArray(listed.presets)); assert.ok(listed.presets.length >= 6); assert.doesNotMatch(JSON.stringify(listed), /test-key|"apiKey"/);
  const cleared = await request("POST", input({ id: created.connection.id, apiKey: "" })); assert.equal(cleared.status, 400); assert.equal((await cleared.json()).error, "api_model_key_required");
  assert.equal(changed, 1);
  assert.equal((await request("DELETE", undefined, true, false, `/${created.connection.id}`)).status, 403);
  assert.equal((await request("DELETE", undefined, true, true, `/${created.connection.id}`)).status, 200); assert.equal(changed, 2);
  assert.equal((await request("DELETE", undefined, true, true, `/${created.connection.id}`)).status, 404);
});

test("public server cannot read, save or delete cloud API profiles", async (t) => {
  const directory = temporaryStore(t), app = express(); let lookupCalls = 0;
  app.use(express.json());
  app.use(createApiConnectionsRouter({ directory, available: false, lookup: async () => { lookupCalls++; return []; }, requireCsrf: (_req, _res, next) => next() }));
  const server = await new Promise<any>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  for (const method of ["GET", "POST", "DELETE"]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api-models${method === "DELETE" ? "/missing" : ""}`, { method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(input()) } : {}) });
    assert.equal(response.status, 403); assert.equal((await response.json()).error, "api_models_local_only");
  }
  assert.equal(lookupCalls, 0); assert.deepEqual(loadApiConnections(directory), []);
});
