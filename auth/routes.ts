// auth/routes.ts — bootstrap / 登录页 / 发起 / 退出 / 账号操作（v9 §5.15–5.16）
import { Router, type Request } from "express";
import { config, googleReady } from "./config.ts";
import { transaction } from "./db.ts";
import { ensureBrowser, bumpEpoch } from "./browser.ts";
import { issueCsrf, requireCsrf, safeReturnTo, AuthError, logAuthError, randomToken } from "./security.ts";
import { requireBrowser, requireAuthApi } from "./middleware.ts";
import { googleAuthUrl, googleCallback } from "./google.ts";
import { isWechatUA } from "./wechat.ts";
import { githubReady, githubAuthUrl, githubCallback } from "./github.ts";
import { emailAuth, emailReady } from "./email.ts";
import { devAuthUrl, devAuthorizePage, devCallback, devReady } from "./dev.ts";
import { revokeSession, clearSessionCookie, recentlyVerified, revokeAllSessions, insertSession, setSessionCookie } from "./session.ts";
import { listIdentities, getIdentity, removeIdentities } from "./users.ts";
import { entitlementSummary } from "./entitlements.ts";
import { invalidateUserTx } from "./tx.ts";
import { accessStatus } from "../billing/access.ts";
import { publicPlan, wechatGroupInfo } from "../billing/plan.ts";

export const auth = Router();
export const account = Router();
auth.use(emailAuth);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

export function providersFor(req: Request) {
  const inWechat = isWechatUA(req);
  return {
    inWechat,
    google: { available: googleReady(), hint: inWechat ? "微信内置浏览器可能无法完成 Google 登录，请在系统浏览器中打开本页" : null as string | null },
    github: { available: githubReady(), hint: null },
    email: { available: emailReady(), hint: emailReady() ? null : "邮箱验证码暂未开放，管理员配置邮件发送服务后可用。" },
    wechat: { available: false, mode: null, hint: "微信登录已停用，请使用邮箱、Google 或 GitHub 登录。" },
    dev: { available: devReady() },
  };
}
export function meJson(req: Request) {
  const r = req as any;
  if (!r.user) return { user: null };
  return { user: {
    id: r.user.id, name: r.user.display_name, avatar: r.user.avatar_url, createdAt: r.user.created_at,
    identities: listIdentities(r.user.id), entitlements: entitlementSummary(r.user.id),
    access: accessStatus(r.user), wechatGroup: wechatGroupInfo(),
    recentlyVerified: recentlyVerified(r.session), verifiedBy: r.session.verified_by_identity_id,
  } };
}
const authUrlFor = (provider: string, req: Request, opts: any) =>
  provider === "google" ? googleAuthUrl(req, opts) : provider === "github" ? githubAuthUrl(req, opts) : provider === "dev" ? devAuthUrl(req, opts) : null;

auth.get("/api/auth/bootstrap", (req, res) => {
  const r = req as any;
  ensureBrowser(req, res);
  res.json({
    status: r.user ? "authenticated" : "anonymous",
    ...meJson(req), providers: providersFor(req), plan: publicPlan(), webWorkspace: config.webWorkspace,
    csrf: issueCsrf({ bidHash: r.bidHash, sessionId: r.session?.id || null, authEpoch: r.authEpoch }),
  });
});
/** 服务端渲染的渠道选择页（无 JS 可用） */
auth.get("/login", (req, res) => {
  const r = req as any;
  ensureBrowser(req, res);
  const intent = r.user ? "switch" : "login";
  const returnTo = safeReturnTo(req.query.return_to);
  const csrf = issueCsrf({ bidHash: r.bidHash, sessionId: r.session?.id || null, authEpoch: r.authEpoch });
  const p = providersFor(req);
  const form = (provider: string, label: string) => `
    <form method="post" action="/api/auth/start">
      <input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="provider" value="${provider}">
      <input type="hidden" name="intent" value="${intent}"><input type="hidden" name="return_to" value="${esc(returnTo)}">
      <button class="button button-provider" type="submit">${label}</button></form>`;
  const buttons = [
    p.github.available ? form("github", "GitHub 登录") : "",
    p.google.available ? form("google", "Google 登录") + (p.google.hint ? `<p class="fine">${esc(p.google.hint)}</p>` : "") : "",
    p.dev.available ? form("dev", "开发者登录（仅本地）") : "",
  ].join("");
  const emailForm = `<div id="email-login-root" data-intent="${intent}" data-return-to="${esc(returnTo)}" data-csrf="${esc(csrf)}"></div>
    <noscript><p class="fine">邮箱验证码需要启用 JavaScript；Google 和 GitHub 可使用下方按钮直接授权。</p></noscript>`;
  const notice = req.query.reason === "required" ? '<p class="muted">该页面需要登录后访问。</p>' : "";
  res.type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${intent === "switch" ? "切换账号" : "登录"} · ${esc(config.plan.name)}</title><link rel="stylesheet" href="/site.css"></head>
<body><main id="main" class="section narrow"><p class="eyebrow">${intent === "switch" ? "切换账号" : "欢迎"}</p>
<h2>${intent === "switch" ? "选择要切换到的登录方式" : "登录或注册"}</h2>${notice}
<p class="muted">${intent === "switch" ? "当前账号将退出登录，切换到所选身份对应的账号。" : "使用您常用的账号登录；首次登录将自动创建账号。"}</p>
${emailForm}<div class="login-buttons">${buttons}</div>
<p class="fine">登录即表示您同意 <a href="/terms">服务条款</a> 与 <a href="/privacy">隐私政策</a>。 <a href="${esc(returnTo)}">返回</a></p></main><script src="/site-i18n.js" defer></script><script src="/site.js" defer></script></body></html>`);
});

auth.post("/api/auth/start", requireBrowser, requireCsrf, (req, res) => {
  const r = req as any;
  const trace = randomToken(6);
  try {
    const { provider, intent } = req.body || {};
    if (provider === "wechat") throw new AuthError("provider_unavailable");
    if (!["google", "github", "dev"].includes(provider) || !["login", "switch"].includes(intent)) throw new AuthError("bad_request");
    if (intent === "login" && r.session) throw new AuthError("already_authenticated");
    if (intent === "switch" && !r.session) throw new AuthError("unauthenticated");
    const url = authUrlFor(provider, req, { intent, returnTo: req.body.return_to, userId: intent === "switch" ? r.user.id : null });
    if (!url) throw new AuthError("provider_unavailable");
    if (req.is("application/x-www-form-urlencoded")) return res.redirect(303, url);
    res.json({ url });
  } catch (e: any) {
    logAuthError(e, trace);
    const code = e instanceof AuthError ? e.code : "failed";
    if (req.is("application/x-www-form-urlencoded")) return res.redirect(`/?login=${code === "provider_unavailable" ? "unavailable" : "failed"}`);
    res.status(code === "provider_unavailable" ? 409 : 400).json({ error: code });
  }
});
auth.get("/auth/:provider/start", (req, res) => res.redirect(`/login?return_to=${encodeURIComponent(safeReturnTo(req.query.return_to))}`));
auth.get("/auth/google/callback", googleCallback);
auth.get("/auth/github/callback", githubCallback);
auth.get("/auth/wechat/callback", (_req, res) => res.status(410).type("text").send("微信登录已停用，请返回登录页面使用邮箱、Google 或 GitHub。"));
auth.get("/auth/dev/authorize", devAuthorizePage);
auth.get("/auth/dev/callback", devCallback);

auth.post("/auth/logout", requireBrowser, requireCsrf, (req, res) => {
  const r = req as any;
  transaction(() => { if (r.session) revokeSession(r.session.id); bumpEpoch(r.bidHash, null); });
  clearSessionCookie(res);
  if (req.is("application/x-www-form-urlencoded")) return res.redirect(303, "/");
  res.json({ ok: true });
});
auth.get("/api/me", (req, res) => res.json(meJson(req)));

/* ---------- 账号：重新验证 / 绑定 / 解绑 ---------- */
account.use(requireBrowser, requireAuthApi, requireCsrf);
const requireRecent = (req: any, res: any, next: any) => recentlyVerified(req.session) ? next() : res.status(403).json({ error: "reverify_required" });
const fail = (res: any, e: any, trace: string) => { logAuthError(e, trace); res.status(e instanceof AuthError ? 409 : 500).json({ error: e.code || "failed" }); };

account.post("/reverify", (req, res) => {
  const r = req as any; const trace = randomToken(6);
  try {
    const ident = getIdentity(Number(req.body?.identityId));
    if (!ident || ident.user_id !== r.user.id) throw new AuthError("not_found");
    const opts: any = { intent: "reverify", returnTo: "/account", userId: r.user.id, targetIdentityId: ident.id, targetLinkVersion: ident.link_version };
    let url: string | null;
    if (ident.provider === "email") return res.json({ email: ident.provider_uid, identityId: ident.id, method: "email" });
    url = authUrlFor(ident.provider, req, opts);
    if (!url) throw new AuthError("provider_unavailable");
    res.json({ url });
  } catch (e) { fail(res, e, trace); }
});
account.post("/bind", requireRecent, (req, res) => {
  const r = req as any; const trace = randomToken(6);
  try {
    if (req.body?.provider === "email") return res.json({ method: "email" });
    const url = authUrlFor(req.body?.provider, req, { intent: "bind", returnTo: "/account", userId: r.user.id, verifiedAt: r.session.last_verified_at });
    if (!url) throw new AuthError("unknown_provider");
    res.json({ url });
  } catch (e) { fail(res, e, trace); }
});
account.post("/unbind", requireRecent, (req, res) => {
  const r = req as any; const trace = randomToken(6);
  try {
    const body = req.body || {};
    const sel = body.provider === "wechat" ? { provider: "wechat" } : { identityId: Number(body.identityId) };   // 微信整组解绑（扫码 + 公众号）
    const out = transaction(() => {
      const removed = removeIdentities(r.user.id, sel);
      invalidateUserTx(r.user.id);
      const keepVerified = removed.includes(r.session.verified_by_identity_id) ? 0 : r.session.last_verified_at;
      revokeAllSessions(r.user.id);
      const s = insertSession(r.user.id, { lastVerifiedAt: keepVerified, verifiedBy: keepVerified ? r.session.verified_by_identity_id : null });
      bumpEpoch(r.bidHash, s.id);
      return s;
    });
    setSessionCookie(res, out.token);
    res.json({ ok: true });
  } catch (e) { fail(res, e, trace); }
});
