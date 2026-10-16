// Device authorization exercises real HTTP servers with an isolated database; no paid service is contacted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-desktop-auth-"));
Object.assign(process.env, { DATA_DIR: temporary, BASE_URL: "http://localhost:3000", LOCAL_MODE: "1", DEV_LOGIN: "1", NODE_ENV: "test", SESSION_SECRET: "isolated-desktop-auth-test-secret-000000000" });
const { db, q } = await import("../auth/db.ts");
const { config } = await import("../auth/config.ts");
const { attachBrowser } = await import("../auth/browser.ts");
const { attachUser, noStore } = await import("../auth/middleware.ts");
const { auth } = await import("../auth/routes.ts");
const { device, requireDevice } = await import("../auth/device.ts");
const { local, setCloudUrl, unpair, isPaired, cachedUser, refreshMe, pollPairing, reportUsage, startPairing } = await import("../auth/localmode.ts");
const { desktopReturnUrl } = await import("../auth/desktop-return.ts");
const { now, sha256 } = await import("../auth/security.ts");

const realFetch = globalThis.fetch;
let cloudOrigin = "", localOrigin = "", sequence = 0, proxyCalls: any[] = [];
let cloudServer: any, localServer: any;
const cloudApp = express();
cloudApp.use(express.json(), express.urlencoded({ extended: false }), cookieParser(), noStore, attachBrowser, attachUser);
cloudApp.use(auth, device);
cloudApp.use("/api/desktop/account", requireDevice, (req, res) => {
  proxyCalls.push({ method: req.method, path: req.path, body: req.body, user: (req as any).user.id });
  const user = (req as any).user;
  res.json({ user: { id: user.id, name: user.display_name, access: { allowed: true, member: true } }, plan: { name: "test-plan" }, body: req.body });
});
const localApp = express();
localApp.use(express.json(), cookieParser(), noStore, attachBrowser);
localApp.use(local);

before(async () => {
  cloudServer = cloudApp.listen(0, "127.0.0.1"); localServer = localApp.listen(0, "127.0.0.1");
  await Promise.all([cloudServer, localServer].map((server) => new Promise<void>((resolve) => server.once("listening", resolve))));
  cloudOrigin = `http://127.0.0.1:${cloudServer.address().port}`;
  localOrigin = `http://127.0.0.1:${localServer.address().port}`;
  setCloudUrl(cloudOrigin);
});
after(async () => {
  globalThis.fetch = realFetch;
  await Promise.all([cloudServer, localServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  db.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
class Browser {
  cookies = new Map<string, string>();
  origin: string;
  constructor(origin: string) { this.origin = origin; }
  async request(target: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await realFetch(this.origin + target, { ...options, headers, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const [key, value] = cookie.split(";")[0].split("=");
      if (value) this.cookies.set(key, value); else this.cookies.delete(key);
    }
    return response;
  }
  async bootstrap() { return (await this.request("/api/auth/bootstrap")).json(); }
  async post(target: string, body: any, extra: Record<string, string> = {}) {
    const bootstrap = await this.bootstrap();
    return this.request(target, { method: "POST", headers: { origin: config.siteOrigin, "x-csrf-token": bootstrap.csrf, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
  }
  async login() {
    const started = await this.post("/api/auth/start", { provider: "dev", intent: "login", return_to: "/device" });
    const url = new URL((await started.json()).url, this.origin);
    const response = await this.request(`/auth/dev/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, uid: `desktop_${++sequence}` })}`);
    assert.equal(response.status, 302);
    return (await this.bootstrap()).user;
  }
}
async function cloudPost(target: string, body: any) { return realFetch(cloudOrigin + target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
async function startCloud(body: any = {}) {
  const response = await cloudPost("/api/device/start", body);
  assert.equal(response.status, 200, await response.clone().text()); return response.json();
}
const poll = async (code: string) => (await cloudPost("/api/device/poll", { deviceCode: code })).json();
const codeOf = (request: any) => new URL(request.verificationUrl).searchParams.get("code")!;

test("desktop callbacks accept only the literal IPv4 loopback endpoint and a strong state", async () => {
  assert.equal(desktopReturnUrl("http://127.0.0.1:4000/api/local/auth/callback"), "http://127.0.0.1:4000/api/local/auth/callback");
  for (const value of ["https://evil.test/api/local/auth/callback", "http://localhost:4000/api/local/auth/callback", "http://2130706433:4000/api/local/auth/callback", "http://127.0.0.1:80/api/local/auth/callback", "http://127.0.0.1:65536/api/local/auth/callback", "http://127.0.0.1:4000/api/local/auth/callback?next=evil", "http://127.0.0.1:4000/api/local/auth/callback#x", "http://127.0.0.1:4000/api/local/../auth/callback", "http://user@127.0.0.1:4000/api/local/auth/callback"]) assert.equal(desktopReturnUrl(value), null);
  for (const body of [{ loopbackReturnUrl: "https://evil.test/", state: "A".repeat(43) }, { loopbackReturnUrl: `${localOrigin}/api/local/auth/callback`, state: "weak" }, { state: "A".repeat(43) }]) {
    assert.equal((await cloudPost("/api/device/start", body)).status, 400);
  }
});
test("account service accepts HTTPS and local development HTTP, rejecting plaintext remote origins", () => {
  for (const value of ["http://peergrading.ai", "http://192.168.1.2:3001", "http://evil.example", "https://user:password@example.test", "https://example.test/path", "https://example.test?token=secret"]) assert.throws(() => setCloudUrl(value), /invalid_cloud_url/);
  setCloudUrl("http://localhost:3001");
  setCloudUrl("http://[::1]:3001");
  setCloudUrl("https://accounts.example.test");
  setCloudUrl(cloudOrigin);
});
test("manual eight-character codes normalize case/separators and issue a device token once", async () => {
  const browser = new Browser(cloudOrigin); await browser.login();
  const request = await startCloud({ deviceName: "test desktop" });
  assert.match(request.userCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
  assert.notEqual(q("SELECT device_code FROM device_codes WHERE user_code = ?").get(request.userCode).device_code, request.deviceCode);
  assert.equal((await poll(request.deviceCode)).status, "pending");
  const approved = await browser.post("/api/device/approve", { userCode: request.userCode.toLowerCase().replace("-", " ") });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).redirectUrl, undefined);
  const results = await Promise.all([poll(request.deviceCode), poll(request.deviceCode)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ["approved", "consumed"]);
  const token = results.find((r) => r.status === "approved").deviceToken;
  assert.equal(q("SELECT COUNT(*) AS n FROM device_tokens WHERE id = ?").get(sha256(token)).n, 1);
  assert.equal((await poll(request.deviceCode)).status, "consumed");
  const me = await realFetch(cloudOrigin + "/api/device/me", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.status, 200);
});
test("denied, expired and disabled accounts terminate polling without issuing tokens", async () => {
  const browser = new Browser(cloudOrigin), user = await browser.login();
  const denied = await startCloud();
  assert.equal((await browser.post("/api/device/deny", { userCode: denied.userCode.replace("-", "").toLowerCase() })).status, 200);
  assert.equal((await poll(denied.deviceCode)).status, "denied");
  const expired = await startCloud();
  q("UPDATE device_codes SET expires_at = ? WHERE user_code = ?").run(now(), expired.userCode);
  assert.equal((await browser.post("/api/device/approve", { userCode: expired.userCode })).status, 409);
  assert.equal((await poll(expired.deviceCode)).status, "expired");
  const disabled = await startCloud();
  await browser.post("/api/device/approve", { userCode: disabled.userCode });
  const tokens = q("SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = ?").get(user.id).n;
  q("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
  assert.equal((await poll(disabled.deviceCode)).status, "denied");
  assert.equal(q("SELECT COUNT(*) AS n FROM device_tokens WHERE user_id = ?").get(user.id).n, tokens);
});
test("approval and rejection require the browser session and CSRF", async () => {
  const request = await startCloud(), browser = new Browser(cloudOrigin); await browser.login();
  for (const endpoint of ["approve", "deny"]) {
    assert.equal((await cloudPost(`/api/device/${endpoint}`, { userCode: request.userCode })).status, 403);
    assert.equal((await browser.post(`/api/device/${endpoint}`, { userCode: request.userCode }, { "x-csrf-token": "forged" })).status, 403);
    assert.equal((await browser.post(`/api/device/${endpoint}`, { userCode: request.userCode }, { origin: "https://evil.test" })).status, 403);
  }
  assert.equal((await poll(request.deviceCode)).status, "pending");
});
test("one-click browser approval automatically signs the desktop in, without a token in URLs or API JSON", async () => {
  unpair();
  const desktop = new Browser(localOrigin), browser = new Browser(cloudOrigin); await browser.login();
  assert.equal((await desktop.bootstrap()).status, "anonymous");
  const started = await desktop.post("/api/local/auth/start", {});
  assert.equal(started.status, 200);
  const request = await started.json();
  assert.ok(request.expiresAt > Date.now()); assert.equal(request.deviceCode, undefined);
  const response = await browser.post("/api/device/approve", { userCode: codeOf(request) }), body = await response.json();
  const callback = new URL(body.redirectUrl);
  assert.equal(callback.origin, localOrigin); assert.equal(callback.pathname, "/api/local/auth/callback");
  assert.deepEqual([...callback.searchParams.keys()], ["state"]);
  assert.match(callback.searchParams.get("state")!, /^[A-Za-z0-9_-]{43}$/);
  const rejected = await realFetch(`${localOrigin}/api/local/auth/callback?state=${"Z".repeat(43)}`);
  assert.equal(rejected.status, 400); assert.equal(isPaired(), false);
  let emitted = 0; const onComplete = () => emitted++; process.on("peergrading:auth-complete" as any, onComplete);
  try {
    const callbackResponse = await realFetch(callback);
    assert.equal(callbackResponse.status, 200); assert.match(await callbackResponse.text(), /已登录，请返回 PeerGrading/);
    assert.equal(isPaired(), true); assert.equal(emitted, 1);
    assert.equal((await realFetch(callback)).status, 200); assert.equal(emitted, 1, "callback replay cannot mint another token or repeat focus event");
    const status = await (await desktop.request("/api/local/auth/status")).json();
    assert.equal(status.status, "approved"); assert.equal(status.paired, true);
    assert.equal(status.deviceToken, undefined); assert.equal(status.deviceCode, undefined);
    const bootstrap = await desktop.bootstrap();
    assert.equal(bootstrap.status, "authenticated"); assert.equal(bootstrap.user.id, cachedUser().id);
    const file = path.join(temporary, "device.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).token);
  } finally { process.off("peergrading:auth-complete" as any, onComplete); }
});
test("account proxy keeps the device token server-side and permits only account routes with CSRF", async () => {
  const desktop = new Browser(localOrigin); await desktop.bootstrap();
  const account = await desktop.request("/api/local/account"); assert.equal(account.status, 200);
  const details = await account.json(); assert.equal(details.user.access.member, true); assert.equal(details.token, undefined);
  assert.equal(cachedUser().access.member, true);
  assert.equal((await desktop.post("/api/local/account/orders", { plan: "monthly" })).status, 200);
  assert.equal(proxyCalls.at(-1).path, "/orders"); assert.deepEqual(proxyCalls.at(-1).body, { plan: "monthly" });
  const count = proxyCalls.length;
  for (const endpoint of ["orders", "orders/ABCDEFGH/checkout", "orders/ABCDEFGH/sync", "referral/claim", "devices/revoke"]) assert.equal((await desktop.post(`/api/local/account/${endpoint}`, {}, { "x-csrf-token": "bad" })).status, 403);
  assert.equal((await desktop.request("/api/local/account/admin")).status, 404);
  assert.equal((await desktop.post("/api/local/account/orders/ABCDEFGH/delete", {})).status, 404);
  assert.equal((await realFetch(localOrigin + "/api/local/account")).status, 403);
  assert.equal(proxyCalls.length, count);
});
test("logout revokes the remote token, clears local storage and emits a logout event", async () => {
  const desktop = new Browser(localOrigin); await desktop.bootstrap();
  const token = JSON.parse(fs.readFileSync(path.join(temporary, "device.json"), "utf8")).token;
  let emitted = 0; const onLogout = () => emitted++; process.on("peergrading:auth-logout" as any, onLogout);
  try {
    assert.equal((await desktop.post("/api/local/auth/logout", {})).status, 200);
    assert.equal(isPaired(), false); assert.equal(emitted, 1); assert.equal(fs.existsSync(path.join(temporary, "device.json")), false);
    assert.equal((await realFetch(cloudOrigin + "/api/device/me", { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally { process.off("peergrading:auth-logout" as any, onLogout); }
});
test("legacy local pairing ends on denial, expiry, consumed and unknown codes instead of waiting forever", async () => {
  const desktop = new Browser(localOrigin), browser = new Browser(cloudOrigin); await browser.login();
  for (const expected of ["denied", "expired", "consumed", "error"]) {
    unpair();
    const request = await (await desktop.post("/api/local/pair/start", {})).json();
    const row = q("SELECT * FROM device_codes WHERE user_code = ?").get(request.userCode);
    if (expected === "denied") await browser.post("/api/device/deny", { userCode: request.userCode });
    if (expected === "expired") q("UPDATE device_codes SET expires_at = ? WHERE device_code = ?").run(now(), row.device_code);
    if (expected === "consumed") q("UPDATE device_codes SET status = 'consumed' WHERE device_code = ?").run(row.device_code);
    if (expected === "error") q("DELETE FROM device_codes WHERE device_code = ?").run(row.device_code);
    assert.equal(await pollPairing(true), expected);
    assert.equal((await (await desktop.request("/api/local/auth/status")).json()).status, expected);
  }
});
test("revoked accounts invalidate a saved desktop login and reject subsequent usage", async () => {
  unpair();
  const desktop = new Browser(localOrigin), browser = new Browser(cloudOrigin), user = await browser.login();
  const request = await (await desktop.post("/api/local/auth/start", {})).json();
  await browser.post("/api/device/approve", { userCode: request.userCode });
  assert.equal(await pollPairing(true), "approved");
  q("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
  await refreshMe(true); assert.equal(isPaired(), false);
  await assert.rejects(reportUsage("test"), (error: any) => error.code === "unauthenticated");
});
test("a rejected browser authorization still shows a clear callback after desktop polling consumes its status", async () => {
  unpair();
  const desktop = new Browser(localOrigin), browser = new Browser(cloudOrigin); await browser.login();
  const request = await (await desktop.post("/api/local/auth/start", {})).json();
  const rejected = await (await browser.post("/api/device/deny", { userCode: request.userCode })).json();
  assert.equal(await pollPairing(true), "denied");
  const callback = await realFetch(rejected.redirectUrl);
  assert.equal(callback.status, 200); assert.match(await callback.text(), /已取消登录/); assert.equal(isPaired(), false);
});
test("logging out during an in-flight authorization request cannot restore the cancelled login", async () => {
  unpair();
  let release!: () => void, contacted!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve), seen = new Promise<void>((resolve) => contacted = resolve);
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    if (String(input) === cloudOrigin + "/api/device/start") { contacted(); await gate; }
    return realFetch(input, init);
  };
  try {
    const started = startPairing(`${localOrigin}/api/local/auth/callback`);
    await seen; unpair(); release();
    await assert.rejects(started, /登录请求已取消/);
    assert.equal(isPaired(), false); assert.equal(await pollPairing(true), "none");
  } finally { release(); globalThis.fetch = realFetch; }
});
test("logout discards in-flight usage permission and account data for the previous login", async () => {
  for (const endpoint of ["/api/device/usage", "/api/desktop/account"]) {
    unpair();
    const desktop = new Browser(localOrigin), browser = new Browser(cloudOrigin); const user = await browser.login();
    const request = await (await desktop.post("/api/local/auth/start", {})).json();
    await browser.post("/api/device/approve", { userCode: request.userCode });
    assert.equal(await pollPairing(true), "approved");
    await assert.rejects(reportUsage("wrong-user", user.id + 1), (error: any) => error.code === "unauthenticated");
    let release!: () => void, contacted!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve), seen = new Promise<void>((resolve) => contacted = resolve);
    globalThis.fetch = async (input: any, init?: RequestInit) => {
      const response = await realFetch(input, init);
      if (String(input) === cloudOrigin + endpoint) { contacted(); await gate; }
      return response;
    };
    try {
      const operation = endpoint.endsWith("usage") ? reportUsage("in-flight", user.id) : desktop.request("/api/local/account");
      await seen; unpair(); release();
      if (endpoint.endsWith("usage")) await assert.rejects(operation, (error: any) => error.code === "unauthenticated");
      else {
        const response = await operation as Response;
        assert.equal(response.status, 409); const result = await response.json();
        assert.equal(result.error, "account_changed"); assert.equal(result.user, undefined);
      }
    } finally { release(); globalThis.fetch = realFetch; }
  }
});
test("device creation rate limiting responds with Retry-After", async () => {
  let limited: Response | null = null;
  for (let i = 0; i < 35; i++) {
    const response = await cloudPost("/api/device/start", {});
    if (response.status === 429) { limited = response; break; }
  }
  assert.ok(limited); assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await limited.json()).error, "rate_limited");
});
