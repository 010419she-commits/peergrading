// agents/media-openai.ts — OpenAI 图片（gpt-image-1）与视频（Sora 2）生成；兼容任何 OpenAI 格式的中转地址
import { httpFetch, describeFetchError } from "./http.ts";
import type { MediaProvider, MediaRequest, MediaResult } from "./media.ts";

const IMAGE_SIZE: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536" };
const VIDEO_SIZE: Record<string, string> = { "1:1": "1280x720", "16:9": "1280x720", "9:16": "720x1280" };
const VIDEO_SECONDS = [4, 8, 12];
const POLL_MS = Number(process.env.MEDIA_VIDEO_POLL_MS || 5000);
const VIDEO_MAX_WAIT_MS = Number(process.env.MEDIA_VIDEO_MAX_WAIT_MS || 20 * 60 * 1000);

export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("已取消"));
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error("已取消")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

export interface OpenAIMediaConfig { apiKey: string; baseUrl: string; imageModel: string; videoModel: string }

export class OpenAIMediaProvider implements MediaProvider {
  id = "openai"; label = "OpenAI";
  private c: OpenAIMediaConfig;
  constructor(c: OpenAIMediaConfig) { this.c = c; }
  private get base() { return this.c.baseUrl.replace(/\/+$/, ""); }
  private headers(json = true) { return { Authorization: `Bearer ${this.c.apiKey}`, ...(json ? { "Content-Type": "application/json" } : {}) }; }

  private async readJson(r: { ok: boolean; status: number; statusText: string; json(): Promise<any>; text(): Promise<string> }, what: string): Promise<any> {
    let body: any = null, raw = "";
    try { raw = await r.text(); body = raw ? JSON.parse(raw) : null; } catch {}
    if (!r.ok) {
      const msg = body?.error?.message || body?.message || raw.slice(0, 300) || r.statusText;
      if (r.status === 401) throw new Error(`API Key 无效或已过期（${what}：401）`);
      if (r.status === 403) throw new Error(`没有权限使用该模型或接口（${what}：403 ${msg}）`);
      if (r.status === 429) throw new Error(`请求过多或额度不足（${what}：429 ${msg}）`);
      throw new Error(`${what}失败：${r.status} ${msg}`);
    }
    return body ?? {};
  }
  private async call(path: string, init: Parameters<typeof httpFetch>[1], what: string) {
    try { return await httpFetch(`${this.base}${path}`, init); }
    catch (e) { throw new Error(`${what}：${describeFetchError(e)}`); }
  }

  async generate(req: MediaRequest): Promise<MediaResult> {
    return req.kind === "image" ? this.image(req) : this.video(req);
  }

  async image(req: MediaRequest): Promise<MediaResult> {
    const body: any = { model: this.c.imageModel, prompt: req.prompt, n: 1, size: IMAGE_SIZE[req.aspect] || "1024x1024" };
    if (req.quality && req.quality !== "auto") body.quality = req.quality;
    const r = await this.call("/images/generations", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: 5 * 60 * 1000 }, "生成图片");
    const j = await this.readJson(r, "生成图片");
    const d = j.data?.[0];
    if (!d) throw new Error("生成图片失败：服务没有返回图片");
    let bytes: Buffer;
    if (typeof d.b64_json === "string" && d.b64_json) bytes = Buffer.from(d.b64_json, "base64");
    else if (typeof d.url === "string" && /^https?:\/\//.test(d.url)) {
      let dl;
      try { dl = await httpFetch(d.url, { signal: req.signal, timeoutMs: 120000 }); } catch (e) { throw new Error(`下载图片：${describeFetchError(e)}`); }
      if (!dl.ok) throw new Error(`下载图片失败：${dl.status}`);
      bytes = Buffer.from(await dl.arrayBuffer());
    } else throw new Error("生成图片失败：返回格式无法识别");
    const kind = sniffImage(bytes);
    if (!kind) throw new Error("生成图片失败：返回的数据不是图片");
    return { bytes, mime: kind.mime, ext: kind.ext, model: this.c.imageModel, revisedPrompt: typeof d.revised_prompt === "string" ? d.revised_prompt : undefined };
  }

  async video(req: MediaRequest): Promise<MediaResult> {
    const seconds = VIDEO_SECONDS.includes(req.seconds) ? req.seconds : 8;
    const body = { model: this.c.videoModel, prompt: req.prompt, size: VIDEO_SIZE[req.aspect] || "1280x720", seconds: String(seconds) };
    const created = await this.call("/videos", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: 120000 }, "创建视频任务");
    let job = await this.readJson(created, "创建视频任务");
    if (!job?.id) throw new Error("创建视频任务失败：服务没有返回任务 ID");
    const started = Date.now();
    while (!["completed", "failed", "cancelled"].includes(String(job.status))) {
      if (Date.now() - started > VIDEO_MAX_WAIT_MS) throw new Error("生成视频超时");
      await sleep(POLL_MS, req.signal);
      const p = await this.call(`/videos/${encodeURIComponent(job.id)}`, { headers: this.headers(false), signal: req.signal, timeoutMs: 60000 }, "查询视频任务");
      job = await this.readJson(p, "查询视频任务");
      req.onProgress?.({ status: String(job.status || ""), percent: typeof job.progress === "number" ? job.progress : undefined });
    }
    if (job.status !== "completed") throw new Error(`生成视频失败：${job.error?.message || job.status}`);
    const c = await this.call(`/videos/${encodeURIComponent(job.id)}/content`, { headers: this.headers(false), signal: req.signal, timeoutMs: 10 * 60 * 1000 }, "下载视频");
    if (!c.ok) { await this.readJson(c, "下载视频"); throw new Error("下载视频失败"); }
    const bytes = Buffer.from(await c.arrayBuffer());
    if (!bytes.length) throw new Error("下载视频失败：内容为空");
    const mime = c.headers.get("content-type")?.split(";")[0] || "video/mp4";
    return { bytes, mime, ext: /webm/.test(mime) ? "webm" : "mp4", model: this.c.videoModel };
  }
}
