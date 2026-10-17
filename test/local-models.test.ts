import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { configuredQwenLocalEndpoint, detectLocalOpenAIAgents, normalizeLocalBaseUrl } from "../agents/local.ts";
import { createBackend } from "../agents/backends.ts";

const qwenSettings = {
  security: { auth: { selectedType: "openai" } },
  model: { name: "qwen3.8-27b-quasar-v3-dflash2-vision", baseUrl: "http://127.0.0.1:8086/v1" },
  modelProviders: { openai: [{ id: "qwen3.8-27b-quasar-v3-dflash2-vision", baseUrl: "http://127.0.0.1:8086/v1", apiKey: "local-test-key" }] },
};

test("automatic local discovery accepts loopback endpoints and rejects remote URLs and URL credentials", () => {
  assert.equal(normalizeLocalBaseUrl("http://127.0.0.1:8086"), "http://127.0.0.1:8086/v1");
  assert.equal(normalizeLocalBaseUrl("http://localhost:8080/v1/"), "http://localhost:8080/v1");
  assert.equal(normalizeLocalBaseUrl("http://[::1]:8080/v1"), "http://[::1]:8080/v1");
  for (const value of ["https://cloud.example/v1", "http://192.168.1.10:8080/v1", "file:///tmp/model", "http://user:secret@localhost:8080/v1", "http://localhost:8080/v1?key=secret", "http://localhost:8080/v1#secret"]) assert.equal(normalizeLocalBaseUrl(value), null);
});

test("Qwen settings retain the exact local endpoint and model without borrowing a cloud key", () => {
  const endpoint = configuredQwenLocalEndpoint(qwenSettings, { OPENAI_API_KEY: "cloud-key" });
  assert.equal(endpoint?.baseUrl, qwenSettings.model.baseUrl);
  assert.equal(endpoint?.model, qwenSettings.model.name);
  assert.equal(endpoint?.apiKey, "local-test-key");
  const mismatched = structuredClone(qwenSettings);
  mismatched.modelProviders.openai[0].baseUrl = "https://cloud.example/v1";
  assert.equal(configuredQwenLocalEndpoint(mismatched, { OPENAI_API_KEY: "cloud-key" })?.apiKey, "");
  const oauth = structuredClone(qwenSettings);
  oauth.security.auth.selectedType = "qwen-oauth";
  assert.equal(configuredQwenLocalEndpoint(oauth), null);
});

test("NInfer discovers every advertised model without a Qwen CLI or any generation request", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ data: [{ id: "other-model" }, { id: "qwen-exact-id" }, { id: "qwen-exact-id" }] });
  };
  const agents = await detectLocalOpenAIAgents({ env: { NINFER_URL: "http://127.0.0.1:8086/v1", OPENAI_API_KEY: "do-not-send-cloud-key" }, fetch: fetcher });
  assert.deepEqual(agents.map((a) => a.model).sort(), ["other-model", "qwen-exact-id"]);
  assert.equal(new Set(agents.map((a) => a.id)).size, 2);
  assert.ok(agents.every((a) => a.local && a.auto && !a.repository && a.runner.type === "openai"));
  assert.ok(requests.every(({ url, init }) => url.endsWith("/models") && (!init?.method || init.method === "GET")));
  assert.ok(requests.every(({ init }) => !new Headers(init?.headers).has("authorization")));
  const again = await detectLocalOpenAIAgents({ env: { NINFER_URL: "http://127.0.0.1:8086/v1" }, fetch: fetcher });
  assert.deepEqual(again.map((a) => a.id), agents.map((a) => a.id));
});

test("a configured offline Qwen stays visible as disconnected while absent default services stay hidden", async () => {
  const fetcher: typeof fetch = async () => { throw new Error("offline"); };
  const agents = await detectLocalOpenAIAgents({ settings: qwenSettings, env: {}, fetch: fetcher });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].status, "server_off");
  assert.equal(agents[0].model, qwenSettings.model.name);
  assert.equal(agents[0].runner.type, "openai");
  assert.deepEqual(await detectLocalOpenAIAgents({ env: {}, fetch: fetcher }), []);
});

test("local endpoint auth and malformed model responses never become ready or expose response secrets", async () => {
  for (const status of [401, 403]) {
    const agents = await detectLocalOpenAIAgents({ settings: qwenSettings, env: {}, fetch: async () => Response.json({ error: { message: "secret-from-server" } }, { status }) });
    assert.ok(agents.length > 0);
    assert.ok(agents.every((a) => a.status === "not_logged_in"));
    assert.ok(agents.every((a) => !JSON.stringify(a.statusDetail).includes("secret-from-server")));
  }
  const malformed = await detectLocalOpenAIAgents({ settings: qwenSettings, env: {}, fetch: async () => Response.json({ data: [{ id: null }, {}] }) });
  assert.ok(malformed.every((a) => a.status !== "ready"));
});

test("saved Strata addresses override duplicate automatic endpoints and keep their own key and model", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const agents = await detectLocalOpenAIAgents({ env: {}, connections: [
    { id: "strata-connection", name: "Strata", baseUrl: "http://127.0.0.1:8080/v1", model: "qwen-strata", apiKey: "strata-local-key" },
  ], fetch: async (url, init) => {
    requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: [{ id: "other-model" }, { id: "qwen-strata" }] });
  } });
  assert.equal(requests.length, 1, "the default port is probed once");
  assert.equal(requests[0].authorization, "Bearer strata-local-key");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].title, "Strata");
  assert.equal(agents[0].model, "qwen-strata");
  assert.equal(agents[0].status, "ready");
  assert.equal(agents[0].local, true);
});

test("a missing saved model is reported without silently selecting a different model", async () => {
  const agents = await detectLocalOpenAIAgents({ env: { STRATA_URL: "http://127.0.0.1:8080/v1" }, connections: [
    { id: "strata-connection", name: "Strata", baseUrl: "http://127.0.0.1:8080/v1", model: "missing-model" },
  ], fetch: async () => Response.json({ data: [{ id: "other-model" }] }) });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].model, "missing-model");
  assert.equal(agents[0].status, "error");
});

test("saved private LAN endpoints are explicit while cloud URLs from Qwen settings are never probed", async () => {
  const requests: string[] = [];
  const agents = await detectLocalOpenAIAgents({ settings: { ...qwenSettings, model: { name: "cloud-model", baseUrl: "https://cloud.example/v1" } }, env: { NINFER_URL: "http://127.0.0.1:8086/v1" }, connections: [
    { id: "lan-strata", name: "Strata LAN", baseUrl: "http://192.168.1.20:8080/v1" },
  ], fetch: async (url) => {
    requests.push(String(url));
    return Response.json({ data: [{ id: "qwen-strata" }] });
  } });
  assert.ok(requests.includes("http://192.168.1.20:8080/v1/models"));
  assert.ok(requests.every((url) => !url.includes("cloud.example")));
  assert.ok(agents.some((a) => a.title === "Strata LAN" && a.local && a.status === "ready"));
});

test("separate saved models at one address keep both profiles and their own credentials", async () => {
  const requests: string[] = [];
  const agents = await detectLocalOpenAIAgents({ env: {}, connections: [
    { id: "model-profile-a", name: "NInfer A", baseUrl: "http://127.0.0.1:8080/v1", model: "model-a", apiKey: "key-a" },
    { id: "model-profile-b", name: "Strata B", baseUrl: "http://127.0.0.1:8080/v1", model: "model-b", apiKey: "key-b" },
  ], fetch: async (_url, init) => {
    requests.push(new Headers(init?.headers).get("authorization") || "");
    return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] });
  } });
  assert.deepEqual(agents.map((a) => a.title).sort(), ["NInfer A", "Strata B"]);
  assert.equal(new Set(agents.map((a) => a.id)).size, 2);
  assert.deepEqual(requests.sort(), ["Bearer key-a", "Bearer key-b"]);
  for (const agent of agents) {
    assert.equal(agent.runner.type, "openai");
    if (agent.runner.type === "openai") assert.equal(agent.runner.apiKey, agent.model === "model-a" ? "key-a" : "key-b");
  }
});

test("HTTP and streamed model errors redact the selected local key", async () => {
  const realFetch = globalThis.fetch;
  const secret = "local-secret-that-must-not-enter-session-events";
  const backend = createBackend({ type: "openai", baseUrl: "http://127.0.0.1:8086/v1", model: "qwen", apiKey: secret }, {} as any);
  const request = { system: "test", turns: [{ role: "user" as const, text: "test" }], lang: "en" as const, cwd: process.cwd(), signal: new AbortController().signal, onDelta: () => {} };
  try {
    for (const streamed of [false, true]) {
      globalThis.fetch = async () => streamed
        ? new Response(`data: ${JSON.stringify({ error: { message: `Invalid credential: ${secret}` } })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ error: { message: `Invalid credential: ${secret}` } }, { status: 401 });
      await assert.rejects(backend.chat(request), (error: any) => {
        assert.equal(error.message.includes(secret), false);
        assert.match(error.message, /\[redacted\]/);
        return true;
      });
    }
  } finally { globalThis.fetch = realFetch; }
});

test("the exact discovered model and its local key are used for streamed chat with separated reasoning", async () => {
  const requests: any[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") return void res.end(JSON.stringify({ data: [{ id: "qwen-ninfer-exact" }] }));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { reasoning_content: "private reasoning" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: "本地 Qwen 回复" } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as { port: number };
    const agents = await detectLocalOpenAIAgents({ env: { NINFER_URL: `http://127.0.0.1:${address.port}/v1`, NINFER_API_KEY: "selected-local-key" } });
    const backend = createBackend(agents[0].runner, {} as any);
    let delta = "", progress = "";
    const result = await backend.chat({ system: "You are a reviewer.", turns: [{ role: "user", text: "Review this draft." }], lang: "zh", cwd: process.cwd(), signal: new AbortController().signal, onDelta: (text) => { delta += text; }, onProgress: (value) => { progress = value.phase; } });
    assert.equal(result.text, "本地 Qwen 回复");
    assert.equal(delta, result.text);
    assert.equal(progress, "reasoning");
    assert.equal(result.model, "qwen-ninfer-exact");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/chat/completions");
    assert.equal(requests[0].authorization, "Bearer selected-local-key");
    assert.equal(requests[0].body.model, "qwen-ninfer-exact");
    assert.equal(requests[0].body.stream, true);
    assert.deepEqual(requests[0].body.messages.map((m: any) => m.role), ["system", "user"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
