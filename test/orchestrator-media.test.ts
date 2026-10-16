// test/orchestrator-media.test.ts — 协作循环接入图片 / 视频生成：提示词规则、围栏替换进入对方上下文与成果版本、事件与记录
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCollaboration, type RunConfig, type Event } from "../orchestrator.ts";
import type { Backend, ChatRequest } from "../agents/types.ts";
import type { MediaProvider, MediaRequest } from "../agents/media.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-orch-media-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const agent = (name: string) => ({ name, persona: "", agent: { id: name, kind: "api", title: name, subtitle: "", model: "fake", local: true, status: "ready", auto: true, runner: { type: "anthropic", model: "fake", effort: "low" }, icon: "" } as any });
function fakeBackend(reply: (req: ChatRequest) => string): Backend & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  // turns 数组会被协作循环继续追加，这里拍快照以便断言"审查者看到了什么"
  return { seen, async chat(req) { seen.push({ ...req, turns: req.turns.map((t) => ({ ...t })) }); const text = reply(req); req.onDelta(text); return { text, model: "fake" }; } };
}
function fakeProvider() {
  const calls: MediaRequest[] = [];
  const p: MediaProvider & { calls: MediaRequest[] } = { id: "fake", label: "Fake", calls, async generate(req) { calls.push(req); return { bytes: PNG, mime: "image/png", ext: "png", model: "fake-image" }; } };
  return p;
}
const DRAFT = "思路说明。\n\n<deliverable>\n# 海报方案\n\n```image aspect=16:9 quality=high\n一只橘猫坐在窗台上看雨，水彩风格\n```\n\n正文。\n</deliverable>";

test("开启媒体生成：提示词带第 6 条规则，围栏被替换为 media:// 引用后进入审查者上下文与成果版本", async () => {
  const provider = fakeProvider();
  const A = fakeBackend(() => DRAFT);
  const B = fakeBackend(() => "看过了，配图合适。\n【结论】通过");
  const cfg: RunConfig = { task: "做一张海报", lang: "zh", cwd: tmp, agentA: agent("甲"), agentB: agent("乙"), maxRounds: 2, discussionTurns: 1,
    media: { provider, dir: path.join(tmp, "media"), images: true, videos: false } };
  const events: Event[] = [];
  const r = await runCollaboration(cfg, (e) => events.push(e), new AbortController().signal, { A, B });

  // 提示词：两位都拿到规则 6；视频未开启有说明
  for (const be of [A, B]) { assert.match(be.seen[0].system, /6\. 成果需要图片时/); assert.match(be.seen[0].system, /```image aspect=16:9/); assert.match(be.seen[0].system, /视频生成未开启/); assert.doesNotMatch(be.seen[0].system, /```video seconds/); }
  // 生成了一张图，文件落在会话媒体目录
  assert.equal(provider.calls.length, 1); assert.equal(provider.calls[0].aspect, "16:9"); assert.equal(provider.calls[0].quality, "high");
  assert.equal(r.media.length, 1); assert.equal(r.media[0].kind, "image"); assert.match(r.media[0].file, /^m1-[a-f0-9]{6}\.png$/);
  assert.ok(fs.existsSync(path.join(tmp, "media", r.media[0].file)));
  const ref = `![一只橘猫坐在窗台上看雨，水彩风格](media://${r.media[0].file})`;
  // 审查者看到的是引用而不是围栏；成果版本同样
  const reviewPrompt = B.seen[0].turns.at(-1)!.text;
  assert.ok(reviewPrompt.includes(ref), "审查提示里是 media:// 引用"); assert.doesNotMatch(reviewPrompt, /```image/);
  assert.ok(r.versions[0].content.includes(ref)); assert.doesNotMatch(r.versions[0].content, /```image/);
  // 事件：media_start / media_end 挂在作者消息上；message_end 带替换后的正文
  const start = events.find((e) => e.type === "media_start") as any, end = events.find((e) => e.type === "media_end") as any;
  const msgStart = events.find((e) => e.type === "message_start") as any;
  assert.ok(start && end); assert.equal(start.id, msgStart.id); assert.equal(end.ok, true); assert.equal(end.file, r.media[0].file);
  const msgEnd = events.find((e) => e.type === "message_end" && (e as any).id === msgStart.id) as any;
  assert.ok(msgEnd.text.includes(ref));
  // 作者自己的历史里也是替换后的正文（下一轮不会再生成同一张）
  assert.equal(r.approved, true); assert.equal(r.media[0].msgId, msgStart.id);
});

test("未开启媒体生成：提示词没有规则 6，围栏原样保留，无媒体事件", async () => {
  const A = fakeBackend(() => DRAFT), B = fakeBackend(() => "【结论】通过");
  const cfg: RunConfig = { task: "做一张海报", lang: "en", cwd: tmp, agentA: agent("A"), agentB: agent("B"), maxRounds: 1, discussionTurns: 1 };
  const events: Event[] = [];
  const r = await runCollaboration(cfg, (e) => events.push(e), new AbortController().signal, { A, B });
  assert.doesNotMatch(A.seen[0].system, /media:\/\//);
  assert.ok(B.seen[0].turns.at(-1)!.text.includes("```image aspect=16:9"));
  assert.equal(events.some((e) => e.type.startsWith("media_")), false);
  assert.equal((events.find((e) => e.type === "message_end") as any).text, undefined);
  assert.deepEqual(r.media, []);
});

test("只开视频不开图片：图片围栏替换为说明，不调用生成；英文规则正确", async () => {
  const provider = fakeProvider();
  const A = fakeBackend(() => DRAFT), B = fakeBackend(() => "VERDICT: APPROVE");
  const cfg: RunConfig = { task: "poster", lang: "en", cwd: tmp, agentA: agent("A"), agentB: agent("B"), maxRounds: 1, discussionTurns: 1,
    media: { provider, dir: path.join(tmp, "media2"), images: false, videos: true } };
  const r = await runCollaboration(cfg, () => {}, new AbortController().signal, { A, B });
  assert.match(A.seen[0].system, /6\. When the deliverable needs a video/); assert.match(A.seen[0].system, /```video seconds=8/); assert.match(A.seen[0].system, /Image generation is off/);
  assert.equal(provider.calls.length, 0); assert.deepEqual(r.media, []);
  assert.match(r.versions[0].content, /> ⚠️ image generation is off/); assert.doesNotMatch(r.versions[0].content, /```image/);
});
