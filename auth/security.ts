// auth/security.ts — 随机数 / 哈希 / CSRF / 外部请求限制（v9 §5.5）
import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "./config.ts";

export const now = () => Math.floor(Date.now() / 1000);
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: unknown) => crypto.createHash("sha256").update(String(s)).digest("hex");
export const timingEq = (a: unknown, b: unknown) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export class AuthError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, detail?: unknown) { super(code); this.code = code; this.detail = detail; }
}

/** 日志脱敏：不记录异常文本、URL、令牌、资料 */
export function logAuthError(e: any, trace: string) {
  console.error(JSON.stringify({
    at: "auth", trace,
    code: e instanceof AuthError ? e.code : "unknown",
    type: e?.constructor?.name || "Error",
    errcode: Number.isFinite(e?.detail) ? e.detail : undefined,
    ...(config.isProd ? {} : { msg: String(e?.message).slice(0, 200) }),
  }));
}

/** 返回位置白名单 */
export function safeReturnTo(v: unknown): string {
  const m = typeof v === "string" && /^(\/|\/account|\/app)(#[\w-]{1,40})?$/.exec(v);
  return m ? m[1] + (m[2] || "") : "/";
}

/* ---------- CSRF：与 浏览器摘要 + 会话 + auth_epoch 绑定的签名令牌 ---------- */
const csrfKey = crypto.createHmac("sha256", config.sessionSecret).update("csrf-key-v1").digest();
const mac = (payload: string) => crypto.createHmac("sha256", csrfKey).update(payload).digest("base64url");

export function issueCsrf({ bidHash, sessionId, authEpoch }: { bidHash: string; sessionId: string | null; authEpoch: number }) {
  const payload = ["v1", "csrf", bidHash, sessionId || "-", String(authEpoch), String(now() + config.csrfTtlSec)].join("|");
  return `${Buffer.from(payload).toString("base64url")}.${mac(payload)}`;
}
export function verifyCsrf(token: unknown, { bidHash, sessionId, authEpoch }: { bidHash: string; sessionId: string | null; authEpoch: number }) {
  if (typeof token !== "string" || !token.includes(".")) return false;
  const [b, m] = token.split(".");
  let payload: string; try { payload = Buffer.from(b, "base64url").toString(); } catch { return false; }
  if (!timingEq(m, mac(payload))) return false;
  const [v, kind, bh, sid, ep, exp] = payload.split("|");
  return v === "v1" && kind === "csrf" && bh === bidHash && sid === (sessionId || "-") && ep === String(authEpoch) && Number(exp) > now();
}
export function requireCsrf(req: Request, res: Response, next: NextFunction) {
  const deny = (code: string) => req.is("application/x-www-form-urlencoded")
    ? res.status(403).type("text").send("请求校验失败，请返回重试")
    : res.status(403).json({ error: code });
  const origin = req.get("origin");
  if (origin ? origin !== config.siteOrigin : req.get("sec-fetch-site") !== "same-origin") return deny("bad_origin");
  const token = req.get("x-csrf-token") || (req.body as any)?._csrf;
  const r = req as any;
  if (!r.bidHash || !verifyCsrf(token, { bidHash: r.bidHash, sessionId: r.session?.id || null, authEpoch: r.authEpoch })) return deny("csrf");
  next();
}

/* ---------- 外部请求：超时 + 并发上限 ---------- */
let inflight = 0;
export async function fetchJson(url: string, init: RequestInit = {}) {
  if (inflight >= config.maxInflightExternal) throw new AuthError("busy");
  inflight++;
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(config.fetchTimeoutMs) });
    const body: any = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch (e: any) {
    throw e instanceof AuthError ? e : new AuthError(e?.name === "TimeoutError" ? "timeout" : "network");
  } finally { inflight--; }
}
export function withTimeout<T>(makePromise: () => Promise<T>, ms = config.fetchTimeoutMs): Promise<T> {
  if (inflight >= config.maxInflightExternal) return Promise.reject(new AuthError("busy"));
  inflight++;
  const p = makePromise();
  p.finally(() => inflight--).catch(() => {});
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { timer = setTimeout(() => rej(new AuthError("timeout")), ms); })]).finally(() => clearTimeout(timer));
}
