// billing/catalog.ts — 可售方案：早鸟终身版（限量，后台可改名额与价格）与常规方案（来自 .env 的 PLAN_*）
import { q } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { now } from "../auth/security.ts";
import { siteSettings } from "./settings.ts";

export interface Plan {
  code: string; version: number; name: string; mode: "permanent" | "days"; days: number | null;
  priceCents: number; currency: string; entitlement: string;
  /** 限量名额（null = 不限量） */
  limit: number | null;
}
export const EARLY_BIRD = "earlybird";
export const RESERVE_SEC = 24 * 3600;   // 待支付订单占用名额的时长

export function listPlans(): Plan[] {
  const p = config.plan, s = siteSettings();
  const regular: Plan = { code: p.code, version: p.version, name: p.name, mode: p.mode, days: p.mode === "days" ? p.days : null, priceCents: p.priceCents, currency: p.currency, entitlement: p.entitlement, limit: null };
  const earlyBird: Plan = { code: EARLY_BIRD, version: 1, name: "早鸟终身版", mode: "permanent", days: null, priceCents: s.earlyBirdPriceCents, currency: p.currency, entitlement: p.entitlement, limit: s.earlyBirdLimit };
  return p.code === EARLY_BIRD ? [regular] : [earlyBird, regular];
}
export const getPlan = (code: string) => listPlans().find((p) => p.code === code) || null;

/** 早鸟名额：已付订单 + 24 小时内的待支付订单 */
export function earlyBirdStats(at = now()) {
  const limit = siteSettings().earlyBirdLimit;
  const sold = Number(q("SELECT COUNT(*) AS c FROM orders WHERE merchant_id = ? AND plan_code = ? AND status = 'paid'").get(config.payment.merchantId, EARLY_BIRD)?.c ?? 0);
  const reserved = Number(q("SELECT COUNT(*) AS c FROM orders WHERE merchant_id = ? AND plan_code = ? AND status = 'pending' AND created_at > ?").get(config.payment.merchantId, EARLY_BIRD, at - RESERVE_SEC)?.c ?? 0);
  return { limit, sold, reserved, left: Math.max(0, limit - sold - reserved) };
}
