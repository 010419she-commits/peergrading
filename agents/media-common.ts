// agents/media-common.ts — 媒体生成模块共用的小件：带错误码的异常（文案由调用方按语言生成）、环境变量整数解析
export type MediaErrorCode =
  | "unauthorized" | "forbidden" | "rate_limited" | "upstream"      // 服务端返回的 HTTP 错误
  | "timeout" | "aborted" | "network" | "too_large"                // 传输层
  | "bad_response" | "video_failed" | "video_timeout";             // 内容 / 任务层

/** 生成失败：code 决定给用户看的文案；detail 是经过清洗的补充信息（上游错误摘要、状态码等），可为空 */
export class MediaError extends Error {
  code: MediaErrorCode;
  status?: number;
  detail?: string;
  constructor(code: MediaErrorCode, opts: { status?: number; detail?: string } = {}) {
    super(code);
    this.name = "MediaError"; this.code = code; this.status = opts.status;
    this.detail = opts.detail ? sanitizeDetail(opts.detail) : undefined;
  }
}
/** 上游文本只保留一行、去掉可能被当成标记或标签的片段，并截短：它会被拼进成果正文，必须不能"越狱" */
export function sanitizeDetail(s: string, max = 120) {
  return String(s ?? "").replace(/<[^>]*>/g, " ").replace(/【结论】|结论[:：]|VERDICT\s*[:：]|APPROVE|REVISE/gi, " ").replace(/[`>#*_\[\]()|]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
/** 读取非负整数环境变量：空、非数字、负数都回落到默认值 */
export function envInt(v: string | undefined, d: number, min = 0) {
  if (v === undefined || v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : d;
}
