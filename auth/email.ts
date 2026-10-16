import crypto from "node:crypto";
import { Router, type Request } from "express";
import { q, transaction } from "./db.ts";
import { config } from "./config.ts";
import { now, randomToken, sha256, timingEq, AuthError, requireCsrf, logAuthError } from "./security.ts";
import { requireBrowser } from "./middleware.ts";
import { createTx, consumeTx, type TxOpts } from "./tx.ts";
import { currentEpoch } from "./browser.ts";
import { finishAuth } from "./finish.ts";
import { recentlyVerified, setSessionCookie } from "./session.ts";
import { getIdentity, resolveLogin, type VerifiedIdentity } from "./users.ts";
import { emailReady, sendEmailCode } from "./mail.ts";

export { emailReady } from "./mail.ts";
export const emailAuth = Router();
const TTL = 600, COOLDOWN = 60, MAX_ATTEMPTS = 5;
const key = crypto.createHmac("sha256", config.sessionSecret).update("email-auth-v1").digest();
const mac = (value: string) => crypto.createHmac("sha256", key).update(value).digest("hex");
const codeMac = (id: string, email: string, code: string) => mac(JSON.stringify(["otp", id, email, code]));
const verifiedEmail = (email: string): VerifiedIdentity => ({ provider: "email", issuer: "peergrading:email:v1", uid: email, name: email });

export function normalizeEmail(value: unknown) {
  if (typeof value !== "string") throw new AuthError("invalid_email");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)
    || email.startsWith(".") || email.includes("..") || email.includes(".@")) throw new AuthError("invalid_email");
  return email;
}

function limit(scope: string, identity: string, maximum: number, seconds: number) {
  const k = mac(JSON.stringify(["limit", scope, identity]));
  const t = now();
  q("DELETE FROM email_auth_limits WHERE reset_at <= ?").run(t);
  const row = q(`INSERT INTO email_auth_limits (key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count, reset_at`).get(k, t + seconds);
  if (row.count > maximum) throw new AuthError("rate_limited", Math.max(1, row.reset_at - t));
}
function ip(req: Request) { return req.ip || req.socket.remoteAddress || "unknown"; }
function deviceRow(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new AuthError("bad_request");
  const row = q("SELECT * FROM device_codes WHERE device_code = ?").get(sha256(value));
  if (!row || row.status !== "pending") throw new AuthError("code_unusable");
  if (row.expires_at <= now()) throw new AuthError("code_expired");
  return row;
}
function optionsFor(req: Request, email: string): Omit<TxOpts, "provider"> {
  const r = req as any;
  const intent = req.body?.intent;
  if (!["login", "switch", "bind", "reverify"].includes(intent)) throw new AuthError("bad_request");
  if (intent === "login" && r.session) throw new AuthError("already_authenticated");
  if (intent !== "login" && !r.user) throw new AuthError("unauthenticated");
  if (intent === "bind" && !recentlyVerified(r.session)) throw new AuthError("reverify_required");
  const o: Omit<TxOpts, "provider"> = { intent, returnTo: req.body?.return_to || "/account", userId: r.user?.id || null };
  if (intent === "bind") o.verifiedAt = r.session.last_verified_at;
  if (intent === "reverify") {
    const ident = getIdentity(Number(req.body?.identityId));
    if (!ident || ident.user_id !== r.user.id || ident.provider !== "email" || ident.provider_uid !== email) throw new AuthError("reverify_mismatch");
    o.targetIdentityId = ident.id; o.targetLinkVersion = ident.link_version;
  }
  return o;
}
async function start(req: Request, context: "web" | "device") {
  if (!emailReady()) throw new AuthError("mail_unavailable");
  limit("send-ip", ip(req), 20, 3600);
  const email = normalizeEmail(req.body?.email);
  const device = context === "device" ? deviceRow(req.body?.deviceCode) : null;
  const opts = context === "web" ? optionsFor(req, email) : null;
  limit("send-email-hour", email, 5, 3600);
  limit("send-email-cooldown", email, 1, COOLDOWN);
  q("DELETE FROM email_challenges WHERE expires_at < ?").run(now() - 3600);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const challenge = transaction(() => {
    const tx = opts ? createTx(req, { ...opts, provider: "email" }) : null;
    const id = tx?.id || randomToken(16);
    // A fresh challenge supersedes earlier challenges for this browser/device.
    if (tx) {
      q(`UPDATE email_challenges SET consumed_at = ? WHERE context = 'web' AND consumed_at IS NULL
        AND transaction_id IN (SELECT id FROM oauth_transactions WHERE provider = 'email' AND bid_hash = ?)`)
        .run(now(), (req as any).bidHash);
    } else q("UPDATE email_challenges SET consumed_at = ? WHERE device_code = ? AND consumed_at IS NULL").run(now(), device.device_code);
    const expires = Math.min(now() + TTL, device?.expires_at || Infinity);
    q(`INSERT INTO email_challenges (id, context, email, code_mac, transaction_id, device_code, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context, email, codeMac(id, email, code), tx?.id || null, device?.device_code || null, now(), expires);
    return { id, expires };
  });
  try { await sendEmailCode(email, code, challenge.id); }
  catch (e) { q("UPDATE email_challenges SET consumed_at = ? WHERE id = ?").run(now(), challenge.id); throw e; }
  q("UPDATE email_challenges SET sent_at = ? WHERE id = ? AND consumed_at IS NULL").run(now(), challenge.id);
  return { challengeId: challenge.id, email, expiresIn: Math.max(0, challenge.expires - now()), resendAfter: COOLDOWN };
}
function consume(req: Request, context: "web" | "device") {
  limit("verify-ip", ip(req), 60, 600);
  const id = req.body?.challengeId, code = req.body?.code;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw new AuthError("invalid_code");
  const row = q("SELECT * FROM email_challenges WHERE id = ? AND context = ?").get(id, context);
  if (!row || !row.sent_at || row.consumed_at) throw new AuthError("code_unusable");
  if (row.expires_at <= now()) throw new AuthError("code_expired");
  let tx: any;
  if (context === "web") {
    const r = req as any;
    tx = q("SELECT * FROM oauth_transactions WHERE id = ? AND provider = 'email'").get(row.transaction_id);
    if (!tx || tx.consumed_at || tx.expires_at <= now() || tx.bid_hash !== r.bidHash || tx.auth_epoch !== currentEpoch(r.bidHash)
      || (tx.session_id || null) !== (r.session?.id || null)) throw new AuthError("stale_tx");
  } else if (deviceRow(req.body?.deviceCode).device_code !== row.device_code) throw new AuthError("code_unusable");
  if (row.attempts >= MAX_ATTEMPTS) throw new AuthError("too_many_attempts", TTL);
  q("UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ?").run(id);
  if (typeof code !== "string" || !/^\d{6}$/.test(code) || !timingEq(row.code_mac, codeMac(id, row.email, code))) {
    if (row.attempts + 1 >= MAX_ATTEMPTS) throw new AuthError("too_many_attempts", TTL);
    throw new AuthError("invalid_code");
  }
  const changed = q("UPDATE email_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?").run(now(), id, now());
  if (!Number(changed.changes)) throw new AuthError("code_unusable");
  if (tx) {
    tx = consumeTx(req, { provider: "email", state: tx.state });
    if (!tx) throw new AuthError("stale_tx");
  }
  return { row, tx };
}
function failure(res: any, error: unknown) {
  const e = error instanceof AuthError ? error : new AuthError("failed");
  const trace = randomToken(6);
  logAuthError(e, trace);
  const code = e.code;
  if (["rate_limited", "too_many_attempts"].includes(code)) res.set("Retry-After", String(Number(e.detail) || TTL));
  const status = code === "mail_unavailable" ? 503 : code === "mail_delivery_failed" ? 502 : code === "failed" ? 500
    : ["rate_limited", "too_many_attempts"].includes(code) ? 429 : code === "code_expired" ? 410
    : code === "unauthenticated" ? 401 : code === "reverify_required" ? 403
    : ["code_unusable", "stale_tx", "identity_conflict", "reverify_mismatch", "already_authenticated", "account_disabled", "bind_reverify_expired"].includes(code) ? 409 : 400;
  res.status(status).json({ error: code });
}

emailAuth.post("/api/auth/email/start", requireBrowser, requireCsrf, async (req, res) => {
  try { res.json(await start(req, "web")); } catch (e) { failure(res, e); }
});
emailAuth.post("/api/auth/email/verify", requireBrowser, requireCsrf, (req, res) => {
  try {
    const { row, tx } = consume(req, "web");
    const result = finishAuth(req, tx, verifiedEmail(row.email));
    if (result.sessionToken) setSessionCookie(res, result.sessionToken);
    res.json({ ok: true, redirect: result.redirect });
  } catch (e) { failure(res, e); }
});
emailAuth.post("/api/device/email/start", async (req, res) => {
  try { res.json(await start(req, "device")); } catch (e) { failure(res, e); }
});
emailAuth.post("/api/device/email/verify", (req, res) => {
  try {
    const { row } = consume(req, "device");
    transaction(() => {
      const device = deviceRow(req.body?.deviceCode);
      const { user } = resolveLogin(verifiedEmail(row.email));
      if (user.status !== "active") throw new AuthError("account_disabled");
      const changed = q("UPDATE device_codes SET status = 'approved', user_id = ? WHERE device_code = ? AND status = 'pending' AND expires_at > ?")
        .run(user.id, device.device_code, now());
      if (!Number(changed.changes)) throw new AuthError("code_unusable");
    });
    res.json({ ok: true, status: "approved" });
  } catch (e) { failure(res, e); }
});
