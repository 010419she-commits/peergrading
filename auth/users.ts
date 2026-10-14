// auth/users.ts — 身份归属 / 绑定 / 解绑（v9 §5.9）
import { q } from "./db.ts";
import { now, AuthError } from "./security.ts";

export interface VerifiedIdentity {
  provider: "google" | "wechat" | "dev"; issuer: string; uid: string; channel?: string | null;
  unionId?: string | null; unionDomain?: string | null; name?: string | null; avatar?: string | null;
}

export const getUser = (id: number) => q("SELECT * FROM users WHERE id = ?").get(id) || null;
export const listIdentities = (userId: number) =>
  q("SELECT id, provider, channel, display_name, avatar_url, created_at, last_login_at FROM identities WHERE user_id = ? ORDER BY id").all(userId);
export const getIdentity = (id: number) => q("SELECT * FROM identities WHERE id = ?").get(id) || null;

const findIdentity = (p: VerifiedIdentity) => q("SELECT * FROM identities WHERE provider = ? AND issuer = ? AND provider_uid = ?").get(p.provider, p.issuer, p.uid);
const findUnionLink = (p: VerifiedIdentity) => (p.unionDomain && p.unionId)
  ? q("SELECT * FROM wechat_union_links WHERE union_domain = ? AND union_id = ?").get(p.unionDomain, p.unionId) : null;

function ensureUnionLink(p: VerifiedIdentity, userId: number) {
  if (!p.unionDomain || !p.unionId) return;
  const link = findUnionLink(p);
  if (!link) q("INSERT INTO wechat_union_links (union_domain, union_id, user_id) VALUES (?, ?, ?)").run(p.unionDomain, p.unionId, userId);
  else if (link.user_id !== userId) throw new AuthError("identity_conflict");
}
const insertIdentity = (p: VerifiedIdentity, userId: number) => Number(q(
  "INSERT INTO identities (user_id, provider, issuer, provider_uid, channel, union_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  .run(userId, p.provider, p.issuer, p.uid, p.channel || null, p.unionId || null, p.name || null, p.avatar || null).lastInsertRowid);
const touchIdentity = (ident: any, p: VerifiedIdentity) => q(
  "UPDATE identities SET last_login_at = ?, display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), union_id = COALESCE(union_id, ?) WHERE id = ?")
  .run(now(), p.name || null, p.avatar || null, p.unionId || null, ident.id);
const fillProfile = (userId: number, p: VerifiedIdentity) => q(
  "UPDATE users SET display_name = COALESCE(display_name, ?), avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?")
  .run(p.name || null, p.avatar || null, now(), userId);

/** 普通登录 / 切换。必须在外层事务内调用 */
export function resolveLogin(p: VerifiedIdentity) {
  const ident = findIdentity(p);
  if (ident) {
    ensureUnionLink(p, ident.user_id);
    touchIdentity(ident, p); fillProfile(ident.user_id, p);
    return { user: getUser(ident.user_id), identity: getIdentity(ident.id), created: false };
  }
  let userId: number | null = findUnionLink(p)?.user_id || null;
  let created = false;
  if (!userId) {
    userId = Number(q("INSERT INTO users (display_name, avatar_url) VALUES (?, ?)").run(p.name || null, p.avatar || null).lastInsertRowid);
    created = true;
  } else fillProfile(userId, p);
  const id = insertIdentity(p, userId);
  ensureUnionLink(p, userId);
  return { user: getUser(userId), identity: getIdentity(id), created };
}

export function bindIdentity(p: VerifiedIdentity, targetUserId: number): "bound" | "already" {
  ensureUnionLink(p, targetUserId);
  const ident = findIdentity(p);
  if (ident) {
    if (ident.user_id !== targetUserId) throw new AuthError("identity_conflict");
    touchIdentity(ident, p); return "already";
  }
  insertIdentity(p, targetUserId); fillProfile(targetUserId, p);
  return "bound";
}

export function matchReverify(p: VerifiedIdentity, tx: any) {
  ensureUnionLink(p, tx.user_id);
  const ident = findIdentity(p);
  if (!ident || ident.id !== tx.target_identity_id || ident.user_id !== tx.user_id || ident.link_version !== tx.target_link_version) {
    throw new AuthError("reverify_mismatch");
  }
  touchIdentity(ident, p);
  return ident;
}

/** 解绑：wechat 整组；其他按 identityId 单条。返回被移除的 identity id 列表 */
export function removeIdentities(userId: number, { provider, identityId }: { provider?: string; identityId?: number }) {
  const all = q("SELECT id, provider FROM identities WHERE user_id = ?").all(userId);
  let removing: any[];
  if (provider === "wechat") removing = all.filter((i) => i.provider === "wechat");
  else {
    const one = all.find((i) => i.id === identityId);
    if (!one) throw new AuthError("not_found");
    removing = [one];
  }
  if (!removing.length) throw new AuthError("not_found");
  if (all.length - removing.length < 1) throw new AuthError("last_identity");
  const del = q("DELETE FROM identities WHERE id = ? AND user_id = ?");
  for (const r of removing) del.run(r.id, userId);
  if (provider === "wechat") q("DELETE FROM wechat_union_links WHERE user_id = ?").run(userId);
  return removing.map((r) => r.id as number);
}
