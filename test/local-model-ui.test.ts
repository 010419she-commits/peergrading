import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { localEntries } from "../agents/detect.ts";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("local model panel prioritizes automatic discovery and keeps manual settings advanced", () => {
  const html = read("views/app.html");
  assert.match(html, /<details class="local-models" id="local-models" hidden open>/);
  assert.match(html, /id="local-model-auto-status"/);
  assert.match(html, /<details id="local-model-manual">/);
  assert.ok(html.indexOf("local-model-auto-status") < html.indexOf("local-model-manual"));

  const app = read("public/app.js");
  assert.match(app, /agent\.kind === "local" && agent\.status === "ready"/);
  assert.match(app, /t\("localModelsDetected"\)/);
  assert.match(app, /t\("localModelsStartRequired"\)/);

  const i18n = read("public/i18n.js");
  assert.match(i18n, /无需填写接口地址或连接名称/);
  assert.match(i18n, /请先启动 Ollama 或 LM Studio/);
  assert.match(i18n, /No base URL or connection name is required/);
  assert.match(i18n, /Start Ollama or LM Studio and load a model first/);
});

test("offline local model entries explain that the service and model must be started first", () => {
  const [agent] = localEntries({ service: "ollama", title: "Ollama", baseUrl: "http://localhost:11434/v1", apiKey: "ollama", up: false, models: ["qwen-test"], installed: true }, null);
  assert.equal(agent.status, "server_off");
  assert.equal(agent.service, "ollama");
  const detail = agent.statusDetail as { zh: string; en: string };
  assert.match(detail.zh, /请先启动 Ollama/);
  assert.match(detail.zh, /加载本地大模型/);
  assert.match(detail.en, /Start Ollama/);
  assert.match(detail.en, /load a local model/);
  assert.equal(agent.runner.type, "openai");
});
