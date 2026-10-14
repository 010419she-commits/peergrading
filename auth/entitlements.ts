// auth/entitlements.ts — 权益（v9 §5.10）
import { q } from "./db.ts";
import { now, AuthError } from "./security.ts";

const seg = (r: any) => ({ startsAt: r.starts_at, endsAt: r.is_permanent ? null : r.ends_at, permanent: !!r.is_permanent });

export function entitlementSummary(userId: number, at = now()) {
  const rows = q(`SELECT id, entitlement, starts_at, ends_at, is_permanent FROM entitlement_grants
    WHERE user_id = ? AND revoked_at IS NULL ORDER BY starts_at, is_permanent DESC`).all(userId);
  const byCode = new Map<string, any[]>();
  for (const r of rows) { if (!byCode.has(r.entitlement)) byCode.set(r.entitlement, []); byCode.get(r.entitlement)!.push(r); }
  const out: any[] = [];
  for (const [code, rs] of byCode) {
    const covering = rs.filter((r) => r.starts_at <= at && (r.is_permanent || r.ends_at > at));
    const future = rs.filter((r) => r.starts_at > at);
    const s: any = { code, active: covering.length > 0, permanentNow: covering.some((r) => r.is_permanent), continuousUntil: null, scheduled: [] };
    if (!s.active) { s.scheduled = future.map(seg); out.push(s); continue; }
    if (s.permanentNow) { out.push(s); continue; }
    let end = Math.max(...covering.map((r) => r.ends_at)), i = 0, infinite = false;
    while (i < future.length && !infinite) {
      const r = future[i];
      if (r.starts_at > end) break;
      if (r.is_permanent) infinite = true; else end = Math.max(end, r.ends_at);
      i++;
    }
    s.continuousUntil = infinite ? null : end;
    s.scheduled = infinite ? [] : future.slice(i).map(seg);
    out.push(s);
  }
  return out;
}
export const hasEntitlement = (userId: number, code: string) => entitlementSummary(userId).some((e) => e.code === code && e.active);

export function grantEntitlement({ userId, entitlement, sourceType, sourceRef, mode, days = null as number | null, startPolicy = "extend" }:
  { userId: number; entitlement: string; sourceType: string; sourceRef: string; mode: "permanent" | "days"; days?: number | null; startPolicy?: "extend" | "immediate" }) {
  if (!["permanent", "days"].includes(mode) || !["extend", "immediate"].includes(startPolicy)) throw new AuthError("bad_plan");
  if (mode === "days" && !(Number.isInteger(days) && (days as number) > 0)) throw new AuthError("bad_plan");
  const params = JSON.stringify({ userId, entitlement, mode, days: mode === "days" ? days : null, startPolicy });
  const prev = q("SELECT id, grant_params FROM entitlement_grants WHERE source_type = ? AND source_ref = ? AND entitlement = ?").get(sourceType, sourceRef, entitlement);
  if (prev) { if (prev.grant_params === params) return prev.id; throw new AuthError("grant_param_mismatch"); }
  const t = now();
  let startsAt = t, endsAt: number | null = null;
  if (mode === "days") {
    if (startPolicy === "extend") {
      const cur = q("SELECT MAX(ends_at) AS e FROM entitlement_grants WHERE user_id = ? AND entitlement = ? AND revoked_at IS NULL AND is_permanent = 0").get(userId, entitlement);
      startsAt = Math.max(t, cur?.e || 0);
    }
    endsAt = startsAt + (days as number) * 86400;
  }
  return Number(q(`INSERT INTO entitlement_grants (user_id, entitlement, source_type, source_ref, starts_at, ends_at, is_permanent, grant_params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, entitlement, sourceType, sourceRef, startsAt, endsAt, mode === "permanent" ? 1 : 0, params).lastInsertRowid);
}

export function revokeEntitlement({ sourceType, sourceRef, reason }: { sourceType: string; sourceRef: string; reason?: string }) {
  return q("UPDATE entitlement_grants SET revoked_at = ?, revoke_reason = ? WHERE source_type = ? AND source_ref = ? AND revoked_at IS NULL")
    .run(now(), reason || null, sourceType, sourceRef).changes;
}
