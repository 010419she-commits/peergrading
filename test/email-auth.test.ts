// Isolated real HTTP/SQLite flows. No production account, SMTP server or payment provider is contacted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import cookieParser from "cookie-parser";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pg-email-auth-"));
const outbox = path.join(temporary, "outbox");
Object.assign(process.env, {
  DATA_DIR: temporary, NODE_ENV: "test", BASE_URL: "http://localhost:3000", DEV_LOGIN: "1",
  SESSION_SECRET: "email-test-isolated-secret-at-least-32-characters", EMAIL_TEST_OUTBOX_DIR: outbox,
  EMAIL_PROVIDER: "", EMAIL_FROM: "", WECHAT_OPEN_APPID: "old-app", WECHAT_OPEN_SECRET: "old-secret",
});
const { db, q, transaction } = await import("../auth/db.ts");
const { config } = await import("../auth/config.ts");
const { attachBrowser } = await import("../auth/browser.ts");
const { attachUser, noStore } = await import("../auth/middleware.ts");
const { auth, account } = await import("../auth/routes.ts");
const { device } = await import("../auth/device.ts");
const { now, sha256 } = await import("../auth/security.ts");
const { resolveLogin } = await import("../auth/users.ts");
const { sendEmailCode } = await import("../auth/mail.ts");
const nativeFetch = globalThis.fetch;
let origin = "", sequence = 0;
const app = express();
app.use(express.json(), cookieParser(), noStore, attachBrowser, attachUser, auth, device);
app.use("/api/account", account);
let server: ReturnType<typeof app.listen>;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  db.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
const address = () => `person-${++sequence}@example.test`;
class Browser {
  cookies = new Map<string, string>();
  async request(route: string, opts: RequestInit = {}) {
    const headers = new Headers(opts.headers);
    headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await nativeFetch(origin + route, { ...opts, headers, redirect: "manual" });
    for (const value of response.headers.getSetCookie()) {
      const [k, v] = value.split(";")[0].split("=");
      if (v) this.cookies.set(k, v); else this.cookies.delete(k);
    }
    return response;
  }
  async bootstrap() { return (await this.request("/api/auth/bootstrap")).json(); }
  async post(route: string, body: object, extra: Record<string, string> = {}) {
    const bootstrap = await this.bootstrap();
    return this.request(route, { method: "POST", headers: { "content-type": "application/json", origin: config.siteOrigin, "x-csrf-token": bootstrap.csrf, ...extra }, body: JSON.stringify(body) });
  }
  async start(email = address(), opts: object = {}) {
    const response = await this.post("/api/auth/email/start", { email, intent: "login", return_to: "/account", ...opts });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  }
  verify(challenge: any, code = codeOf(challenge)) { return this.post("/api/auth/email/verify", { challengeId: challenge.challengeId, code }); }
  async login(email = address()) {
    const challenge = await this.start(email);
    assert.equal((await this.verify(challenge)).status, 200);
    return (await this.bootstrap()).user;
  }
}
function codeOf(challenge: any) {
  const file = path.join(outbox, `${challenge.challengeId}.json`);
  // Windows uses the user directory's ACL; POSIX mode bits apply only on Unix.
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  return /验证码：(\d{6})/.exec(JSON.parse(fs.readFileSync(file, "utf8")).text)![1];
}
const devicePost = (route: string, body: object) => nativeFetch(origin + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const deviceStart = async () => (await devicePost("/api/device/start", { deviceName: "email isolated desktop" })).json();

test("mail availability is honest, retired WeChat endpoints cannot authorize, and login HTML supplies an email mount", async () => {
  const browser = new Browser();
  assert.equal((await browser.bootstrap()).providers.email.available, true);
  assert.equal((await browser.bootstrap()).providers.wechat.available, false);
  assert.equal((await browser.post("/api/auth/start", { provider: "wechat", intent: "login" })).status, 409);
  assert.equal((await browser.request("/auth/wechat/callback?code=old&state=old")).status, 410);
  assert.match(await (await browser.request("/login")).text(), /id="email-login-root"/);
  config.email.testOutboxDir = "";
  try {
    const bootstrap = await browser.bootstrap(); assert.equal(bootstrap.providers.email.available, false);
    const response = await browser.post("/api/auth/email/start", { email: address(), intent: "login" });
    assert.equal(response.status, 503); assert.equal((await response.json()).error, "mail_unavailable");
    assert.equal((await devicePost("/api/device/email/start", { email: address(), deviceCode: (await deviceStart()).deviceCode })).status, 503);
  } finally { config.email.testOutboxDir = outbox; }
});

test("email input rejects header injection, multiple recipients and invalid local/domain syntax", async () => {
  const browser = new Browser();
  for (const email of ["person@example.test\r\nBcc:other@example.test", "a@example.test,b@example.test", "a@localhost", "..a@example.test", ".a@example.test", "a.@example.test", "x".repeat(65) + "@example.test"]) {
    assert.equal((await browser.post("/api/auth/email/start", { email, intent: "login" })).status, 400);
  }
});

test("web OTP uses the existing session/entitlement flow and stores only a bound HMAC", async () => {
  const browser = new Browser(), email = address();
  const challenge = await browser.start(` ${email.toUpperCase()} `);
  assert.equal(challenge.email, email); assert.equal(challenge.code, undefined);
  assert.equal(challenge.expiresIn, 600); assert.equal(challenge.resendAfter, 60);
  const row = q("SELECT * FROM email_challenges WHERE id = ?").get(challenge.challengeId), code = codeOf(challenge);
  assert.notEqual(row.code_mac, code); assert.notEqual(row.code_mac, sha256(code));
  assert.match(row.code_mac, /^[a-f0-9]{64}$/);
  const response = await browser.verify(challenge);
  assert.equal(response.status, 200); assert.equal((await response.json()).redirect, "/account?login=welcome");
  const user = (await browser.bootstrap()).user;
  assert.equal(user.identities[0].provider, "email"); assert.equal(user.identities[0].email, email);
  assert.equal(user.recentlyVerified, true); assert.equal(user.access.allowed, true);
  assert.equal((await browser.verify(challenge)).status, 409);
});

test("email login never silently merges a Google account using a matching display name/email", async () => {
  const email = address();
  const existing = transaction(() => resolveLogin({ provider: "google", issuer: "https://accounts.google.com", uid: "google-id-email-test", name: email })).user;
  const user = await new Browser().login(email);
  assert.notEqual(user.id, existing.id);
});

test("cross-browser verification and forged CSRF cannot redeem the code; the original browser can", async () => {
  const original = new Browser(), other = new Browser(), challenge = await original.start();
  const wrongBrowser = await other.verify(challenge); assert.equal(wrongBrowser.status, 409);
  assert.equal((await wrongBrowser.json()).error, "stale_tx");
  for (const headers of [{ "x-csrf-token": "forged" }, { origin: "https://evil.example" }]) {
    assert.equal((await original.post("/api/auth/email/verify", { challengeId: challenge.challengeId, code: codeOf(challenge) }, headers)).status, 403);
  }
  assert.equal(q("SELECT attempts FROM email_challenges WHERE id = ?").get(challenge.challengeId).attempts, 0);
  assert.equal((await original.verify(challenge)).status, 200);
});

test("five failed guesses lock the challenge even with the correct code, and expired codes cannot authenticate", async () => {
  const browser = new Browser(), challenge = await browser.start();
  const wrong = codeOf(challenge) === "000000" ? "999999" : "000000";
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await browser.verify(challenge, wrong);
    assert.equal(response.status, attempt === 5 ? 429 : 400);
  }
  const locked = await browser.verify(challenge); assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get("retry-after")) > 0);
  const expired = await browser.start();
  q("UPDATE email_challenges SET expires_at = ? WHERE id = ?").run(now(), expired.challengeId);
  assert.equal((await browser.verify(expired)).status, 410); assert.equal((await browser.bootstrap()).user, null);
});

test("logout changes the browser epoch so an earlier email challenge cannot sign the user back in", async () => {
  const browser = new Browser(); await browser.login();
  const challenge = await browser.start(address(), { intent: "switch" });
  assert.equal((await browser.post("/auth/logout", {})).status, 200);
  const response = await browser.verify(challenge); assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "stale_tx"); assert.equal((await browser.bootstrap()).user, null);
});

test("explicit email binding preserves the account, verifies its exact identity, and refuses a different owner", async () => {
  const browser = new Browser(), user = await browser.login(), boundEmail = address();
  const challenge = await browser.start(boundEmail, { intent: "bind" });
  assert.equal((await browser.verify(challenge)).status, 200);
  const updated = (await browser.bootstrap()).user; assert.equal(updated.id, user.id); assert.equal(updated.identities.length, 2);
  const identity = updated.identities.find((i: any) => i.email === boundEmail);
  // Bypass the resend cooldown in this isolated fixture only.
  q("DELETE FROM email_auth_limits").run();
  const reverify = await browser.start(boundEmail, { intent: "reverify", identityId: identity.id });
  const verified = await browser.verify(reverify); assert.equal(verified.status, 200); assert.match((await verified.json()).redirect, /login=reverified/);
  assert.equal((await browser.bootstrap()).user.verifiedBy, identity.id);
  const other = new Browser(); await other.login(); q("DELETE FROM email_auth_limits").run();
  const conflict = await other.start(boundEmail, { intent: "bind" });
  const rejected = await other.verify(conflict); assert.equal(rejected.status, 409); assert.equal((await rejected.json()).error, "identity_conflict");
  assert.equal((await other.bootstrap()).user.identities.length, 1);
});

test("binding requires fresh verification and an identity removed while the email is in flight cannot reverify", async () => {
  const browser = new Browser(), user = await browser.login(), email = user.identities[0].email;
  q("UPDATE sessions SET last_verified_at = ? WHERE user_id = ?").run(now() - 3600, user.id);
  const staleBind = await browser.post("/api/auth/email/start", { intent: "bind", email: address() });
  assert.equal(staleBind.status, 403);
  q("DELETE FROM email_auth_limits").run();
  const challenge = await browser.start(email, { intent: "reverify", identityId: user.identities[0].id });
  q("UPDATE identities SET link_version = link_version + 1 WHERE id = ?").run(user.identities[0].id);
  const response = await browser.verify(challenge); assert.equal(response.status, 409); assert.equal((await response.json()).error, "reverify_mismatch");
});

test("disabled email users cannot start new sessions or approve a desktop", async () => {
  const browser = new Browser(), email = address(), user = await browser.login(email);
  await browser.post("/auth/logout", {}); q("DELETE FROM email_auth_limits").run();
  const challenge = await browser.start(email);
  q("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
  const response = await browser.verify(challenge); assert.equal(response.status, 409); assert.equal((await response.json()).error, "account_disabled");
  assert.equal((await browser.bootstrap()).user, null);
  q("DELETE FROM email_auth_limits").run();
  const desktop = await deviceStart();
  const sent = await devicePost("/api/device/email/start", { deviceCode: desktop.deviceCode, email });
  assert.equal(sent.status, 200); const deviceChallenge = await sent.json();
  const disabled = await devicePost("/api/device/email/verify", { deviceCode: desktop.deviceCode, challengeId: deviceChallenge.challengeId, code: codeOf(deviceChallenge) });
  assert.equal(disabled.status, 409); assert.equal((await disabled.json()).error, "account_disabled");
  assert.equal(q("SELECT COUNT(*) n FROM device_tokens WHERE user_id = ?").get(user.id).n, 0);
  assert.equal(q("SELECT status FROM device_codes WHERE device_code = ?").get(sha256(desktop.deviceCode)).status, "pending");
});

test("desktop OTP proves the exact high-entropy device request and lets the normal poll issue one token", async () => {
  q("DELETE FROM email_auth_limits").run();
  const desktop = await deviceStart(), other = await deviceStart(), email = address();
  const sent = await devicePost("/api/device/email/start", { deviceCode: desktop.deviceCode, email });
  assert.equal(sent.status, 200); const challenge = await sent.json();
  const body = { challengeId: challenge.challengeId, code: codeOf(challenge) };
  assert.equal((await devicePost("/api/device/email/verify", { ...body, deviceCode: other.deviceCode })).status, 409);
  const approved = await devicePost("/api/device/email/verify", { ...body, deviceCode: desktop.deviceCode });
  assert.equal(approved.status, 200); assert.deepEqual(await approved.json(), { ok: true, status: "approved" });
  assert.equal(approved.headers.get("set-cookie"), null);
  const response = await devicePost("/api/device/poll", { deviceCode: desktop.deviceCode });
  const polled = await response.json(); assert.equal(polled.status, "approved"); assert.ok(polled.deviceToken);
  assert.equal((await (await devicePost("/api/device/poll", { deviceCode: desktop.deviceCode })).json()).status, "consumed");
  assert.equal((await devicePost("/api/device/email/verify", { ...body, deviceCode: desktop.deviceCode })).status, 409);
});

test("a denied or expired desktop request cannot be approved by a previously delivered OTP", async () => {
  for (const expired of [false, true]) {
    const desktop = await deviceStart(), sent = await devicePost("/api/device/email/start", { deviceCode: desktop.deviceCode, email: address() });
    assert.equal(sent.status, 200); const challenge = await sent.json();
    if (expired) q("UPDATE device_codes SET expires_at = ? WHERE device_code = ?").run(now(), sha256(desktop.deviceCode));
    else q("UPDATE device_codes SET status = 'denied' WHERE device_code = ?").run(sha256(desktop.deviceCode));
    assert.equal((await devicePost("/api/device/email/verify", { deviceCode: desktop.deviceCode, challengeId: challenge.challengeId, code: codeOf(challenge) })).status, expired ? 410 : 409);
  }
});

test("email and IP send limits persist in SQLite and return Retry-After", async () => {
  q("DELETE FROM email_auth_limits").run();
  const browser = new Browser(), email = address(); await browser.start(email);
  const resend = await browser.post("/api/auth/email/start", { email, intent: "login" });
  assert.equal(resend.status, 429); assert.ok(Number(resend.headers.get("retry-after")) > 0);
  let limited: Response | undefined;
  for (let i = 0; i < 21; i++) {
    const response = await browser.post("/api/auth/email/start", { email: address(), intent: "login" });
    if (response.status === 429) { limited = response; break; }
  }
  assert.ok(limited); assert.equal((await limited.json()).error, "rate_limited");
  assert.ok(q("SELECT COUNT(*) AS n FROM email_auth_limits").get().n > 0);
});

test("Resend payload uses the verified sender, idempotency and text OTP; delivery failure never reports success", async () => {
  const previous = structuredClone(config.email);
  let calls = 0;
  config.email.testOutboxDir = ""; config.email.provider = "resend"; config.email.from = "PeerGrading <login@example.test>"; config.email.resendKey = "fake-key";
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    assert.equal(String(input), "https://api.resend.com/emails");
    const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
    assert.equal(headers.get("authorization"), "Bearer fake-key"); assert.match(headers.get("idempotency-key")!, /^email-challenge-/);
    assert.deepEqual(body.to, ["test@example.test"]); assert.equal(body.from, config.email.from); assert.match(body.text, /123456/);
    return ++calls === 1 ? Response.json({ id: "mock-message" }) : Response.json({ message: "secret provider text" }, { status: 500 });
  };
  try {
    await sendEmailCode("test@example.test", "123456", "test-message");
    await assert.rejects(sendEmailCode("test@example.test", "123456", "failed-message"), (e: any) => e.code === "mail_delivery_failed" && !e.message.includes("secret provider"));
  } finally { Object.assign(config.email, previous); globalThis.fetch = nativeFetch; }
});

test("a delivery rejection burns the pending challenge and returns an error instead of sent/success", async () => {
  const previous = structuredClone(config.email);
  config.email.testOutboxDir = ""; config.email.provider = "resend"; config.email.from = "login@example.test"; config.email.resendKey = "fake-key";
  globalThis.fetch = async () => Response.json({ message: "unverified sender" }, { status: 403 });
  try {
    q("DELETE FROM email_auth_limits").run();
    const browser = new Browser(), email = address();
    const response = await browser.post("/api/auth/email/start", { email, intent: "login" });
    assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: "mail_delivery_failed" });
    const row = q("SELECT * FROM email_challenges WHERE email = ?").get(email);
    assert.ok(row.consumed_at); assert.equal(row.sent_at, null); assert.equal((await browser.bootstrap()).user, null);
  } finally { Object.assign(config.email, previous); globalThis.fetch = nativeFetch; }
});

test("simultaneous email verification can mint only one authenticated session", async () => {
  q("DELETE FROM email_auth_limits").run();
  const browser = new Browser(), challenge = await browser.start();
  const before = q("SELECT COUNT(*) n FROM sessions").get().n;
  const responses = await Promise.all([browser.verify(challenge), browser.verify(challenge)]);
  assert.equal(responses.filter((response) => response.status === 200).length, 1);
  assert.ok(responses.filter((response) => response.status !== 200).every((response) => [403, 409].includes(response.status)));
  assert.equal(q("SELECT COUNT(*) n FROM sessions").get().n, before + 1);
});

test("production ignores the test outbox even when the environment variable is supplied", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `const {config}=await import(${JSON.stringify(pathToFileURL(path.resolve("auth/config.ts")).href)}); const {emailReady}=await import(${JSON.stringify(pathToFileURL(path.resolve("auth/mail.ts")).href)}); if(config.email.testOutboxDir || emailReady())process.exit(7);`], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_ENV: "production", BASE_URL: "https://example.test", DATA_DIR: path.join(temporary, "production"), EMAIL_PROVIDER: "", EMAIL_FROM: "", EMAIL_TEST_OUTBOX_DIR: outbox },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("legacy identity CHECK migration retains IDs, session verification, grants, orders and sequence values", () => {
  const directory = path.join(temporary, "legacy"); fs.mkdirSync(directory);
  const legacy = new DatabaseSync(path.join(directory, "app.db"));
  legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT, avatar_url TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER DEFAULT (unixepoch()), updated_at INTEGER DEFAULT (unixepoch()));
    INSERT INTO users(id,display_name)VALUES(7,'legacy user');
    CREATE TABLE identities(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,provider TEXT NOT NULL CHECK(provider IN ('google','wechat','dev')),issuer TEXT NOT NULL,provider_uid TEXT NOT NULL,channel TEXT,union_id TEXT,display_name TEXT,avatar_url TEXT,link_version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL DEFAULT (unixepoch()),last_login_at INTEGER NOT NULL DEFAULT (unixepoch()),UNIQUE(provider,issuer,provider_uid));
    INSERT INTO identities(id,user_id,provider,issuer,provider_uid)VALUES(42,7,'google','google','legacy-google');
    INSERT INTO identities(id,user_id,provider,issuer,provider_uid,channel,union_id)VALUES(43,7,'wechat','wx','legacy-wechat','open','legacy-union');
    INSERT INTO identities(id,user_id,provider,issuer,provider_uid)VALUES(99,7,'dev','dev','deleted'); DELETE FROM identities WHERE id=99;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER DEFAULT (unixepoch()),expires_at INTEGER NOT NULL,last_verified_at INTEGER NOT NULL,verified_by_identity_id INTEGER,revoked_at INTEGER);
    INSERT INTO sessions(id,user_id,expires_at,last_verified_at,verified_by_identity_id)VALUES('existing-session',7,9999999999,123,42);`);
  for (const table of ["entitlement_grants", "orders"]) legacy.exec(q("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql);
  legacy.exec(`INSERT INTO entitlement_grants(id,user_id,entitlement,source_type,source_ref,starts_at,ends_at,is_permanent,grant_params)
    VALUES(88,7,'member','payment','old-paid-order',1,NULL,1,'{}');
    INSERT INTO orders(id,user_id,merchant_id,merchant_order_no,plan_code,plan_version,plan_snapshot,amount_cents,currency,provider,provider_txn_id,status,paid_at)
    VALUES(77,7,'merchant','old-paid-order','permanent',1,'{}',9900,'CNY','wechat','old-transaction','paid',123);`);
  legacy.close();
  const moduleUrl = pathToFileURL(path.resolve("auth/db.ts")).href;
  const script = `const {q,db}=await import(${JSON.stringify(moduleUrl)});
    if(q("SELECT COUNT(*) n FROM identities").get().n!==2)throw Error('lost identities');
    if(q("SELECT verified_by_identity_id id FROM sessions").get().id!==42)throw Error('lost session linkage');
    if(q("SELECT union_id FROM identities WHERE id=43").get().union_id!=='legacy-union')throw Error('lost WeChat');
    if(q("SELECT user_id FROM entitlement_grants WHERE id=88 AND is_permanent=1").get()?.user_id!==7)throw Error('lost member grant');
    if(q("SELECT user_id FROM orders WHERE id=77 AND status='paid' AND amount_cents=9900").get()?.user_id!==7)throw Error('lost paid order');
    q("INSERT INTO identities(user_id,provider,issuer,provider_uid)VALUES(7,'email','peergrading:email:v1','legacy@example.test')").run();
    q("INSERT INTO identities(user_id,provider,issuer,provider_uid)VALUES(7,'github','https://github.com','123')").run();
    if(q("SELECT MIN(id) id FROM identities WHERE provider IN ('email','github')").get().id<=99)throw Error('lost sequence');
    if(q('PRAGMA foreign_key_check').all().length)throw Error('foreign keys');db.close();`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATA_DIR: directory } });
  assert.equal(result.status, 0, result.stderr);
});
