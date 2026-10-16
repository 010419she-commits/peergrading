// agents/media.ts — 协作中的图片 / 视频生成
// agent 在消息里用 ```image / ```video 围栏描述想要的画面，这里解析围栏、调用生成服务、把文件存进会话目录，
// 并把围栏替换成 ![描述](media://<id>.<ext>) 引用，供前端渲染、供另一位 agent 在后续版本里原样保留。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Lang } from "./types.ts";
import { MediaError, envInt, sanitizeDetail, type MediaErrorCode } from "./media-common.ts";
export { MediaError, envInt, sanitizeDetail, type MediaErrorCode };

export type MediaKind = "image" | "video";
export type Aspect = "1:1" | "16:9" | "9:16";
export type Quality = "low" | "medium" | "high" | "auto";

export interface MediaRequest {
  kind: MediaKind; prompt: string; aspect: Aspect; seconds: number; quality: Quality;
  signal?: AbortSignal;
  onProgress?: (p: { status: string; percent?: number }) => void;
}
export interface MediaResult { bytes: Buffer; mime: string; ext: string; model?: string; revisedPrompt?: string }
export interface MediaProvider { id: string; label: string; generate(req: MediaRequest): Promise<MediaResult> }

/* ---------- 设置（桌面端存在数据目录的 media.json；环境变量为缺省） ---------- */
/** keySource：当前生效的 Key 来自哪里。环境变量里的 Key 永远不会被写进 media.json；"清除"只删掉文件里的 Key */
export interface MediaSettings { provider: "openai"; apiKey: string; keySource: "file" | "env" | "none"; baseUrl: string; imageModel: string; videoModel: string; images: boolean; videos: boolean }
export const MEDIA_DEFAULTS = { baseUrl: "https://api.openai.com/v1", imageModel: "gpt-image-1", videoModel: "sora-2" };
export const MEDIA_LIMITS = {
  perRunImages: envInt(process.env.MEDIA_MAX_IMAGES, 6),
  perRunVideos: envInt(process.env.MEDIA_MAX_VIDEOS, 2),
  perMessageImages: 3, perMessageVideos: 1, promptChars: 4000,
};
const settingsFile = (dir: string) => path.join(dir, "media.json");
const envKey = () => process.env.MEDIA_API_KEY || process.env.OPENAI_API_KEY || "";
const readSaved = (dir: string): Partial<MediaSettings> => { try { return JSON.parse(fs.readFileSync(settingsFile(dir), "utf8")) || {}; } catch { return {}; } };
export function loadMediaSettings(dir: string): MediaSettings {
  const saved = readSaved(dir);
  const fileKey = typeof saved.apiKey === "string" ? saved.apiKey.trim() : "";
  const key = fileKey || envKey();
  return {
    provider: "openai",
    apiKey: key, keySource: fileKey ? "file" : key ? "env" : "none",
    baseUrl: normalizeBaseUrl(saved.baseUrl || process.env.MEDIA_BASE_URL || MEDIA_DEFAULTS.baseUrl),
    imageModel: (saved.imageModel || process.env.MEDIA_IMAGE_MODEL || MEDIA_DEFAULTS.imageModel).trim(),
    videoModel: (saved.videoModel || process.env.MEDIA_VIDEO_MODEL || MEDIA_DEFAULTS.videoModel).trim(),
    images: saved.images !== false, videos: saved.videos !== false,
  };
}
export function normalizeBaseUrl(u: string) {
  const s = String(u || "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(s) ? s : MEDIA_DEFAULTS.baseUrl;
}
/** 保存：apiKey 为 undefined 时保留文件里的旧值（来自环境变量的 Key 不落盘），为空串时清除文件里的 Key（环境变量的 Key 随即重新生效） */
export function saveMediaSettings(dir: string, patch: Partial<MediaSettings>): MediaSettings {
  const cur = loadMediaSettings(dir), saved = readSaved(dir);
  const fileKey = patch.apiKey === undefined ? (typeof saved.apiKey === "string" ? saved.apiKey.trim() : "") : String(patch.apiKey).trim().slice(0, 500);
  const next = {
    provider: "openai" as const,
    apiKey: fileKey,
    baseUrl: normalizeBaseUrl(patch.baseUrl ?? cur.baseUrl),
    imageModel: String(patch.imageModel ?? cur.imageModel).trim().slice(0, 80) || MEDIA_DEFAULTS.imageModel,
    videoModel: String(patch.videoModel ?? cur.videoModel).trim().slice(0, 80) || MEDIA_DEFAULTS.videoModel,
    images: patch.images === undefined ? cur.images : !!patch.images,
    videos: patch.videos === undefined ? cur.videos : !!patch.videos,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsFile(dir), JSON.stringify(next, null, 2), { mode: 0o600 });
  return loadMediaSettings(dir);
}
export const keyHint = (k: string) => (k ? (k.length > 10 ? `${k.slice(0, 5)}…${k.slice(-4)}` : "••••") : "");
/** 给前端看的设置：不含密钥本身 */
export function publicMediaSettings(s: MediaSettings) {
  return { provider: s.provider, configured: !!s.apiKey, keySource: s.keySource, keyHint: keyHint(s.apiKey), baseUrl: s.baseUrl, imageModel: s.imageModel, videoModel: s.videoModel,
    images: s.images, videos: s.videos, defaults: MEDIA_DEFAULTS, limits: { images: MEDIA_LIMITS.perRunImages, videos: MEDIA_LIMITS.perRunVideos } };
}
/** 给非管理员看的最小视图：只说有没有配置、开没开，不泄露 Key 片段、中转地址与模型名 */
export function minimalMediaSettings(s: MediaSettings) {
  return { provider: s.provider, configured: !!s.apiKey, images: s.images, videos: s.videos, limits: { images: MEDIA_LIMITS.perRunImages, videos: MEDIA_LIMITS.perRunVideos } };
}
export async function createMediaProvider(s: MediaSettings): Promise<MediaProvider | null> {
  if (!s.apiKey) return null;
  const { OpenAIMediaProvider } = await import("./media-openai.ts");
  return new OpenAIMediaProvider({ apiKey: s.apiKey, baseUrl: s.baseUrl, imageModel: s.imageModel, videoModel: s.videoModel });
}

/* ---------- 围栏解析 ---------- */
export interface MediaFence { kind: MediaKind; prompt: string; aspect: Aspect; seconds: number; quality: Quality; start: number; end: number }
const ASPECTS = new Set<Aspect>(["1:1", "16:9", "9:16"]);
export function parseMediaFences(text: string): MediaFence[] {
  const out: MediaFence[] = [];
  const lines = text.split("\n");   // 偏移量按原文（含 \r）计算；匹配时去掉行尾 \r，Windows 上的 CLI agent 常输出 CRLF
  const bare = (l: string) => l.replace(/\r$/, "");
  let pos = 0, i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = /^\s{0,3}(`{3,})\s*([A-Za-z][\w+-]*)?\s*(.*)$/.exec(bare(line));
    if (open) {
      const fence = open[1], langName = (open[2] || "").toLowerCase(), info = open[3] || "";
      const start = pos;
      let j = i + 1, closed = -1;
      for (; j < lines.length; j++) { const c = /^\s{0,3}(`{3,})\s*$/.exec(bare(lines[j])); if (c && c[1].length >= fence.length) { closed = j; break; } }
      if (closed < 0) break;   // 未闭合：后面都当正文
      const bodyLines = lines.slice(i + 1, closed).map(bare);
      const blockEnd = start + lines.slice(i, closed + 1).join("\n").length;
      const end = blockEnd - (lines[closed].endsWith("\r") ? 1 : 0);   // 闭合行的 \r 留在原文里，替换后仍是 CRLF
      if ((langName === "image" || langName === "video")) {
        const prompt = bodyLines.join("\n").trim().slice(0, MEDIA_LIMITS.promptChars);
        if (prompt) {
          const param = (k: string) => new RegExp(`(?:^|\\s)${k}=([^\\s]+)`).exec(info)?.[1];
          const a = param("aspect"), q = param("quality"), sec = Number(param("seconds"));
          out.push({ kind: langName, prompt, start, end,
            aspect: a && ASPECTS.has(a as Aspect) ? (a as Aspect) : langName === "video" ? "16:9" : "1:1",
            seconds: Number.isFinite(sec) && sec > 0 ? Math.min(12, Math.max(4, Math.round(sec / 4) * 4)) : 8,
            quality: q && ["low", "medium", "high", "auto"].includes(q) ? (q as Quality) : "auto" });
        }
      }
      pos = blockEnd + 1; i = closed + 1;
      continue;
    }
    pos += line.length + 1; i++;
  }
  return out;
}

/* ---------- 处理一条消息 ---------- */
export type MediaEvent =
  | { type: "media_start"; id: string; mediaId: string; kind: MediaKind; prompt: string }
  | { type: "media_progress"; id: string; mediaId: string; status: string; percent?: number }
  | { type: "media_end"; id: string; mediaId: string; kind: MediaKind; ok: boolean; file?: string; error?: string };
export interface MediaRecord { id: string; kind: MediaKind; prompt: string; file: string; mime: string; model?: string; msgId: string; aspect: Aspect; seconds?: number; createdAt: number }
/** 一次协作共享：目录、预算、缓存与记录 */
export interface MediaRun {
  provider: MediaProvider; dir: string; lang: Lang; signal: AbortSignal;
  enabled: { images: boolean; videos: boolean };
  /** 已成功生成的数量（失败不计，不占额度） */
  used: { images: number; videos: number };
  cache: Map<string, MediaRecord>;
  records: MediaRecord[];
  seq: number;
}
export function newMediaRun(provider: MediaProvider, dir: string, lang: Lang, signal: AbortSignal, enabled: { images: boolean; videos: boolean }): MediaRun {
  return { provider, dir, lang, signal, enabled, used: { images: 0, videos: 0 }, cache: new Map(), records: [], seq: 0 };
}
const TXT = {
  zh: { image: "图片", video: "视频", off: (k: string) => `${k}生成未开启，未生成。`, limit: (k: string, n: number) => `本次协作最多生成 ${n} 个${k}，已达上限，未生成。`,
    perMsg: (k: string, n: number) => `每条消息最多 ${n} 个${k}，此处未生成。`, fail: (k: string, e: string) => `${k}生成失败：${e}`, desc: "描述：",
    err: { unauthorized: "API Key 无效或已过期", forbidden: "没有权限使用该模型或接口", rate_limited: "请求过多或额度不足", upstream: "服务返回错误", timeout: "请求超时", aborted: "已取消",
      network: "无法连接，请检查网络或代理", too_large: "返回内容过大", bad_response: "服务返回的内容无法识别", video_failed: "视频任务失败", video_timeout: "生成视频超时" } as Record<MediaErrorCode, string> },
  en: { image: "image", video: "video", off: (k: string) => `${k} generation is off; not generated.`, limit: (k: string, n: number) => `At most ${n} ${k}s per run; limit reached, not generated.`,
    perMsg: (k: string, n: number) => `At most ${n} ${k}s per message; not generated here.`, fail: (k: string, e: string) => `${k} generation failed: ${e}`, desc: "Prompt: ",
    err: { unauthorized: "the API key is invalid or expired", forbidden: "no permission for this model or endpoint", rate_limited: "rate limited or out of quota", upstream: "the service returned an error", timeout: "request timed out", aborted: "cancelled",
      network: "could not connect; check the network or proxy", too_large: "the response was too large", bad_response: "unrecognised response from the service", video_failed: "the video job failed", video_timeout: "video generation timed out" } as Record<MediaErrorCode, string> },
};
const oneLine = (s: string, max = 300) => s.replace(/\s+/g, " ").replace(/[\[\]()]/g, (c) => ({ "[": "［", "]": "］", "(": "（", ")": "）" }[c] as string)).trim().slice(0, max);
const note = (lang: Lang, msg: string, prompt: string) => `> ⚠️ ${msg}\n> ${TXT[lang].desc}${oneLine(prompt, 500)}`;
export const mediaRef = (rec: { id: string; file: string; prompt: string }) => `![${oneLine(rec.prompt)}](media://${rec.file})`;
/** 失败原因的用户文案：按语言翻译错误码；上游细节经清洗后附在括号里。会被拼进成果正文，所以永远是单行、短、无标记 */
export function describeMediaError(e: any, lang: Lang): string {
  const L = TXT[lang];
  if (e instanceof MediaError) {
    const base = L.err[e.code] || e.code;
    const detail = e.detail && e.code !== "aborted" ? sanitizeDetail(e.detail, 120) : "";
    return detail ? `${base}${lang === "zh" ? "（" : " ("}${detail}${lang === "zh" ? "）" : ")"}` : base;
  }
  return sanitizeDetail(String(e?.message || e), 160) || L.err.upstream;
}

/** 解析并生成消息里的全部媒体围栏，返回替换后的文本。图片并行、视频串行；同样的描述只生成一次；失败不占额度；运行被取消时抛出 */
export async function processMedia(text: string, run: MediaRun, msgId: string, emit: (ev: MediaEvent) => void): Promise<string> {
  const fences = parseMediaFences(text);
  if (!fences.length) return text;
  if (run.signal.aborted) throw new MediaError("aborted");
  const L = TXT[run.lang];
  const perMsg = { image: 0, video: 0 }, reserved = { image: 0, video: 0 };
  type Item = { f: MediaFence; key: string; result: string | null; dupOf?: Item };
  const pending = new Map<string, Item>();
  const plan: Item[] = fences.map((f) => {
    const k = f.kind, label = L[k];
    const key = crypto.createHash("sha256").update([k, f.aspect, k === "video" ? f.seconds : "", f.quality, f.prompt.replace(/\s+/g, " ").trim()].join("|")).digest("hex");
    const cached = run.cache.get(key);
    if (cached) return { f, key, result: mediaRef(cached) };
    const first = pending.get(key);
    if (first) return { f, key, result: null, dupOf: first };   // 同一条消息里重复的描述：跟着第一处的结果走
    if (!(k === "image" ? run.enabled.images : run.enabled.videos)) return { f, key, result: note(run.lang, L.off(label), f.prompt) };
    const perLimit = k === "image" ? MEDIA_LIMITS.perMessageImages : MEDIA_LIMITS.perMessageVideos;
    if (++perMsg[k] > perLimit) return { f, key, result: note(run.lang, L.perMsg(label, perLimit), f.prompt) };
    const runLimit = k === "image" ? MEDIA_LIMITS.perRunImages : MEDIA_LIMITS.perRunVideos;
    const usedSoFar = k === "image" ? run.used.images : run.used.videos;
    if (usedSoFar + reserved[k] >= runLimit) return { f, key, result: note(run.lang, L.limit(label, runLimit), f.prompt) };
    reserved[k]++;
    const item: Item = { f, key, result: null };
    pending.set(key, item);
    return item;
  });
  const generate = async (item: Item) => {
    const f = item.f, label = L[f.kind];
    const mediaId = `m${++run.seq}-${crypto.randomBytes(3).toString("hex")}`;
    emit({ type: "media_start", id: msgId, mediaId, kind: f.kind, prompt: f.prompt });
    try {
      const r = await run.provider.generate({ kind: f.kind, prompt: f.prompt, aspect: f.aspect, seconds: f.seconds, quality: f.quality, signal: run.signal,
        onProgress: (p) => emit({ type: "media_progress", id: msgId, mediaId, status: p.status, percent: p.percent }) });
      if (run.signal.aborted) throw new MediaError("aborted");
      const ext = r.ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || (f.kind === "image" ? "png" : "mp4");
      const file = `${mediaId}.${ext}`;
      fs.mkdirSync(run.dir, { recursive: true });
      fs.writeFileSync(path.join(run.dir, file), r.bytes);
      const rec: MediaRecord = { id: mediaId, kind: f.kind, prompt: f.prompt, file, mime: r.mime, model: r.model, msgId, aspect: f.aspect, seconds: f.kind === "video" ? f.seconds : undefined, createdAt: Date.now() };
      run.records.push(rec); run.cache.set(item.key, rec);
      if (f.kind === "image") run.used.images++; else run.used.videos++;
      emit({ type: "media_end", id: msgId, mediaId, kind: f.kind, ok: true, file });
      item.result = mediaRef(rec);
    } catch (e: any) {
      if (run.signal.aborted) throw e;   // 用户停止：让整条消息的处理中止，协作循环随之结束
      const msg = describeMediaError(e, run.lang);
      emit({ type: "media_end", id: msgId, mediaId, kind: f.kind, ok: false, error: msg });
      item.result = note(run.lang, L.fail(label, msg), f.prompt);
    }
  };
  const todo = plan.filter((p) => p.result === null && !p.dupOf);
  await Promise.all(todo.filter((p) => p.f.kind === "image").map(generate));
  for (const p of todo.filter((p) => p.f.kind === "video")) await generate(p);
  let out = "", cursor = 0;
  for (const p of plan) { out += text.slice(cursor, p.f.start) + ((p.dupOf ? p.dupOf.result : p.result) as string); cursor = p.f.end; }
  return out + text.slice(cursor);
}

/** 媒体文件名白名单（路由里用） */
export const MEDIA_FILE_RE = /^m\d+-[a-f0-9]{6}\.(png|jpg|webp|mp4|webm)$/;
export const mediaMime = (file: string) => ({ png: "image/png", jpg: "image/jpeg", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" } as Record<string, string>)[file.split(".").pop() || ""] || "application/octet-stream";
