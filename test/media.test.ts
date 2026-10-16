// test/media.test.ts — 协作中的图片 / 视频生成：围栏解析、生成流水线（限额、缓存、失败替换）、OpenAI 接口（本地假服务）、设置存取
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { parseMediaFences, processMedia, newMediaRun, loadMediaSettings, saveMediaSettings, publicMediaSettings, MEDIA_LIMITS, MEDIA_FILE_RE, type MediaProvider, type MediaRequest } from "../agents/media.ts";
import { OpenAIMediaProvider } from "../agents/media-openai.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-media-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("围栏解析：识别 image / video 与参数，忽略其他语言、嵌套与未闭合围栏", () => {
  const text = [
    "开头说明", "```image aspect=16:9 quality=high", "一只橘猫坐在窗台上看雨", "水彩风格", "```", "中间",
    "```python title=a.py", "print('```image 不是围栏')", "```",
    "````markdown", "```image", "嵌套在四反引号里，不算", "```", "````",
    "```video seconds=12 aspect=9:16", "镜头缓慢推进", "```",
    "```video", "```",            // 空描述：忽略
    "```image", "未闭合的围栏",
  ].join("\n");
  const f = parseMediaFences(text);
  assert.equal(f.length, 2);
  assert.equal(f[0].kind, "image"); assert.equal(f[0].prompt, "一只橘猫坐在窗台上看雨\n水彩风格"); assert.equal(f[0].aspect, "16:9"); assert.equal(f[0].quality, "high");
  assert.equal(text.slice(f[0].start, f[0].end), "```image aspect=16:9 quality=high\n一只橘猫坐在窗台上看雨\n水彩风格\n```");
  assert.equal(f[1].kind, "video"); assert.equal(f[1].seconds, 12); assert.equal(f[1].aspect, "9:16"); assert.equal(f[1].quality, "auto");
  assert.equal(text.slice(f[1].start, f[1].end), "```video seconds=12 aspect=9:16\n镜头缓慢推进\n```");
  // 默认值：图 1:1，视频 16:9 / 8 秒；seconds 取最近的 4 的倍数并限制在 4–12
  const d = parseMediaFences("```image\nx\n```\n```video seconds=5\ny\n```\n```video seconds=99\nz\n```");
  assert.equal(d[0].aspect, "1:1"); assert.equal(d[1].aspect, "16:9"); assert.equal(d[1].seconds, 4); assert.equal(d[2].seconds, 12);
  assert.equal(parseMediaFences("没有围栏").length, 0);
});

function fakeProvider(opts: { fail?: (req: MediaRequest) => string | null; delayMs?: number } = {}) {
  const calls: MediaRequest[] = [];
  const p: MediaProvider & { calls: MediaRequest[] } = {
    id: "fake", label: "Fake", calls,
    async generate(req) {
      calls.push(req);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const err = opts.fail?.(req); if (err) throw new Error(err);
      return req.kind === "image" ? { bytes: PNG, mime: "image/png", ext: "png", model: "fake-img" } : { bytes: Buffer.from("MP4"), mime: "video/mp4", ext: "mp4", model: "fake-vid" };
    },
  };
  return p;
}

test("生成流水线：替换为 media:// 引用、落盘、事件顺序、相同描述复用、失败与关闭时的提示", async () => {
  const dir = path.join(tmp, "run1"), events: any[] = [];
  const provider = fakeProvider({ fail: (r) => (r.prompt.includes("坏") ? "模拟失败" : null) });
  const run = newMediaRun(provider, dir, "zh", new AbortController().signal, { images: true, videos: false });
  const text = "说明\n\n<deliverable>\n# 海报\n\n```image aspect=16:9\n一只橘猫 [看雨] (水彩)\n```\n\n```image\n坏图\n```\n\n```video\n一段视频\n```\n</deliverable>\n结尾";
  const out = await processMedia(text, run, "A-0-draft", (e) => events.push(e));
  assert.equal(run.records.length, 1);
  const rec = run.records[0];
  assert.match(rec.file, MEDIA_FILE_RE);
  assert.ok(fs.existsSync(path.join(dir, rec.file)));
  assert.ok(out.includes(`![一只橘猫 ［看雨］ （水彩）](media://${rec.file})`), out);
  assert.ok(out.includes("> ⚠️ 图片生成失败：模拟失败\n> 描述：坏图"), out);
  assert.ok(out.includes("> ⚠️ 视频生成未开启，未生成。\n> 描述：一段视频"), out);
  assert.ok(out.startsWith("说明\n\n<deliverable>\n# 海报\n\n![") && out.endsWith("\n</deliverable>\n结尾"), out);
  assert.deepEqual(events.map((e) => e.type), ["media_start", "media_start", "media_end", "media_end"]);
  assert.ok(events.every((e) => e.id === "A-0-draft"));
  const ok = events.find((e) => e.type === "media_end" && e.ok), bad = events.find((e) => e.type === "media_end" && !e.ok);
  assert.equal(ok.file, rec.file); assert.equal(bad.error, "模拟失败");
  // 第二条消息里同样的描述：复用，不再调用服务，不发事件
  const n = provider.calls.length;
  const out2 = await processMedia("```image aspect=16:9\n一只橘猫 [看雨] (水彩)\n```", run, "B-1-revision", (e) => events.push(e));
  assert.equal(out2, `![一只橘猫 ［看雨］ （水彩）](media://${rec.file})`);
  assert.equal(provider.calls.length, n); assert.equal(events.length, 4);
  // 没有围栏：原文返回
  assert.equal(await processMedia("plain", run, "x", () => {}), "plain");
});

test("限额：每条消息最多 3 张图 / 1 个视频；每次协作最多 MEDIA_MAX_IMAGES / MEDIA_MAX_VIDEOS；英文提示", async () => {
  const provider = fakeProvider();
  const run = newMediaRun(provider, path.join(tmp, "run2"), "en", new AbortController().signal, { images: true, videos: true });
  const img = (i: number) => "```image\npic " + i + "\n```";
  const out = await processMedia([img(1), img(2), img(3), img(4), "```video\nv1\n```", "```video\nv2\n```"].join("\n"), run, "m1", () => {});
  assert.equal(provider.calls.filter((c) => c.kind === "image").length, 3);
  assert.equal(provider.calls.filter((c) => c.kind === "video").length, 1);
  assert.ok(out.includes("> ⚠️ At most 3 images per message; not generated here.\n> Prompt: pic 4"), out);
  assert.ok(out.includes("> ⚠️ At most 1 videos per message; not generated here.\n> Prompt: v2"), out);
  // 用完本次协作的额度
  const more: string[] = []; for (let i = 5; i < 5 + MEDIA_LIMITS.perRunImages; i++) more.push(img(i));
  for (let i = 0; i < more.length; i += 3) await processMedia(more.slice(i, i + 3).join("\n"), run, "m" + i, () => {});
  const over = await processMedia(img(99), run, "last", () => {});
  assert.ok(over.includes(`At most ${MEDIA_LIMITS.perRunImages} images per run; limit reached`), over);
  assert.equal(run.used.images >= MEDIA_LIMITS.perRunImages, true);
});

test("OpenAI 接口：生图（b64）、生视频（排队 → 完成 → 下载）、错误码翻译", async () => {
  const log: string[] = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      log.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      const json = (code: number, obj: any) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== "Bearer sk-test") return json(401, { error: { message: "Incorrect API key provided" } });
      if (req.url === "/v1/images/generations") {
        const b = JSON.parse(body);
        if (b.prompt === "nope") return json(400, { error: { message: "Your request was rejected" } });
        return json(200, { created: 1, data: [{ b64_json: PNG.toString("base64"), revised_prompt: "revised " + b.prompt }], output_format: "png", size: b.size, quality: b.quality });
      }
      if (req.url === "/v1/videos" && req.method === "POST") { const b = JSON.parse(body); log.push(`video:${b.size}:${b.seconds}:${b.model}`); return json(200, { id: "video_1", status: "queued", progress: 0 }); }
      if (req.url === "/v1/videos/video_1") { polls++; return json(200, { id: "video_1", status: polls < 2 ? "in_progress" : "completed", progress: polls < 2 ? 50 : 100 }); }
      if (req.url === "/v1/videos/video_1/content") { res.writeHead(200, { "content-type": "video/mp4" }); return res.end(Buffer.from("FAKEMP4")); }
      json(404, { error: { message: "no route " + req.url } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/v1/`;   // 末尾斜杠应被容忍
  try {
    const p = new OpenAIMediaProvider({ apiKey: "sk-test", baseUrl: base, imageModel: "gpt-image-1", videoModel: "sora-2" });
    const img = await p.generate({ kind: "image", prompt: "a cat", aspect: "16:9", seconds: 8, quality: "high" });
    assert.equal(img.ext, "png"); assert.equal(img.mime, "image/png"); assert.ok(img.bytes.equals(PNG)); assert.equal(img.revisedPrompt, "revised a cat");
    assert.ok(log.some((l) => l.startsWith("POST /v1/images/generations Bearer sk-test")));
    const progress: any[] = [];
    process.env.MEDIA_VIDEO_POLL_MS = "10";
    const vid = await p.generate({ kind: "video", prompt: "a dog", aspect: "9:16", seconds: 12, quality: "auto", onProgress: (x) => progress.push(x) });
    assert.equal(vid.ext, "mp4"); assert.equal(vid.bytes.toString(), "FAKEMP4");
    assert.ok(log.includes("video:720x1280:12:sora-2"), log.join("\n"));
    assert.ok(progress.length >= 1 && progress.at(-1).status === "completed");
    await assert.rejects(p.generate({ kind: "image", prompt: "nope", aspect: "1:1", seconds: 8, quality: "auto" }), /生成图片失败：400 Your request was rejected/);
    const bad = new OpenAIMediaProvider({ apiKey: "sk-wrong", baseUrl: base, imageModel: "gpt-image-1", videoModel: "sora-2" });
    await assert.rejects(bad.generate({ kind: "image", prompt: "x", aspect: "1:1", seconds: 8, quality: "auto" }), /API Key 无效/);
    const free = http.createServer(); await new Promise<void>((r) => free.listen(0, "127.0.0.1", () => r())); const freePort = (free.address() as any).port; await new Promise<void>((r) => free.close(() => r()));
    const dead = new OpenAIMediaProvider({ apiKey: "sk-test", baseUrl: `http://127.0.0.1:${freePort}/v1`, imageModel: "gpt-image-1", videoModel: "sora-2" });
    await assert.rejects(dead.generate({ kind: "image", prompt: "x", aspect: "1:1", seconds: 8, quality: "auto" }), /无法连接/);
  } finally { server.close(); }
});

test("设置：环境变量为缺省，保存后覆盖；公开视图不含密钥；空串清除密钥", () => {
  const dir = path.join(tmp, "settings");
  process.env.MEDIA_API_KEY = "sk-env-1234567890";
  let s = loadMediaSettings(dir);
  assert.equal(s.apiKey, "sk-env-1234567890"); assert.equal(s.baseUrl, "https://api.openai.com/v1"); assert.equal(s.imageModel, "gpt-image-1"); assert.equal(s.videoModel, "sora-2"); assert.equal(s.images, true);
  s = saveMediaSettings(dir, { apiKey: "sk-saved-abcdefghij", baseUrl: "https://relay.example.com/v1/", videos: false, imageModel: "" });
  assert.equal(s.apiKey, "sk-saved-abcdefghij"); assert.equal(s.baseUrl, "https://relay.example.com/v1"); assert.equal(s.videos, false); assert.equal(s.imageModel, "gpt-image-1");
  assert.equal((fs.statSync(path.join(dir, "media.json")).mode & 0o777), 0o600);
  const pub = publicMediaSettings(loadMediaSettings(dir));
  assert.equal(pub.configured, true); assert.equal(pub.keyHint, "sk-sa…ghij"); assert.equal(JSON.stringify(pub).includes("sk-saved-abcdefghij"), false);
  s = saveMediaSettings(dir, { apiKey: "", baseUrl: "not a url" });
  assert.equal(s.apiKey, ""); assert.equal(s.baseUrl, "https://api.openai.com/v1");
  assert.equal(publicMediaSettings(s).configured, false);
  delete process.env.MEDIA_API_KEY;
});
