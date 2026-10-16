// auth/wechat.ts — 微信登录（v9 §5.13）
import type { Request, Response } from "express";
import { config, wechatOpenReady, wechatMpReady } from "./config.ts";
import { createTx, consumeTx, type TxOpts } from "./tx.ts";
import { finishAuth, errorRedirect } from "./finish.ts";
import { setSessionCookie } from "./session.ts";
import { AuthError, logAuthError, fetchJson, randomToken } from "./security.ts";

const REDIRECT = `${config.baseUrl}/auth/wechat/callback`;
export const isWechatUA = (req: Request) => /MicroMessenger/i.test(req.get("user-agent") || "");
export function wechatMode(req: Request): "mp" | "open" | null {
  if (isWechatUA(req) && wechatMpReady()) return "mp";
  return wechatOpenReady() ? "open" : null;
}
export function wechatHint(req: Request) {
  if (isWechatUA(req) && !wechatMpReady() && wechatOpenReady()) {
    return "本站暂未开通微信内授权登录，请在电脑或系统浏览器打开本站后使用微信扫码登录。请在新的浏览器中重新点击登录。";
  }
  return null;
}

export function wechatAuthUrl(req: Request, txOpts: Omit<TxOpts, "provider">) {
  const channel = txOpts.channel || wechatMode(req);
  if ((channel !== "mp" && channel !== "open") || (channel === "mp" && !wechatMpReady()) || (channel === "open" && !wechatOpenReady())) throw new AuthError("provider_unavailable");
  const app = config.wechat[channel];
  const tx = createTx(req, { ...txOpts, provider: "wechat", channel });
  const base = channel === "mp" ? "https://open.weixin.qq.com/connect/oauth2/authorize" : "https://open.weixin.qq.com/connect/qrconnect";
  const qs = new URLSearchParams({ appid: app.appId, redirect_uri: REDIRECT, response_type: "code", scope: channel === "mp" ? "snsapi_userinfo" : "snsapi_login", state: tx.state });
  return `${base}?${qs}#wechat_redirect`;
}

const idOk = (v: unknown) => typeof v === "string" && /^[\w-]{1,128}$/.test(v);

export async function wechatCallback(req: Request, res: Response) {
  const trace = randomToken(6);
  const { code, state } = req.query;
  let tx: any = null;
  try {
    tx = consumeTx(req, { provider: "wechat", state });
    if (!tx) throw new AuthError("bad_state");
    if (code === undefined || code === "") return res.redirect("/?login=cancelled");
    if (typeof code !== "string" || code.length > 512) throw new AuthError("bad_request");
    if (tx.channel !== "mp" && tx.channel !== "open") throw new AuthError("provider_unavailable");
    const app = config.wechat[tx.channel as "mp" | "open"];
    if (!app.appId || !app.secret) throw new AuthError("provider_unavailable");
    const tok = await fetchJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${new URLSearchParams({ appid: app.appId, secret: app.secret, code, grant_type: "authorization_code" })}`);
    if (!tok.ok || !tok.body || tok.body.errcode) throw new AuthError("wx_token", tok.body?.errcode);
    if (typeof tok.body.access_token !== "string" || !tok.body.access_token || !idOk(tok.body.openid)) throw new AuthError("wx_bad_response");
    // 网页快照页会返回虚拟 OpenID，不能据此创建真实登录账号。
    if (tok.body.is_snapshotuser === 1 || tok.body.is_snapshotuser === "1") throw new AuthError("wx_snapshot_user");
    const requiredScope = tx.channel === "mp" ? "snsapi_userinfo" : "snsapi_login";
    if (typeof tok.body.scope !== "string" || !tok.body.scope.split(",").includes(requiredScope)) throw new AuthError("wx_bad_scope");
    const info = await fetchJson(`https://api.weixin.qq.com/sns/userinfo?${new URLSearchParams({ access_token: tok.body.access_token, openid: tok.body.openid, lang: "zh_CN" })}`);
    if (!info.ok || !info.body || info.body.errcode) throw new AuthError("wx_userinfo", info.body?.errcode);
    if (info.body.openid !== tok.body.openid) throw new AuthError("wx_bad_response");
    const u1 = tok.body.unionid, u2 = info.body.unionid;
    if ((u1 != null && !idOk(u1)) || (u2 != null && !idOk(u2))) throw new AuthError("wx_bad_response");
    if (u1 && u2 && u1 !== u2) throw new AuthError("wx_bad_response");
    const unionId = u2 || u1 || null;
    const out = finishAuth(req, tx, {
      provider: "wechat", issuer: app.appId, uid: tok.body.openid, channel: tx.channel, unionId, unionDomain: app.unionDomain || null,
      name: typeof info.body.nickname === "string" ? info.body.nickname.slice(0, 64) : null,
      avatar: typeof info.body.headimgurl === "string" && /^https:\/\//.test(info.body.headimgurl) ? info.body.headimgurl : null,
    });
    if (out.sessionToken) setSessionCookie(res, out.sessionToken);
    res.redirect(out.redirect);
  } catch (e) {
    logAuthError(e, trace);
    res.redirect(errorRedirect(e, tx, trace));
  }
}
