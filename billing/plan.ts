// billing/plan.ts — 对外公开的方案信息（不含密钥）：内测状态、可售方案、邀请天数、微信群入口
import { config } from "../auth/config.ts";
import { siteSettings } from "./settings.ts";
import { listPlans, earlyBirdStats } from "./catalog.ts";

/** 内测微信群入口：只给已登录用户（随 /api/me 返回），不对匿名访客公开 */
export function wechatGroupInfo() {
  const s = siteSettings();
  return s.wechatGroupQrUrl || s.wechatGroupNote ? { qrUrl: s.wechatGroupQrUrl, note: s.wechatGroupNote } : null;
}
export function publicPlan() {
  const p = config.plan, s = siteSettings(), eb = earlyBirdStats();
  return {
    // 旧字段（桌面端缓存过的 plan 形状）
    code: p.code, name: p.name, mode: p.mode, days: p.days, priceCents: p.priceCents, currency: p.currency, trialDays: p.trialDays, trialUses: p.trialUses,
    beta: s.betaFree,
    plans: listPlans().map((pl) => ({ code: pl.code, name: pl.name, mode: pl.mode, days: pl.days, priceCents: pl.priceCents, currency: pl.currency,
      limit: pl.limit, left: pl.limit == null ? null : eb.left, sold: pl.limit == null ? null : eb.sold })),
    referralDays: s.referralDays, referralClaimDays: config.referral.claimDays,
    paymentConfigured: !!config.payment.webhookSecret || !!s.payInstructions || !!s.payQrUrl || config.devLogin,
  };
}
