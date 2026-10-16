import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-desktop-account-"));
const merchant = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const merchantKey = path.join(tmp, "merchant.pem"), platformKey = path.join(tmp, "platform.pem");
fs.writeFileSync(merchantKey, merchant.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(platformKey, platform.publicKey.export({ type: "spki", format: "pem" }));
Object.assign(process.env, { DATA_DIR: tmp, BASE_URL: "https://membership.example.test", FREE_BETA: "0", SESSION_SECRET: "isolated-desktop-account-test-secret", NODE_ENV: "test",
  AIRWALLEX_CLIENT_ID: "test-client", AIRWALLEX_API_KEY: "test-api-key", AIRWALLEX_ACCOUNT_ID: "test-account", AIRWALLEX_WEBHOOK_SECRET: "test-webhook", AIRWALLEX_ENV: "sandbox",
  WECHAT_PAY_MCH_ID: "wx-merchant", WECHAT_PAY_APP_ID: "wx-app", WECHAT_PAY_CERT_SERIAL: "merchant-serial", WECHAT_PAY_PRIVATE_KEY_PATH: merchantKey,
  WECHAT_PAY_API_V3_KEY: "0123456789abcdef0123456789abcdef", WECHAT_PAY_PLATFORM_KEY_ID: "PUB_KEY_ID_TEST", WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH: platformKey });
const { db, q } = await import("../auth/db.ts");
const { desktopAccount } = await import("../auth/desktop-account.ts");
const { sha256, now } = await import("../auth/security.ts");
const { setSetting } = await import("../billing/settings.ts");
const { getOrder } = await import("../billing/orders.ts");
const { checkoutRecord } = await import("../billing/payments.ts");
const { referralCode } = await import("../billing/referral.ts");
const realFetch = globalThis.fetch;
const intents = new Map<string, any>();
let createCount = 0;
function wxResponse(data: any) {
  const raw = Buffer.from(JSON.stringify(data)), timestamp = String(now()), nonce = "test-nonce";
  const signature = crypto.sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), raw, Buffer.from("\n")]), platform.privateKey).toString("base64");
  return new Response(raw, { headers: { "content-type": "application/json", "wechatpay-serial": "PUB_KEY_ID_TEST", "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-signature": signature } });
}
globalThis.fetch = async (input: any, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
  if (url.endsWith("/authentication/login")) return Response.json({ token: "provider-token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (url.endsWith("/payment_intents/create")) {
    createCount++;
    const intent = { id: `intent_${createCount}`, client_secret: `scoped_secret_${createCount}</script>`, merchant_order_id: body.merchant_order_id, amount: body.amount,
      currency: body.currency, metadata: body.metadata, status: "REQUIRES_PAYMENT_METHOD", captured_amount: 0 };
    intents.set(intent.id, intent);
    return Response.json(intent);
  }
  if (url.includes("/payment_intents/")) return Response.json(intents.get(new URL(url).pathname.split("/").at(-1)!));
  if (url.endsWith("/transactions/native")) return wxResponse({ code_url: `weixin://wxpay/bizpayurl?pr=${body.out_trade_no}` });
  throw new Error(`Unexpected provider URL: ${url}`);
};
const app = express();
app.use(express.json());
// A browser session must not authorize the desktop subtree or override bearer ownership.
app.use((req, _res, next) => { (req as any).user = { id: 99999 }; next(); });
app.use(desktopAccount);
const server = await new Promise<any>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`, prefix = "/api/desktop/account";
after(async () => { await new Promise<void>((resolve) => server.close(resolve)); globalThis.fetch = realFetch; db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
function fixture(name = "Desktop user") {
  const userId = Number(q("INSERT INTO users (display_name) VALUES (?)").run(name).lastInsertRowid);
  q("INSERT INTO identities (user_id, provider, issuer, provider_uid, display_name) VALUES (?, 'dev', 'test', ?, ?)").run(userId, `uid-${userId}`, name);
  const token = crypto.randomBytes(32).toString("base64url"), deviceId = sha256(token);
  q("INSERT INTO device_tokens (id, user_id, device_name) VALUES (?, ?, ?)").run(deviceId, userId, `${name}'s computer`);
  return { userId, token, deviceId };
}
async function api(p: string, f?: ReturnType<typeof fixture>, body?: any, method = body === undefined ? "GET" : "POST") {
  return fetch(base + prefix + p, { method, headers: { "content-type": "application/json", ...(f ? { authorization: `Bearer ${f.token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function orderFor(f: ReturnType<typeof fixture>, plan = "monthly") {
  const response = await api("/orders", f, { plan }); assert.equal(response.status, 200);
  return (await response.json()).order;
}
async function launchFor(f: ReturnType<typeof fixture>, order: any) {
  const response = await api(`/orders/${order.no}/checkout`, f, { provider: "airwallex" }); assert.equal(response.status, 200);
  return (await response.json()).checkout;
}
const launchPath = (checkout: any) => new URL(checkout.url).pathname;

test("desktop membership requires its bearer; cookie-shaped session state grants nothing", async () => {
  const response = await api("");
  assert.equal(response.status, 401); assert.equal(response.headers.get("cache-control"), "no-store");
  const invalid = await fetch(base + prefix, { headers: { authorization: `Bearer ${"a".repeat(43)}`, cookie: "session=not-authority" } });
  assert.equal(invalid.status, 401);
  const f = fixture(); q("UPDATE users SET status = 'disabled' WHERE id = ?").run(f.userId);
  assert.equal((await api("", f)).status, 401);
});

test("bootstrap supplies desktop membership, invites and device state without tokens, hashes or identity secrets", async () => {
  const f = fixture("Owner"), other = fixture("Other");
  const response = await api("", f), data = await response.json(), text = JSON.stringify(data);
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(data.user.id, f.userId); assert.equal(data.user.identities[0].provider, "dev");
  assert.equal(data.user.access.allowed, true); assert.equal(data.plan.plans.length, 2); assert.equal(data.paymentProviders.length, 2);
  assert.equal(data.devices.length, 1); assert.equal(data.devices[0].current, true); assert.equal(data.devices[0].id.length, 12);
  assert.match(data.referral.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(data.securityUrl, "https://membership.example.test/account#security");
  for (const secret of [f.token, f.deviceId, other.deviceId, "provider_uid", "provider-token", "client_secret"]) assert.equal(text.includes(secret), false);
});

test("orders use server prices and owner checks for reads, checkout and reconciliation", async () => {
  const owner = fixture(), other = fixture();
  const created = await api("/orders", owner, { plan: "monthly", amountCents: 1, currency: "USD", userId: other.userId });
  const data = await created.json(), order = data.order;
  assert.equal(order.amountCents, 1800); assert.equal(order.currency, "CNY"); assert.equal(getOrder(order.no).user_id, owner.userId);
  assert.equal((await api(`/orders/${order.no}`, owner)).status, 200);
  assert.equal((await api(`/orders/${order.no}`, other)).status, 404);
  assert.equal((await api(`/orders/${order.no}/checkout`, other, { provider: "airwallex" })).status, 404);
  assert.equal((await api(`/orders/${order.no}/sync`, other, {})).status, 404);
  assert.equal((await orderFor(owner)).no, order.no, "retry does not create another order");
});

test("free beta suppresses purchases and checkout launch even for already pending orders", async () => {
  const f = fixture(), order = await orderFor(f), checkout = await launchFor(f, order);
  setSetting("beta_free", "1");
  try {
    const data = await (await api("", f)).json(); assert.equal(data.plan.beta, true); assert.equal(data.user.access.allowed, true);
    assert.equal((await api("/orders", f, { plan: "earlybird" })).status, 403);
    assert.equal((await api(`/orders/${order.no}/checkout`, f, { provider: "airwallex" })).status, 403);
    assert.equal((await fetch(base + launchPath(checkout))).status, 403);
  } finally { setSetting("beta_free", "0"); }
});

test("card launch is a scoped five-minute one-use URL and creates no browser session or entitlement", async () => {
  const f = fixture(), order = await orderFor(f), before = createCount, checkout = await launchFor(f, order);
  assert.equal(checkout.kind, "external"); assert.equal(checkout.provider, "airwallex"); assert.equal(createCount, before + 1);
  assert.ok(checkout.expiresAt <= now() + 300); assert.ok(checkout.expiresAt > now());
  const raw = launchPath(checkout).split("/").at(-1)!, saved = q("SELECT * FROM desktop_checkout_tickets WHERE id = ?").get(sha256(raw));
  assert.ok(saved); assert.equal(saved.device_id, f.deviceId); assert.equal(saved.user_id, f.userId);
  const checkoutText = JSON.stringify(checkout); assert.equal(checkoutText.includes(f.token), false); assert.equal(checkoutText.includes("secret"), false);
  const page = await fetch(base + launchPath(checkout)), html = await page.text();
  assert.equal(page.status, 200); assert.equal(page.headers.get("set-cookie"), null); assert.equal(page.headers.get("cache-control"), "no-store");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer"); assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(html, /payment-sdk\.js/); assert.match(html, /account\?desktop=1/); assert.match(html, /scoped_secret_\d+\\u003c\/script>/);
  assert.equal(html.includes(f.token), false); assert.equal(html.includes(f.deviceId), false);
  assert.equal((await fetch(base + launchPath(checkout))).status, 410);
  assert.equal(getOrder(order.no).status, "pending"); assert.equal(q("SELECT COUNT(*) AS n FROM entitlement_grants WHERE user_id = ?").get(f.userId).n, 0);
});

test("launch tickets reject expiry, revoked devices, disabled users and changed order ownership", async () => {
  for (const scenario of ["expired", "revoked", "disabled", "owner", "paid"]) {
    const f = fixture(), order = await orderFor(f), checkout = await launchFor(f, order);
    const raw = launchPath(checkout).split("/").at(-1)!;
    if (scenario === "expired") q("UPDATE desktop_checkout_tickets SET expires_at = ? WHERE id = ?").run(now() - 1, sha256(raw));
    if (scenario === "revoked") q("UPDATE device_tokens SET revoked_at = ? WHERE id = ?").run(now(), f.deviceId);
    if (scenario === "disabled") q("UPDATE users SET status = 'disabled' WHERE id = ?").run(f.userId);
    if (scenario === "owner") q("UPDATE orders SET user_id = ? WHERE merchant_order_no = ?").run(fixture().userId, order.no);
    if (scenario === "paid") q("UPDATE orders SET status = 'paid' WHERE merchant_order_no = ?").run(order.no);
    const response = await fetch(base + launchPath(checkout));
    assert.equal(response.status, scenario === "expired" ? 410 : scenario === "paid" ? 409 : 403, scenario);
    assert.equal((await response.text()).includes("clientSecret"), false);
  }
  assert.equal((await fetch(base + "/desktop/checkout/not-valid")).status, 404);
});

test("opening a fresh card link invalidates the old link; concurrent redemption consumes it once", async () => {
  const f = fixture(), order = await orderFor(f), first = await launchFor(f, order), second = await launchFor(f, order);
  assert.equal((await fetch(base + launchPath(first))).status, 410);
  const responses = await Promise.all([fetch(base + launchPath(second)), fetch(base + launchPath(second))]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 410]);
});

test("WeChat checkout stays in the desktop as a QR and a provider cannot be switched mid-order", async () => {
  const f = fixture(), order = await orderFor(f);
  const response = await api(`/orders/${order.no}/checkout`, f, { provider: "wechat" }), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.checkout.kind, "qr"); assert.match(data.checkout.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(data.checkout.clientSecret, undefined); assert.equal(data.checkout.url, undefined);
  const switchResponse = await api(`/orders/${order.no}/checkout`, f, { provider: "airwallex" });
  assert.equal(switchResponse.status, 409); assert.equal((await switchResponse.json()).error, "checkout_provider_locked");
});

test("desktop reconciliation grants membership only from authenticated provider state and remains idempotent", async () => {
  const f = fixture(), order = await orderFor(f); await launchFor(f, order);
  const checkout = checkoutRecord(getOrder(order.no).id), intent = intents.get(checkout.provider_reference);
  const first = await (await api(`/orders/${order.no}/sync`, f, { status: "paid", paid: true })).json();
  assert.equal(first.order.status, "pending"); assert.equal(first.access.member, false);
  intent.status = "SUCCEEDED"; intent.captured_amount = intent.amount;
  const paid = await (await api(`/orders/${order.no}/sync`, f, {})).json();
  assert.equal(paid.order.status, "paid"); assert.equal(paid.access.member, true);
  await api(`/orders/${order.no}/sync`, f, {});
  assert.equal(q("SELECT COUNT(*) AS n FROM entitlement_grants WHERE user_id = ? AND source_type = 'order'").get(f.userId).n, 1);
});

test("invitation rewards are managed with bearer ownership and claim once", async () => {
  const inviter = fixture(), invitee = fixture(), code = referralCode(inviter.userId);
  const response = await api("/referral/claim", invitee, { code, userId: inviter.userId }), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.days, 7); assert.equal(data.settled, true); assert.equal(data.access.member, true);
  assert.equal((await api("/referral/claim", invitee, { code })).status, 409);
  const sum = await (await api("/referral", inviter)).json(); assert.equal(sum.referral.invited, 1); assert.equal(sum.referral.earnedDays, 7);
});

test("device management cannot revoke another owner's device or modify identities", async () => {
  const f = fixture(), other = fixture();
  const foreign = await (await api("/devices/revoke", f, { id: other.deviceId.slice(0, 12) })).json(); assert.equal(foreign.ok, false);
  assert.equal((await api("/devices/revoke", f, { id: f.deviceId })).status, 400);
  for (const route of ["/bind", "/unbind", "/reverify"]) assert.equal((await api(route, f, { identityId: 1 })).status, 404);
  const revoked = await (await api("/devices/revoke", f, { id: f.deviceId.slice(0, 12) })).json();
  assert.deepEqual(revoked, { ok: true, current: true }); assert.equal((await api("", f)).status, 401);
  assert.equal((await api("", other)).status, 200);
});
