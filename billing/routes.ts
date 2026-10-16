// billing/routes.ts — 定价 / 下单 / 订单查询 / 支付回调 / 邀请 / 本地模拟支付
import express, { Router } from "express";
import { config } from "../auth/config.ts";
import { transaction } from "../auth/db.ts";
import { requireBrowser, requireAuthApi } from "../auth/middleware.ts";
import { requireCsrf, AuthError, logAuthError, randomToken, now } from "../auth/security.ts";
import { accessStatus } from "./access.ts";
import { createOrder, closeOrder, getOrder, listOrders, processPayment, verifyWebhookSignature } from "./orders.ts";
import { publicPlan } from "./plan.ts";
import { getPlan, RESERVE_SEC } from "./catalog.ts";
import { betaFree, siteSettings } from "./settings.ts";
import { claimReferral, referralSummary } from "./referral.ts";

export const billing = Router();

billing.get("/api/billing/status", (req, res) => {
  const u = (req as any).user;
  res.json({ plan: publicPlan(), access: u ? accessStatus(u) : null, orders: u ? listOrders(u.id) : [] });
});

/** 下单：返回订单号与付款指引。内测免费期间不开放（403 beta_free）；限量方案售罄 409 sold_out */
billing.post("/api/billing/orders", requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  if (betaFree()) return res.status(403).json({ error: "beta_free" });
  const plan = typeof req.body?.plan === "string" ? getPlan(req.body.plan) : null;
  const planCode = plan ? plan.code : config.plan.code;
  try {
    // 限量方案的待支付订单只占用名额 24 小时：过期的先关闭（即使随后售罄也保持关闭），再重新下单（重查名额、按现价）；不限量方案沿用原订单
    const reused = transaction(() => {
      const pendings = listOrders(u.id).filter((o: any) => o.status === "pending" && o.plan_code === planCode);
      const reusable = plan?.limit == null ? pendings[0] : pendings.find((o: any) => Number(o.created_at) > now() - RESERVE_SEC);
      if (reusable) return getOrder(reusable.merchant_order_no);
      for (const o of pendings) closeOrder(o.merchant_order_no);
      return null;
    });
    const order = reused ?? transaction(() => createOrder(u.id, planCode));
    res.json({ order: orderView(order) });
  } catch (e: any) {
    res.status(e instanceof AuthError && e.code === "sold_out" ? 409 : 400).json({ error: e?.code || "failed" });
  }
});
billing.get("/api/billing/orders/:no", requireAuthApi, (req, res) => {
  const u = (req as any).user;
  const o = getOrder(String(req.params.no));
  if (!o || o.user_id !== u.id) return res.status(404).json({ error: "not_found" });
  res.json({ order: orderView(o), access: accessStatus(u) });
});
function orderView(o: any) {
  const s = siteSettings();
  return { no: o.merchant_order_no, plan: o.plan_code, amountCents: o.amount_cents, currency: o.currency, status: o.status, createdAt: o.created_at, paidAt: o.paid_at,
    instructions: s.payInstructions, qrUrl: s.payQrUrl, mockPay: config.devLogin };
}

/** 邀请：我的邀请码 / 链接 / 奖励；被邀请者在注册后一周内可手动填码 */
billing.get("/api/referral", requireAuthApi, (req, res) => res.json({ referral: referralSummary((req as any).user.id) }));
billing.post("/api/referral/claim", requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  try {
    const r = transaction(() => claimReferral(u.id, req.body?.code));
    res.json({ ok: true, days: r.invitee_days, settled: !!r.settled_at, referral: referralSummary(u.id), access: accessStatus(u) });
  } catch (e: any) { res.status(e instanceof AuthError ? 409 : 500).json({ error: e?.code || "failed" }); }
});

/** 支付回调：raw body 验签。未配置密钥 → 501，不发放权益 */
export const paymentWebhook = [express.raw({ type: "*/*", limit: "1mb" }), (req: express.Request, res: express.Response) => {
  if (!config.payment.webhookSecret) return res.status(501).json({ error: "payment_not_configured" });
  const raw = req.body as Buffer;
  if (!verifyWebhookSignature(raw, req.get("x-signature"))) return res.status(401).json({ error: "bad_signature" });
  const trace = randomToken(6);
  try {
    const b = JSON.parse(raw.toString("utf8"));
    const r = processPayment({ provider: String(b.provider || "webhook"), eventId: String(b.event_id), merchantId: b.merchant_id, merchantOrderNo: String(b.merchant_order_no),
      amountCents: Number(b.amount_cents), currency: String(b.currency), providerTxnId: String(b.provider_txn_id || b.event_id), payload: raw.toString("utf8") });
    res.json({ ok: true, result: r });
  } catch (e: any) {
    logAuthError(e, trace);
    if (e instanceof AuthError && e.code === "event_in_progress") return res.status(503).json({ error: e.code });
    res.status(e instanceof AuthError ? 400 : 500).json({ error: e?.code || "failed" });
  }
}];

/** 仅本地开发：模拟支付成功，用于验证整条权益发放链路 */
billing.post("/api/dev/pay", requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  if (!config.devLogin) return res.status(404).end();
  const u = (req as any).user;
  const o = getOrder(String(req.body?.no || ""));
  if (!o || o.user_id !== u.id) return res.status(404).json({ error: "not_found" });
  try {
    const r = processPayment({ provider: "mock", eventId: `mock-${o.merchant_order_no}`, merchantOrderNo: o.merchant_order_no, amountCents: o.amount_cents, currency: o.currency, providerTxnId: `mock-${randomToken(6)}`, payload: "{}" });
    res.json({ ok: true, result: r, access: accessStatus(u) });
  } catch (e: any) { res.status(400).json({ error: e?.code || "failed" }); }
});
