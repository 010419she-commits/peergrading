// billing/referral.ts — 邀请奖励：邀请一位好友，双方各得 N 天会员。内测期间先记账，内测结束时统一发放
import crypto from "node:crypto";
import { q } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { grantEntitlement } from "../auth/entitlements.ts";
import { now, AuthError } from "../auth/security.ts";
import { betaFree, siteSettings } from "./settings.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 不含 0 O 1 I
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/;
const newCode = () => { const b = crypto.randomBytes(8); let s = ""; for (let i = 0; i < 8; i++) s += ALPHABET[b[i] % ALPHABET.length]; return s; };
export const normalizeCode = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

/** 用户的邀请码：首次查看时生成 */
export function referralCode(userId: number): string {
  for (let i = 0; i < 10; i++) {
    const row = q("SELECT referral_code FROM users WHERE id = ?").get(userId);
    if (!row) throw new AuthError("not_found");
    if (row.referral_code) return row.referral_code;
    try { q("UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL").run(newCode(), userId); }
    catch (e: any) { if (!/UNIQUE/i.test(String(e?.message))) throw e; }
  }
  throw new AuthError("code_collision");
}
export const inviterByCode = (code: string) => (CODE_RE.test(code) ? q("SELECT id, status FROM users WHERE referral_code = ?").get(code) || null : null);
export const referralLink = (code: string) => `${config.baseUrl}/?ref=${code}`;

/** 登记一次邀请（被邀请者 = inviteeId）。必须在事务内调用 */
export function claimReferral(inviteeId: number, rawCode: unknown, at = now()) {
  const code = normalizeCode(rawCode);
  const invitee = q("SELECT id, created_at FROM users WHERE id = ?").get(inviteeId);
  if (!invitee) throw new AuthError("not_found");
  const inviter = inviterByCode(code);
  if (!inviter || inviter.status !== "active") throw new AuthError("unknown_code");
  if (inviter.id === inviteeId) throw new AuthError("self_referral");
  if (q("SELECT 1 FROM referrals WHERE invitee_id = ?").get(inviteeId)) throw new AuthError("already_referred");
  if (at - Number(invitee.created_at) > config.referral.claimDays * 86400) throw new AuthError("claim_window_closed");
  const days = siteSettings().referralDays;
  const inviterCount = Number(q("SELECT COUNT(*) AS c FROM referrals WHERE inviter_id = ?").get(inviter.id)?.c ?? 0);
  const inviterDays = inviterCount < config.referral.maxPerUser ? days : 0;   // 超过上限：被邀请者照样得奖励，邀请者不再累加
  const id = Number(q("INSERT INTO referrals (inviter_id, invitee_id, code, inviter_days, invitee_days, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(inviter.id, inviteeId, code, inviterDays, days, at).lastInsertRowid);
  const r = q("SELECT * FROM referrals WHERE id = ?").get(id);
  if (!betaFree()) settleReferral(r);
  return q("SELECT * FROM referrals WHERE id = ?").get(id);
}

function settleReferral(r: any) {
  const ent = config.plan.entitlement;
  if (r.invitee_days > 0) grantEntitlement({ userId: r.invitee_id, entitlement: ent, sourceType: "referral", sourceRef: `${r.id}:invitee`, mode: "days", days: r.invitee_days });
  if (r.inviter_days > 0) grantEntitlement({ userId: r.inviter_id, entitlement: ent, sourceType: "referral", sourceRef: `${r.id}:inviter`, mode: "days", days: r.inviter_days });
  q("UPDATE referrals SET settled_at = ? WHERE id = ?").run(now(), r.id);
}
/** 内测结束：发放所有未发放的邀请奖励（幂等）。必须在事务内调用 */
export function settlePendingReferrals() {
  const rows = q("SELECT * FROM referrals WHERE settled_at IS NULL ORDER BY id").all();
  for (const r of rows) settleReferral(r);
  return rows.length;
}

export function referralSummary(userId: number, at = now()) {
  const u = q("SELECT created_at FROM users WHERE id = ?").get(userId);
  if (!u) throw new AuthError("not_found");
  const code = referralCode(userId);
  const sent = q("SELECT inviter_days, settled_at FROM referrals WHERE inviter_id = ?").all(userId);
  const got = q("SELECT code, invitee_days, settled_at FROM referrals WHERE invitee_id = ?").get(userId) || null;
  const sum = (rows: any[], k: string) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
  return {
    code, link: referralLink(code), days: siteSettings().referralDays, beta: betaFree(),
    invited: sent.length,
    earnedDays: sum(sent, "inviter_days") + (got ? Number(got.invitee_days) : 0),
    pendingDays: sum(sent.filter((r) => !r.settled_at), "inviter_days") + (got && !got.settled_at ? Number(got.invitee_days) : 0),
    claimed: got ? { code: got.code, days: Number(got.invitee_days), settled: !!got.settled_at } : null,
    canClaim: !got && at - Number(u.created_at) <= config.referral.claimDays * 86400,
  };
}
