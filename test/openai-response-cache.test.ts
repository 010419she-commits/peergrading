import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createBackend } from "../agents/backends.ts";
import { clearOpenAIResponseCache } from "../acceleration.ts";
import type { ChatRequest, RunnerSpec } from "../agents/types.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
async function endpoint(handler: Handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const { port } = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: async () => {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}
function backend(baseUrl: string, options: Partial<Extract<RunnerSpec, { type: "openai" }>> = {}) {
  return createBackend({ type: "openai", baseUrl, model: "cache-model", apiKey: "fixture-cache-key", ...options }, { emit: () => {} });
}
function request(options: Partial<ChatRequest> = {}): ChatRequest {
  return { system: "Review exactly", turns: [{ role: "user", text: "Same input" }], lang: "en", cwd: process.cwd(), signal: new AbortController().signal, onDelta: () => {}, cache: true, ...options };
}
const event = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const choice = (content: unknown, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] });
function complete(res: ServerResponse, text = "Cached answer", reasoning = "private cache reasoning") {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(event({ model: "provider-cache-model", choices: [{ delta: { reasoning_content: reasoning } }] })
    + event(choice(text.slice(0, 3))) + event(choice(text.slice(3), "stop"))
    + event({ usage: { prompt_tokens: 7, completion_tokens: 4 } }) + "data: [DONE]\n\n");
}

beforeEach(() => clearOpenAIResponseCache());

test("successful responses replay deltas and private protocol data with cacheHit; the default still bypasses cache", async () => {
  let calls = 0;
  const server = await endpoint((_req, res) => { calls++; complete(res); });
  try {
    const api = backend(server.baseUrl);
    const firstDeltas: string[] = [], hitDeltas: string[] = [];
    const first = await api.chat(request({ onDelta: (text) => firstDeltas.push(text) }));
    const hit = await api.chat(request({ onDelta: (text) => hitDeltas.push(text) }));
    assert.equal(calls, 1);
    assert.equal(first.cacheHit, undefined);
    assert.equal(hit.cacheHit, true);
    assert.deepEqual(hitDeltas, firstDeltas);
    assert.equal(hitDeltas.join(""), "Cached answer");
    assert.deepEqual(hit.apiMessage, first.apiMessage);
    assert.deepEqual(hit.usage, { input: 7, output: 4 });
    assert.equal(hit.model, "provider-cache-model");

    const uncached = await api.chat(request({ cache: false }));
    assert.equal(calls, 2);
    assert.equal(uncached.cacheHit, undefined);
  } finally { await server.close(); }
});

test("cache keys isolate connection, model, credential namespace and every effective wire message", async () => {
  let firstCalls = 0, secondCalls = 0;
  const firstServer = await endpoint((_req, res) => { firstCalls++; complete(res); });
  const secondServer = await endpoint((_req, res) => { secondCalls++; complete(res); });
  try {
    await backend(firstServer.baseUrl).chat(request());
    await backend(firstServer.baseUrl).chat(request());
    assert.equal(firstCalls, 1);

    await backend(firstServer.baseUrl, { apiKey: "another-fixture-key" }).chat(request());
    assert.equal(firstCalls, 2, "a different API key namespace must not share entries");
    await backend(firstServer.baseUrl, { model: "another-model" }).chat(request());
    assert.equal(firstCalls, 3, "a different model must not share entries");
    await backend(secondServer.baseUrl).chat(request());
    assert.equal(secondCalls, 1, "a different connection must not share entries");

    await backend(firstServer.baseUrl).chat(request({ system: "Different system" }));
    assert.equal(firstCalls, 4);
    await backend(firstServer.baseUrl).chat(request({ turns: [{ role: "user", text: "Different user" }] }));
    assert.equal(firstCalls, 5);
    const history = (reasoning: string) => [
      { role: "user" as const, text: "Earlier" },
      { role: "assistant" as const, text: "Visible", apiMessage: { role: "assistant" as const, content: "Visible", reasoning_content: reasoning } },
      { role: "user" as const, text: "Same input" },
    ];
    await backend(firstServer.baseUrl).chat(request({ turns: history("reasoning one") }));
    await backend(firstServer.baseUrl).chat(request({ turns: history("reasoning two") }));
    assert.equal(firstCalls, 7, "private reasoning affects the actual wire body and therefore the key");
  } finally { await firstServer.close(); await secondServer.close(); }
});

test("TTL, explicit invalidation and LRU eviction only affect reuse, never responses", async () => {
  let calls = 0;
  const server = await endpoint((_req, res) => { calls++; complete(res); });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const spec = { type: "openai" as const, baseUrl: server.baseUrl, model: "cache-model", apiKey: "fixture-cache-key" };
    const api = backend(server.baseUrl);
    await api.chat(request());
    now += 299_999;
    assert.equal((await api.chat(request())).cacheHit, true);
    assert.equal(calls, 1);
    now += 1;
    assert.equal((await api.chat(request())).cacheHit, undefined);
    assert.equal(calls, 2);
    clearOpenAIResponseCache(spec);
    await api.chat(request());
    assert.equal(calls, 3);

    clearOpenAIResponseCache();
    for (let index = 0; index < 129; index++) {
      await api.chat(request({ turns: [{ role: "user", text: `entry-${index}` }] }));
    }
    const filled = calls;
    await api.chat(request({ turns: [{ role: "user", text: "entry-0" }] }));
    assert.equal(calls, filled + 1, "the oldest entry was evicted after 128 entries");
    assert.equal((await api.chat(request({ turns: [{ role: "user", text: "entry-128" }] }))).cacheHit, true);
    assert.equal(calls, filled + 1, "the newest entry remains usable");
  } finally { Date.now = realNow; await server.close(); }
});

test("cancellation, timeout, stream errors and empty responses are never cached", async () => {
  for (const scenario of ["cancellation", "timeout", "stream-error", "empty"] as const) {
    let calls = 0;
    const server = await endpoint((_req, res) => {
      calls++;
      if (calls > 1) { complete(res, `Recovered ${scenario}`); return; }
      if (scenario === "cancellation") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(event(choice("partial")));
      } else if (scenario === "stream-error") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(event(choice("partial")) + 'event: error\ndata: {"message":"fixture stream failure"}\n\n');
      } else if (scenario === "empty") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end("data: [DONE]\n\n");
      }
    });
    try {
      const api = backend(server.baseUrl, { timeoutMs: 60 });
      const controller = new AbortController();
      await assert.rejects(api.chat(request({
        signal: controller.signal,
        onDelta: scenario === "cancellation" ? () => controller.abort() : () => {},
      })));
      assert.equal(calls, 1);
      const recovered = await api.chat(request());
      assert.equal(recovered.text, `Recovered ${scenario}`);
      assert.equal(calls, 2, `${scenario}: recovery must make a fresh request`);
      assert.equal((await api.chat(request())).cacheHit, true);
      assert.equal(calls, 2, `${scenario}: only the complete recovery may be replayed`);
    } finally { await server.close(); }
  }
});
