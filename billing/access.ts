// billing/access.ts — 使用权：会员权益 或 试用（天数与次数双重限制）
import { q } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { hasEntitlement } from "../auth/entitlements.ts";
import { now } from "../auth/security.ts";

export interface AccessStatus {
  allowed: boolean;
  member: boolean;
  trial: { active: boolean; endsAt: number; daysLeft: number; usesLeft: number; usesTotal: number; used: number };
  reason?: "trial_expired" | "trial_exhausted";
}

export function usageCount(userId: number, kind = "run") {
  return Number(q("SELECT COUNT(*) AS c FROM usage_events WHERE user_id = ? AND kind = ?").get(userId, kind)?.c ?? 0);
}

export function accessStatus(user: any): AccessStatus {
  const p = config.plan;
  const member = hasEntitlement(user.id, p.entitlement);
  const endsAt = Number(user.created_at) + p.trialDays * 86400;
  const used = usageCount(user.id);
  const t = now();
  const daysLeft = Math.max(0, Math.ceil((endsAt - t) / 86400));
  const usesLeft = Math.max(0, p.trialUses - used);
  const active = t < endsAt && used < p.trialUses;
  const out: AccessStatus = { allowed: member || active, member, trial: { active, endsAt, daysLeft, usesLeft, usesTotal: p.trialUses, used } };
  if (!out.allowed) out.reason = t >= endsAt ? "trial_expired" : "trial_exhausted";
  return out;
}

/** 记一次使用（会员不计） */
export function recordUsage(user: any, ref: string) {
  if (hasEntitlement(user.id, config.plan.entitlement)) return;
  q("INSERT INTO usage_events (user_id, kind, ref) VALUES (?, 'run', ?)").run(user.id, ref);
}
