// billing/access.ts — 使用权：内测免费 / 会员权益 / 试用（天数与次数双重限制）
import { q } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { entitlementSummary, hasEntitlement } from "../auth/entitlements.ts";
import { now } from "../auth/security.ts";
import { betaFree, betaEndedAt } from "./settings.ts";

export interface AccessStatus {
  allowed: boolean;
  /** 内测免费期：一律放行（会员 / 试用状态仍照常计算，供展示） */
  beta: boolean;
  member: boolean;
  permanent: boolean;
  /** 会员到期时间；永久会员或非会员为 null */
  memberUntil: number | null;
  /** 还能用几天：永久会员 null；会员到到期；试用到试用期末；否则 0 */
  daysLeft: number | null;
  trial: { active: boolean; startsAt: number; endsAt: number; daysLeft: number; usesLeft: number; usesTotal: number; used: number };
  reason?: "trial_expired" | "trial_exhausted";
}

export function usageCount(userId: number, kind = "run", since = 0) {
  return Number(q("SELECT COUNT(*) AS c FROM usage_events WHERE user_id = ? AND kind = ? AND created_at >= ?").get(userId, kind, since)?.c ?? 0);
}
/** 试用从注册时起算；内测期间注册的用户从内测结束时重新起算（内测期间的用量也不计入） */
export const trialStart = (user: any) => Math.max(Number(user.created_at), betaEndedAt());

export function accessStatus(user: any, at = now()): AccessStatus {
  const p = config.plan;
  const m = entitlementSummary(user.id, at).find((e) => e.code === p.entitlement);
  const member = !!m?.active, permanent = !!m?.permanentNow;
  const memberUntil = member && !permanent ? Number(m.continuousUntil) : null;
  const startsAt = trialStart(user);
  const endsAt = startsAt + p.trialDays * 86400;
  const used = usageCount(user.id, "run", startsAt);
  const trialDaysLeft = Math.max(0, Math.ceil((endsAt - at) / 86400));
  const usesLeft = Math.max(0, p.trialUses - used);
  const active = at < endsAt && used < p.trialUses;
  const beta = betaFree();
  const daysLeft = permanent ? null : member ? Math.max(0, Math.ceil(((memberUntil as number) - at) / 86400)) : active ? trialDaysLeft : 0;
  const out: AccessStatus = {
    allowed: beta || member || active, beta, member, permanent, memberUntil, daysLeft,
    trial: { active, startsAt, endsAt, daysLeft: trialDaysLeft, usesLeft, usesTotal: p.trialUses, used },
  };
  if (!out.allowed) out.reason = at >= endsAt ? "trial_expired" : "trial_exhausted";
  return out;
}

/** 记一次使用（会员不计；内测期间照记，便于统计） */
export function recordUsage(user: any, ref: string) {
  if (hasEntitlement(user.id, config.plan.entitlement)) return;
  q("INSERT INTO usage_events (user_id, kind, ref) VALUES (?, 'run', ?)").run(user.id, ref);
}
