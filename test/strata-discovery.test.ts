import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLocalOpenAIAgents } from "../agents/local.ts";

test("default compatible discovery identifies Strata from its local health response", async () => {
  const requests: string[] = [];
  const agents = await detectLocalOpenAIAgents({ env: {}, fetch: async (url, init) => {
    const href = String(url);
    requests.push(href);
    assert.ok(!init?.method || init.method === "GET");
    if (href === "http://127.0.0.1:8080/health") return Response.json({ service: "strata", loaded: true });
    if (href === "http://127.0.0.1:8080/v1/models") return Response.json({ data: [{ id: "qwen-strata" }] });
    throw new Error(`unexpected request ${href}`);
  } });
  assert.deepEqual(requests, ["http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/health"]);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].title, "Strata");
  assert.equal(agents[0].model, "qwen-strata");
  assert.equal(agents[0].status, "ready");
});

test("health identification failure keeps compatible discovery working", async () => {
  const agents = await detectLocalOpenAIAgents({ env: {}, fetch: async (url) => {
    const href = String(url);
    if (href === "http://127.0.0.1:8080/health") throw new Error("unknown health endpoint");
    if (href === "http://127.0.0.1:8080/v1/models") return Response.json({ data: [{ id: "compatible-model" }] });
    throw new Error(`unexpected request ${href}`);
  } });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].title, "NInfer / Strata");
  assert.equal(agents[0].model, "compatible-model");
  assert.equal(agents[0].status, "ready");
});

test("Qwen-configured Strata is still identified by its service name", async () => {
  const settings = {
    security: { auth: { selectedType: "openai" } },
    model: { name: "qwen-strata", baseUrl: "http://127.0.0.1:8080/v1" },
    modelProviders: { openai: [{ id: "qwen-strata", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "local-test-key" }] },
  };
  const agents = await detectLocalOpenAIAgents({ settings, env: {}, fetch: async (url) => {
    const href = String(url);
    if (href === "http://127.0.0.1:8080/health") return Response.json({ service: "strata", loaded: true });
    if (href === "http://127.0.0.1:8080/v1/models") return Response.json({ data: [{ id: "qwen-strata" }] });
    throw new Error(`unexpected request ${href}`);
  } });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].title, "Strata");
  assert.equal(agents[0].model, "qwen-strata");
  assert.equal(agents[0].status, "ready");
  assert.equal(agents[0].runner.type, "openai");
  if (agents[0].runner.type === "openai") assert.equal(agents[0].runner.apiKey, "local-test-key");
});
