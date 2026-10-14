// auth/session.ts — 会话（v9 §5.8）
import type { Request, Response } from "express";
import { q } from "./db.ts";
import { config } from "./config.ts";
import { now, randomToken, sha256 } from "./security.ts";

const COOKIE = "sid";
const cookieOpts = { httpOnly: true, secure: config.isProd, sameSite: "lax" as const, path: "/" };

export function insertSession(userId: number, { lastVerifiedAt = now(), verifiedBy = null as number | null } = {}) {
  const token = randomToken(32);
  const id = sha256(token);
  q("INSERT INTO sessions (id, user_id, expires_at, last_verified_at, verified_by_identity_id) VALUES (?, ?, ?, ?, ?)")
    .run(id, userId, now() + config.sessionTtlSec, lastVerifiedAt, verifiedBy);
  return { token, id };
}
export function setSessionCookie(res: Response, token: string) { res.cookie(COOKIE, token, { ...cookieOpts, maxAge: config.sessionTtlSec * 1000 }); }
export function clearSessionCookie(res: Response) { res.clearCookie(COOKIE, { path: "/" }); }

export function readSession(req: Request) {
  const t = req.cookies?.[COOKIE];
  if (typeof t !== "string" || !t) return null;
  return q("SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?").get(sha256(t), now()) || null;
}
export function revokeSession(id: string) { q("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id); }
export function revokeAllSessions(userId: number) { q("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(now(), userId); }
export const recentlyVerified = (s: any) => !!s && s.last_verified_at > now() - config.reverifyWindowSec;
