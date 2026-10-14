// auth/dev.ts — 本地开发登录：没有任何第三方凭证时也能走通完整的事务 / 会话 / 权益流程
import type { Request, Response } from "express";
import { config } from "./config.ts";
import { createTx, consumeTx, type TxOpts } from "./tx.ts";
import { finishAuth, errorRedirect } from "./finish.ts";
import { setSessionCookie } from "./session.ts";
import { AuthError, logAuthError, randomToken } from "./security.ts";

export const devReady = () => config.devLogin;

export function devAuthUrl(req: Request, txOpts: Omit<TxOpts, "provider">) {
  if (!devReady()) throw new AuthError("provider_unavailable");
  const tx = createTx(req, { ...txOpts, provider: "dev" });
  return `/auth/dev/authorize?state=${encodeURIComponent(tx.state)}`;
}

/** 模拟"第三方授权页"：输入一个测试账号名即可 */
export function devAuthorizePage(req: Request, res: Response) {
  if (!devReady()) return res.status(404).end();
  const state = String(req.query.state || "");
  res.type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>开发者登录（仅本地）</title><link rel="stylesheet" href="/site.css"></head>
<body><main class="section narrow"><p class="eyebrow">仅本地开发</p><h2>模拟第三方登录</h2>
<p class="muted">这是本地测试用的假登录页，生产环境不存在。输入任意测试账号名，相同的名字会登录到同一个账号。</p>
<form method="get" action="/auth/dev/callback" class="stack">
<input type="hidden" name="state" value="${state.replace(/"/g, "")}">
<label>测试账号名 <input name="uid" required pattern="[\\w.-]{1,40}" value="tester"></label>
<label>显示名称 <input name="name" value="测试用户"></label>
<button class="button button-primary" type="submit">授权并返回</button>
<a class="text-link" href="/auth/dev/callback?state=${encodeURIComponent(state)}&cancel=1">取消</a>
</form></main></body></html>`);
}

export function devCallback(req: Request, res: Response) {
  const trace = randomToken(6);
  let tx: any = null;
  try {
    if (!devReady()) throw new AuthError("provider_unavailable");
    const { state, uid, name, cancel } = req.query as Record<string, string | undefined>;
    tx = consumeTx(req, { provider: "dev", state });
    if (cancel) return res.redirect(tx ? "/?login=cancelled" : "/?login=expired");
    if (!tx || !uid || !/^[\w.-]{1,40}$/.test(uid)) throw new AuthError("bad_state");
    const out = finishAuth(req, tx, { provider: "dev", issuer: "dev", uid, channel: null, unionId: null, unionDomain: null, name: (name || uid).slice(0, 64), avatar: null });
    if (out.sessionToken) setSessionCookie(res, out.sessionToken);
    res.redirect(out.redirect);
  } catch (e) {
    logAuthError(e, trace);
    res.redirect(errorRedirect(e, tx, trace));
  }
}
