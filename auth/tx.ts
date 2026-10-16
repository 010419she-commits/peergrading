// auth/tx.ts — 一次性认证事务（v9 §5.7）
import type { Request } from "express";
import { randomBytes } from "node:crypto";
import { q } from "./db.ts";
import { config } from "./config.ts";
import { now, randomToken, safeReturnTo, AuthError } from "./security.ts";

export interface TxOpts {
  provider: string; channel?: string | null; intent: "login" | "switch" | "reverify" | "bind"; returnTo?: unknown;
  userId?: number | null; targetIdentityId?: number | null; targetLinkVersion?: number | null; verifiedAt?: number | null; pkce?: boolean;
}

export function createTx(req: Request, o: TxOpts) {
  const r = req as any;
  if (!r.bidHash) throw new AuthError("no_browser");
  const tx = {
    id: randomToken(16), provider: o.provider, channel: o.channel ?? null, intent: o.intent,
    // 微信网页授权的 state 仅接受 a-zA-Z0-9（最长 128 字节）。
    state: randomBytes(24).toString("hex"), nonce: randomToken(16), code_verifier: o.pkce ? randomToken(32) : null,
    return_to: safeReturnTo(o.returnTo),
    bid_hash: r.bidHash as string, auth_epoch: r.authEpoch as number, session_id: (r.session?.id as string) || null,
    user_id: o.userId ?? null, target_identity_id: o.targetIdentityId ?? null, target_link_version: o.targetLinkVersion ?? null, verified_at: o.verifiedAt ?? null,
    expires_at: now() + config.txTtlSec,
  };
  q(`INSERT INTO oauth_transactions (id, provider, channel, intent, state, nonce, code_verifier, return_to, bid_hash, auth_epoch,
      session_id, user_id, target_identity_id, target_link_version, verified_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(tx.id, tx.provider, tx.channel, tx.intent, tx.state, tx.nonce, tx.code_verifier, tx.return_to, tx.bid_hash, tx.auth_epoch,
      tx.session_id, tx.user_id, tx.target_identity_id, tx.target_link_version, tx.verified_at, tx.expires_at);
  return tx;
}

/** 原子消费：state ∧ 渠道 ∧ 浏览器 ∧ 当前 epoch ∧ 未过期 ∧ 未消费 */
export function consumeTx(req: Request, { provider, state }: { provider: string; state: unknown }) {
  const r = req as any;
  if (!r.bidHash || typeof state !== "string" || !state || state.length > 128) return null;
  return q(`UPDATE oauth_transactions SET consumed_at = ?
    WHERE state = ? AND provider = ? AND bid_hash = ?
      AND auth_epoch = (SELECT auth_epoch FROM browser_auth_state WHERE bid_hash = ?)
      AND consumed_at IS NULL AND expires_at > ?
    RETURNING *`).get(now(), state, provider, r.bidHash, r.bidHash, now()) || null;
}

export function invalidateUserTx(userId: number) {
  q("UPDATE oauth_transactions SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL").run(now(), userId);
}
export function cleanupTx() { q("DELETE FROM oauth_transactions WHERE expires_at < ?").run(now() - 3600); }
