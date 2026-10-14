// auth/browser.ts — 浏览器认证版本（v9 §5.6）
import type { Request, Response, NextFunction } from "express";
import { q } from "./db.ts";
import { config } from "./config.ts";
import { now, randomToken, sha256, AuthError } from "./security.ts";

const COOKIE = "bid";
const cookieOpts = { httpOnly: true, secure: config.isProd, sameSite: "lax" as const, path: "/", maxAge: 365 * 86400 * 1000 };

export function attachBrowser(req: Request, _res: Response, next: NextFunction) {
  const r = req as any;
  r.bidHash = null; r.authEpoch = null;
  const bid = req.cookies?.[COOKIE];
  if (typeof bid === "string" && /^[A-Za-z0-9_-]{32,}$/.test(bid)) {
    const row = q("SELECT auth_epoch FROM browser_auth_state WHERE bid_hash = ?").get(sha256(bid));
    if (row) { r.bidHash = sha256(bid); r.authEpoch = row.auth_epoch; }
  }
  next();
}

/** 只在 bootstrap / 登录页调用 */
export function ensureBrowser(req: Request, res: Response) {
  const r = req as any;
  if (r.bidHash) return;
  const bid = randomToken(24);
  const hash = sha256(bid);
  const epoch = now();
  q("INSERT INTO browser_auth_state (bid_hash, auth_epoch, session_id, updated_at) VALUES (?, ?, NULL, ?)").run(hash, epoch, now());
  res.cookie(COOKIE, bid, cookieOpts);
  r.bidHash = hash; r.authEpoch = epoch;
}

/** 原子递增；必须在最终事务内调用 */
export function bumpEpoch(bidHash: string, sessionId: string | null) {
  const row = q("UPDATE browser_auth_state SET auth_epoch = auth_epoch + 1, session_id = ?, updated_at = ? WHERE bid_hash = ? RETURNING auth_epoch").get(sessionId, now(), bidHash);
  if (!row) throw new AuthError("stale_tx");
  return row.auth_epoch as number;
}
export const currentEpoch = (bidHash: string) => q("SELECT auth_epoch FROM browser_auth_state WHERE bid_hash = ?").get(bidHash)?.auth_epoch ?? null;

export function cleanupBrowsers() {
  q(`DELETE FROM browser_auth_state WHERE updated_at < ? AND bid_hash NOT IN (SELECT bid_hash FROM oauth_transactions WHERE expires_at > ?)`)
    .run(now() - config.browserStateRetentionSec, now());
}
