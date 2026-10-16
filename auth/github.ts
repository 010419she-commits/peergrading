// GitHub 只用于身份登录；不申请仓库权限，不保存 GitHub access token。
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "./config.ts";
import { createTx, consumeTx, type TxOpts } from "./tx.ts";
import { finishAuth, errorRedirect } from "./finish.ts";
import { setSessionCookie } from "./session.ts";
import { AuthError, logAuthError, fetchJson, randomToken } from "./security.ts";

const ISSUER = "https://github.com";
const REDIRECT = `${config.baseUrl}/auth/github/callback`;
const credentials = () => ({
  clientId: (process.env.GITHUB_CLIENT_ID || "").trim(),
  clientSecret: (process.env.GITHUB_CLIENT_SECRET || "").trim(),
});

export function githubReady(): boolean {
  const c = credentials();
  return !!(c.clientId && c.clientSecret);
}

export function githubAuthUrl(req: Request, txOpts: Omit<TxOpts, "provider">): string {
  if (!githubReady()) throw new AuthError("provider_unavailable");
  const tx = createTx(req, { ...txOpts, provider: "github", pkce: true });
  const challenge = crypto.createHash("sha256").update(tx.code_verifier as string).digest("base64url");
  const u = new URL(`${ISSUER}/login/oauth/authorize`);
  u.search = new URLSearchParams({
    client_id: credentials().clientId, redirect_uri: REDIRECT,
    scope: "read:user", state: tx.state,
    code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  }).toString();
  return u.toString();
}

function displayName(p: any): string {
  const name = typeof p.name === "string" && p.name.trim() ? p.name : p.login;
  return name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
}

function avatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch { return null; }
}

export async function githubCallback(req: Request, res: Response): Promise<void> {
  const trace = randomToken(6);
  const { code, state, error } = req.query;
  let tx: any = null;
  try {
    tx = consumeTx(req, { provider: "github", state });
    if (!tx) throw new AuthError("bad_state");
    if (error !== undefined) {
      if (error === "access_denied") { res.redirect("/?login=cancelled"); return; }
      throw new AuthError("github_authorization");
    }
    if (!githubReady()) throw new AuthError("provider_unavailable");
    if (typeof code !== "string" || !code || code.length > 2048) throw new AuthError("github_code");
    if (typeof tx.code_verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(tx.code_verifier)) {
      throw new AuthError("bad_state");
    }
    const c = credentials();
    const tok = await fetchJson(`${ISSUER}/login/oauth/access_token`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "PeerGrading" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code,
        redirect_uri: REDIRECT, code_verifier: tx.code_verifier }),
    });
    const token = tok.body;
    if (!tok.ok || token?.error || typeof token?.access_token !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/.test(token.access_token) ||
        typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
      throw new AuthError("github_token");
    }
    // 每次授权都从 /user 重新确认身份；不信任前端 username、邮箱或授权前选中的账号。
    const profile = await fetchJson("https://api.github.com/user", {
      redirect: "error",
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json",
        "user-agent": "PeerGrading", "x-github-api-version": "2026-03-10" },
    });
    const p = profile.body;
    if (!profile.ok || !p || !Number.isSafeInteger(p.id) || p.id <= 0 ||
        typeof p.login !== "string" || !p.login.trim() || p.login.length > 100 || p.type !== "User") {
      throw new AuthError("github_profile");
    }
    const out = finishAuth(req, tx, {
      provider: "github", issuer: ISSUER, uid: String(p.id), channel: null,
      unionId: null, unionDomain: null, name: displayName(p), avatar: avatarUrl(p.avatar_url),
    });
    if (out.sessionToken) setSessionCookie(res, out.sessionToken);
    res.redirect(out.redirect);
  } catch (e) {
    logAuthError(e, trace);
    res.redirect(errorRedirect(e, tx, trace));
  }
}
