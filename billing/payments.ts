import crypto from "node:crypto";
import QRCode from "qrcode";
import { db, q, transaction } from "../auth/db.ts";
import { config } from "../auth/config.ts";
import { AuthError, now } from "../auth/security.ts";
import { closeOrder, getOrder, processPayment } from "./orders.ts";
import { RESERVE_SEC } from "./catalog.ts";
import { airwallexRequest, airwallexSettings, decryptWechatResource, verifyAirwallexSignature, verifyWechatSignature, wechatRequest, wechatSettings } from "./providers.ts";
import type { WechatHeaders } from "./providers.ts";

// One checkout channel per order. Persist UUID before the first request, including when a request times out.
db.exec(`CREATE TABLE IF NOT EXISTS payment_checkouts (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id),
  provider TEXT NOT NULL CHECK (provider IN ('wechat','airwallex')),
  request_id TEXT NOT NULL UNIQUE,
  provider_account_id TEXT NOT NULL,
  provider_app_id TEXT,
  provider_reference TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(provider, provider_account_id, provider_reference)
)`);

export const checkoutRecord = (orderId: number) => q("SELECT * FROM payment_checkouts WHERE order_id = ?").get(orderId) || null;
export const checkoutExpired = (orderId: number) => { const c = checkoutRecord(orderId); return !!c && c.expires_at <= now(); };
const twoDecimalCurrencies = new Set(["CNY", "USD", "EUR", "GBP", "HKD", "SGD", "AUD", "CAD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "MYR", "THB", "PHP", "INR", "IDR", "BRL", "MXN", "AED", "SAR", "ZAR"]);
function validOrderAmount(order: any) {
  if (!Number.isSafeInteger(order.amount_cents) || order.amount_cents <= 0) throw new AuthError("payment_amount_invalid");
  if (!twoDecimalCurrencies.has(order.currency)) throw new AuthError("payment_currency_unsupported");
}
function callbackUrl(provider: string) {
  // WeChat Native and production Airwallex require a publicly reachable TLS endpoint.
  if (!config.baseUrl.startsWith("https://") && (provider === "wechat" || airwallexSettings().sdkEnv === "prod")) throw new AuthError("payment_https_required");
  return `${config.baseUrl}/api/billing/webhooks/${provider}`;
}
function returnUrl(no: string) { return `${config.baseUrl}/account?order=${encodeURIComponent(no)}`; }

const creating = new Map<string, Promise<any>>();
export async function createCheckout(no: string, provider: string) {
  if (!["wechat", "airwallex"].includes(provider)) throw new AuthError("payment_provider_invalid");
  const key = `${config.payment.merchantId}:${no}`;
  const running = creating.get(key);
  if (running) {
    await running;
    return createCheckout(no, provider);
  }
  const promise = createCheckoutOnce(no, provider);
  creating.set(key, promise);
  try { return await promise; } finally { creating.delete(key); }
}
async function createCheckoutOnce(no: string, provider: string) {
  const order = getOrder(no);
  if (!order) throw new AuthError("unknown_order");
  if (order.status !== "pending") throw new AuthError("order_not_pending");
  validOrderAmount(order);
  const wx = provider === "wechat" ? wechatSettings() : null;
  const aw = provider === "airwallex" ? airwallexSettings() : null;
  if (wx && order.currency !== "CNY") throw new AuthError("wechat_requires_cny");
  const notifyUrl = callbackUrl(provider);
  const accountId = wx?.mchId || aw!.accountId;
  const checkout = transaction(() => {
    let c = checkoutRecord(order.id);
    if (c) {
      if (c.provider !== provider) throw new AuthError("checkout_provider_locked");
      if (c.provider_account_id !== accountId || (wx && c.provider_app_id !== wx.appId)) throw new AuthError("checkout_account_changed");
      if (c.expires_at <= now()) throw new AuthError("checkout_expired");
      return c;
    }
    const plan = JSON.parse(order.plan_snapshot);
    const expiry = Math.min(now() + (wx ? 1800 : 3600), plan.limit == null ? Infinity : Number(order.created_at) + RESERVE_SEC);
    if (expiry <= now() + 60) throw new AuthError("checkout_expired");
    q("INSERT INTO payment_checkouts (order_id, provider, request_id, provider_account_id, provider_app_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(order.id, provider, crypto.randomUUID(), accountId, wx?.appId || null, now(), expiry);
    return checkoutRecord(order.id);
  });
  if (checkout.payload) return checkoutView(checkout, order);
  if (wx) {
    const data = await wechatRequest("POST", "/v3/pay/transactions/native", { appid: wx.appId, mchid: wx.mchId,
      description: String(JSON.parse(order.plan_snapshot).name || config.plan.name).slice(0, 40),
      out_trade_no: no, time_expire: new Date(checkout.expires_at * 1000).toISOString(), notify_url: notifyUrl,
      amount: { total: order.amount_cents, currency: order.currency } });
    if (typeof data.code_url !== "string" || !/^weixin:\/\/(?:wxpay\/|pay\.wechatpay\.cn\/bizpayurl\/)/.test(data.code_url)) throw new AuthError("payment_bad_response");
    q("UPDATE payment_checkouts SET provider_reference = ?, payload = ? WHERE order_id = ?").run(no, JSON.stringify({ codeUrl: data.code_url }), order.id);
  } else {
    const data = await airwallexRequest("POST", "/api/v1/pa/payment_intents/create", {
      request_id: checkout.request_id, amount: order.amount_cents / 100, currency: order.currency, merchant_order_id: no,
      return_url: returnUrl(no), metadata: { peergrading_merchant: config.payment.merchantId },
    });
    if (typeof data.id !== "string" || !data.id || typeof data.client_secret !== "string" || !data.client_secret || data.merchant_order_id !== no || data.currency !== order.currency || majorUnitsToCents(data.amount) !== order.amount_cents) throw new AuthError("payment_bad_response");
    q("UPDATE payment_checkouts SET provider_reference = ?, payload = ? WHERE order_id = ?").run(data.id, JSON.stringify({ intentId: data.id, clientSecret: data.client_secret }), order.id);
  }
  return checkoutView(checkoutRecord(order.id), order);
}
async function checkoutView(checkout: any, order: any) {
  const payload = JSON.parse(checkout.payload);
  if (checkout.provider === "wechat") return { kind: "qr", provider: "wechat", ...payload, qrDataUrl: await QRCode.toDataURL(payload.codeUrl, { width: 280, margin: 2 }), expiresAt: checkout.expires_at };
  const settings = airwallexSettings();
  return { kind: "airwallex", provider: "airwallex", ...payload, currency: order.currency, env: settings.sdkEnv, countryCode: settings.countryCode,
    successUrl: returnUrl(order.merchant_order_no), cancelUrl: returnUrl(order.merchant_order_no), expiresAt: checkout.expires_at };
}
/** Do not round fractional cents or coerce null/empty values into a valid amount. */
export function majorUnitsToCents(value: unknown) {
  const str = typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(str)) throw new AuthError("payment_amount_invalid");
  const [whole, fraction = ""] = str.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new AuthError("payment_amount_invalid");
  return cents;
}
function requiredString(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 256) throw new AuthError("bad_payment_notice");
  return value;
}
function boundCheckout(no: string, provider: string, accountId: string) {
  const order = getOrder(no);
  if (!order) throw new AuthError("unknown_order");
  const checkout = checkoutRecord(order.id);
  if (!checkout || checkout.provider !== provider || checkout.provider_account_id !== accountId) throw new AuthError("payment_checkout_mismatch");
  return checkout;
}
function settleWechat(transactionData: any, eventId: string, payload: string) {
  if (!transactionData || typeof transactionData !== "object") throw new AuthError("bad_payment_notice");
  const settings = wechatSettings();
  if (transactionData.mchid !== settings.mchId || transactionData.appid !== settings.appId) throw new AuthError("bad_merchant");
  if (transactionData.trade_type !== "NATIVE") throw new AuthError("payment_checkout_mismatch");
  const no = requiredString(transactionData.out_trade_no), c = boundCheckout(no, "wechat", settings.mchId);
  if (c.provider_app_id !== transactionData.appid) throw new AuthError("bad_merchant");
  if (transactionData.trade_state === "CLOSED") { closeOrder(no); return "closed"; }
  if (transactionData.trade_state !== "SUCCESS") return "ignored";
  if (!Number.isSafeInteger(transactionData.amount?.total) || transactionData.amount.total <= 0 || transactionData.amount.currency !== "CNY") throw new AuthError("payment_amount_invalid");
  return processPayment({ provider: "wechat", eventId, merchantOrderNo: no, amountCents: transactionData.amount.total, currency: transactionData.amount.currency,
    providerTxnId: requiredString(transactionData.transaction_id), payload });
}
export function receiveWechatNotice(raw: Buffer, headers: WechatHeaders) {
  const settings = wechatSettings();
  if (!verifyWechatSignature(raw, headers, settings)) throw new AuthError("bad_signature");
  let event: any; try { event = JSON.parse(raw.toString("utf8")); } catch { throw new AuthError("bad_payment_notice"); }
  if (!event || typeof event !== "object") throw new AuthError("bad_payment_notice");
  requiredString(event.id);
  if (event.event_type !== "TRANSACTION.SUCCESS") return "ignored";
  if (event.resource_type !== "encrypt-resource") throw new AuthError("bad_payment_resource");
  return settleWechat(decryptWechatResource(event.resource, settings.apiV3Key), event.id, raw.toString("utf8"));
}
function settleAirwallex(intent: any, eventId: string, payload: string, accountId: string) {
  if (!intent || typeof intent !== "object") throw new AuthError("bad_payment_notice");
  const no = requiredString(intent.merchant_order_id), checkout = boundCheckout(no, "airwallex", accountId);
  if (requiredString(intent.id) !== checkout.provider_reference || intent.metadata?.peergrading_merchant !== config.payment.merchantId) throw new AuthError("payment_checkout_mismatch");
  if (intent.status === "CANCELLED") { closeOrder(no); return "closed"; }
  if (intent.status !== "SUCCEEDED") return "ignored";
  const amountCents = majorUnitsToCents(intent.amount);
  // Card authorizations/requires_capture and partial captures cannot issue membership.
  if (majorUnitsToCents(intent.captured_amount) !== amountCents) throw new AuthError("amount_mismatch");
  return processPayment({ provider: "airwallex", eventId, merchantOrderNo: no, amountCents, currency: requiredString(intent.currency), providerTxnId: intent.id, payload });
}
export function receiveAirwallexNotice(raw: Buffer, timestamp?: string, signature?: string) {
  const settings = airwallexSettings();
  if (!verifyAirwallexSignature(raw, timestamp, signature, settings.webhookSecret)) throw new AuthError("bad_signature");
  let event: any; try { event = JSON.parse(raw.toString("utf8")); } catch { throw new AuthError("bad_payment_notice"); }
  if (!event || typeof event !== "object") throw new AuthError("bad_payment_notice");
  requiredString(event.id);
  if (event.accountId !== settings.accountId) throw new AuthError("bad_merchant");
  if (event.name !== "payment_intent.succeeded") return "ignored";
  return settleAirwallex(event.data?.object, event.id, raw.toString("utf8"), settings.accountId);
}

/** Explicit recovery action: a signed/TLS-authenticated provider query can settle missed notifications. */
export async function syncCheckout(no: string) {
  const order = getOrder(no);
  if (!order) throw new AuthError("unknown_order");
  if (order.status !== "pending") return "ignored";
  const c = checkoutRecord(order.id);
  if (!c) return "ignored";
  if (c.provider === "wechat") {
    const s = wechatSettings();
    const result = await wechatRequest("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(no)}?mchid=${encodeURIComponent(s.mchId)}`);
    return settleWechat(result, `query:${requiredString(result.transaction_id || no)}`, JSON.stringify(result));
  }
  if (!c.provider_reference) throw new AuthError("payment_checkout_incomplete");
  const s = airwallexSettings();
  const result = await airwallexRequest("GET", `/api/v1/pa/payment_intents/${encodeURIComponent(c.provider_reference)}`);
  return settleAirwallex(result, `query:${c.provider_reference}`, JSON.stringify(result), s.accountId);
}

/** Close remotely before releasing the local order; an expired browser session may still be paying. */
export async function retireCheckout(no: string) {
  const order = getOrder(no);
  if (!order || order.status !== "pending") return;
  const checkout = checkoutRecord(order.id);
  if (!checkout) return;
  await syncCheckout(no);
  if (getOrder(no).status !== "pending") return;
  try {
    if (checkout.provider === "wechat") {
      const settings = wechatSettings();
      await wechatRequest("POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(no)}/close`, { mchid: settings.mchId });
    } else {
      if (!checkout.provider_reference) throw new AuthError("payment_checkout_incomplete");
      // A distinct, deterministic UUID also makes cancellation safe to retry after a timeout.
      const digest = crypto.createHash("sha256").update(`cancel:${checkout.request_id}`).digest();
      digest[6] = (digest[6] & 15) | 64; digest[8] = (digest[8] & 63) | 128;
      const h = digest.subarray(0, 16).toString("hex"), cancelId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      const result = await airwallexRequest("POST", `/api/v1/pa/payment_intents/${encodeURIComponent(checkout.provider_reference)}/cancel`, { request_id: cancelId });
      if (result.id !== checkout.provider_reference || result.status !== "CANCELLED") throw new AuthError("payment_cancel_unconfirmed");
    }
  } catch (error) {
    // Cancellation can race a successful capture; recover that payment before deciding to retry.
    await syncCheckout(no);
    if (getOrder(no).status === "pending") throw error;
  }
}
