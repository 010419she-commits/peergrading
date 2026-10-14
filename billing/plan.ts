// billing/plan.ts — 对外公开的方案信息（不含密钥）
import { config } from "../auth/config.ts";
export function publicPlan() {
  const p = config.plan;
  return { code: p.code, name: p.name, mode: p.mode, days: p.days, priceCents: p.priceCents, currency: p.currency, trialDays: p.trialDays, trialUses: p.trialUses,
    paymentConfigured: !!config.payment.webhookSecret || !!config.payment.instructions || !!config.payment.qrUrl || config.devLogin };
}
