// 微信 OAuth 集成测试：真实本地 HTTP + 独立数据库，微信 API 仅使用伪造凭证与 fetch mock。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-wechat-login-"));
Object.assign(process.env, {
  DATA_DIR: tmp, NODE_ENV: "test", BASE_URL: "http://localhost:3000", DEV_LOGIN: "1",
  SESSION_SECRET: "wechat-test-only-session-secret-000000000000",
  WECHAT_OPEN_APPID: "wx_test_website", WECHAT_OPEN_SECRET: "fake-website-secret",
  WECHAT_OPEN_UNION_DOMAIN: "test-platform", WECHAT_MP_APPID: "wx_test_mp",
  WECHAT_MP_SECRET: "fake-mp-secret", WECHAT_MP_UNION_DOMAIN: "test-platform",
});

const { db, q } = await import("../auth/db.ts");
const { config } = await import("../auth/config.ts");
const { attachBrowser } = await import("../auth/browser.ts");
const { attachUser, noStore } = await import("../auth/middleware.ts");
const { auth, account } = await import("../auth/routes.ts");
const { now } = await import("../auth/security.ts");

const nativeFetch = globalThis.fetch;
const wxResponses = new Map<string, { channel: "open" | "mp"; token: any; info: any }>();
const exchangedCodes = new Set<string>();
let wxCalls = 0, seq = 0, origin = "";
const app = express();
app.use(express.json(), express.urlencoded({ extended: false }), cookieParser(), noStore, attachBrowser, attachUser);
app.use(auth);
app.use("/api/account", account);
let server: ReturnType<typeof app.listen>;

before(async () => {
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.weixin.qq.com") return nativeFetch(input, init);
    wxCalls++;
    assert.equal(url.protocol, "https:");
    if (url.pathname === "/sns/oauth2/access_token") {
      const code = url.searchParams.get("code") || "";
      const fixture = wxResponses.get(code);
      assert.ok(fixture, "测试只允许事先登记的授权码");
      if (exchangedCodes.has(code)) return Response.json({ errcode: 40029 });
      exchangedCodes.add(code);
      assert.equal(url.searchParams.get("appid"), config.wechat[fixture.channel].appId);
      assert.equal(url.searchParams.get("secret"), config.wechat[fixture.channel].secret);
      assert.equal(url.searchParams.get("grant_type"), "authorization_code");
      return Response.json(fixture.token);
    }
    assert.equal(url.pathname, "/sns/userinfo");
    const fixture = [...wxResponses.values()].find((f) => f.token.access_token === url.searchParams.get("access_token"));
    assert.ok(fixture);
    assert.equal(url.searchParams.get("openid"), fixture.token.openid);
    return Response.json(fixture.info);
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

const WECHAT_UA = "Mozilla/5.0 MicroMessenger/8.0";
class Browser {
  cookies = new Map<string, string>();
  ua: string;
  constructor(ua = "Mozilla/5.0 Desktop") { this.ua = ua; }
  async request(p: string, opts: RequestInit = {}) {
    const headers = new Headers(opts.headers);
    headers.set("user-agent", this.ua);
    headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await nativeFetch(origin + p, { ...opts, headers, redirect: "manual" });
    for (const value of res.headers.getSetCookie()) {
      const [k, v] = value.split(";")[0].split("=");
      if (v) this.cookies.set(k, v); else this.cookies.delete(k);
    }
    return res;
  }
  async bootstrap() { return (await this.request("/api/auth/bootstrap")).json(); }
  async post(p: string, body: object, headers: Record<string, string> = {}) {
    const b = await this.bootstrap();
    return this.request(p, {
      method: "POST", headers: { "content-type": "application/json", origin: config.siteOrigin, "x-csrf-token": b.csrf, ...headers },
      body: JSON.stringify(body),
    });
  }
  async start(provider = "wechat", intent = "login") {
    const res = await this.post("/api/auth/start", { provider, intent, return_to: "/account" });
    assert.equal(res.status, 200, await res.clone().text());
    const { url } = await res.json();
    return new URL(url, origin);
  }
  async callback(url: URL, code: string) {
    return this.request(`/auth/wechat/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, code })}`);
  }
  async devLogin(uid = `dev_${++seq}`) {
    const url = await this.start("dev");
    const res = await this.request(`/auth/dev/callback?${new URLSearchParams({ state: url.searchParams.get("state")!, uid })}`);
    assert.match(res.headers.get("location")!, /login=(welcome|ok)/);
    return (await this.bootstrap()).user;
  }
}

function wx(channel: "open" | "mp" = "open", options: { uid?: string; union?: string | null; token?: any; info?: any } = {}) {
  const id = ++seq, code = `fake_code_${id}`, uid = options.uid || `openid_${id}`;
  const union = options.union === undefined ? `union_${id}` : options.union;
  wxResponses.set(code, {
    channel,
    token: { access_token: `fake_access_${id}`, openid: uid, scope: channel === "mp" ? "snsapi_userinfo" : "snsapi_login", ...(union ? { unionid: union } : {}), ...options.token },
    info: { openid: uid, nickname: "测试微信用户", headimgurl: "https://thirdwx.qlogo.cn/test", ...(union ? { unionid: union } : {}), ...options.info },
  });
  return code;
}
const countUsers = () => q("SELECT COUNT(*) AS n FROM users").get().n;
const txState = (url: URL) => url.searchParams.get("state")!;
const assertFailed = (res: Response) => assert.match(res.headers.get("location")!, /^\/\?login=(failed|stale)/);

test("未配置凭证时不展示微信登录，强行发起返回不可用且不创建事务", async () => {
  const saved = structuredClone(config.wechat);
  const txs = q("SELECT COUNT(*) AS n FROM oauth_transactions").get().n;
  try {
    config.wechat.open.secret = ""; config.wechat.mp.secret = "";
    for (const ua of ["Desktop", WECHAT_UA]) {
      const b = new Browser(ua);
      assert.equal((await b.bootstrap()).providers.wechat.available, false);
      const res = await b.post("/api/auth/start", { provider: "wechat", intent: "login" });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error, "provider_unavailable");
    }
    assert.equal(q("SELECT COUNT(*) AS n FROM oauth_transactions").get().n, txs);
  } finally { Object.assign(config.wechat, saved); }
});

test("网站应用扫码授权、回调、首次建用户、重复登录及回调重放", async () => {
  const b = new Browser(), usersBefore = countUsers();
  const url = await b.start();
  assert.equal(url.origin + url.pathname, "https://open.weixin.qq.com/connect/qrconnect");
  assert.equal(url.searchParams.get("scope"), "snsapi_login");
  assert.equal(url.searchParams.get("appid"), config.wechat.open.appId);
  assert.equal(url.searchParams.get("redirect_uri"), `${config.baseUrl}/auth/wechat/callback`);
  assert.match(txState(url), /^[a-zA-Z0-9]{48}$/);
  const code = wx("open", { uid: "website_repeat", union: "repeat_union" });
  const res = await b.callback(url, code);
  assert.equal(res.headers.get("location"), "/account?login=welcome");
  assert.match(res.headers.getSetCookie().join(";"), /HttpOnly/);
  assert.match(res.headers.getSetCookie().join(";"), /SameSite=Lax/);
  const user = (await b.bootstrap()).user;
  assert.ok(user.id);
  assert.equal(user.identities[0].channel, "open");
  assert.equal(countUsers(), usersBefore + 1);
  const calls = wxCalls, sid = b.cookies.get("sid");
  assertFailed(await b.callback(url, code));
  assert.equal(wxCalls, calls); assert.equal(b.cookies.get("sid"), sid);
  const again = new Browser();
  assert.equal((await again.callback(await again.start(), wx("open", { uid: "website_repeat", union: "repeat_union" }))).headers.get("location"), "/account?login=ok");
  assert.equal((await again.bootstrap()).user.id, user.id);
  assert.equal(countUsers(), usersBefore + 1);
});

test("微信内使用已认证服务号渠道；相同开放平台 UnionID 与网站扫码账号关联", async () => {
  const web = new Browser();
  await web.callback(await web.start(), wx("open", { union: "cross_channel_union" }));
  const expected = (await web.bootstrap()).user.id;
  const mp = new Browser(WECHAT_UA), url = await mp.start();
  assert.equal(url.pathname, "/connect/oauth2/authorize");
  assert.equal(url.searchParams.get("appid"), config.wechat.mp.appId);
  assert.equal(url.searchParams.get("scope"), "snsapi_userinfo");
  await mp.callback(url, wx("mp", { union: "cross_channel_union" }));
  const user = (await mp.bootstrap()).user;
  assert.equal(user.id, expected); assert.equal(user.identities.length, 2);
});

test("微信 UA 但只有网站应用时仍给出扫码渠道和系统浏览器提示", async () => {
  const secret = config.wechat.mp.secret;
  try {
    config.wechat.mp.secret = "";
    const b = new Browser(WECHAT_UA), boot = await b.bootstrap();
    assert.equal(boot.providers.wechat.available, true);
    assert.equal(boot.providers.wechat.mode, "qr");
    assert.match(boot.providers.wechat.hint, /系统浏览器/);
    assert.match(await (await b.request("/login")).text(), /系统浏览器/);
    assert.equal((await b.start()).pathname, "/connect/qrconnect");
  } finally { config.wechat.mp.secret = secret; }
});

test("不同开放平台的 UnionID，以及未明确配置关联域的 UnionID，均不自动合并账号", async () => {
  const saved = structuredClone(config.wechat);
  try {
    const a = new Browser();
    await a.callback(await a.start(), wx("open", { union: "untrusted_union" }));
    const aId = (await a.bootstrap()).user.id;
    config.wechat.mp.unionDomain = "another-platform";
    const b = new Browser(WECHAT_UA);
    await b.callback(await b.start(), wx("mp", { union: "untrusted_union" }));
    assert.notEqual((await b.bootstrap()).user.id, aId);
    config.wechat.mp.unionDomain = "";
    const c = new Browser(WECHAT_UA);
    await c.callback(await c.start(), wx("mp", { union: "untrusted_union" }));
    assert.notEqual((await c.bootstrap()).user.id, aId);
  } finally { Object.assign(config.wechat, saved); }
});

test("发起授权必须通过浏览器、同源和会话绑定的 CSRF 校验", async () => {
  const a = new Browser(), b = new Browser();
  const aBoot = await a.bootstrap(); await b.bootstrap();
  const count = q("SELECT COUNT(*) AS n FROM oauth_transactions").get().n;
  for (const [browser, headers] of [
    [a, { "x-csrf-token": "" }], [a, { origin: "https://attacker.invalid" }], [b, { "x-csrf-token": aBoot.csrf }],
  ] as const) {
    assert.equal((await browser.post("/api/auth/start", { provider: "wechat", intent: "login" }, headers)).status, 403);
  }
  assert.equal(q("SELECT COUNT(*) AS n FROM oauth_transactions").get().n, count);
});

test("伪造 state、重复参数及其他浏览器回调不会请求微信或消费正确浏览器的事务", async () => {
  const a = new Browser(), b = new Browser(), url = await a.start(), code = wx();
  await b.bootstrap();
  const calls = wxCalls;
  assertFailed(await a.request(`/auth/wechat/callback?code=${code}&state=forged`));
  assertFailed(await a.request(`/auth/wechat/callback?code=${code}&state=${txState(url)}&state=other`));
  assertFailed(await b.callback(url, code));
  assert.equal(wxCalls, calls);
  assert.equal(q("SELECT consumed_at FROM oauth_transactions WHERE state = ?").get(txState(url)).consumed_at, null);
  assert.equal((await a.callback(url, code)).headers.get("location"), "/account?login=welcome");
});

test("事务过期与其他标签已完成登录时，旧回调都不能登录", async () => {
  const a = new Browser(), expired = await a.start();
  q("UPDATE oauth_transactions SET expires_at = ? WHERE state = ?").run(now() - 1, txState(expired));
  const calls = wxCalls;
  assertFailed(await a.callback(expired, wx())); assert.equal(wxCalls, calls);
  const stale = await a.start(), current = await a.start();
  await a.callback(current, wx());
  const id = (await a.bootstrap()).user.id, after = wxCalls;
  assertFailed(await a.callback(stale, wx()));
  assert.equal(wxCalls, after); assert.equal((await a.bootstrap()).user.id, id);
});

test("并发重复回调只有一个创建账号和会话", async () => {
  const b = new Browser(), url = await b.start(), code = wx(), users = countUsers(), calls = wxCalls;
  const out = await Promise.all([b.callback(url, code), b.callback(url, code)]);
  assert.equal(out.filter((r) => r.headers.get("location") === "/account?login=welcome").length, 1);
  assert.equal(countUsers(), users + 1); assert.equal(wxCalls, calls + 2);
});

test("微信错误、错误 scope、虚拟账号、OpenID 或 UnionID 不一致都不创建会话", async (t) => {
  const cases = [
    { token: { errcode: 40029 } }, { token: { access_token: "" } },
    { token: { scope: "snsapi_base" } }, { token: { is_snapshotuser: 1 } },
    { info: { errcode: 40003 } }, { info: { openid: "wrong_openid" } },
    { info: { unionid: "different_union" } }, { token: { unionid: { forged: true } } },
    { info: { unionid: "with invalid space" } },
  ];
  for (const [i, options] of cases.entries()) await t.test(`拒绝异常响应 ${i + 1}`, async () => {
    const b = new Browser(), url = await b.start(), users = countUsers();
    assertFailed(await b.callback(url, wx("open", options)));
    assert.equal(countUsers(), users); assert.equal((await b.bootstrap()).user, null);
    const calls = wxCalls;
    assertFailed(await b.callback(url, wx())); assert.equal(wxCalls, calls, "失败回调仍是一次性消费");
  });
});

test("已有 OpenID 后续返回不同 UnionID 时拒绝关联新的 UnionID", async () => {
  const a = new Browser();
  await a.callback(await a.start(), wx("open", { uid: "fixed_openid", union: "fixed_union" }));
  const b = new Browser(), users = countUsers();
  assertFailed(await b.callback(await b.start(), wx("open", { uid: "fixed_openid", union: "changed_union" })));
  assert.equal(countUsers(), users);
  assert.equal(q("SELECT * FROM wechat_union_links WHERE union_id = 'changed_union'").get(), undefined);
});

test("登录后显式绑定微信；重复绑定幂等，其他账户不能抢绑", async () => {
  const a = new Browser(), user = await a.devLogin();
  const newCode = () => wx("open", { uid: "bound_openid", union: "bound_union" });
  for (const op of ["bound", "already"]) {
    const res = await a.post("/api/account/bind", { provider: "wechat" });
    assert.equal(res.status, 200);
    const url = new URL((await res.json()).url);
    assert.equal((await a.callback(url, newCode())).headers.get("location"), `/account?op=${op}`);
  }
  assert.equal((await a.bootstrap()).user.identities.length, 2);
  const b = new Browser(), other = await b.devLogin();
  const res = await b.post("/api/account/bind", { provider: "wechat" });
  assert.equal((await b.callback(new URL((await res.json()).url), newCode())).headers.get("location"), "/account?op=identity_conflict");
  assert.equal((await b.bootstrap()).user.id, other.id);
  assert.equal(q("SELECT user_id FROM identities WHERE provider_uid = 'bound_openid'").get().user_id, user.id);
  assert.equal((await b.bootstrap()).user.identities.length, 1);
});

test("绑定期间退出并换账号后，旧绑定回调不能将微信串到新账号", async () => {
  const b = new Browser(); await b.devLogin();
  const bind = await b.post("/api/account/bind", { provider: "wechat" });
  const url = new URL((await bind.json()).url);
  assert.equal((await b.post("/auth/logout", {})).status, 200);
  const other = await b.devLogin();
  const calls = wxCalls;
  assertFailed(await b.callback(url, wx("open", { uid: "must_not_bind" })));
  assert.equal(wxCalls, calls);
  assert.equal((await b.bootstrap()).user.id, other.id);
  assert.equal(q("SELECT id FROM identities WHERE provider_uid = 'must_not_bind'").get(), undefined);
});

test("回调期间会话 cookie 被替换时，不能忽略发起会话绑定", async () => {
  const a = new Browser(), b = new Browser();
  await a.devLogin(); await b.devLogin();
  const bind = await a.post("/api/account/bind", { provider: "wechat" });
  a.cookies.set("sid", b.cookies.get("sid")!);
  assert.equal((await a.callback(new URL((await bind.json()).url), wx("open", { uid: "wrong_session_bind" }))).headers.get("location"), "/account?op=stale_tx");
  assert.equal(q("SELECT id FROM identities WHERE provider_uid = 'wrong_session_bind'").get(), undefined);
});

test("重新验证只接受目标身份，并轮换成功会话", async () => {
  const b = new Browser(), newCode = () => wx("open", { uid: "reverify_openid", union: "reverify_union" });
  await b.callback(await b.start(), newCode());
  const identityId = (await b.bootstrap()).user.identities[0].id;
  const mismatch = await b.post("/api/account/reverify", { identityId });
  const sid = b.cookies.get("sid");
  assert.equal((await b.callback(new URL((await mismatch.json()).url), wx())).headers.get("location"), "/account?op=reverify_mismatch");
  assert.equal(b.cookies.get("sid"), sid);
  const success = await b.post("/api/account/reverify", { identityId });
  assert.equal((await b.callback(new URL((await success.json()).url), newCode())).headers.get("location"), "/account?login=reverified");
  assert.notEqual(b.cookies.get("sid"), sid);
});

test("绑定回调前验证窗口到期或账号被禁用，均不新增身份", async () => {
  for (const disabled of [false, true]) {
    const b = new Browser(), user = await b.devLogin();
    const bind = await b.post("/api/account/bind", { provider: "wechat" });
    if (disabled) q("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    else q("UPDATE sessions SET last_verified_at = ? WHERE user_id = ?").run(now() - config.reverifyWindowSec - 1, user.id);
    const uid = `expired_bind_${++seq}`;
    const res = await b.callback(new URL((await bind.json()).url), wx("open", { uid }));
    if (disabled) assertFailed(res);
    else assert.equal(res.headers.get("location"), "/account?op=bind_reverify_expired");
    assert.equal(q("SELECT id FROM identities WHERE provider_uid = ?").get(uid), undefined);
  }
});

test("授权发起后凭证被清除，回调报告不可用且不请求微信", async () => {
  const b = new Browser(), url = await b.start(), secret = config.wechat.open.secret, calls = wxCalls;
  try {
    config.wechat.open.secret = "";
    assertFailed(await b.callback(url, wx()));
    assert.equal(wxCalls, calls);
  } finally { config.wechat.open.secret = secret; }
});
