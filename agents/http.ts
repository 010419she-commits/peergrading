// agents/http.ts — 进程内发往境外服务的 HTTPS 请求：带上系统代理（国内直连 OpenAI 等会被拒），可设超时并与运行的取消信号联动
import { fetch as undiciFetch, ProxyAgent, type Dispatcher, type RequestInit as UndiciInit, type Response as UndiciResponse } from "undici";
import { getProxyEnv } from "./proxy.ts";

const agents = new Map<string, ProxyAgent | null>();

/** 该地址该不该走代理：遵守 NO_PROXY（逗号分隔；支持 .cn 这类后缀与 * ） */
function dispatcherFor(url: string): Dispatcher | undefined {
  const env = getProxyEnv();
  let u: URL; try { u = new URL(url); } catch { return undefined; }
  const proxy = u.protocol === "http:" ? env.HTTP_PROXY || env.HTTPS_PROXY : env.HTTPS_PROXY || env.HTTP_PROXY;
  if (!proxy) return undefined;
  const host = u.hostname.toLowerCase();
  const skip = (env.NO_PROXY || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((p) => p === "*" || host === p || (p.startsWith(".") ? host.endsWith(p) || host === p.slice(1) : host.endsWith("." + p)));
  if (skip) return undefined;
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

/** 把失败的 fetch 原因变成能读的中文 */
export function describeFetchError(e: any): string {
  if (e?.name === "TimeoutError" || e?.cause?.name === "TimeoutError") return "请求超时";
  if (e?.name === "AbortError") return "已取消";
  const code = e?.cause?.code || e?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_SOCKET") return `无法连接（${code}）：请检查网络或代理`;
  return e?.cause?.message || e?.message || String(e);
}
