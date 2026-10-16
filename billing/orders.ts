// billing/orders.ts — 订单与支付回调处理（v9 §6.4：单事务、幂等、验签）
import crypto from "node:crypto";
import { q, transaction } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { grantEntitlement } from "../auth/entitlements.ts";
import { now, randomToken, AuthError, timingEq } from "../auth/security.ts";
import { getPlan, earlyBirdStats, EARLY_BIRD } from "./catalog.ts";

/** 下单。限量方案（早鸟）名额用完抛 sold_out。建议在事务内调用，避免并发超卖 */
export function createOrder(userId: number, planCode: string = config.plan.code) {
  const p = getPlan(planCode);
  if (!p) throw new AuthError("unknown_plan");
  if (p.limit != null && earlyBirdStats().left <= 0) throw new AuthError("sold_out");
  const no = `DA${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${randomToken(6).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase()}`;
  const snapshot = JSON.stringify({ code: p.code, version: p.version, name: p.name, mode: p.mode, days: p.days, entitlement: p.entitlement, limit: p.limit });
  q(`INSERT INTO orders (user_id, merchant_id, merchant_order_no, plan_code, plan_version, plan_snapshot, amount_cents, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, config.payment.merchantId, no, p.code, p.version, snapshot, p.priceCents, p.currency);
  return getOrder(no);
}
export const getOrder = (no: string) => q("SELECT * FROM orders WHERE merchant_id = ? AND merchant_order_no = ?").get(config.payment.merchantId, no) || null;
/** 关闭一笔待支付订单（占用时限已过：重新下单以重查名额与现价） */
export const closeOrder = (no: string) => q("UPDATE orders SET status = 'closed' WHERE merchant_id = ? AND merchant_order_no = ? AND status = 'pending'").run(config.payment.merchantId, no);
export const listOrders = (userId: number) => q("SELECT merchant_order_no, plan_code, amount_cents, currency, status, created_at, paid_at, provider FROM orders WHERE user_id = ? AND merchant_id = ? ORDER BY id DESC LIMIT 20").all(userId, config.payment.merchantId);

export interface PaymentNotice {
  provider: string; eventId: string; merchantId?: string; merchantOrderNo: string;
  amountCents: number; currency: string; providerTxnId: string; payload: string;
}

/**
 * 处理一次"已支付"通知。单事务：事件入库（唯一键）→ 校验商户/订单/金额/币种/状态 → 订单 paid → 发权益 → processed_at。
 * 返回 'processed' | 'duplicate'；校验失败抛 AuthError（调用方返回 4xx，渠道不应重试）。
 */
export function processPayment(n: PaymentNotice): "processed" | "duplicate" {
  return transaction(() => {
    const merchantId = n.merchantId || config.payment.merchantId;
    if (merchantId !== config.payment.merchantId) throw new AuthError("bad_merchant");
    const existing = q("SELECT id, processed_at FROM payment_events WHERE provider = ? AND merchant_id = ? AND event_id = ?").get(n.provider, merchantId, n.eventId);
    if (existing) {
      if (existing.processed_at) return "duplicate";
      throw new AuthError("event_in_progress");           // 并发重复：让渠道稍后重试
    }
    const evId = Number(q("INSERT INTO payment_events (provider, merchant_id, event_id, payload) VALUES (?, ?, ?, ?)").run(n.provider, merchantId, n.eventId, n.payload).lastInsertRowid);
    const order = q("SELECT * FROM orders WHERE merchant_id = ? AND merchant_order_no = ?").get(merchantId, n.merchantOrderNo);
    if (!order) throw new AuthError("unknown_order");
    if (order.amount_cents !== n.amountCents || order.currency !== n.currency) throw new AuthError("amount_mismatch");
    if (order.status === "paid") {
      // 同一订单的另一条支付事件：不重复发权益
      q("UPDATE payment_events SET processed_at = ? WHERE id = ?").run(now(), evId);
      return "duplicate";
    }
    if (order.status !== "pending") throw new AuthError("order_not_pending");
    const plan = JSON.parse(order.plan_snapshot);
    // 限量方案：发放前再查一次名额（待支付订单只占用 24 小时，之后名额可能已被别人买走）。名额已满则不发放、订单保持待支付，由站主退款或手动赠送
    if (order.plan_code === EARLY_BIRD && plan.limit != null) {
      const eb = earlyBirdStats();
      if (eb.sold >= eb.limit) throw new AuthError("sold_out");
    }
    q("UPDATE orders SET status = 'paid', provider = ?, provider_txn_id = ?, paid_at = ? WHERE id = ?").run(n.provider, n.providerTxnId, now(), order.id);
    grantEntitlement({ userId: order.user_id, entitlement: plan.entitlement, sourceType: "order", sourceRef: order.merchant_order_no,
      mode: plan.mode === "days" ? "days" : "permanent", days: plan.mode === "days" ? plan.days : null });
    q("UPDATE payment_events SET processed_at = ? WHERE id = ?").run(now(), evId);
    return "processed";
  });
}

/** 通用回调验签：HMAC-SHA256(secret, rawBody) 放在 x-signature 头。真实渠道（微信支付 / 支付宝）接入时替换为各自的验签逻辑 */
export function verifyWebhookSignature(raw: Buffer, signature: string | undefined) {
  if (!config.payment.webhookSecret || !signature) return false;
  const expect = crypto.createHmac("sha256", config.payment.webhookSecret).update(raw).digest("hex");
  return timingEq(expect, signature.trim().toLowerCase());
}
