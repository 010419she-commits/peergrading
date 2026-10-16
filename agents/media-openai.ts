// agents/media-openai.ts — OpenAI 图片（gpt-image-1）与视频（Sora 2）生成；兼容任何 OpenAI 格式的中转地址。错误只带错误码，文案由 media.ts 按语言生成
import { httpFetch, fetchErrorCode, fetchErrorDetail, readBody } from "./http.ts";
import { MediaError, envInt } from "./media-common.ts";
import type { MediaProvider, MediaRequest, MediaResult } from "./media.ts";

const IMAGE_SIZE: Record<string, string> = { "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536" };
const VIDEO_SIZE: Record<string, string> = { "1:1": "1280x720", "16:9": "1280x720", "9:16": "720x1280" };
const VIDEO_SECONDS = [4, 8, 12];
// 每次生成时读取，便于运行中调整与测试覆盖
const pollMs = () => envInt(process.env.MEDIA_VIDEO_POLL_MS, 5000, 10);
const videoMaxWaitMs = () => envInt(process.env.MEDIA_VIDEO_MAX_WAIT_MS, 20 * 60 * 1000, 10_000);
/** 响应体上限：JSON（含 base64 图片）64 MB、图片文件 50 MB、视频文件 512 MB */
const MAX_JSON = 64 * 1024 * 1024, MAX_IMAGE = 50 * 1024 * 1024, MAX_VIDEO = 512 * 1024 * 1024;

export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  return null;
}
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(new MediaError("aborted"));
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new MediaError("aborted")); };
  signal?.addEventListener("abort", onAbort, { once: true });
});
const upstreamMessage = (body: any, raw: string) => {
  const m = body?.error?.message ?? body?.message;
  return typeof m === "string" ? m : raw.slice(0, 200);
};

export interface OpenAIMediaConfig { apiKey: string; baseUrl: string; imageModel: string; videoModel: string }

export class OpenAIMediaProvider implements MediaProvider {
  id = "openai"; label = "OpenAI";
  private c: OpenAIMediaConfig;
  constructor(c: OpenAIMediaConfig) { this.c = c; }
  private get base() { return this.c.baseUrl.replace(/\/+$/, ""); }
  private headers(json = true) { return { Authorization: `Bearer ${this.c.apiKey}`, ...(json ? { "Content-Type": "application/json" } : {}) }; }

  private async readJson(r: Awaited<ReturnType<typeof httpFetch>>, step: string): Promise<any> {
    let body: any = null, raw = "";
    try { raw = (await readBody(r, MAX_JSON)).toString("utf8"); } catch (e) { if (e instanceof MediaError) throw e; }
    try { body = raw ? JSON.parse(raw) : null; } catch {}
    if (!r.ok) {
      const detail = `${step} ${r.status}: ${upstreamMessage(body, raw)}`;
      if (r.status === 401) throw new MediaError("unauthorized", { status: 401, detail: step });
      if (r.status === 403) throw new MediaError("forbidden", { status: 403, detail });
      if (r.status === 429) throw new MediaError("rate_limited", { status: 429, detail });
      throw new MediaError("upstream", { status: r.status, detail });
    }
    return body ?? {};
  }
  private async call(path: string, init: Parameters<typeof httpFetch>[1], step: string) {
    try { return await httpFetch(`${this.base}${path}`, init); }
    catch (e) { throw e instanceof MediaError ? e : new MediaError(fetchErrorCode(e), { detail: [step, fetchErrorDetail(e)].filter(Boolean).join(" ") }); }
  }

  async generate(req: MediaRequest): Promise<MediaResult> {
    return req.kind === "image" ? this.image(req) : this.video(req);
  }

  async image(req: MediaRequest): Promise<MediaResult> {
    const body: any = { model: this.c.imageModel, prompt: req.prompt, n: 1, size: IMAGE_SIZE[req.aspect] || "1024x1024" };
    if (req.quality && req.quality !== "auto") body.quality = req.quality;
    const r = await this.call("/images/generations", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: 5 * 60 * 1000 }, "images");
    const j = await this.readJson(r, "images");
    const d = j.data?.[0];
    if (!d) throw new MediaError("bad_response", { detail: "no image in response" });
    let bytes: Buffer;
    if (typeof d.b64_json === "string" && d.b64_json) bytes = Buffer.from(d.b64_json, "base64");
    else if (typeof d.url === "string" && /^https?:\/\//.test(d.url)) {
      let dl: Awaited<ReturnType<typeof httpFetch>>;
      try { dl = await httpFetch(d.url, { signal: req.signal, timeoutMs: 120000 }); } catch (e) { throw new MediaError(fetchErrorCode(e), { detail: ["download", fetchErrorDetail(e)].filter(Boolean).join(" ") }); }
      if (!dl.ok) throw new MediaError("upstream", { status: dl.status, detail: `download ${dl.status}` });
      bytes = await readBody(dl, MAX_IMAGE);
    } else throw new MediaError("bad_response", { detail: "unrecognised image payload" });
    const kind = sniffImage(bytes);
    if (!kind) throw new MediaError("bad_response", { detail: "payload is not an image" });
    return { bytes, mime: kind.mime, ext: kind.ext, model: this.c.imageModel, revisedPrompt: typeof d.revised_prompt === "string" ? d.revised_prompt : undefined };
  }

  async video(req: MediaRequest): Promise<MediaResult> {
    const seconds = VIDEO_SECONDS.includes(req.seconds) ? req.seconds : 8;
    const body = { model: this.c.videoModel, prompt: req.prompt, size: VIDEO_SIZE[req.aspect] || "1280x720", seconds: String(seconds) };
    const created = await this.call("/videos", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: req.signal, timeoutMs: 120000 }, "videos");
    let job = await this.readJson(created, "videos");
    if (!job?.id || typeof job.id !== "string") throw new MediaError("bad_response", { detail: "no job id" });
    const started = Date.now();
    while (!["completed", "failed", "cancelled"].includes(String(job.status))) {
      if (Date.now() - started > videoMaxWaitMs()) throw new MediaError("video_timeout");
      await sleep(pollMs(), req.signal);
      const p = await this.call(`/videos/${encodeURIComponent(job.id)}`, { headers: this.headers(false), signal: req.signal, timeoutMs: 60000 }, "videos/poll");
      job = await this.readJson(p, "videos/poll");
      req.onProgress?.({ status: String(job.status || ""), percent: typeof job.progress === "number" ? job.progress : undefined });
    }
    if (job.status !== "completed") throw new MediaError("video_failed", { detail: typeof job.error?.message === "string" ? job.error.message : String(job.status) });
    const c = await this.call(`/videos/${encodeURIComponent(job.id)}/content`, { headers: this.headers(false), signal: req.signal, timeoutMs: 10 * 60 * 1000 }, "videos/content");
    if (!c.ok) { await this.readJson(c, "videos/content"); throw new MediaError("upstream", { status: c.status, detail: "videos/content" }); }
    const bytes = await readBody(c, MAX_VIDEO);
    if (!bytes.length) throw new MediaError("bad_response", { detail: "empty video" });
    const mime = c.headers.get("content-type")?.split(";")[0] || "video/mp4";
    return { bytes, mime, ext: /webm/.test(mime) ? "webm" : "mp4", model: this.c.videoModel };
  }
}
