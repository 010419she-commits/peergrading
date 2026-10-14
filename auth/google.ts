// auth/google.ts — Google 登录（v9 §5.12）
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { config, googleReady } from "./config.ts";
import { createTx, consumeTx, type TxOpts } from "./tx.ts";
import { finishAuth, errorRedirect } from "./finish.ts";
import { setSessionCookie } from "./session.ts";
import { AuthError, logAuthError, fetchJson, withTimeout, randomToken } from "./security.ts";

const REDIRECT = `${config.baseUrl}/auth/google/callback`;
const ISSUER = "https://accounts.google.com";
const ALLOWED_ISS = new Set(["https://accounts.google.com", "accounts.google.com"]);
const client = new OAuth2Client({ clientId: config.google.clientId });

export function googleAuthUrl(req: Request, txOpts: Omit<TxOpts, "provider">) {
  if (!googleReady()) throw new AuthError("provider_unavailable");
  const tx = createTx(req, { ...txOpts, provider: "google", pkce: true });
  const challenge = crypto.createHash("sha256").update(tx.code_verifier as string).digest("base64url");
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: REDIRECT, response_type: "code",
    scope: "openid email profile", state: tx.state, nonce: tx.nonce,
    code_challenge: challenge, code_challenge_method: "S256", access_type: "online", prompt: "select_account",
  }).toString();
  return u.toString();
}

export async function googleCallback(req: Request, res: Response) {
  const trace = randomToken(6);
  const { code, state, error } = req.query as Record<string, string | undefined>;
  let tx: any = null;
  try {
    tx = consumeTx(req, { provider: "google", state });
    if (error) return res.redirect(tx ? "/?login=cancelled" : "/?login=expired");
    if (!tx || typeof code !== "string") throw new AuthError("bad_state");
    const tok = await fetchJson("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
        redirect_uri: REDIRECT, grant_type: "authorization_code", code_verifier: tx.code_verifier }),
    });
    if (!tok.ok || typeof tok.body?.id_token !== "string") throw new AuthError("google_token");
    const ticket = await withTimeout(() => client.verifyIdToken({ idToken: tok.body.id_token, audience: config.google.clientId }));
    const p = ticket.getPayload();
    if (!p || !ALLOWED_ISS.has(p.iss)) throw new AuthError("google_iss");
    if (typeof p.sub !== "string" || !p.sub) throw new AuthError("google_sub");
    if (p.nonce !== tx.nonce) throw new AuthError("bad_nonce");
    if (p.azp && p.azp !== config.google.clientId) throw new AuthError("google_azp");
    const out = finishAuth(req, tx, { provider: "google", issuer: ISSUER, uid: p.sub, channel: null, unionId: null, unionDomain: null, name: p.name || null, avatar: p.picture || null });
    if (out.sessionToken) setSessionCookie(res, out.sessionToken);
    res.redirect(out.redirect);
  } catch (e) {
    logAuthError(e, trace);
    res.redirect(errorRedirect(e, tx, trace));
  }
}
