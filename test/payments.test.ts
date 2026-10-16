import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-payments-"));
const merchant = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantKey = path.join(tmp, "merchant.pem"), platformKey = path.join(tmp, "platform.pem");
fs.writeFileSync(merchantKey, merchant.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(platformKey, platform.publicKey.export({ type: "spki", format: "pem" }));
Object.assign(process.env, { DATA_DIR: tmp, BASE_URL: "https://payments.example.test", FREE_BETA: "0", SESSION_SECRET: "unit-test-session-secret-32-characters", NODE_ENV: "test",
  MERCHANT_ID: "test-store", WECHAT_PAY_MCH_ID: "wx-merchant", WECHAT_PAY_APP_ID: "wx-app", WECHAT_PAY_CERT_SERIAL: "merchant-serial",
  WECHAT_PAY_PRIVATE_KEY_PATH: merchantKey, WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef",
  WECHAT_PAY_PLATFORM_KEY_ID: "PUB_KEY_ID_123", WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH: platformKey,
  AIRWALLEX_CLIENT_ID: "test-client", AIRWALLEX_API_KEY: "test-api-key", AIRWALLEX_ACCOUNT_ID: "test-account", AIRWALLEX_WEBHOOK_SECRET: "test-webhook-secret", AIRWALLEX_ENV: "sandbox" });

const { db, q, transaction } = await import("../auth/db.ts");
const { createOrder, getOrder } = await import("../billing/orders.ts");
const { createCheckout, checkoutRecord, majorUnitsToCents, receiveWechatNotice, receiveAirwallexNotice, syncCheckout, retireCheckout } = await import("../billing/payments.ts");
const { paymentProviders, verifyWechatSignature, verifyAirwallexSignature } = await import("../billing/providers.ts");
const { billing, wechatWebhook, airwallexWebhook } = await import("../billing/routes.ts");
const { issueCsrf } = await import("../auth/security.ts");
const realFetch = globalThis.fetch;
let intentCreates = 0;
const requests: any[] = [];
const intents = new Map<string, any>();
const intentRequests = new Map<string, any>();
const wxTransactions = new Map<string, any>();
function wxSignature(raw: Buffer, timestamp = String(Math.floor(Date.now() / 1000)), nonce = "response-nonce") {
  return { serial: "PUB_KEY_ID_123", timestamp, nonce, signature: crypto.sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), raw, Buffer.from("\n")]), platform.privateKey).toString("base64") };
}
function wxResponse(data: any) {
  const raw = Buffer.from(JSON.stringify(data)), h = wxSignature(raw);
  return new Response(raw, { status: 200, headers: { "content-type": "application/json", "wechatpay-serial": h.serial, "wechatpay-timestamp": h.timestamp, "wechatpay-nonce": h.nonce, "wechatpay-signature": h.signature } });
}
globalThis.fetch = async (input: any, init?: RequestInit) => {
  const url = String(input), body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ url, init, body });
  if (url.endsWith("/authentication/login")) return Response.json({ token: "test-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (url.endsWith("/payment_intents/create")) {
    if (intentRequests.has(body.request_id)) return Response.json(intentRequests.get(body.request_id));
    intentCreates++;
    const intent = { id: `int_${intentCreates}`, client_secret: `secret_${intentCreates}`, merchant_order_id: body.merchant_order_id, amount: body.amount, currency: body.currency,
      metadata: body.metadata, captured_amount: 0, status: "REQUIRES_PAYMENT_METHOD" };
    intents.set(intent.id, intent);
    intentRequests.set(body.request_id, intent);
    return Response.json(intent);
  }
  if (url.endsWith("/cancel")) {
    const intent = intents.get(url.split("/").at(-2)!);
    intent.status = "CANCELLED";
    return Response.json(intent);
  }
  if (url.includes("/payment_intents/")) return Response.json(intents.get(url.split("/").at(-1)!));
  if (url.endsWith("/transactions/native")) {
    const authorization = (init?.headers as any).Authorization;
    const timestamp = /timestamp="([^"]+)"/.exec(authorization)![1], nonce = /nonce_str="([^"]+)"/.exec(authorization)![1], signature = /signature="([^"]+)"/.exec(authorization)![1];
    assert.equal(crypto.verify("RSA-SHA256", Buffer.from(`POST\n/v3/pay/transactions/native\n${timestamp}\n${nonce}\n${init!.body}\n`), merchant.publicKey, Buffer.from(signature, "base64")), true, "outgoing merchant signature verifies");
    return wxResponse({ code_url: `weixin://wxpay/bizpayurl?pr=${body.out_trade_no}` });
  }
  if (url.includes("/transactions/out-trade-no/") && url.endsWith("/close")) {
    const transactionData = wxTransactions.get(new URL(url).pathname.split("/").at(-2)!);
    transactionData.trade_state = "CLOSED";
    return wxResponse({});
  }
  if (url.includes("/transactions/out-trade-no/")) return wxResponse(wxTransactions.get(new URL(url).pathname.split("/").at(-1)!));
  throw new Error(`Unexpected mock request: ${url}`);
};
after(() => { globalThis.fetch = realFetch; db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
function newOrder() {
  const id = Number(q("INSERT INTO users (display_name) VALUES ('buyer')").run().lastInsertRowid);
  return transaction(() => createOrder(id, "monthly"));
}
const grants = (order: any) => q("SELECT COUNT(*) AS c FROM entitlement_grants WHERE source_ref = ? AND source_type = 'order'").get(order.merchant_order_no).c;
async function awOrder() {
  const order = newOrder(), checkout = await createCheckout(order.merchant_order_no, "airwallex");
  return { order, intent: { ...intents.get(checkout.intentId), status: "SUCCEEDED", captured_amount: order.amount_cents / 100 } };
}
function awNotice(intent: any, changes: any = {}, timestamp = String(Date.now())) {
  const raw = Buffer.from(JSON.stringify({ id: `evt_${intent.id}`, name: "payment_intent.succeeded", accountId: "test-account", data: { object: intent }, ...changes }));
  const signature = crypto.createHmac("sha256", "test-webhook-secret").update(timestamp).update(raw).digest("hex");
  return { raw, timestamp, signature };
}
const receiveAW = (n: ReturnType<typeof awNotice>) => receiveAirwallexNotice(n.raw, n.timestamp, n.signature);
async function wxOrder() { const order = newOrder(); await createCheckout(order.merchant_order_no, "wechat"); return order; }
function wxTransaction(order: any, changes: any = {}) {
  return { mchid: "wx-merchant", appid: "wx-app", trade_type: "NATIVE", trade_state: "SUCCESS", out_trade_no: order.merchant_order_no,
    transaction_id: `wx_${order.id}`, amount: { total: order.amount_cents, currency: order.currency }, ...changes };
}
function wxNotice(transactionData: any, changes: any = {}, timestamp?: string) {
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(process.env.WECHAT_PAY_API_V3_KEY!), Buffer.from("123456789012"));
  cipher.setAAD(Buffer.from("transaction"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(transactionData)), cipher.final(), cipher.getAuthTag()]);
  const raw = Buffer.from(JSON.stringify({ id: `wx_evt_${transactionData.transaction_id}`, event_type: "TRANSACTION.SUCCESS", resource_type: "encrypt-resource",
    resource: { original_type: "transaction", algorithm: "AEAD_AES_256_GCM", nonce: "123456789012", associated_data: "transaction", ciphertext: encrypted.toString("base64") }, ...changes }));
  return { raw, headers: wxSignature(raw, timestamp) };
}
const receiveWX = (n: ReturnType<typeof wxNotice>) => receiveWechatNotice(n.raw, n.headers);

test("providers disclose availability and fail closed without a required credential", async () => {
  assert.equal(paymentProviders().every((p: any) => p.configured), true);
  const key = process.env.AIRWALLEX_API_KEY;
  delete process.env.AIRWALLEX_API_KEY;
  assert.equal(paymentProviders().find((p: any) => p.id === "airwallex")!.configured, false);
  await assert.rejects(createCheckout(newOrder().merchant_order_no, "airwallex"), /payment_not_configured/);
  process.env.AIRWALLEX_API_KEY = key;
});
test("checkout binds server-side amount and persisted request UUID; concurrent and repeated requests reuse one intent", async () => {
  const order = newOrder(), before = intentCreates;
  const [first, second] = await Promise.all([createCheckout(order.merchant_order_no, "airwallex"), createCheckout(order.merchant_order_no, "airwallex")]);
  assert.equal(intentCreates, before + 1); assert.equal(first.intentId, second.intentId);
  assert.equal(first.env, "demo"); assert.equal(first.currency, order.currency);
  assert.equal(first.successUrl, `https://payments.example.test/account?order=${order.merchant_order_no}`);
  assert.equal(getOrder(order.merchant_order_no).status, "pending", "checkout and success URLs do not grant access");
  const request = requests.find((r) => r.body?.merchant_order_id === order.merchant_order_no);
  assert.equal(request.body.amount, order.amount_cents / 100);
  assert.match(request.body.request_id, /^[0-9a-f-]{14}4[0-9a-f-]{21}$/);
  await assert.rejects(createCheckout(order.merchant_order_no, "wechat"), /checkout_provider_locked/);
  q("UPDATE payment_checkouts SET expires_at = 0 WHERE order_id = ?").run(order.id);
  await assert.rejects(createCheckout(order.merchant_order_no, "airwallex"), /checkout_expired/);
});
test("Airwallex rejects forged, modified, and stale events without entitlements", async () => {
  const { order, intent } = await awOrder(), notice = awNotice(intent);
  assert.throws(() => receiveAirwallexNotice(notice.raw, notice.timestamp, "0".repeat(64)), /bad_signature/);
  assert.throws(() => receiveAirwallexNotice(Buffer.concat([notice.raw, Buffer.from(" ")]), notice.timestamp, notice.signature), /bad_signature/);
  assert.throws(() => receiveAW(awNotice(intent, {}, String(Date.now() - 301_000))), /bad_signature/);
  assert.equal(grants(order), 0);
});
test("a timed-out create retries the persisted UUID and recovers the same payment intent", async () => {
  const mockFetch = globalThis.fetch, order = newOrder(), before = intentCreates;
  let failOnce = true;
  globalThis.fetch = async (input, init) => {
    const result = await mockFetch(input, init);
    if (String(input).endsWith("/payment_intents/create") && failOnce) { failOnce = false; throw new DOMException("test timeout", "TimeoutError"); }
    return result;
  };
  try {
    await assert.rejects(createCheckout(order.merchant_order_no, "airwallex"), /payment_timeout/);
    assert.equal(checkoutRecord(order.id).payload, null);
    const requestId = checkoutRecord(order.id).request_id;
    const checkout = await createCheckout(order.merchant_order_no, "airwallex");
    assert.equal(intentCreates, before + 1); assert.equal(checkoutRecord(order.id).request_id, requestId);
    assert.equal(checkout.intentId, `int_${before + 1}`);
  } finally { globalThis.fetch = mockFetch; }
});
test("Airwallex fulfilled event grants once; repeated event and second success event remain idempotent", async () => {
  const { order, intent } = await awOrder(), notice = awNotice(intent);
  assert.equal(receiveAW(notice), "processed");
  assert.equal(receiveAW(notice), "duplicate");
  assert.equal(receiveAW(awNotice(intent, { id: `${intent.id}-another-event` })), "duplicate");
  assert.equal(getOrder(order.merchant_order_no).status, "paid"); assert.equal(grants(order), 1);
});
test("Airwallex validates merchant, intent, amount, currency, and full captured amount", async () => {
  for (const change of [{ amount: 0.01 }, { currency: "USD" }, { captured_amount: 0.01 }, { id: "int_other" }, { metadata: { peergrading_merchant: "another-store" } }]) {
    const { order, intent } = await awOrder();
    assert.throws(() => receiveAW(awNotice({ ...intent, ...change })), /amount_mismatch|payment_checkout_mismatch/);
    assert.equal(grants(order), 0); assert.equal(getOrder(order.merchant_order_no).status, "pending");
  }
  const { order, intent } = await awOrder();
  assert.throws(() => receiveAW(awNotice(intent, { accountId: "other-account" })), /bad_merchant/);
  assert.equal(receiveAW(awNotice({ ...intent, status: "REQUIRES_CAPTURE" })), "ignored");
  assert.equal(receiveAW(awNotice(intent, { name: "payment_intent.payment_failed" })), "ignored");
  assert.equal(grants(order), 0);
});
test("WeChat creates a signed Native request and renders the returned code URL locally", async () => {
  const order = newOrder(), checkout = await createCheckout(order.merchant_order_no, "wechat");
  assert.equal(checkout.kind, "qr"); assert.match(checkout.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(checkout.codeUrl, `weixin://wxpay/bizpayurl?pr=${order.merchant_order_no}`);
  assert.equal(checkoutRecord(order.id).provider_account_id, "wx-merchant"); assert.equal(grants(order), 0);
});
test("WeChat verifies RSA signature, pinned platform key ID, timestamp, and authenticated decryption", async () => {
  const order = await wxOrder(), notice = wxNotice(wxTransaction(order));
  assert.throws(() => receiveWechatNotice(notice.raw, { ...notice.headers, signature: "WECHATPAY/SIGNTEST/test" }), /bad_signature/);
  assert.throws(() => receiveWechatNotice(notice.raw, { ...notice.headers, serial: "PUB_KEY_ID_another" }), /bad_signature/);
  assert.throws(() => receiveWechatNotice(Buffer.concat([notice.raw, Buffer.from(" ")]), notice.headers), /bad_signature/);
  assert.throws(() => receiveWX(wxNotice(wxTransaction(order), {}, String(Math.floor(Date.now() / 1000) - 301))), /bad_signature/);
  const wrongResource = wxNotice(wxTransaction(order), { resource: { original_type: "transaction", algorithm: "AEAD_AES_256_GCM", nonce: "123456789012", ciphertext: Buffer.alloc(60).toString("base64") } });
  assert.throws(() => receiveWX(wrongResource), /bad_payment_resource/);
  assert.equal(grants(order), 0);
  assert.equal(receiveWX(notice), "processed"); assert.equal(receiveWX(notice), "duplicate"); assert.equal(grants(order), 1);
});
test("an unsigned WeChat API response cannot create a checkout or issue entitlements", async () => {
  const mockFetch = globalThis.fetch, order = newOrder();
  globalThis.fetch = async (input, init) => String(input).endsWith("/transactions/native") ? Response.json({ code_url: "weixin://wxpay/fake" }) : mockFetch(input, init);
  try {
    await assert.rejects(createCheckout(order.merchant_order_no, "wechat"), /payment_bad_response_signature/);
    assert.equal(checkoutRecord(order.id).payload, null); assert.equal(grants(order), 0);
  } finally { globalThis.fetch = mockFetch; }
});
test("WeChat validates merchant, app, amount and currency and ignores non-success states", async () => {
  for (const changes of [{ mchid: "other-merchant" }, { appid: "other-app" }, { amount: { total: 1, currency: "CNY" } }, { amount: { total: 1800, currency: "USD" } }]) {
    const order = await wxOrder();
    assert.throws(() => receiveWX(wxNotice(wxTransaction(order, changes))), /bad_merchant|amount_mismatch|payment_amount_invalid/);
    assert.equal(grants(order), 0);
  }
  const order = await wxOrder();
  assert.equal(receiveWX(wxNotice(wxTransaction(order, { trade_state: "NOTPAY" }))), "ignored");
  assert.equal(receiveWX(wxNotice(wxTransaction(order), { event_type: "TRANSACTION.CLOSED" })), "ignored");
  assert.equal(grants(order), 0);
});
test("explicit provider query recovers a missed webhook and remains idempotent", async () => {
  const { order, intent } = await awOrder(); intents.set(intent.id, intent);
  assert.equal(await syncCheckout(order.merchant_order_no), "processed");
  assert.equal(await syncCheckout(order.merchant_order_no), "ignored"); assert.equal(grants(order), 1);
  const wx = await wxOrder(); wxTransactions.set(wx.merchant_order_no, wxTransaction(wx));
  assert.equal(await syncCheckout(wx.merchant_order_no), "processed"); assert.equal(grants(wx), 1);
});
test("expired checkouts are closed at the provider before a local order can be replaced", async () => {
  const { order, intent } = await awOrder();
  await retireCheckout(order.merchant_order_no);
  assert.equal(intents.get(intent.id).status, "CANCELLED"); assert.equal(grants(order), 0);
  // A lost cancellation response is recovered by querying its now-cancelled state.
  await retireCheckout(order.merchant_order_no);
  assert.equal(getOrder(order.merchant_order_no).status, "closed");
  const paid = await awOrder(); intents.set(paid.intent.id, paid.intent);
  await retireCheckout(paid.order.merchant_order_no);
  assert.equal(getOrder(paid.order.merchant_order_no).status, "paid"); assert.equal(grants(paid.order), 1);
  const wx = await wxOrder(); wxTransactions.set(wx.merchant_order_no, wxTransaction(wx, { trade_state: "NOTPAY" }));
  await retireCheckout(wx.merchant_order_no);
  assert.equal(wxTransactions.get(wx.merchant_order_no).trade_state, "CLOSED"); assert.equal(grants(wx), 0);
});
test("invalid fractional currency amounts cannot be rounded into a valid charge", () => {
  assert.equal(majorUnitsToCents(18), 1800); assert.equal(majorUnitsToCents("18.80"), 1880);
  for (const amount of [18.001, null, "", 0, -1, Infinity, "1e3", "9007199254740992"]) assert.throws(() => majorUnitsToCents(amount), /payment_amount_invalid/);
  assert.equal(verifyAirwallexSignature(Buffer.from("{}"), undefined, undefined, "secret"), false);
  assert.equal(verifyWechatSignature(Buffer.from("{}"), {}), false);
});
test("raw webhook routes preserve request bytes before JSON parsing and return provider acknowledgements", async () => {
  const app = express();
  app.post("/wechat", ...wechatWebhook); app.post("/airwallex", ...airwallexWebhook); app.use(express.json());
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const wx = await wxOrder(), notice = wxNotice(wxTransaction(wx));
    const response = await realFetch(`${origin}/wechat`, { method: "POST", headers: { "content-type": "application/json", "wechatpay-serial": notice.headers.serial, "wechatpay-timestamp": notice.headers.timestamp, "wechatpay-nonce": notice.headers.nonce, "wechatpay-signature": notice.headers.signature }, body: notice.raw });
    assert.equal(response.status, 204); assert.equal(grants(wx), 1);
    const { order, intent } = await awOrder(), event = awNotice(intent);
    const result = await realFetch(`${origin}/airwallex`, { method: "POST", headers: { "content-type": "application/json", "x-timestamp": event.timestamp, "x-signature": event.signature }, body: event.raw });
    assert.equal(result.status, 200); assert.equal(grants(order), 1);
  } finally { await new Promise<void>((resolve) => server.close(resolve)); }
});
test("checkout API enforces order ownership and CSRF; private checkout secrets are not exposed by status queries", async () => {
  const app = express(), order = newOrder(), stranger = newOrder();
  app.use(express.json());
  // This fixture provides an authenticated session; the real authorization and CSRF guards still execute.
  app.use((req, _res, next) => {
    Object.assign(req, { bidHash: "test-browser", authEpoch: 1, session: { id: "test-session" }, user: req.get("x-test-user") ? { id: Number(req.get("x-test-user")) } : null }); next();
  });
  app.use(billing);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const csrf = issueCsrf({ bidHash: "test-browser", sessionId: "test-session", authEpoch: 1 });
  const ownerHeaders = { "content-type": "application/json", origin: "https://payments.example.test", "x-csrf-token": csrf, "x-test-user": String(order.user_id) };
  const url = `${origin}/api/billing/orders/${order.merchant_order_no}/checkout`;
  try {
    assert.equal((await realFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"provider":"airwallex"}' })).status, 401);
    assert.equal((await realFetch(url, { method: "POST", headers: { ...ownerHeaders, "x-test-user": String(stranger.user_id) }, body: '{"provider":"airwallex"}' })).status, 404);
    assert.equal((await realFetch(url, { method: "POST", headers: { ...ownerHeaders, "x-csrf-token": "wrong" }, body: '{"provider":"airwallex"}' })).status, 403);
    const checkoutResponse = await realFetch(url, { method: "POST", headers: ownerHeaders, body: '{"provider":"airwallex"}' });
    assert.equal(checkoutResponse.status, 200); assert.equal(checkoutResponse.headers.get("cache-control"), "no-store");
    assert.equal((await checkoutResponse.json() as any).checkout.kind, "airwallex");
    const statusResponse = await realFetch(`${origin}/api/billing/orders/${order.merchant_order_no}`, { headers: ownerHeaders });
    const statusText = await statusResponse.text(); assert.equal(statusResponse.status, 200); assert.equal(statusText.includes("clientSecret"), false);
    assert.equal(grants(order), 0);
  } finally { await new Promise<void>((resolve) => server.close(resolve)); }
});
