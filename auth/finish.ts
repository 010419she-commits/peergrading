// auth/finish.ts — 最终事务：复核 → 执行 → epoch+1（v9 §5.11）
import type { Request } from "express";
import { transaction } from "./db.ts";
import { config } from "./config.ts";
import { now, AuthError } from "./security.ts";
import { currentEpoch, bumpEpoch } from "./browser.ts";
import { insertSession, revokeSession, readSession } from "./session.ts";
import { getUser, resolveLogin, bindIdentity, matchReverify, type VerifiedIdentity } from "./users.ts";
import { claimReferral } from "../billing/referral.ts";

function finish(req: Request, tx: any, identity: VerifiedIdentity): { redirect: string; sessionToken: string | null } {
  return transaction(() => {
    if (currentEpoch(tx.bid_hash) !== tx.auth_epoch) throw new AuthError("stale_tx");
    const session: any = readSession(req);
    if ((session?.id || null) !== (tx.session_id || null)) throw new AuthError("stale_tx");
    if (tx.user_id && session?.user_id !== tx.user_id) throw new AuthError("stale_tx");
    if (tx.user_id && getUser(tx.user_id)?.status !== "active") throw new AuthError("account_disabled");
    const back = (path: string, k: string, v: string) => { const [p, h = ""] = path.split("#"); return `${p}${p.includes("?") ? "&" : "?"}${k}=${v}${h ? "#" + h : ""}`; };

    if (tx.intent === "bind") {
      if (!tx.verified_at || tx.verified_at <= now() - config.reverifyWindowSec || session.last_verified_at <= now() - config.reverifyWindowSec) {
        throw new AuthError("bind_reverify_expired");
      }
      const r = bindIdentity(identity, tx.user_id);
      bumpEpoch(tx.bid_hash, session.id);
      return { redirect: `/account?op=${r}`, sessionToken: null };
    }
    if (tx.intent === "reverify") {
      const ident = matchReverify(identity, tx);
      revokeSession(session.id);
      const s = insertSession(tx.user_id, { lastVerifiedAt: now(), verifiedBy: ident.id });
      bumpEpoch(tx.bid_hash, s.id);
      return { redirect: back(tx.return_to, "login", "reverified"), sessionToken: s.token };
    }
    if (tx.intent === "login" && session) throw new AuthError("stale_tx");
    if (tx.intent === "switch" && !session) throw new AuthError("stale_tx");
    const { user, identity: ident, created } = resolveLogin(identity);
    if (user.status !== "active") throw new AuthError("account_disabled");
    if (created) {
      // 通过邀请链接（/?ref=码）来的新用户：登记邀请，奖励按内测状态立即发放或内测结束后发放
      const code = (req as any).cookies?.pg_ref;
      if (typeof code === "string" && code) { try { claimReferral(user.id, code); } catch {} }
    }
    if (session) revokeSession(session.id);
    const s = insertSession(user.id, { lastVerifiedAt: now(), verifiedBy: ident.id });
    bumpEpoch(tx.bid_hash, s.id);
    const hint = tx.intent === "switch" ? (session.user_id === user.id ? "reverified" : "switched") : (created ? "welcome" : "ok");
    return { redirect: back(tx.return_to, "login", hint), sessionToken: s.token };
  });
}

export function finishAuth(req: Request, tx: any, identity: VerifiedIdentity) {
  try { return finish(req, tx, identity); }
  catch (e: any) {
    if (/UNIQUE|PRIMARY KEY/i.test(String(e?.message))) return finish(req, tx, identity);
    throw e;
  }
}

export function errorRedirect(e: any, tx: any, trace: string) {
  const code = e instanceof AuthError ? e.code : "failed";
  const accountOps = new Set(["identity_conflict", "bind_reverify_expired", "reverify_mismatch", "stale_tx"]);
  if (tx && (tx.intent === "bind" || tx.intent === "reverify") && accountOps.has(code)) return `/account?op=${code}`;
  if (code === "stale_tx") return "/?login=stale";
  if (code === "busy") return "/?login=busy";
  return `/?login=failed&trace=${trace}`;
}
