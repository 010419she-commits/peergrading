// Retired WeChat endpoints plus generic OAuth security through the isolated dev provider.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-retired-wechat-"));
Object.assign(process.env, { DATA_DIR: temporary, NODE_ENV: "test", BASE_URL: "http://localhost:3000", DEV_LOGIN: "1",
  SESSION_SECRET: "retired-wechat-test-secret-00000000000000", WECHAT_OPEN_APPID: "legacy-app", WECHAT_OPEN_SECRET: "legacy-secret",
  WECHAT_MP_APPID: "legacy-mp", WECHAT_MP_SECRET: "legacy-mp-secret", GOOGLE_CLIENT_ID: "fake-google", GOOGLE_CLIENT_SECRET: "fake-google-secret" });
const { db, q, transaction } = await import("../auth/db.ts");
const { config } = await import("../auth/config.ts");
const { attachBrowser } = await import("../auth/browser.ts");
const { attachUser, noStore } = await import("../auth/middleware.ts");
const { auth, account } = await import("../auth/routes.ts");
const { now } = await import("../auth/security.ts");
const { resolveLogin, bindIdentity, removeIdentities } = await import("../auth/users.ts");
const nativeFetch = globalThis.fetch;
let origin = "", sequence = 0, externalRequests = 0;
const app = express();
app.use(express.json(), cookieParser(), noStore, attachBrowser, attachUser, auth);
app.use("/api/account", account);
let server: ReturnType<typeof app.listen>;
before(async () => {
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    if (new URL(String(input)).hostname === "api.weixin.qq.com") { externalRequests++; throw new Error("Retired provider must not be contacted"); }
    return nativeFetch(input, init);
  };
  server = app.listen(0, "127.0.0.1"); await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  db.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
class Browser {
  cookies = new Map<string, string>();
  ua: string;
  constructor(ua = "Desktop") { this.ua = ua; }
  async request(route: string, opts: RequestInit = {}) {
    const headers = new Headers(opts.headers); headers.set("user-agent", this.ua);
    headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await nativeFetch(origin + route, { ...opts, headers, redirect: "manual" });
    for (const value of response.headers.getSetCookie()) { const [k, v] = value.split(";")[0].split("="); if (v) this.cookies.set(k, v); else this.cookies.delete(k); }
    return response;
  }
  async bootstrap() { return (await this.request("/api/auth/bootstrap")).json(); }
  async post(route: string, body: object, extra: Record<string, string> = {}) {
    const b = await this.bootstrap();
    return this.request(route, { method: "POST", headers: { "content-type": "application/json", origin: config.siteOrigin, "x-csrf-token": b.csrf, ...extra }, body: JSON.stringify(body) });
  }
  async start() {
    const response = await this.post("/api/auth/start", { provider: "dev", intent: "login", return_to: "/account" });
    assert.equal(response.status, 200); return new URL((await response.json()).url, origin);
  }
  callback(url: URL, uid = `test_${++sequence}`) { return this.request(`/auth/dev/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, uid })}`); }
  async login() { const response = await this.callback(await this.start()); assert.match(response.headers.get("location")!, /login=(welcome|ok)/); return (await this.bootstrap()).user; }
}
const stateOf = (url: URL) => url.searchParams.get("state")!;
const failed = (response: Response) => assert.match(response.headers.get("location")!, /^\/\?login=(failed|stale)/);
const legacyIdentity = (uid: string, unionDomain = "platform-a", unionId = "legacy-union") => ({ provider: "wechat" as const, issuer: "wechat:old-app", uid, channel: "open", unionDomain, unionId, name: "Legacy profile" });

test("WeChat remains unavailable for all UAs despite configured legacy credentials", async () => {
  const count = q("SELECT COUNT(*) n FROM oauth_transactions").get().n;
  for (const ua of ["Desktop", "Mozilla MicroMessenger/8.0"]) {
    const browser = new Browser(ua), bootstrap = await browser.bootstrap();
    assert.equal(bootstrap.providers.wechat.available, false); assert.equal(bootstrap.providers.wechat.mode, null);
    const response = await browser.post("/api/auth/start", { provider: "wechat", intent: "login" });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, "provider_unavailable");
    assert.doesNotMatch(await (await browser.request("/login")).text(), /name="provider" value="wechat"/);
  }
  assert.equal(q("SELECT COUNT(*) n FROM oauth_transactions").get().n, count);
});
test("retired callbacks never contact WeChat, replace a session or mint another session", async () => {
  const browser = new Browser(), user = await browser.login(), session = browser.cookies.get("sid");
  const count = q("SELECT COUNT(*) n FROM sessions").get().n;
  for (const query of ["state=forged&code=old", "state=one&state=two&code=old", "error=access_denied", ""]) assert.equal((await browser.request(`/auth/wechat/callback?${query}`)).status, 410);
  assert.equal(externalRequests, 0); assert.equal(q("SELECT COUNT(*) n FROM sessions").get().n, count);
  assert.equal(browser.cookies.get("sid"), session); assert.equal((await browser.bootstrap()).user.id, user.id);
});
test("OAuth start requires a matching browser, origin, session and CSRF", async () => {
  const first = new Browser(), second = new Browser(), bootstrap = await first.bootstrap(); await second.bootstrap();
  const count = q("SELECT COUNT(*) n FROM oauth_transactions").get().n;
  for (const [browser, headers] of [[first, { "x-csrf-token": "" }], [first, { origin: "https://attacker.invalid" }], [second, { "x-csrf-token": bootstrap.csrf }]] as const) assert.equal((await browser.post("/api/auth/start", { provider: "dev", intent: "login" }, headers)).status, 403);
  assert.equal(q("SELECT COUNT(*) n FROM oauth_transactions").get().n, count);
});
test("forged, duplicate and cross-browser states leave the original transaction usable", async () => {
  const first = new Browser(), second = new Browser(), request = await first.start(); await second.bootstrap();
  failed(await first.request("/auth/dev/callback?state=forged&uid=test"));
  failed(await first.request(`/auth/dev/callback?state=${stateOf(request)}&state=other&uid=test`));
  failed(await second.callback(request));
  assert.equal(q("SELECT consumed_at FROM oauth_transactions WHERE state = ?").get(stateOf(request)).consumed_at, null);
  assert.equal((await first.callback(request)).headers.get("location"), "/account?login=welcome");
});
test("expiry, browser epoch changes and simultaneous callback replay cannot create extra sessions", async () => {
  const browser = new Browser(), expired = await browser.start();
  q("UPDATE oauth_transactions SET expires_at = ? WHERE state = ?").run(now() - 1, stateOf(expired)); failed(await browser.callback(expired));
  const stale = await browser.start(), current = await browser.start(), users = q("SELECT COUNT(*) n FROM users").get().n;
  const responses = await Promise.all([browser.callback(current, "parallel"), browser.callback(current, "parallel")]);
  assert.equal(responses.filter((r) => r.headers.get("location") === "/account?login=welcome").length, 1);
  assert.equal(q("SELECT COUNT(*) n FROM users").get().n, users + 1);
  const id = (await browser.bootstrap()).user.id; failed(await browser.callback(stale)); assert.equal((await browser.bootstrap()).user.id, id);
});
test("binding is idempotent, cannot steal an identity and rejects a replaced session cookie", async () => {
  const first = new Browser(), owner = await first.login();
  for (const op of ["bound", "already"]) {
    const response = await first.post("/api/account/bind", { provider: "dev" });
    assert.equal((await first.callback(new URL((await response.json()).url, origin), "bound_uid")).headers.get("location"), `/account?op=${op}`);
  }
  const second = new Browser(); await second.login();
  const conflict = await second.post("/api/account/bind", { provider: "dev" });
  assert.equal((await second.callback(new URL((await conflict.json()).url, origin), "bound_uid")).headers.get("location"), "/account?op=identity_conflict");
  assert.equal(q("SELECT user_id FROM identities WHERE provider_uid='bound_uid'").get().user_id, owner.id);
  const binding = await first.post("/api/account/bind", { provider: "dev" }); first.cookies.set("sid", second.cookies.get("sid")!);
  assert.equal((await first.callback(new URL((await binding.json()).url, origin), "wrong_session")).headers.get("location"), "/account?op=stale_tx");
  assert.equal(q("SELECT id FROM identities WHERE provider_uid='wrong_session'").get(), undefined);
});
test("logout during binding and an expired verification window cannot create a new identity", async () => {
  const browser = new Browser(); await browser.login();
  const binding = await browser.post("/api/account/bind", { provider: "dev" });
  await browser.post("/auth/logout", {}); const next = await browser.login();
  failed(await browser.callback(new URL((await binding.json()).url, origin), "after_logout")); assert.equal((await browser.bootstrap()).user.id, next.id);
  const expired = await browser.post("/api/account/bind", { provider: "dev" });
  q("UPDATE sessions SET last_verified_at = ? WHERE user_id = ?").run(now() - config.reverifyWindowSec - 1, next.id);
  assert.equal((await browser.callback(new URL((await expired.json()).url, origin), "expired_bind")).headers.get("location"), "/account?op=bind_reverify_expired");
  assert.equal(q("SELECT id FROM identities WHERE provider_uid='expired_bind'").get(), undefined);
});
test("reverify accepts only the requested identity and rotates the session on success", async () => {
  const browser = new Browser(), user = await browser.login(), identity = user.identities[0], sid = browser.cookies.get("sid");
  const bad = await browser.post("/api/account/reverify", { identityId: identity.id });
  assert.equal((await browser.callback(new URL((await bad.json()).url, origin), "unlinked_uid")).headers.get("location"), "/account?op=reverify_mismatch"); assert.equal(browser.cookies.get("sid"), sid);
  const good = await browser.post("/api/account/reverify", { identityId: identity.id }), uid = q("SELECT provider_uid FROM identities WHERE id = ?").get(identity.id).provider_uid;
  assert.equal((await browser.callback(new URL((await good.json()).url, origin), uid)).headers.get("location"), "/account?login=reverified"); assert.notEqual(browser.cookies.get("sid"), sid);
});
test("historical WeChat records preserve owner, UnionID isolation and conflict checks", () => {
  const existing = transaction(() => resolveLogin(legacyIdentity("old-openid"))).user;
  assert.equal(transaction(() => resolveLogin({ ...legacyIdentity("old-mp"), channel: "mp" })).user.id, existing.id);
  const isolated = transaction(() => resolveLogin(legacyIdentity("other-platform", "platform-b"))).user; assert.notEqual(isolated.id, existing.id);
  assert.throws(() => transaction(() => resolveLogin(legacyIdentity("old-openid", "platform-a", "changed"))), /wx_bad_response/);
  assert.throws(() => transaction(() => bindIdentity(legacyIdentity("old-openid"), isolated.id)), /identity_conflict/);
  assert.equal(q("SELECT COUNT(*) n FROM identities WHERE user_id = ?").get(existing.id).n, 2);
});
test("retired WeChat cannot be the remaining identity when unlinking the last active Google login", () => {
  const owner = transaction(() => resolveLogin({ provider: "google", issuer: "https://accounts.google.com", uid: "last-google" }));
  transaction(() => bindIdentity(legacyIdentity("owner-wechat", "platform-a", "other-union"), owner.user.id));
  assert.throws(() => transaction(() => removeIdentities(owner.user.id, { identityId: owner.identity.id })), /last_identity/);
  assert.equal(q("SELECT COUNT(*) n FROM identities WHERE user_id = ?").get(owner.user.id).n, 2);
  assert.equal(transaction(() => removeIdentities(owner.user.id, { provider: "wechat" })).length, 1);
});
