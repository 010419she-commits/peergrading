// GitHub OAuth：真实本地 HTTP / 独立数据库，远端只使用模拟凭证及 fetch。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-github-login-"));
Object.assign(process.env, {
  DATA_DIR: tmp, NODE_ENV: "test", BASE_URL: "http://localhost:3000", DEV_LOGIN: "1",
  SESSION_SECRET: "github-test-only-session-secret-000000000000",
  GITHUB_CLIENT_ID: "fake-github-client", GITHUB_CLIENT_SECRET: "fake-github-secret",
});
const { db, q } = await import("../auth/db.ts");
const { config } = await import("../auth/config.ts");
const { attachBrowser } = await import("../auth/browser.ts");
const { attachUser, noStore } = await import("../auth/middleware.ts");
const { auth, account } = await import("../auth/routes.ts");
const { githubReady } = await import("../auth/github.ts");
const { now } = await import("../auth/security.ts");

type Fixture = { token: any; profile: any; tokenStatus: number; profileStatus: number; challenge: string };
const fixtures = new Map<string, Fixture>();
const nativeFetch = globalThis.fetch;
const seenCodes = new Set<string>();
let calls = 0, seq = 0, origin = "";
const app = express();
app.use(express.json(), express.urlencoded({ extended: false }), cookieParser(), noStore, attachBrowser, attachUser);
app.use(auth);
app.use("/api/account", account);
let server: ReturnType<typeof app.listen>;

before(async () => {
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    if (!["github.com", "api.github.com"].includes(url.hostname)) return nativeFetch(input, init);
    calls++;
    assert.equal(url.protocol, "https:");
    assert.equal(init?.redirect, "error", "凭证不能随远端重定向转发");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), "PeerGrading");
    if (url.hostname === "github.com") {
      assert.equal(url.pathname, "/login/oauth/access_token");
      assert.equal(init?.method, "POST");
      assert.equal(headers.get("accept"), "application/json");
      const body = new URLSearchParams(String(init?.body));
      const code = body.get("code")!, f = fixtures.get(code);
      assert.ok(f, "只能交换预登记的测试授权码");
      assert.equal(body.get("client_id"), process.env.GITHUB_CLIENT_ID);
      assert.equal(body.get("client_secret"), process.env.GITHUB_CLIENT_SECRET);
      assert.equal(body.get("redirect_uri"), `${config.baseUrl}/auth/github/callback`);
      assert.equal(crypto.createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), f.challenge);
      if (seenCodes.has(code)) return Response.json({ error: "bad_verification_code" });
      seenCodes.add(code);
      return Response.json(f.token, { status: f.tokenStatus });
    }
    assert.equal(url.pathname, "/user");
    assert.equal(url.search, "", "token 不能出现在 URL 中");
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    const f = [...fixtures.values()].find((f) => headers.get("authorization") === `Bearer ${f.token?.access_token}`);
    assert.ok(f);
    return Response.json(f.profile, { status: f.profileStatus });
  };
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  if (server) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

class Browser {
  cookies = new Map<string, string>();
  async request(p: string, opts: RequestInit = {}) {
    const headers = new Headers(opts.headers);
    headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await nativeFetch(origin + p, { ...opts, headers, redirect: "manual" });
    for (const value of res.headers.getSetCookie()) {
      const [k, v] = value.split(";")[0].split("=");
      if (v) this.cookies.set(k, v); else this.cookies.delete(k);
    }
    return res;
  }
  async bootstrap() { return (await this.request("/api/auth/bootstrap")).json(); }
  async post(p: string, body: object, override: Record<string, string> = {}) {
    const b = await this.bootstrap();
    return this.request(p, { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: config.siteOrigin, "x-csrf-token": b.csrf, ...override } });
  }
  async start(provider = "github", intent = "login", returnTo = "/account") {
    const res = await this.post("/api/auth/start", { provider, intent, return_to: returnTo });
    assert.equal(res.status, 200, await res.clone().text());
    return new URL((await res.json()).url, origin);
  }
  async callback(url: URL, code: string) {
    return this.request(`/auth/github/callback?${new URLSearchParams({ state: state(url), code })}`);
  }
  async devLogin() {
    const url = await this.start("dev");
    const res = await this.request(`/auth/dev/callback?${new URLSearchParams({ state: state(url), uid: `dev_${++seq}` })}`);
    assert.match(res.headers.get("location")!, /login=(welcome|ok)/);
    return (await this.bootstrap()).user;
  }
}

function github(url: URL, opts: { id?: number; token?: any; profile?: any; tokenStatus?: number; profileStatus?: number } = {}) {
  const n = ++seq, code = `fake_code_${n}`;
  fixtures.set(code, {
    token: { access_token: `fake_github_access_${n}`, token_type: "bearer", scope: "read:user", ...opts.token },
    profile: { id: opts.id ?? 100000 + n, login: `user_${n}`, type: "User", name: "GitHub 测试用户",
      avatar_url: "https://avatars.githubusercontent.com/u/1", email: null, ...opts.profile },
    tokenStatus: opts.tokenStatus ?? 200, profileStatus: opts.profileStatus ?? 200,
    challenge: url.searchParams.get("code_challenge")!,
  });
  return code;
}
const state = (url: URL) => url.searchParams.get("state")!;
const users = () => q("SELECT count(*) AS n FROM users").get().n;
const txCount = () => q("SELECT count(*) AS n FROM oauth_transactions").get().n;
const failed = (res: Response) => assert.match(res.headers.get("location")!, /^\/\?login=(failed|stale)/);

test("未配置或只有单项凭证时隐藏 GitHub，不能发起认证事务", async () => {
  const saved = { id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET }, before = txCount();
  try {
    for (const [id, secret] of [["", ""], ["configured", " "], ["", "configured"]]) {
      process.env.GITHUB_CLIENT_ID = id; process.env.GITHUB_CLIENT_SECRET = secret;
      assert.equal(githubReady(), false);
      const b = new Browser();
      assert.equal((await b.bootstrap()).providers.github.available, false);
      assert.doesNotMatch(await (await b.request("/login")).text(), /name="provider" value="github"/);
      const res = await b.post("/api/auth/start", { provider: "github", intent: "login" });
      assert.equal(res.status, 409); assert.equal((await res.json()).error, "provider_unavailable");
    }
    assert.equal(txCount(), before);
  } finally { process.env.GITHUB_CLIENT_ID = saved.id; process.env.GITHUB_CLIENT_SECRET = saved.secret; }
});

test("GitHub 授权仅申请 read:user，使用 S256，创建会话后回调不可重放", async () => {
  const b = new Browser(), before = users(), url = await b.start();
  assert.equal((await b.bootstrap()).providers.github.available, true);
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), process.env.GITHUB_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), `${config.baseUrl}/auth/github/callback`);
  assert.equal(url.searchParams.get("scope"), "read:user");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.equal(url.searchParams.has("client_secret"), false);
  const code = github(url, { id: 424242 });
  const res = await b.callback(url, code);
  assert.equal(res.headers.get("location"), "/account?login=welcome");
  assert.match(res.headers.getSetCookie().join(";"), /HttpOnly/);
  assert.match(res.headers.getSetCookie().join(";"), /SameSite=Lax/);
  const user = (await b.bootstrap()).user;
  assert.equal(user.identities[0].provider, "github");
  assert.equal(users(), before + 1);
  const identity = q("SELECT * FROM identities WHERE id = ?").get(user.identities[0].id);
  assert.equal(identity.issuer, "https://github.com"); assert.equal(identity.provider_uid, "424242");
  assert.equal(JSON.stringify(identity).includes("fake_github_access_"), false);
  assert.equal(JSON.stringify(q("SELECT * FROM oauth_transactions WHERE state = ?").get(state(url))).includes("fake_github_access_"), false);
  const n = calls, sid = b.cookies.get("sid");
  failed(await b.callback(url, code)); assert.equal(calls, n); assert.equal(b.cookies.get("sid"), sid);
});

test("稳定数字 ID 支持用户名更改与隐藏邮箱，不凭相同公开邮箱合并邮箱账号", async () => {
  const email = `same_${++seq}@example.com`;
  const existing = Number(q("INSERT INTO users(display_name) VALUES (?)").run(email).lastInsertRowid);
  q("INSERT INTO identities(user_id,provider,issuer,provider_uid) VALUES (?,'email','peergrading:email:v1',?)").run(existing, email);
  let id: number | undefined;
  for (const [login, publicEmail] of [["first-name", email], ["new-name", null]]) {
    const b = new Browser(), url = await b.start();
    await b.callback(url, github(url, { id: 343434, profile: { login, name: null, email: publicEmail } }));
    const user = (await b.bootstrap()).user;
    assert.ok(user); assert.notEqual(user.id, existing);
    if (id !== undefined) assert.equal(user.id, id); else id = user.id;
  }
  assert.equal(q("SELECT display_name FROM identities WHERE provider='github' AND provider_uid='343434'").get().display_name, "new-name");
});

test("必须通过同源和当前浏览器 CSRF 校验才能发起 GitHub 登录", async () => {
  const a = new Browser(), b = new Browser(), boot = await a.bootstrap(); await b.bootstrap();
  const before = txCount();
  for (const [browser, override] of [[a, { "x-csrf-token": "" }], [a, { origin: "https://attacker.invalid" }], [b, { "x-csrf-token": boot.csrf }]] as const) {
    assert.equal((await browser.post("/api/auth/start", { provider: "github", intent: "login" }, override)).status, 403);
  }
  assert.equal(txCount(), before);
});

test("伪造、重复 state 或其他浏览器回调不交换令牌，也不消费正确事务", async () => {
  const a = new Browser(), b = new Browser(), url = await a.start(), code = github(url), before = calls;
  await b.bootstrap();
  failed(await a.request(`/auth/github/callback?code=${code}&state=forged`));
  failed(await a.request(`/auth/github/callback?code=${code}&state=${state(url)}&state=extra`));
  failed(await b.callback(url, code));
  assert.equal(calls, before);
  assert.equal(q("SELECT consumed_at FROM oauth_transactions WHERE state=?").get(state(url)).consumed_at, null);
  assert.equal((await a.callback(url, code)).headers.get("location"), "/account?login=welcome");
});

test("取消也需有效一次性 state；提供错误参数不会继续交换令牌", async () => {
  const b = new Browser(), url = await b.start(), before = calls;
  failed(await b.request("/auth/github/callback?state=forged&error=access_denied"));
  assert.equal((await b.request(`/auth/github/callback?state=${state(url)}&error=access_denied`)).headers.get("location"), "/?login=cancelled");
  failed(await b.callback(url, github(url))); assert.equal(calls, before);
  const other = await b.start();
  failed(await b.request(`/auth/github/callback?state=${state(other)}&error=server_error`));
  assert.equal(calls, before);
});

test("过期、跨 provider 与旧标签事务均不交换 GitHub 令牌", async () => {
  const b = new Browser(), expired = await b.start(), before = calls;
  q("UPDATE oauth_transactions SET expires_at=? WHERE state=?").run(now() - 1, state(expired));
  failed(await b.callback(expired, github(expired))); assert.equal(calls, before);
  const dev = await b.start("dev");
  failed(await b.callback(dev, github(dev))); assert.equal(calls, before);
  const stale = await b.start(), current = await b.start();
  await b.callback(current, github(current));
  const id = (await b.bootstrap()).user.id, after = calls;
  failed(await b.callback(stale, github(stale)));
  assert.equal(calls, after); assert.equal((await b.bootstrap()).user.id, id);
});

test("并发重复回调只允许一次令牌交换和一次建号", async () => {
  const b = new Browser(), url = await b.start(), code = github(url), before = users(), n = calls;
  const out = await Promise.all([b.callback(url, code), b.callback(url, code)]);
  assert.equal(out.filter((r) => r.headers.get("location") === "/account?login=welcome").length, 1);
  assert.equal(users(), before + 1); assert.equal(calls, n + 2);
});

test("异常令牌、HTTP 错误与不可信用户资料都不能创建会话，失败事务不可重试", async (t) => {
  const cases = [
    { token: { error: "bad_verification_code" } }, { tokenStatus: 401 },
    { token: { access_token: "" } }, { token: { access_token: { forged: true } } },
    { token: { access_token: "token\nforged-header" } }, { token: { token_type: "basic" } },
    { profileStatus: 401 }, { profile: { id: "123" } }, { profile: { id: 0 } },
    { profile: { id: Number.MAX_SAFE_INTEGER + 1 } }, { profile: { login: "" } },
    { profile: { type: "Organization" } },
  ];
  for (const [i, opts] of cases.entries()) await t.test(`拒绝响应 ${i + 1}`, async () => {
    const b = new Browser(), url = await b.start(), before = users();
    failed(await b.callback(url, github(url, opts)));
    assert.equal(users(), before); assert.equal((await b.bootstrap()).user, null);
    const n = calls; failed(await b.callback(url, github(url))); assert.equal(calls, n);
  });
});

test("禁用账号不能通过 GitHub 登录，回调中不安全头像不会进入账号资料", async () => {
  const b = new Browser(), url = await b.start();
  await b.callback(url, github(url, { id: 565656, profile: { avatar_url: "javascript:alert(1)" } }));
  const user = (await b.bootstrap()).user;
  assert.equal(user.avatar, null);
  q("UPDATE users SET status='disabled' WHERE id=?").run(user.id);
  const other = new Browser(), next = await other.start(), before = users();
  failed(await other.callback(next, github(next, { id: 565656 })));
  assert.equal((await other.bootstrap()).user, null); assert.equal(users(), before);
});

test("已有账号显式绑定 GitHub 幂等；另一账号不能抢绑", async () => {
  const a = new Browser(), user = await a.devLogin();
  for (const result of ["bound", "already"]) {
    const res = await a.post("/api/account/bind", { provider: "github" });
    assert.equal(res.status, 200);
    const url = new URL((await res.json()).url);
    assert.equal((await a.callback(url, github(url, { id: 676767 }))).headers.get("location"), `/account?op=${result}`);
  }
  assert.equal((await a.bootstrap()).user.identities.length, 2);
  const b = new Browser(), other = await b.devLogin();
  const url = new URL((await (await b.post("/api/account/bind", { provider: "github" })).json()).url);
  assert.equal((await b.callback(url, github(url, { id: 676767 }))).headers.get("location"), "/account?op=identity_conflict");
  assert.equal((await b.bootstrap()).user.id, other.id);
  assert.equal(q("SELECT user_id FROM identities WHERE provider='github' AND provider_uid='676767'").get().user_id, user.id);
});

test("重新验证必须为目标 GitHub 身份，成功后轮换会话", async () => {
  const b = new Browser(), first = await b.start();
  await b.callback(first, github(first, { id: 787878 }));
  const identityId = (await b.bootstrap()).user.identities[0].id, sid = b.cookies.get("sid");
  const wrong = new URL((await (await b.post("/api/account/reverify", { identityId })).json()).url);
  assert.equal((await b.callback(wrong, github(wrong))).headers.get("location"), "/account?op=reverify_mismatch");
  assert.equal(b.cookies.get("sid"), sid);
  const right = new URL((await (await b.post("/api/account/reverify", { identityId })).json()).url);
  assert.equal((await b.callback(right, github(right, { id: 787878 }))).headers.get("location"), "/account?login=reverified");
  assert.notEqual(b.cookies.get("sid"), sid);
});

test("绑定回调的会话被替换，或重新验证时限过期时，均不能增加 GitHub 身份", async () => {
  const a = new Browser(), b = new Browser(); await a.devLogin(); await b.devLogin();
  const url = new URL((await (await a.post("/api/account/bind", { provider: "github" })).json()).url);
  a.cookies.set("sid", b.cookies.get("sid")!);
  assert.equal((await a.callback(url, github(url, { id: 898989 }))).headers.get("location"), "/account?op=stale_tx");
  assert.equal(q("SELECT id FROM identities WHERE provider='github' AND provider_uid='898989'").get(), undefined);
  const expired = new URL((await (await b.post("/api/account/bind", { provider: "github" })).json()).url);
  const user = (await b.bootstrap()).user;
  q("UPDATE sessions SET last_verified_at=? WHERE user_id=?").run(now() - config.reverifyWindowSec - 1, user.id);
  assert.equal((await b.callback(expired, github(expired, { id: 909090 }))).headers.get("location"), "/account?op=bind_reverify_expired");
  assert.equal(q("SELECT id FROM identities WHERE provider='github' AND provider_uid='909090'").get(), undefined);
});

test("授权后凭证移除，回调安全失败且不请求 GitHub", async () => {
  const b = new Browser(), url = await b.start(), secret = process.env.GITHUB_CLIENT_SECRET, before = calls;
  try {
    process.env.GITHUB_CLIENT_SECRET = "";
    failed(await b.callback(url, github(url))); assert.equal(calls, before);
  } finally { process.env.GITHUB_CLIENT_SECRET = secret; }
});
