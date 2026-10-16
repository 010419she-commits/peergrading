// billing/settings.ts — 站点设置：数据库里的键值（后台 /admin 可改），缺省回落到 .env
import { q } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { now } from "../auth/security.ts";

export const getSetting = (key: string): string | null => q("SELECT value FROM app_settings WHERE key = ?").get(key)?.value ?? null;
export function setSetting(key: string, value: string | null) {
  if (value === null) q("DELETE FROM app_settings WHERE key = ?").run(key);
  else q("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, now());
}
const num = (key: string, fallback: number) => { const v = getSetting(key); const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? n : fallback; };

/** 内测免费：所有登录用户免费使用、不开放购买。默认开（FREE_BETA=0 改默认关）；后台开关优先 */
export const betaFree = () => (getSetting("beta_free") ?? (process.env.FREE_BETA === "0" ? "0" : "1")) === "1";
/** 最近一次关闭内测的时间（0 = 从未关闭）。内测期间注册的用户，试用从这一刻重新起算 */
export const betaEndedAt = () => num("beta_ended_at", 0);

export function siteSettings() {
  return {
    betaFree: betaFree(), betaEndedAt: betaEndedAt(),
    payInstructions: getSetting("pay_instructions") ?? config.payment.instructions,
    payQrUrl: getSetting("pay_qr_url") ?? config.payment.qrUrl,
    wechatGroupQrUrl: getSetting("wechat_group_qr_url") ?? "",
    wechatGroupNote: getSetting("wechat_group_note") ?? "",
    earlyBirdLimit: num("early_bird_limit", config.earlyBird.limit),
    earlyBirdPriceCents: num("early_bird_price_cents", config.earlyBird.priceCents),
    referralDays: num("referral_days", config.referral.days),
  };
}
