// auth/db.ts — SQLite（Node 内置 node:sqlite），表结构按 v9 §5.4，另加试用用量表
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

type Param = string | number | bigint | null | Uint8Array;
const norm = (v: unknown): Param => (v === undefined ? null : typeof v === "boolean" ? Number(v) : (v as Param));

/** 预编译语句包装：undefined → NULL，布尔 → 0/1 */
export function q(sql: string) {
  const stmt = db.prepare(sql);
  return {
    run: (...p: unknown[]) => stmt.run(...p.map(norm)) as { changes: number | bigint; lastInsertRowid: number | bigint },
    get: (...p: unknown[]) => stmt.get(...p.map(norm)) as any,
    all: (...p: unknown[]) => stmt.all(...p.map(norm)) as any[],
  };
}

/** 同步事务；不支持嵌套 */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT,
  avatar_url   TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS browser_auth_state (
  bid_hash   TEXT PRIMARY KEY,
  auth_epoch INTEGER NOT NULL,
  session_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('google','wechat','dev')),
  issuer        TEXT NOT NULL,
  provider_uid  TEXT NOT NULL,
  channel       TEXT,
  union_id      TEXT,
  display_name  TEXT,
  avatar_url    TEXT,
  link_version  INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  last_login_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(provider, issuer, provider_uid)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
CREATE TABLE IF NOT EXISTS wechat_union_links (
  union_domain TEXT NOT NULL,
  union_id     TEXT NOT NULL,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (union_domain, union_id)
);
CREATE INDEX IF NOT EXISTS idx_union_user ON wechat_union_links(user_id);
CREATE TABLE IF NOT EXISTS oauth_transactions (
  id                  TEXT PRIMARY KEY,
  provider            TEXT NOT NULL,
  channel             TEXT,
  intent              TEXT NOT NULL CHECK (intent IN ('login','switch','reverify','bind')),
  state               TEXT NOT NULL UNIQUE,
  nonce               TEXT,
  code_verifier       TEXT,
  return_to           TEXT NOT NULL,
  bid_hash            TEXT NOT NULL,
  auth_epoch          INTEGER NOT NULL,
  session_id          TEXT,
  user_id             INTEGER,
  target_identity_id  INTEGER,
  target_link_version INTEGER,
  verified_at         INTEGER,
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON oauth_transactions(user_id);
CREATE TABLE IF NOT EXISTS sessions (
  id                      TEXT PRIMARY KEY,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at              INTEGER NOT NULL,
  last_verified_at        INTEGER NOT NULL,
  verified_by_identity_id INTEGER,
  revoked_at              INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS entitlement_grants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entitlement   TEXT NOT NULL,
  source_type   TEXT NOT NULL,
  source_ref    TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER,
  is_permanent  INTEGER NOT NULL DEFAULT 0 CHECK (is_permanent IN (0,1)),
  grant_params  TEXT NOT NULL,
  revoked_at    INTEGER,
  revoke_reason TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_type, source_ref, entitlement),
  CHECK (is_permanent = 0 OR ends_at IS NULL),
  CHECK (is_permanent = 1 OR ends_at IS NOT NULL),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON entitlement_grants(user_id, entitlement);
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id),
  merchant_id       TEXT NOT NULL,
  merchant_order_no TEXT NOT NULL,
  plan_code         TEXT NOT NULL,
  plan_version      INTEGER NOT NULL,
  plan_snapshot     TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  provider          TEXT,
  provider_txn_id   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','refunded','partially_refunded','failed','closed')),
  created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
  paid_at           INTEGER,
  UNIQUE(merchant_id, merchant_order_no),
  UNIQUE(provider, merchant_id, provider_txn_id)
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS payment_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT NOT NULL,
  merchant_id  TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  payload      TEXT NOT NULL,
  received_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  processed_at INTEGER,
  UNIQUE(provider, merchant_id, event_id)
);
-- 桌面软件配对：设备授权码（短期）与设备令牌（长期、可撤销）
CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code   TEXT NOT NULL UNIQUE,
  user_id     INTEGER,
  device_name TEXT,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','consumed','denied')),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS device_tokens (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name  TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
-- 试用用量：每次开始协作记一条
CREATE TABLE IF NOT EXISTS usage_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  ref        TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, kind);
`);
