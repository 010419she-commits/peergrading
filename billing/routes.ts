// billing/routes.ts — 定价 / 下单 / 订单查询 / 支付回调 / 本地模拟支付
import express, { Router } from "express";
import { config } from "../auth/config.ts";
import { requireBrowser, requireAuthApi } from "../auth/middleware.ts";
import { requireCsrf, AuthError, logAuthError, randomToken } from "../auth/security.ts";
import { accessStatus } from "./access.ts";
import { createOrder, getOrder, listOrders, processPayment, verifyWebhookSignature } from "./orders.ts";
import { publicPlan } from "../auth/routes.ts";

export const billing = Router();

billing.get("/api/billing/status", (req, res) => {
  const u = (req as any).user;
  res.json({ plan: publicPlan(), access: u ? accessStatus(u) : null, orders: u ? listOrders(u.id) : [] });
});

/** 下单：返回订单号与付款指引（真实渠道接入后在此调用渠道下单并返回支付链接 / 二维码） */
billing.post("/api/billing/orders", requireBrowser, requireAuthApi, requireCsrf, (req, res) => {
  const u = (req as any).user;
  const pending = listOrders(u.id).find((o: any) => o.status === "pending");
  const order = pending ? getOrder(pending.merchant_order_no) : createOrder(u.id);
  res.json({ order: orderView(order) });
});
billing.get("/api/billing/orders/:no", requireAuthApi, (req, res) => {
  const u = (req as any).user;
  const o = getOrder(String(req.params.no));
  if (!o || o.user_id !== u.id) return res.status(404).json({ error: "not_found" });
  res.json({ order: orderView(o), access: accessStatus(u) });
});
function orderView(o: any) {
  return { no: o.merchant_order_no, amountCents: o.amount_cents, currency: o.currency, status: o.status, createdAt: o.created_at, paidAt: o.paid_at,
    instructions: config.payment.instructions, qrUrl: config.payment.qrUrl, mockPay: config.devLogin };
}

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
