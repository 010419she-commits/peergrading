// agents/http.ts — 进程内发往境外服务的 HTTPS 请求：带上系统代理（国内直连 OpenAI 等会被拒），可设超时并与运行的取消信号联动；读取响应体有大小上限
import { fetch as undiciFetch, ProxyAgent, type Dispatcher, type RequestInit as UndiciInit, type Response as UndiciResponse } from "undici";
import { getProxyEnv } from "./proxy.ts";
import { MediaError, type MediaErrorCode } from "./media-common.ts";

const agents = new Map<string, ProxyAgent | null>();

/** NO_PROXY 是否覆盖该主机：逗号分隔；支持 *、example.com（含子域）、.example.com、*.example.com，可带 :端口 */
export function bypassesProxy(host: string, noProxy: string | undefined) {
  const h = host.toLowerCase();
  return (noProxy || "").split(",").map((s) => s.trim().toLowerCase()).some((raw) => {
    if (raw === "*") return true;
    const p = raw.replace(/^\*/, "").replace(/:\d+$/, "");
    if (p === "") return false;
    const suffix = p.startsWith(".") ? p : "." + p;
    return h === p || h === suffix.slice(1) || h.endsWith(suffix);
  });
}
function dispatcherFor(url: string): Dispatcher | undefined {
  const env = getProxyEnv();
  let u: URL; try { u = new URL(url); } catch { return undefined; }
  const proxy = u.protocol === "http:" ? env.HTTP_PROXY || env.HTTPS_PROXY : env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!proxy) return undefined;
  if ((env.NO_PROXY || "").trim() === "*" || bypassesProxy(u.hostname, env.NO_PROXY)) return undefined;
  if (!agents.has(proxy)) { try { agents.set(proxy, new ProxyAgent(proxy)); } catch { agents.set(proxy, null); } }
  return agents.get(proxy) ?? undefined;
}

export type HttpInit = Omit<UndiciInit, "signal"> & { signal?: AbortSignal; timeoutMs?: number };

/** 与全局 fetch 用法一致；超时与外部取消信号任一触发即中止 */
export function httpFetch(url: string, init: HttpInit = {}): Promise<UndiciResponse> {
  const { timeoutMs, signal, ...rest } = init;
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  const dispatcher = dispatcherFor(url);
  return undiciFetch(url, { ...rest, ...(signals.length ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}), ...(dispatcher ? { dispatcher } : {}) });
}

/** 把失败的 fetch 原因归类为错误码（文案由调用方按语言生成） */
export function fetchErrorCode(e: any): MediaErrorCode {
  if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") return "timeout";
  if (e?.name === "AbortError") return "aborted";
  return "network";
}
export const fetchErrorDetail = (e: any): string | undefined => e?.cause?.code || e?.code || undefined;

/** 有上限地读完响应体：先看 Content-Length，再边读边数；超过 maxBytes 立即中止并抛 too_large，避免把超大响应整个读进内存 */
export async function readBody(r: UndiciResponse, maxBytes: number): Promise<Buffer> {
  const declared = Number(r.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { try { await r.body?.cancel(); } catch {} throw new MediaError("too_large", { detail: `${declared} bytes` }); }
  if (!r.body) return Buffer.alloc(0);
  const chunks: Buffer[] = []; let total = 0;
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { try { await reader.cancel(); } catch {} throw new MediaError("too_large", { detail: `> ${maxBytes} bytes` }); }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(chunks, total);
}
