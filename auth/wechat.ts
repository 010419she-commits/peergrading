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
  if (isWechatUA(req)) return wechatMpReady() ? "mp" : null;
  return wechatOpenReady() ? "open" : null;
}

export function wechatAuthUrl(req: Request, txOpts: Omit<TxOpts, "provider">) {
  const channel = (txOpts.channel as "mp" | "open" | null | undefined) || wechatMode(req);
  if (!channel || (channel === "mp" && !wechatMpReady()) || (channel === "open" && !wechatOpenReady())) throw new AuthError("provider_unavailable");
  const app = config.wechat[channel];
  const tx = createTx(req, { ...txOpts, provider: "wechat", channel });
  const base = channel === "mp" ? "https://open.weixin.qq.com/connect/oauth2/authorize" : "https://open.weixin.qq.com/connect/qrconnect";
  const qs = new URLSearchParams({ appid: app.appId, redirect_uri: REDIRECT, response_type: "code", scope: channel === "mp" ? "snsapi_userinfo" : "snsapi_login", state: tx.state });
  return `${base}?${qs}#wechat_redirect`;
}

const idOk = (v: unknown) => typeof v === "string" && /^[\w-]{1,128}$/.test(v);

export async function wechatCallback(req: Request, res: Response) {
  const trace = randomToken(6);
  const { code, state } = req.query as Record<string, string | undefined>;
  let tx: any = null;
  try {
    tx = consumeTx(req, { provider: "wechat", state });
    if (!code) return res.redirect(tx ? "/?login=cancelled" : "/?login=expired");
    if (!tx || typeof code !== "string") throw new AuthError("bad_state");
    const app = (config.wechat as any)[tx.channel];
    if (!app?.appId) throw new AuthError("provider_unavailable");
    const tok = await fetchJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${new URLSearchParams({ appid: app.appId, secret: app.secret, code, grant_type: "authorization_code" })}`);
    if (!tok.ok || !tok.body || tok.body.errcode) throw new AuthError("wx_token", tok.body?.errcode);
    if (typeof tok.body.access_token !== "string" || !tok.body.access_token || !idOk(tok.body.openid)) throw new AuthError("wx_bad_response");
    const info = await fetchJson(`https://api.weixin.qq.com/sns/userinfo?${new URLSearchParams({ access_token: tok.body.access_token, openid: tok.body.openid, lang: "zh_CN" })}`);
    if (!info.ok || !info.body || info.body.errcode) throw new AuthError("wx_userinfo", info.body?.errcode);
    if (info.body.openid !== tok.body.openid) throw new AuthError("wx_bad_response");
    const u1 = tok.body.unionid, u2 = info.body.unionid;
    if (u1 && u2 && u1 !== u2) throw new AuthError("wx_bad_response");
    const unionId = (u2 || u1) && idOk(u2 || u1) ? (u2 || u1) : null;
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
