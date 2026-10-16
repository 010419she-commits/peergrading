// billing/admin.ts — 站主后台（/admin）：内测开关、收款设置、早鸟 / 邀请参数、微信群入口、用户剩余天数、订单确认、手动赠送
import fs from "node:fs";
import path from "node:path";
import express, { Router, type Request, type Response, type NextFunction } from "express";
import { q, transaction } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { hasEntitlement, grantEntitlement } from "../auth/entitlements.ts";
import { requireAuthApi, requireBrowser } from "../auth/middleware.ts";
import { getUser } from "../auth/users.ts";
import { requireCsrf, now, AuthError, randomToken, logAuthError } from "../auth/security.ts";
import { accessStatus } from "./access.ts";
import { setSetting, siteSettings, betaFree } from "./settings.ts";
import { earlyBirdStats } from "./catalog.ts";
import { settlePendingReferrals } from "./referral.ts";
import { getOrder, processPayment } from "./orders.ts";

export const ADMIN_ENTITLEMENT = "admin";
export const isAdmin = (u: any) => !!u && (config.adminUserIds.includes(Number(u.id)) || hasEntitlement(u.id, ADMIN_ENTITLEMENT));
export const requireAdminApi = (req: Request, res: Response, next: NextFunction) => {
  const u = (req as any).user;
  if (!u) return res.status(401).json({ error: "unauthenticated" });
  if (!isAdmin(u)) return res.status(404).json({ error: "not_found" });
  next();
};

/** 切换内测免费。关闭时记录时间（试用从此刻重新起算）并发放未发放的邀请奖励。必须在事务内调用 */
export function applyBetaFree(on: boolean) {
  setSetting("beta_free", on ? "1" : "0");
  if (on) return 0;
  setSetting("beta_ended_at", String(now()));
  return settlePendingReferrals();
}

function adminUsers() {
  const rows = q(`SELECT u.id, u.display_name, u.created_at, u.status, u.referral_code,
      (SELECT group_concat(DISTINCT provider) FROM identities i WHERE i.user_id = u.id) AS providers,
      (SELECT MAX(created_at) FROM sessions s WHERE s.user_id = u.id) AS last_login,
      (SELECT MAX(last_seen_at) FROM device_tokens d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS last_seen,
      (SELECT COUNT(*) FROM usage_events e WHERE e.user_id = u.id AND e.kind = 'run') AS runs,
      (SELECT COUNT(*) FROM referrals r WHERE r.inviter_id = u.id) AS invited,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_orders
    FROM users u ORDER BY u.id DESC LIMIT 2000`).all();
  return rows.map((u: any) => {
    const a = accessStatus(u);
    return {
      id: u.id, name: u.display_name, status: u.status, createdAt: u.created_at, providers: String(u.providers || "").split(",").filter(Boolean),
      lastActive: Math.max(Number(u.last_login || 0), Number(u.last_seen || 0)) || null, runs: Number(u.runs), invited: Number(u.invited), paidOrders: Number(u.paid_orders),
      admin: isAdmin(u),
      access: { allowed: a.allowed, member: a.member, permanent: a.permanent, memberUntil: a.memberUntil, daysLeft: a.daysLeft,
        trialActive: a.trial.active, trialEndsAt: a.trial.endsAt, usesLeft: a.trial.usesLeft, reason: a.reason ?? null },
    };
  });
}
const adminOrders = () => q(`SELECT o.merchant_order_no AS no, o.user_id AS userId, u.display_name AS userName, o.plan_code AS plan, o.amount_cents AS amountCents, o.currency,
    o.status, o.created_at AS createdAt, o.paid_at AS paidAt, o.provider
  FROM orders o JOIN users u ON u.id = o.user_id WHERE o.merchant_id = ? ORDER BY o.id DESC LIMIT 200`).all(config.payment.merchantId);

export const admin = Router();
admin.get("/api/admin/overview", requireAuthApi, requireAdminApi, (req, res) => {
  const users = adminUsers(), orders = adminOrders();
  res.json({
    me: { id: (req as any).user.id }, settings: { ...siteSettings(), referralMax: config.referral.maxPerUser, referralClaimDays: config.referral.claimDays }, earlyBird: earlyBirdStats(), users, orders,
    stats: { users: Number(q("SELECT COUNT(*) AS c FROM users").get()?.c ?? 0), listed: users.length, members: users.filter((x) => x.access.member).length, trialActive: users.filter((x) => !x.access.member && x.access.trialActive).length,
      pendingOrders: Number(q("SELECT COUNT(*) AS c FROM orders WHERE merchant_id = ? AND status = 'pending'").get(config.payment.merchantId)?.c ?? 0),
      pendingReferrals: Number(q("SELECT COUNT(*) AS c FROM referrals WHERE settled_at IS NULL").get()?.c ?? 0), referrals: Number(q("SELECT COUNT(*) AS c FROM referrals").get()?.c ?? 0) },
  });
});

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number) => { if (v === undefined || v === null || v === "") return undefined; const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : NaN; };

admin.post("/api/admin/settings", requireBrowser, requireAuthApi, requireAdminApi, requireCsrf, (req, res) => {
  const b = req.body || {};
  const trace = randomToken(6);
  try {
    const settled = transaction(() => {
      let settled = 0;
      if (typeof b.betaFree === "boolean" && b.betaFree !== betaFree()) settled = applyBetaFree(b.betaFree);
      const pi = str(b.payInstructions, 2000); if (pi !== undefined) setSetting("pay_instructions", pi);
      const note = str(b.wechatGroupNote, 500); if (note !== undefined) setSetting("wechat_group_note", note);
      for (const [field, key, min, max] of [["earlyBirdLimit", "early_bird_limit", 0, 1000000], ["earlyBirdPriceCents", "early_bird_price_cents", 1, 100000000], ["referralDays", "referral_days", 0, 3650]] as const) {
        const n = int(b[field], min, max);
        if (n === undefined) continue;
        if (Number.isNaN(n)) throw new AuthError("bad_" + field);
        setSetting(key, String(n));
      }
      return settled;
    });
    res.json({ ok: true, settings: siteSettings(), earlyBird: earlyBirdStats(), settledReferrals: settled });
  } catch (e: any) { logAuthError(e, trace); res.status(e instanceof AuthError ? 400 : 500).json({ error: e?.code || "failed" }); }
});

/* ---------- 图片上传：收款码 / 微信群二维码（body 为图片原始字节） ---------- */
const KINDS: Record<string, string> = { pay_qr: "pay_qr_url", wechat_group: "wechat_group_qr_url" };
const settingKeyFor = (kind: string) => (Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined);
const EXTS = ["png", "jpg", "webp"];
function sniff(b: Buffer) {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}
const removeUpload = (kind: string) => { for (const e of EXTS) { try { fs.unlinkSync(path.join(config.uploadsDir, `${kind}.${e}`)); } catch {} } };
admin.post("/api/admin/upload", requireBrowser, requireAuthApi, requireAdminApi, requireCsrf, express.raw({ type: () => true, limit: "5mb" }), (req, res) => {
  const kind = String(req.query.kind || ""), key = settingKeyFor(kind);
  if (!key) return res.status(400).json({ error: "bad_kind" });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "empty" });
  const ext = sniff(buf);
  if (!ext) return res.status(415).json({ error: "unsupported_type" });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  removeUpload(kind);
  fs.writeFileSync(path.join(config.uploadsDir, `${kind}.${ext}`), buf);
  const url = `/uploads/${kind}.${ext}?v=${now()}`;
  setSetting(key, url);
  res.json({ ok: true, url });
});
admin.post("/api/admin/upload/clear", requireBrowser, requireAuthApi, requireAdminApi, requireCsrf, (req, res) => {
  const kind = String(req.body?.kind || ""), key = settingKeyFor(kind);
  if (!key) return res.status(400).json({ error: "bad_kind" });
  removeUpload(kind);
  setSetting(key, "");
  res.json({ ok: true });
});

/* ---------- 订单：站主确认收款（线下转账 / 扫码） ---------- */
admin.post("/api/admin/orders/:no/confirm", requireBrowser, requireAuthApi, requireAdminApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  const o = getOrder(String(req.params.no));
  if (!o) return res.status(404).json({ error: "not_found" });
  try {
    const r = processPayment({ provider: "manual", eventId: `manual-${o.merchant_order_no}`, merchantOrderNo: o.merchant_order_no, amountCents: o.amount_cents, currency: o.currency,
      providerTxnId: String(req.body?.txn || "").trim().slice(0, 80) || `manual-${o.merchant_order_no}`, payload: JSON.stringify({ by: "admin", adminId: u.id, at: now() }) });
    res.json({ ok: true, result: r, access: accessStatus(getUser(o.user_id)) });
  } catch (e: any) { res.status(e instanceof AuthError ? 409 : 500).json({ error: e?.code || "failed" }); }
});

/* ---------- 手动赠送会员天数 / 永久 ---------- */
admin.post("/api/admin/users/:id/grant", requireBrowser, requireAuthApi, requireAdminApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  const target = getUser(Number(req.params.id));
  if (!target) return res.status(404).json({ error: "not_found" });
  const permanent = req.body?.period === "permanent";
  const days = permanent ? null : int(req.body?.days, 1, 3650);
  if (!permanent && (days === undefined || Number.isNaN(days))) return res.status(400).json({ error: "bad_days" });
  try {
    transaction(() => grantEntitlement({ userId: target.id, entitlement: config.plan.entitlement, sourceType: "admin", sourceRef: `${u.id}-${now()}-${randomToken(4)}`,
      mode: permanent ? "permanent" : "days", days: permanent ? null : (days as number) }));
    res.json({ ok: true, access: accessStatus(target) });
  } catch (e: any) { res.status(e instanceof AuthError ? 400 : 500).json({ error: e?.code || "failed" }); }
});
