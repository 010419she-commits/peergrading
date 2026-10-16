// Cloud account APIs for the desktop BFF. Bearer device auth never becomes a browser session.
import { Router } from "express";
import { q, db, transaction } from "./db.ts";
import { config } from "./config.ts";
import { requireDevice } from "./device.ts";
import { entitlementSummary } from "./entitlements.ts";
import { getUser, listIdentities } from "./users.ts";
import { AuthError, logAuthError, now, randomToken, sha256 } from "./security.ts";
import { accessStatus } from "../billing/access.ts";
import { getOrder, listOrders } from "../billing/orders.ts";
import { createBillingOrder, orderView, syncBillingOrder } from "../billing/routes.ts";
import { publicPlan, wechatGroupInfo } from "../billing/plan.ts";
import { betaFree } from "../billing/settings.ts";
import { claimReferral, referralSummary } from "../billing/referral.ts";
import { paymentProviders } from "../billing/providers.ts";
import { createCheckout } from "../billing/payments.ts";

db.exec(`CREATE TABLE IF NOT EXISTS desktop_checkout_tickets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
)`);
const TICKET_TTL = 5 * 60;
export const desktopAccount = Router();
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function devicesFor(userId: number, currentId: string) {
  return q("SELECT id, device_name, created_at, last_seen_at FROM device_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, rowid DESC").all(userId)
    .map((d: any) => ({ id: d.id.slice(0, 12), deviceName: d.device_name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, current: d.id === currentId }));
}
function userView(u: any) {
  return { id: u.id, name: u.display_name, avatar: u.avatar_url, createdAt: u.created_at,
    identities: listIdentities(u.id), entitlements: entitlementSummary(u.id), access: accessStatus(u), wechatGroup: wechatGroupInfo() };
}
function paymentFailure(res: any, error: any) {
  const code = error instanceof AuthError ? error.code : "payment_failed";
  if (!(error instanceof AuthError)) logAuthError(error, randomToken(6));
  const status = code === "payment_not_configured" ? 503 : code.startsWith("checkout_") || code === "order_not_pending" ? 409 : code.startsWith("payment_provider") || code === "payment_timeout" || code === "payment_network" ? 502 : 400;
  res.status(status).json({ error: code });
}

// This authenticated subtree is independent of cookies and does not accept browser CSRF credentials.
desktopAccount.use("/api/desktop/account", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); }, requireDevice);
desktopAccount.get("/api/desktop/account", (req, res) => {
  const r = req as any;
  res.json({ user: userView(r.user), plan: publicPlan(), paymentProviders: paymentProviders(),
    orders: listOrders(r.user.id).map((o: any) => orderView(getOrder(o.merchant_order_no))),
    referral: referralSummary(r.user.id), devices: devicesFor(r.user.id, r.deviceToken.id), securityUrl: `${config.baseUrl}/account#security` });
});
desktopAccount.post("/api/desktop/account/orders", createBillingOrder);
desktopAccount.get("/api/desktop/account/orders/:no", (req, res) => {
  const o = getOrder(String(req.params.no));
  if (!o || o.user_id !== (req as any).user.id) return res.status(404).json({ error: "not_found" });
  res.json({ order: orderView(o), access: accessStatus((req as any).user) });
});
desktopAccount.post("/api/desktop/account/orders/:no/sync", syncBillingOrder);
desktopAccount.post("/api/desktop/account/orders/:no/checkout", async (req, res) => {
  const r = req as any, order = getOrder(String(req.params.no));
  if (!order || order.user_id !== r.user.id) return res.status(404).json({ error: "not_found" });
  if (betaFree()) return res.status(403).json({ error: "beta_free" });
  try {
    const checkout = await createCheckout(order.merchant_order_no, String(req.body?.provider || ""));
    if (checkout.provider !== "airwallex") return res.json({ checkout });
    const ticket = randomToken(32), expiresAt = Math.min(now() + TICKET_TTL, checkout.expiresAt);
    transaction(() => {
      q("DELETE FROM desktop_checkout_tickets WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(now());
      // An order may be reopened in the desktop, so invalidate older unused launch URLs.
      q("DELETE FROM desktop_checkout_tickets WHERE user_id = ? AND device_id = ? AND order_no = ?").run(r.user.id, r.deviceToken.id, order.merchant_order_no);
      q("INSERT INTO desktop_checkout_tickets (id, user_id, device_id, order_no, expires_at) VALUES (?, ?, ?, ?, ?)").run(sha256(ticket), r.user.id, r.deviceToken.id, order.merchant_order_no, expiresAt);
    });
    // Only the cloud launch page receives the intent's client secret. No bearer is ever placed in a URL.
    res.json({ checkout: { kind: "external", provider: "airwallex", url: `${config.baseUrl}/desktop/checkout/${ticket}`, expiresAt } });
  } catch (error) { paymentFailure(res, error); }
});
desktopAccount.get("/api/desktop/account/referral", (req, res) => res.json({ referral: referralSummary((req as any).user.id) }));
desktopAccount.post("/api/desktop/account/referral/claim", (req, res) => {
  const u = (req as any).user;
  try {
    const result = transaction(() => claimReferral(u.id, req.body?.code));
    res.json({ ok: true, days: result.invitee_days, settled: !!result.settled_at, referral: referralSummary(u.id), access: accessStatus(u) });
  } catch (error: any) { res.status(error instanceof AuthError ? 409 : 500).json({ error: error instanceof AuthError ? error.code : "failed" }); }
});
desktopAccount.get("/api/desktop/account/devices", (req, res) => res.json({ devices: devicesFor((req as any).user.id, (req as any).deviceToken.id) }));
desktopAccount.post("/api/desktop/account/devices/revoke", (req, res) => {
  const r = req as any, id = req.body?.id;
  if (typeof id !== "string" || !/^[a-f0-9]{12}$/.test(id)) return res.status(400).json({ error: "bad_request" });
  const changes = q("UPDATE device_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND substr(id, 1, 12) = ?").run(now(), r.user.id, id);
  res.json({ ok: Number(changes.changes) > 0, current: r.deviceToken.id.startsWith(id) && Number(changes.changes) > 0 });
});

/** A scoped, one-use browser capability to launch the hosted card checkout, never a login session. */
desktopAccount.get("/desktop/checkout/:ticket", async (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow" });
  const failure = (status: number, message: string) => res.status(status).type("html").send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>付款链接 · PeerGrading</title><link rel="stylesheet" href="/site.css"><main class="section narrow"><h1>请回软件重新打开付款</h1><p>${esc(message)}</p><p>付款状态请在软件「账号与会员」中刷新。</p></main></html>`);
  const raw = String(req.params.ticket);
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return failure(404, "付款链接无效。");
  const ticket = q("SELECT * FROM desktop_checkout_tickets WHERE id = ?").get(sha256(raw));
  if (!ticket || ticket.consumed_at || ticket.expires_at <= now()) return failure(410, "付款链接已过期或已使用。");
  const device = q("SELECT * FROM device_tokens WHERE id = ? AND user_id = ? AND revoked_at IS NULL").get(ticket.device_id, ticket.user_id);
  const u = getUser(ticket.user_id), order = getOrder(ticket.order_no);
  if (!device || !u || u.status !== "active" || !order || order.user_id !== u.id) return failure(403, "设备登录已失效。");
  if (betaFree()) return failure(403, "目前为免费内测，暂不开放付款。");
  if (order.status !== "pending") return failure(409, "订单状态已变化，请回软件刷新。");
  const consumed = q("UPDATE desktop_checkout_tickets SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").run(now(), ticket.id, now());
  if (Number(consumed.changes) !== 1) return failure(410, "付款链接已使用。");
  try {
    const checkout = await createCheckout(order.merchant_order_no, "airwallex");
    const complete = `${config.baseUrl}/account?desktop=1&order=${encodeURIComponent(order.merchant_order_no)}`;
    const payload = JSON.stringify({ ...checkout, successUrl: complete, cancelUrl: complete }).replace(/</g, "\\u003c");
    const nonce = randomToken(18);
    res.set("Content-Security-Policy", `default-src 'self'; script-src 'self' https: 'nonce-${nonce}'; connect-src 'self' https:; frame-src https:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`);
    res.type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>信用卡付款 · PeerGrading</title><link rel="stylesheet" href="/site.css"></head><body><main class="section narrow"><h1>正在打开信用卡付款</h1><p id="status">由 Airwallex 安全收取卡片信息，请稍候。</p><p>付款后请回软件「账号与会员」刷新订单；本页面不会直接开通会员。</p></main><script src="/payment-sdk.js"></script><script nonce="${nonce}">window.PeerGradingCards.checkout(${payload},"zh").catch(function(){document.getElementById("status").textContent="暂时无法打开付款，请回软件重新尝试。"});</script></body></html>`);
  } catch (error) {
    if (!(error instanceof AuthError)) logAuthError(error, randomToken(6));
    failure(502, "付款渠道暂时不可用，请回软件重试。");
  }
});
