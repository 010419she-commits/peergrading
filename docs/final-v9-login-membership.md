# 网站微信 / Google 登录接入、会费制基础与视觉改造 · v9

## 0. 站主先看这一页

**现在就能并行做的 3 件事（不必等代码）：**

1. **把网站资料发给我**：网址；源码或项目目录（`package.json` / `composer.json` / `requirements.txt` 等）；现在有没有用户表、用什么数据库、部署在哪（服务器 / 宝塔 / Vercel / 纯静态托管）。
2. **去申请登录渠道**（见 §8，审核通常以周计，是整个项目最长的链路）：微信开放平台"网站应用"（需企业主体认证）；如要微信内一键登录再加一个服务号；Google Cloud 的 OAuth 客户端。
3. **确认品牌**：品牌名、Logo、现有主色（没有就从 §7 的两套候选里挑）、哪些页面/功能将来收费。

**本版交付状态（唯一的免责说明，后文不再重复）：**

| 项 | 状态 |
|---|---|
| 原网站分析 | **未进行**（无网址/源码）。§1 给方法与挂接方向 |
| 登录 / 账号 / 权益代码 | **参考实现**（Node 18+ / Express / SQLite），与 §2–§5 规格一致，**未在真实环境运行或测试**；非 Node 站点按同一规格移植 |
| 平台申请与配置 | 未开始；资格、费用、审核周期以申请时官方页面为准 |
| 会费制 | 只做账号、会话、权益模型与权限检查；**不接支付、不显示价格** |
| 视觉 | 两套候选主题 + 页面模板，`【】`内为占位文案 |
| 外部核实 | 未进行：`google-auth-library` 校验行为、依赖版本兼容性需实施时按库文档确认 |
| 验收 | §9 全部**未执行** |

只有真实配置并通过 §9 验收后，才能称"已接入"或"已上线"。

---

## 1. 第一步：理解原网站

### 1.1 分析方法
沿真实用户路径：进入 → 核心操作 → 是否需登录 → 调哪些接口 → 数据存哪 → 哪些将来收费 → 成功/失败/取消如何反馈。产出 5 份清单：页面与流程图；数据、接口与外部服务关系；权限清单（公开 / 登录 / 付费）；部署说明（域名、HTTPS、代理、配置方式）；改造影响清单（页面、接口、迁移、兼容）。每条结论注明依据，未知项标"待核实"。已有用户系统优先扩展，不另建脱节账号。

### 1.2 挂接方向（待核实示例）

| 原站形态 | 方向 |
|---|---|
| 纯静态站 | 本参考实现作为"认证 + 会员"后端，Nginx 把 `/auth/*`、`/api/*`、`/login`、`/member`、`/account` 反代过去，其余静态照旧；需确认同源、Cookie 与资源保护 |
| Node / Express | 引入 `server/*`；`users` 表映射到现有用户表，其余表新增；需核对原会话机制与新会话如何共存 |
| PHP / Python / Java | 按 §2 数据模型与 §3–§5 行为规格重写；各文件头部注释即为行为说明 |
| CMS（WordPress 等） | 评估成熟插件能否满足身份归属、会话撤销、权益检查；本方案作为配置依据 |
| 多端 / 多认证客户端 | 共用站内用户；身份键见 §3.1 |

---

## 2. 架构与数据模型

```
页面：原有业务 ─ /login（服务端渲染，无 JS 可用）─ /account ─ /member（鉴权路由返回）
        │
后端：第三方验证 → 认证事务（一次性）→ 最终事务（复核 epoch/会话 → 登录/切换/重验/绑定 → 递增 epoch → 发会话）
      权益检查（API: JSON 401/403；页面：引导）     支付回调（raw body，当前 501）
        │
数据：users · browser_auth_state · identities · wechat_union_links · oauth_transactions · sessions
      entitlement_grants · orders · payment_events
```

**关键约束**
- 浏览器认证版本 `auth_epoch`：按浏览器凭证摘要 `bid_hash` 保存；登录、切换、重新验证、绑定、解绑、退出成功时 **原子 +1**。事务保存发起时的 epoch，回调消费与最终提交都要求 epoch 未变，否则 `stale_tx`。
- 身份关联版本 `link_version`：`identities` 行级，解绑/重绑时变化；reverify 事务记录目标 identity 与其 `link_version`。
- 权益区间 `[starts_at, ends_at)`；永久 ⇒ `ends_at IS NULL`；限期 ⇒ `ends_at > starts_at`；`(source_type, source_ref, entitlement)` 唯一并保存原始授予参数。

---

## 3. 登录、切换、重新验证、绑定 —— 行为规格

### 3.1 身份键
- Google：`issuer + sub`。只接受已验证的 `https://accounts.google.com` 或 `accounts.google.com`，统一存前者。Client ID 仅用于 `aud` 校验；若有 `azp` 须等于 Client ID。
- 微信：`AppID + OpenID`，另记 `channel`（open / mp）。跨应用关联用 `该应用配置的开放平台身份域 + UnionID`；身份域未配置则不做 UnionID 关联。
- 邮箱、昵称、头像不作合并依据；资料最小化保存。

### 3.2 四种意图

| intent | 发起条件 | 回调允许的行为 |
|---|---|---|
| `login` | 无会话 | 登录已有用户或创建用户 |
| `switch` | 有会话，从"切换账号"入口发起 | 登录目标身份所属用户，轮换会话 |
| `reverify` | 有会话，选择已关联身份 | 只刷新当前会话验证时间；身份必须精确匹配且 `link_version` 未变 |
| `bind` | 有会话 + 近期验证 | 只向发起用户绑定；成功**不**刷新验证时间；回调重查验证仍在窗口内 |

发起时事务保存：浏览器摘要、`auth_epoch`、发起会话 id（可为 NULL）、目标用户、目标身份与版本、`verified_at`。回调：原子消费 → 外部请求 → 最终事务复核 epoch 与会话一致 → 执行 → epoch+1 → 提交后才写 Cookie。

### 3.3 归属与冲突
- 已有身份 → 其用户；新微信身份带可信同域 UnionID 且已有唯一归属 → 该用户；否则新建。身份与 UnionID 指向不同用户 → `identity_conflict`，不转移不合并。
- 绑定所有分支先检查 UnionID 归属（补齐或拒绝），再处理身份。
- **解绑微信 = 移除该账号全部微信入口**（扫码 + 公众号 + UnionID 归属），同一事务内撤销全部会话、重签当前会话、继承验证时间（若验证依据正是被解绑的身份则清零）、使该用户未完成事务失效、epoch+1。Google 按单条解绑，其余规则同。必须保留至少一种登录方式。

### 3.4 事务与会话
- 消费条件（单条原子 SQL）：state ∧ 渠道 ∧ 浏览器摘要 ∧ `auth_epoch` 当前值 ∧ 未过期 ∧ 未消费。
- 回调缺少浏览器凭证 → 拒绝，不补发。取消：匹配事务 → `cancelled`；无匹配 → `expired`。
- 会话：高熵随机令牌，服务端存 sha256，可撤销；轮换防固定；Cookie `HttpOnly + Secure + SameSite=Lax`。
- CSRF：bootstrap 下发签名令牌 `HMAC(csrfKey, 'v1|csrf|bid_hash|session_id|auth_epoch|exp')`；校验绑定状态 + `Origin == 站点 origin`（无 Origin 时要求 `Sec-Fetch-Site: same-origin`）。状态变化后重新 bootstrap 取新令牌。
- 外部请求有超时与并发上限；超时后迟到结果丢弃；日志只记 trace / code / 异常类名 / 数字 errcode。

---

## 4. 接口契约

| 接口 | 保护 | 行为 |
|---|---|---|
| `GET /api/auth/bootstrap` | — | 创建/读取浏览器状态；返回 `{status, user, providers, csrf, inWechat}`。**前端必须先调它再调其他接口** |
| `GET /login?intent=login\|switch&return_to=` | — | 服务端渲染渠道选择页，表单 POST 发起（无 JS 可用） |
| `POST /api/auth/start` | CSRF | `provider, intent(login\|switch), return_to` → 表单 303 跳平台 / JSON `{url}` |
| `GET /auth/{p}/start` | — | 兼容旧链接：302 `/login` |
| `GET /auth/{p}/callback` | 事务 | 见 §3.2；结果经白名单位置返回并带提示参数 |
| `POST /auth/logout` | CSRF | 撤销会话（无会话也允许），epoch+1 |
| `GET /api/me` | — | `{user:null}` 或用户 + 身份 + 权益摘要 + `recentlyVerified` |
| `POST /api/account/reverify` | 登录 + CSRF | `{identityId}` → `{url}` |
| `POST /api/account/bind` | 登录 + 近期验证 + CSRF | `{provider}` → `{url}` |
| `POST /api/account/unbind` | 登录 + 近期验证 + CSRF | `{provider:'wechat'}` 或 `{identityId}` |
| `GET /member` · `GET /api/member/content` | 权益 `member` | 页面引导 / JSON 401·403 |
| `POST /api/payments/webhook` | 验签（待接） | raw body；当前 501 |

返回位置白名单：`/`、`/account`、`/member`（可带 `#[\w-]+`）。回调提示参数：`login=welcome|ok|switched|reverified|cancelled|expired|failed|stale|unavailable|required|busy`；`op=bound|already|identity_conflict|stale_tx|bind_reverify_expired|reverify_mismatch`。

---

## 5. 服务端参考实现

### 5.1 `package.json`
```json
{
  "name": "site-auth-membership",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js",
    "grant": "node scripts/grant-entitlement.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "cookie-parser": "^1.4.6",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "google-auth-library": "^9.14.0"
  }
}
```

### 5.2 `.env.example`
```ini
PORT=3000
NODE_ENV=production
BASE_URL=https://www.your-domain.com     # 生产必须 https；本地调 Google 可用 http://localhost:3000
SESSION_SECRET=                           # openssl rand -hex 32（≥32 字符）
DB_PATH=./data/app.db

# Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application)
# Authorized redirect URI 填：${BASE_URL}/auth/google/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# 微信开放平台 · 网站应用（扫码登录）。"授权回调域"填裸域名：www.your-domain.com
WECHAT_OPEN_APPID=
WECHAT_OPEN_SECRET=
WECHAT_OPEN_UNION_DOMAIN=                 # 该应用所属开放平台账号标识（自定义稳定字符串）；留空不做 UnionID 关联

# 微信公众号（微信内登录，可选）。"网页授权域名"填：www.your-domain.com
WECHAT_MP_APPID=
WECHAT_MP_SECRET=
WECHAT_MP_UNION_DOMAIN=                   # 公众号已绑定到同一开放平台账号时，与上面填相同值；否则留空
```
> 密钥的实际存放方式按部署平台（环境变量面板 / Secret 管理 / `.env`）决定，不进前端与仓库。

### 5.3 `server/config.js`
```js
import 'dotenv/config';

const must = (n) => { const v = process.env[n]; if (!v) throw new Error(`缺少环境变量 ${n}`); return v; };
const baseUrl = must('BASE_URL').replace(/\/$/, '');

export const config = {
  port: Number(process.env.PORT || 3000),
  isProd: process.env.NODE_ENV === 'production',
  baseUrl,
  siteOrigin: new URL(baseUrl).origin,
  sessionSecret: must('SESSION_SECRET'),
  dbPath: process.env.DB_PATH || './data/app.db',
  google: { clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '' },
  wechat: {
    open: { appId: process.env.WECHAT_OPEN_APPID || '', secret: process.env.WECHAT_OPEN_SECRET || '', unionDomain: process.env.WECHAT_OPEN_UNION_DOMAIN || '' },
    mp:   { appId: process.env.WECHAT_MP_APPID || '',   secret: process.env.WECHAT_MP_SECRET || '',   unionDomain: process.env.WECHAT_MP_UNION_DOMAIN || '' },
  },
  txTtlSec: 600,
  sessionTtlSec: 30 * 86400,
  reverifyWindowSec: 15 * 60,
  csrfTtlSec: 3600,
  fetchTimeoutMs: 8000,
  maxInflightExternal: 50,
  browserStateRetentionSec: 30 * 86400,
};

if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET 至少 32 字符');
if (config.isProd && !baseUrl.startsWith('https://')) throw new Error('生产环境 BASE_URL 必须为 https');

export const googleReady = () => !!(config.google.clientId && config.google.clientSecret);
export const wechatOpenReady = () => !!(config.wechat.open.appId && config.wechat.open.secret);
export const wechatMpReady = () => !!(config.wechat.mp.appId && config.wechat.mp.secret);
```

### 5.4 `server/db.js`
```js
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT,
  avatar_url   TEXT,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 浏览器认证版本：每个浏览器凭证一行；认证状态变化时 auth_epoch 原子 +1
CREATE TABLE IF NOT EXISTS browser_auth_state (
  bid_hash   TEXT PRIMARY KEY,
  auth_epoch INTEGER NOT NULL,
  session_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('google','wechat')),
  issuer        TEXT NOT NULL,                 -- google: https://accounts.google.com ；wechat: appid
  provider_uid  TEXT NOT NULL,                 -- google sub / wechat openid
  channel       TEXT,                          -- wechat: open | mp
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
  session_id          TEXT,                    -- 发起时会话；NULL 表示发起时无会话
  user_id             INTEGER,                 -- switch/reverify/bind: 发起用户
  target_identity_id  INTEGER,                 -- reverify
  target_link_version INTEGER,                 -- reverify
  verified_at         INTEGER,                 -- bind: 发起时的近期验证时间
  expires_at          INTEGER NOT NULL,
  consumed_at         INTEGER,
  created_at          INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON oauth_transactions(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id                      TEXT PRIMARY KEY,    -- sha256(令牌)
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
  source_type   TEXT NOT NULL,                 -- order | manual | promo
  source_ref    TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,
  ends_at       INTEGER,
  is_permanent  INTEGER NOT NULL DEFAULT 0 CHECK (is_permanent IN (0,1)),
  grant_params  TEXT NOT NULL,                 -- 规范化 JSON，幂等核对用
  revoked_at    INTEGER,
  revoke_reason TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_type, source_ref, entitlement),
  CHECK (is_permanent = 0 OR ends_at IS NULL),
  CHECK (is_permanent = 1 OR ends_at IS NOT NULL),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_grants_user ON entitlement_grants(user_id, entitlement);

-- 收费阶段预留，当前无写入路径
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
`);
```

### 5.5 `server/security.js`
```js
import crypto from 'node:crypto';
import { config } from './config.js';

export const now = () => Math.floor(Date.now() / 1000);
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const timingEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };

export class AuthError extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail; }
}

/** 日志脱敏：不记录异常文本、URL、令牌、资料 */
export function logAuthError(e, trace) {
  console.error(JSON.stringify({
    at: 'auth', trace,
    code: e instanceof AuthError ? e.code : 'unknown',
    type: e?.constructor?.name || 'Error',
    errcode: Number.isFinite(e?.detail) ? e.detail : undefined,
  }));
}

/** 返回位置白名单 */
export function safeReturnTo(v) {
  const m = typeof v === 'string' && /^(\/|\/account|\/member)(#[\w-]{1,40})?$/.exec(v);
  return m ? m[1] + (m[2] || '') : '/';
}

/* ---------- CSRF：与 浏览器摘要 + 会话 + auth_epoch 绑定的签名令牌 ---------- */
const csrfKey = crypto.createHmac('sha256', config.sessionSecret).update('csrf-key-v1').digest();
const mac = (payload) => crypto.createHmac('sha256', csrfKey).update(payload).digest('base64url');

export function issueCsrf({ bidHash, sessionId, authEpoch }) {
  // 各字段均为 hex / base64url / 数字，不含分隔符 '|'
  const payload = ['v1', 'csrf', bidHash, sessionId || '-', String(authEpoch), String(now() + config.csrfTtlSec)].join('|');
  return `${Buffer.from(payload).toString('base64url')}.${mac(payload)}`;
}
export function verifyCsrf(token, { bidHash, sessionId, authEpoch }) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [b, m] = token.split('.');
  let payload; try { payload = Buffer.from(b, 'base64url').toString(); } catch { return false; }
  if (!timingEq(m, mac(payload))) return false;
  const [v, kind, bh, sid, ep, exp] = payload.split('|');
  return v === 'v1' && kind === 'csrf' && bh === bidHash && sid === (sessionId || '-')
    && ep === String(authEpoch) && Number(exp) > now();
}
export function requireCsrf(req, res, next) {
  const deny = (code) => req.is('application/x-www-form-urlencoded')
    ? res.status(403).type('text').send('请求校验失败，请返回重试')
    : res.status(403).json({ error: code });
  const origin = req.get('origin');
  if (origin ? origin !== config.siteOrigin : req.get('sec-fetch-site') !== 'same-origin') return deny('bad_origin');
  const token = req.get('x-csrf-token') || req.body?._csrf;
  if (!req.bidHash || !verifyCsrf(token, { bidHash: req.bidHash, sessionId: req.session?.id || null, authEpoch: req.authEpoch })) return deny('csrf');
  next();
}

/* ---------- 外部请求：超时 + 并发上限 ---------- */
let inflight = 0;
export async function fetchJson(url, init = {}) {
  if (inflight >= config.maxInflightExternal) throw new AuthError('busy');
  inflight++;
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(config.fetchTimeoutMs) }); // 真正取消
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    throw e instanceof AuthError ? e : new AuthError(e?.name === 'TimeoutError' ? 'timeout' : 'network');
  } finally { inflight--; }
}
/** 对无法取消的库调用限时；超时后底层仍可能继续，其结果被丢弃，计数在真正结束时释放 */
export function withTimeout(makePromise, ms = config.fetchTimeoutMs) {
  if (inflight >= config.maxInflightExternal) return Promise.reject(new AuthError('busy'));
  inflight++;
  const p = makePromise();
  p.finally(() => inflight--).catch(() => {});
  let timer;
  return Promise.race([
    p,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new AuthError('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
```

### 5.6 `server/auth/browser.js` — 浏览器认证版本
```js
import { db } from '../db.js';
import { config } from '../config.js';
import { now, randomToken, sha256, AuthError } from '../security.js';

const COOKIE = 'bid';
const cookieOpts = { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/', maxAge: 365 * 86400 * 1000 };

/** 只读取：有凭证且有记录才算有效浏览器；回调请求绝不在此补发 */
export function attachBrowser(req, res, next) {
  req.bidHash = null; req.authEpoch = null;
  const bid = req.cookies[COOKIE];
  if (typeof bid === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(bid)) {
    const row = db.prepare('SELECT auth_epoch FROM browser_auth_state WHERE bid_hash = ?').get(sha256(bid));
    if (row) { req.bidHash = sha256(bid); req.authEpoch = row.auth_epoch; }
  }
  next();
}

/** 只在 bootstrap / 登录页调用。记录缺失时发新凭证（不会沿用旧 bid 重建记录，旧事务因此无法匹配） */
export function ensureBrowser(req, res) {
  if (req.bidHash) return;
  const bid = randomToken(24);
  const hash = sha256(bid);
  const epoch = now(); // 以时间戳起始，保证严格大于任何历史 epoch
  db.prepare('INSERT INTO browser_auth_state (bid_hash, auth_epoch, session_id, updated_at) VALUES (?, ?, NULL, ?)').run(hash, epoch, now());
  res.cookie(COOKIE, bid, cookieOpts);
  req.bidHash = hash; req.authEpoch = epoch;
}

/** 原子递增；必须在最终事务内调用。返回新 epoch */
export function bumpEpoch(bidHash, sessionId) {
  const row = db.prepare('UPDATE browser_auth_state SET auth_epoch = auth_epoch + 1, session_id = ?, updated_at = ? WHERE bid_hash = ? RETURNING auth_epoch')
    .get(sessionId, now(), bidHash);
  if (!row) throw new AuthError('stale_tx');
  return row.auth_epoch;
}
export const currentEpoch = (bidHash) =>
  db.prepare('SELECT auth_epoch FROM browser_auth_state WHERE bid_hash = ?').get(bidHash)?.auth_epoch ?? null;

/** 清理：仅删除长期不活动且没有未过期事务引用的记录 */
export function cleanupBrowsers() {
  db.prepare(`DELETE FROM browser_auth_state WHERE updated_at < ?
    AND bid_hash NOT IN (SELECT bid_hash FROM oauth_transactions WHERE expires_at > ?)`)
    .run(now() - config.browserStateRetentionSec, now());
}
```

### 5.7 `server/auth/tx.js` — 一次性认证事务
```js
import { db } from '../db.js';
import { config } from '../config.js';
import { now, randomToken, safeReturnTo, AuthError } from '../security.js';

export function createTx(req, { provider, channel = null, intent, returnTo, userId = null, targetIdentityId = null, targetLinkVersion = null, verifiedAt = null, pkce = false }) {
  if (!req.bidHash) throw new AuthError('no_browser');
  const tx = {
    id: randomToken(16), provider, channel, intent,
    state: randomToken(24), nonce: randomToken(16), code_verifier: pkce ? randomToken(32) : null,
    return_to: safeReturnTo(returnTo),
    bid_hash: req.bidHash, auth_epoch: req.authEpoch, session_id: req.session?.id || null,
    user_id: userId, target_identity_id: targetIdentityId, target_link_version: targetLinkVersion, verified_at: verifiedAt,
    expires_at: now() + config.txTtlSec,
  };
  db.prepare(`INSERT INTO oauth_transactions (id, provider, channel, intent, state, nonce, code_verifier, return_to, bid_hash, auth_epoch,
      session_id, user_id, target_identity_id, target_link_version, verified_at, expires_at)
    VALUES (@id, @provider, @channel, @intent, @state, @nonce, @code_verifier, @return_to, @bid_hash, @auth_epoch,
      @session_id, @user_id, @target_identity_id, @target_link_version, @verified_at, @expires_at)`).run(tx);
  return tx;
}

/** 原子消费：state ∧ 渠道 ∧ 浏览器 ∧ 当前 epoch ∧ 未过期 ∧ 未消费 全部满足才写 consumed_at */
export function consumeTx(req, { provider, state }) {
  if (!req.bidHash || typeof state !== 'string' || !state) return null;
  return db.prepare(`UPDATE oauth_transactions SET consumed_at = ?
    WHERE state = ? AND provider = ? AND bid_hash = ?
      AND auth_epoch = (SELECT auth_epoch FROM browser_auth_state WHERE bid_hash = ?)
      AND consumed_at IS NULL AND expires_at > ?
    RETURNING *`).get(now(), state, provider, req.bidHash, req.bidHash, now()) || null;
}

export function invalidateUserTx(userId) {
  db.prepare('UPDATE oauth_transactions SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL').run(now(), userId);
}
export function cleanupTx() {
  db.prepare('DELETE FROM oauth_transactions WHERE expires_at < ?').run(now() - 3600);
}
```

### 5.8 `server/auth/session.js`
```js
import { db } from '../db.js';
import { config } from '../config.js';
import { now, randomToken, sha256 } from '../security.js';

const COOKIE = 'sid';
const cookieOpts = { httpOnly: true, secure: config.isProd, sameSite: 'lax', path: '/' };

/** 只写库，不写 Cookie（供最终事务内调用；Cookie 在提交后写） */
export function insertSession(userId, { lastVerifiedAt = now(), verifiedBy = null } = {}) {
  const token = randomToken(32);
  const id = sha256(token);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, last_verified_at, verified_by_identity_id) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, now() + config.sessionTtlSec, lastVerifiedAt, verifiedBy);
  return { token, id };
}
export function setSessionCookie(res, token) { res.cookie(COOKIE, token, { ...cookieOpts, maxAge: config.sessionTtlSec * 1000 }); }
export function clearSessionCookie(res) { res.clearCookie(COOKIE, { path: '/' }); }

export function readSession(req) {
  const t = req.cookies[COOKIE];
  if (typeof t !== 'string' || !t) return null;
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL AND expires_at > ?').get(sha256(t), now()) || null;
}
export function revokeSession(id) { db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now(), id); }
export function revokeAllSessions(userId) { db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId); }
export const recentlyVerified = (s) => !!s && s.last_verified_at > now() - config.reverifyWindowSec;
```

### 5.9 `server/auth/users.js` — 身份归属 / 绑定 / 解绑
```js
import { db } from '../db.js';
import { now, AuthError } from '../security.js';

export const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
export const listIdentities = (userId) =>
  db.prepare('SELECT id, provider, channel, display_name, avatar_url, created_at, last_login_at FROM identities WHERE user_id = ? ORDER BY id').all(userId);
export const getIdentity = (id) => db.prepare('SELECT * FROM identities WHERE id = ?').get(id) || null;

/**
 * 已验证身份 p：{ provider, issuer, uid, channel, unionId, unionDomain, name, avatar }
 */
const findIdentity = (p) => db.prepare('SELECT * FROM identities WHERE provider = ? AND issuer = ? AND provider_uid = ?').get(p.provider, p.issuer, p.uid);
const findUnionLink = (p) => (p.unionDomain && p.unionId)
  ? db.prepare('SELECT * FROM wechat_union_links WHERE union_domain = ? AND union_id = ?').get(p.unionDomain, p.unionId) : null;

/** UnionID 归属：补齐缺失、冲突抛错（在事务内 → 回滚） */
function ensureUnionLink(p, userId) {
  if (!p.unionDomain || !p.unionId) return;
  const link = findUnionLink(p);
  if (!link) db.prepare('INSERT INTO wechat_union_links (union_domain, union_id, user_id) VALUES (?, ?, ?)').run(p.unionDomain, p.unionId, userId);
  else if (link.user_id !== userId) throw new AuthError('identity_conflict');
}
const insertIdentity = (p, userId) => Number(db.prepare(
  `INSERT INTO identities (user_id, provider, issuer, provider_uid, channel, union_id, display_name, avatar_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  .run(userId, p.provider, p.issuer, p.uid, p.channel || null, p.unionId || null, p.name || null, p.avatar || null).lastInsertRowid);
const touchIdentity = (ident, p) => db.prepare(
  'UPDATE identities SET last_login_at = ?, display_name = COALESCE(?, display_name), avatar_url = COALESCE(?, avatar_url), union_id = COALESCE(union_id, ?) WHERE id = ?')
  .run(now(), p.name || null, p.avatar || null, p.unionId || null, ident.id);
const fillProfile = (userId, p) => db.prepare(
  'UPDATE users SET display_name = COALESCE(display_name, ?), avatar_url = COALESCE(avatar_url, ?), updated_at = ? WHERE id = ?')
  .run(p.name || null, p.avatar || null, now(), userId);

/** 普通登录 / 切换：返回 { user, identity, created }。必须在外层事务内调用 */
export function resolveLogin(p) {
  const ident = findIdentity(p);
  if (ident) {
    ensureUnionLink(p, ident.user_id);
    touchIdentity(ident, p); fillProfile(ident.user_id, p);
    return { user: getUser(ident.user_id), identity: getIdentity(ident.id), created: false };
  }
  let userId = findUnionLink(p)?.user_id || null;
  let created = false;
  if (!userId) {
    userId = Number(db.prepare('INSERT INTO users (display_name, avatar_url) VALUES (?, ?)').run(p.name || null, p.avatar || null).lastInsertRowid);
    created = true;
  } else fillProfile(userId, p);
  const id = insertIdentity(p, userId);
  ensureUnionLink(p, userId);
  return { user: getUser(userId), identity: getIdentity(id), created };
}

/** 绑定：所有分支先检查 UnionID 归属。返回 'bound' | 'already' */
export function bindIdentity(p, targetUserId) {
  ensureUnionLink(p, targetUserId);
  const ident = findIdentity(p);
  if (ident) {
    if (ident.user_id !== targetUserId) throw new AuthError('identity_conflict');
    touchIdentity(ident, p); return 'already';
  }
  insertIdentity(p, targetUserId); fillProfile(targetUserId, p);
  return 'bound';
}

/** 重新验证：平台身份必须精确等于事务指定的身份且版本未变 */
export function matchReverify(p, tx) {
  ensureUnionLink(p, tx.user_id);
  const ident = findIdentity(p);
  if (!ident || ident.id !== tx.target_identity_id || ident.user_id !== tx.user_id || ident.link_version !== tx.target_link_version) {
    throw new AuthError('reverify_mismatch');
  }
  touchIdentity(ident, p);
  return ident;
}

/**
 * 解绑。wechat：移除该用户全部微信身份与 UnionID 归属；google：按 identityId 单条。
 * 返回被移除的 identity id 列表。调用方负责会话处理（见 routes/account.js）
 */
export function removeIdentities(userId, { provider, identityId }) {
  const all = db.prepare('SELECT id, provider FROM identities WHERE user_id = ?').all(userId);
  let removing;
  if (provider === 'wechat') removing = all.filter((i) => i.provider === 'wechat');
  else {
    const one = all.find((i) => i.id === identityId);
    if (!one) throw new AuthError('not_found');
    removing = [one];
  }
  if (!removing.length) throw new AuthError('not_found');
  if (all.length - removing.length < 1) throw new AuthError('last_identity');
  const del = db.prepare('DELETE FROM identities WHERE id = ? AND user_id = ?');
  for (const r of removing) del.run(r.id, userId);
  if (provider === 'wechat') db.prepare('DELETE FROM wechat_union_links WHERE user_id = ?').run(userId);
  return removing.map((r) => r.id);
}
```

### 5.10 `server/auth/entitlements.js`
```js
import { db } from '../db.js';
import { now, AuthError } from '../security.js';

const rowsFor = db.prepare(`SELECT id, entitlement, starts_at, ends_at, is_permanent FROM entitlement_grants
  WHERE user_id = ? AND revoked_at IS NULL ORDER BY starts_at, is_permanent DESC`);
const seg = (r) => ({ startsAt: r.starts_at, endsAt: r.is_permanent ? null : r.ends_at, permanent: !!r.is_permanent });

/** 每个权益：active / permanentNow / continuousUntil(连续覆盖终点，无限为 null) / scheduled(空档之后的未来区间) */
export function entitlementSummary(userId, at = now()) {
  const byCode = new Map();
  for (const r of rowsFor.all(userId)) { if (!byCode.has(r.entitlement)) byCode.set(r.entitlement, []); byCode.get(r.entitlement).push(r); }
  const out = [];
  for (const [code, rows] of byCode) {
    const covering = rows.filter((r) => r.starts_at <= at && (r.is_permanent || r.ends_at > at));
    const future = rows.filter((r) => r.starts_at > at);
    const s = { code, active: covering.length > 0, permanentNow: covering.some((r) => r.is_permanent), continuousUntil: null, scheduled: [] };
    if (!s.active) { s.scheduled = future.map(seg); out.push(s); continue; }
    if (s.permanentNow) { out.push(s); continue; }
    let end = Math.max(...covering.map((r) => r.ends_at)), i = 0, infinite = false;
    while (i < future.length && !infinite) {
      const r = future[i];
      if (r.starts_at > end) break;                 // 空档：停止合并
      if (r.is_permanent) infinite = true; else end = Math.max(end, r.ends_at);
      i++;
    }
    s.continuousUntil = infinite ? null : end;
    s.scheduled = infinite ? [] : future.slice(i).map(seg);
    out.push(s);
  }
  return out;
}
export const hasEntitlement = (userId, code) => entitlementSummary(userId).some((e) => e.code === code && e.active);

/**
 * 授予（在调用方事务内）。永久：立即生效。限期：startPolicy 'extend' = 接在现有限期链之后；'immediate' = 现在。
 * 幂等：同 (source_type, source_ref, entitlement) 必须参数一致，否则 grant_param_mismatch。
 * 周期按天计算为临时规则；自然月/年等待站主确定（§6.3）。
 */
export function grantEntitlement({ userId, entitlement, sourceType, sourceRef, mode, days = null, startPolicy = 'extend' }) {
  if (!['permanent', 'days'].includes(mode) || !['extend', 'immediate'].includes(startPolicy)) throw new AuthError('bad_plan');
  if (mode === 'days' && !(Number.isInteger(days) && days > 0)) throw new AuthError('bad_plan');
  const params = JSON.stringify({ userId, entitlement, mode, days: mode === 'days' ? days : null, startPolicy });
  const prev = db.prepare('SELECT id, grant_params FROM entitlement_grants WHERE source_type = ? AND source_ref = ? AND entitlement = ?').get(sourceType, sourceRef, entitlement);
  if (prev) { if (prev.grant_params === params) return prev.id; throw new AuthError('grant_param_mismatch'); }
  const t = now();
  let startsAt = t, endsAt = null;
  if (mode === 'days') {
    if (startPolicy === 'extend') {
      const cur = db.prepare('SELECT MAX(ends_at) AS e FROM entitlement_grants WHERE user_id = ? AND entitlement = ? AND revoked_at IS NULL AND is_permanent = 0').get(userId, entitlement);
      startsAt = Math.max(t, cur?.e || 0);
    }
    endsAt = startsAt + days * 86400;
  }
  return Number(db.prepare(`INSERT INTO entitlement_grants (user_id, entitlement, source_type, source_ref, starts_at, ends_at, is_permanent, grant_params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, entitlement, sourceType, sourceRef, startsAt, endsAt, mode === 'permanent' ? 1 : 0, params).lastInsertRowid);
}

/** 只撤销对应来源；后续区间是否重排由 §6.3 的政策决定，当前不自动处理 */
export function revokeEntitlement({ sourceType, sourceRef, reason }) {
  return db.prepare('UPDATE entitlement_grants SET revoked_at = ?, revoke_reason = ? WHERE source_type = ? AND source_ref = ? AND revoked_at IS NULL')
    .run(now(), reason || null, sourceType, sourceRef).changes;
}
```

### 5.11 `server/auth/finish.js` — 最终事务：复核 → 执行 → epoch+1
```js
import { db } from '../db.js';
import { config } from '../config.js';
import { now, AuthError } from '../security.js';
import { currentEpoch, bumpEpoch } from './browser.js';
import { insertSession, revokeSession, readSession } from './session.js';
import { resolveLogin, bindIdentity, matchReverify } from './users.js';

/**
 * tx 已消费；identity 已验证。返回 { redirect, sessionToken|null }。
 * 全部在一个数据库事务内；Cookie 由调用方在提交后写。
 */
const finish = db.transaction((req, tx, identity) => {
  // 1) 复核：epoch 未变、会话未变
  if (currentEpoch(tx.bid_hash) !== tx.auth_epoch) throw new AuthError('stale_tx');
  const session = readSession(req);                                   // 事务内重读
  if ((session?.id || null) !== (tx.session_id || null)) throw new AuthError('stale_tx');
  if (tx.user_id && session?.user_id !== tx.user_id) throw new AuthError('stale_tx');
  const back = (path, k, v) => { const [p, h = ''] = path.split('#'); return `${p}?${k}=${v}${h ? '#' + h : ''}`; };

  // 2) 分流
  if (tx.intent === 'bind') {
    if (!tx.verified_at || tx.verified_at <= now() - config.reverifyWindowSec || session.last_verified_at <= now() - config.reverifyWindowSec) {
      throw new AuthError('bind_reverify_expired');
    }
    const r = bindIdentity(identity, tx.user_id);
    bumpEpoch(tx.bid_hash, session.id);                               // 身份变化：旧事务失效；不刷新验证时间
    return { redirect: `/account?op=${r}`, sessionToken: null };
  }

  if (tx.intent === 'reverify') {
    const ident = matchReverify(identity, tx);
    revokeSession(session.id);
    const s = insertSession(tx.user_id, { lastVerifiedAt: now(), verifiedBy: ident.id });
    bumpEpoch(tx.bid_hash, s.id);
    return { redirect: back(tx.return_to, 'login', 'reverified'), sessionToken: s.token };
  }

  // login / switch
  if (tx.intent === 'login' && session) throw new AuthError('stale_tx');
  if (tx.intent === 'switch' && !session) throw new AuthError('stale_tx');
  const { user, identity: ident, created } = resolveLogin(identity);
  if (user.status !== 'active') throw new AuthError('account_disabled');
  if (session) revokeSession(session.id);
  const s = insertSession(user.id, { lastVerifiedAt: now(), verifiedBy: ident.id });
  bumpEpoch(tx.bid_hash, s.id);
  const hint = tx.intent === 'switch' ? (session.user_id === user.id ? 'reverified' : 'switched') : (created ? 'welcome' : 'ok');
  return { redirect: back(tx.return_to, 'login', hint), sessionToken: s.token };
});

export function finishAuth(req, tx, identity) {
  try { return finish(req, tx, identity); }
  catch (e) {
    // 多进程并发创建同一身份：按错误码重试一次（单进程 better-sqlite3 天然串行，通常不会触发）
    if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE' || e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return finish(req, tx, identity);
    throw e;
  }
}

/** 错误 → 跳转位置 */
export function errorRedirect(e, tx, trace) {
  const code = e instanceof AuthError ? e.code : 'failed';
  const accountOps = new Set(['identity_conflict', 'bind_reverify_expired', 'reverify_mismatch', 'stale_tx']);
  if (tx && (tx.intent === 'bind' || tx.intent === 'reverify') && accountOps.has(code)) return `/account?op=${code}`;
  if (code === 'stale_tx') return '/?login=stale';
  if (code === 'busy') return '/?login=busy';
  return `/?login=failed&trace=${trace}`;
}
```

### 5.12 `server/auth/google.js`
```js
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { config, googleReady } from '../config.js';
import { createTx, consumeTx } from './tx.js';
import { finishAuth, errorRedirect } from './finish.js';
import { setSessionCookie } from './session.js';
import { AuthError, logAuthError, fetchJson, withTimeout, randomToken } from '../security.js';

const REDIRECT = `${config.baseUrl}/auth/google/callback`;
const ISSUER = 'https://accounts.google.com';
const ALLOWED_ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const client = new OAuth2Client({ clientId: config.google.clientId });

/** 生成授权 URL；txOpts 由路由按 intent 填好 */
export function googleAuthUrl(req, txOpts) {
  if (!googleReady()) throw new AuthError('provider_unavailable');
  const tx = createTx(req, { ...txOpts, provider: 'google', pkce: true });
  const challenge = crypto.createHash('sha256').update(tx.code_verifier).digest('base64url');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: config.google.clientId, redirect_uri: REDIRECT, response_type: 'code',
    scope: 'openid email profile', state: tx.state, nonce: tx.nonce,
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'online', prompt: 'select_account',
  }).toString();
  return u.toString();
}

export async function googleCallback(req, res) {
  const trace = randomToken(6);
  const { code, state, error } = req.query;
  let tx = null;
  try {
    tx = consumeTx(req, { provider: 'google', state });
    if (error) return res.redirect(tx ? '/?login=cancelled' : '/?login=expired');
    if (!tx || typeof code !== 'string') throw new AuthError('bad_state');

    const tok = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
        redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: tx.code_verifier }),
    });
    if (!tok.ok || typeof tok.body?.id_token !== 'string') throw new AuthError('google_token');

    // 库校验签名/算法/aud/exp（具体覆盖范围按所用版本文档确认）；iss / nonce / azp / sub 由此处显式核对
    const ticket = await withTimeout(() => client.verifyIdToken({ idToken: tok.body.id_token, audience: config.google.clientId }));
    const p = ticket.getPayload();
    if (!p || !ALLOWED_ISS.has(p.iss)) throw new AuthError('google_iss');
    if (typeof p.sub !== 'string' || !p.sub) throw new AuthError('google_sub');
    if (p.nonce !== tx.nonce) throw new AuthError('bad_nonce');
    if (p.azp && p.azp !== config.google.clientId) throw new AuthError('google_azp');

    const out = finishAuth(req, tx, {
      provider: 'google', issuer: ISSUER, uid: p.sub, channel: null, unionId: null, unionDomain: null,
      name: p.name || null, avatar: p.picture || null,
    });
    if (out.sessionToken) setSessionCookie(res, out.sessionToken);
    res.redirect(out.redirect);
  } catch (e) {
    logAuthError(e, trace);
    res.redirect(errorRedirect(e, tx, trace));
  }
}
```

### 5.13 `server/auth/wechat.js`
```js
import { config, wechatOpenReady, wechatMpReady } from '../config.js';
import { createTx, consumeTx } from './tx.js';
import { finishAuth, errorRedirect } from './finish.js';
import { setSessionCookie } from './session.js';
import { AuthError, logAuthError, fetchJson, randomToken } from '../security.js';

const REDIRECT = `${config.baseUrl}/auth/wechat/callback`;
export const isWechatUA = (req) => /MicroMessenger/i.test(req.get('user-agent') || '');
/** 当前入口可用的渠道：微信内 → mp；否则 → open。UA 只决定入口，不参与身份验证 */
export function wechatMode(req) {
  if (isWechatUA(req)) return wechatMpReady() ? 'mp' : null;
  return wechatOpenReady() ? 'open' : null;
}

export function wechatAuthUrl(req, txOpts) {
  const channel = txOpts.channel || wechatMode(req);
  if (!channel || (channel === 'mp' && !wechatMpReady()) || (channel === 'open' && !wechatOpenReady())) throw new AuthError('provider_unavailable');
  const app = config.wechat[channel];
  const tx = createTx(req, { ...txOpts, provider: 'wechat', channel });
  const base = channel === 'mp' ? 'https://open.weixin.qq.com/connect/oauth2/authorize' : 'https://open.weixin.qq.com/connect/qrconnect';
  const qs = new URLSearchParams({ appid: app.appId, redirect_uri: REDIRECT, response_type: 'code',
    scope: channel === 'mp' ? 'snsapi_userinfo' : 'snsapi_login', state: tx.state });
  return `${base}?${qs}#wechat_redirect`;
}

const idOk = (v) => typeof v === 'string' && /^[\w-]{1,128}$/.test(v);

export async function wechatCallback(req, res) {
  const trace = randomToken(6);
  const { code, state } = req.query;
  let tx = null;
  try {
    tx = consumeTx(req, { provider: 'wechat', state });
    if (!code) return res.redirect(tx ? '/?login=cancelled' : '/?login=expired');   // 用户取消时微信不带 code
    if (!tx || typeof code !== 'string') throw new AuthError('bad_state');
    const app = config.wechat[tx.channel];                                           // 由事务决定，不看 UA
    if (!app?.appId) throw new AuthError('provider_unavailable');

    const tok = await fetchJson(`https://api.weixin.qq.com/sns/oauth2/access_token?${new URLSearchParams({
      appid: app.appId, secret: app.secret, code, grant_type: 'authorization_code' })}`);
    if (!tok.ok || !tok.body || tok.body.errcode) throw new AuthError('wx_token', tok.body?.errcode);
    if (typeof tok.body.access_token !== 'string' || !tok.body.access_token || !idOk(tok.body.openid)) throw new AuthError('wx_bad_response');

    const info = await fetchJson(`https://api.weixin.qq.com/sns/userinfo?${new URLSearchParams({
      access_token: tok.body.access_token, openid: tok.body.openid, lang: 'zh_CN' })}`);
    if (!info.ok || !info.body || info.body.errcode) throw new AuthError('wx_userinfo', info.body?.errcode);
    if (info.body.openid !== tok.body.openid) throw new AuthError('wx_bad_response');
    const u1 = tok.body.unionid, u2 = info.body.unionid;
    if (u1 && u2 && u1 !== u2) throw new AuthError('wx_bad_response');
    const unionId = (u2 || u1) && idOk(u2 || u1) ? (u2 || u1) : null;

    const out = finishAuth(req, tx, {
      provider: 'wechat', issuer: app.appId, uid: tok.body.openid, channel: tx.channel,
      unionId, unionDomain: app.unionDomain || null,                                   // 身份域未配置 → 不做 UnionID 关联
      name: typeof info.body.nickname === 'string' ? info.body.nickname.slice(0, 64) : null,
      avatar: typeof info.body.headimgurl === 'string' && /^https:\/\//.test(info.body.headimgurl) ? info.body.headimgurl : null,
    });
    if (out.sessionToken) setSessionCookie(res, out.sessionToken);
    res.redirect(out.redirect);
  } catch (e) {
    logAuthError(e, trace);
    res.redirect(errorRedirect(e, tx, trace));
  }
}
```

### 5.14 `server/middleware/auth.js`
```js
import { readSession } from '../auth/session.js';
import { getUser } from '../auth/users.js';
import { hasEntitlement } from '../auth/entitlements.js';

export function attachUser(req, res, next) {
  req.session = readSession(req);
  req.user = req.session ? getUser(req.session.user_id) : null;
  if (req.user && req.user.status !== 'active') { req.user = null; req.session = null; }
  next();
}
export const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
export const requireBrowser = (req, res, next) => req.bidHash ? next() : res.status(403).json({ error: 'no_browser' });

export const requireAuthApi = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'unauthenticated' });
export const requireEntitlementApi = (code) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (!hasEntitlement(req.user.id, code)) return res.status(403).json({ error: 'entitlement_required', entitlement: code });
  next();
};
export const requireEntitlementPage = (code) => (req, res, next) => {
  if (!req.user) return res.redirect(`/login?return_to=${encodeURIComponent(req.path)}&reason=required`);
  if (!hasEntitlement(req.user.id, code)) return res.redirect('/#membership');
  next();
};
```

### 5.15 `server/routes/auth.js` — bootstrap / 登录页 / 发起 / 退出
```js
import { Router } from 'express';
import { config, googleReady } from '../config.js';
import { db } from '../db.js';
import { ensureBrowser, bumpEpoch } from '../auth/browser.js';
import { issueCsrf, requireCsrf, safeReturnTo, AuthError, logAuthError, randomToken } from '../security.js';
import { requireBrowser } from '../middleware/auth.js';
import { googleAuthUrl, googleCallback } from '../auth/google.js';
import { wechatAuthUrl, wechatCallback, wechatMode, isWechatUA } from '../auth/wechat.js';
import { revokeSession, clearSessionCookie, recentlyVerified } from '../auth/session.js';
import { listIdentities } from '../auth/users.js';
import { entitlementSummary } from '../auth/entitlements.js';

export const auth = Router();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function providersFor(req) {
  const inWechat = isWechatUA(req), mode = wechatMode(req);
  return {
    inWechat,
    google: { available: googleReady(), hint: inWechat ? '微信内置浏览器可能无法完成 Google 登录，请在系统浏览器中打开本页' : null },
    wechat: { available: !!mode, mode: mode === 'mp' ? 'mp' : mode === 'open' ? 'qr' : null },
  };
}
export function meJson(req) {
  if (!req.user) return { user: null };
  return { user: {
    id: req.user.id, name: req.user.display_name, avatar: req.user.avatar_url,
    identities: listIdentities(req.user.id), entitlements: entitlementSummary(req.user.id),
    recentlyVerified: recentlyVerified(req.session), verifiedBy: req.session.verified_by_identity_id,
  } };
}

/** 前端初始化入口：创建浏览器状态并下发 CSRF */
auth.get('/api/auth/bootstrap', (req, res) => {
  ensureBrowser(req, res);
  res.json({
    status: req.user ? 'authenticated' : 'anonymous',
    ...meJson(req), providers: providersFor(req),
    csrf: issueCsrf({ bidHash: req.bidHash, sessionId: req.session?.id || null, authEpoch: req.authEpoch }),
  });
});

/** 服务端渲染的渠道选择页（无 JS 可用）。intent=login|switch */
auth.get('/login', (req, res) => {
  ensureBrowser(req, res);
  const intent = req.user ? 'switch' : 'login';
  const returnTo = safeReturnTo(req.query.return_to);
  const csrf = issueCsrf({ bidHash: req.bidHash, sessionId: req.session?.id || null, authEpoch: req.authEpoch });
  const p = providersFor(req);
  const form = (provider, label) => `
    <form method="post" action="/api/auth/start">
      <input type="hidden" name="_csrf" value="${esc(csrf)}"><input type="hidden" name="provider" value="${provider}">
      <input type="hidden" name="intent" value="${intent}"><input type="hidden" name="return_to" value="${esc(returnTo)}">
      <button class="btn btn-provider" type="submit">${label}</button></form>`;
  const buttons = [
    p.wechat.available ? form('wechat', p.wechat.mode === 'mp' ? '微信登录' : '微信扫码登录') : '',
    p.google.available ? form('google', 'Google 登录') + (p.google.hint ? `<p class="fine">${esc(p.google.hint)}</p>` : '') : '',
  ].join('') || '<p class="muted">登录功能尚未开放。</p>';
  const notice = req.query.reason === 'required' ? '<p class="muted">该页面需要登录后访问。</p>' : '';
  res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${intent === 'switch' ? '切换账号' : '登录'} · 【品牌名】</title><link rel="stylesheet" href="/styles.css"></head>
<body><main id="main" class="section narrow"><p class="eyebrow">${intent === 'switch' ? '切换账号' : '欢迎'}</p>
<h2>${intent === 'switch' ? '选择要切换到的登录方式' : '登录或注册'}</h2>${notice}
<p class="muted">${intent === 'switch' ? '当前账号将退出登录，切换到所选身份对应的账号。' : '使用您常用的账号登录；首次登录将自动创建账号。'}</p>
<div class="login-buttons">${buttons}</div>
<p class="fine">登录即表示您同意 <a href="/terms">服务条款</a> 与 <a href="/privacy">隐私政策</a>。 <a href="${esc(returnTo)}">返回</a></p></main></body></html>`);
});

/** 发起 login / switch。表单 → 303 跳平台；JSON → {url} */
auth.post('/api/auth/start', requireBrowser, requireCsrf, (req, res) => {
  const trace = randomToken(6);
  try {
    const { provider, intent } = req.body || {};
    if (!['google', 'wechat'].includes(provider) || !['login', 'switch'].includes(intent)) throw new AuthError('bad_request');
    if (intent === 'login' && req.session) throw new AuthError('already_authenticated');
    if (intent === 'switch' && !req.session) throw new AuthError('unauthenticated');
    const opts = { intent, returnTo: req.body.return_to, userId: intent === 'switch' ? req.user.id : null };
    const url = provider === 'google' ? googleAuthUrl(req, opts) : wechatAuthUrl(req, opts);
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, url);
    res.json({ url });
  } catch (e) {
    logAuthError(e, trace);
    const code = e instanceof AuthError ? e.code : 'failed';
    if (req.is('application/x-www-form-urlencoded')) return res.redirect(`/?login=${code === 'provider_unavailable' ? 'unavailable' : 'failed'}`);
    res.status(code === 'provider_unavailable' ? 409 : 400).json({ error: code });
  }
});

/** 兼容旧链接 */
auth.get('/auth/:provider/start', (req, res) => res.redirect(`/login?return_to=${encodeURIComponent(safeReturnTo(req.query.return_to))}`));
auth.get('/auth/google/callback', googleCallback);
auth.get('/auth/wechat/callback', wechatCallback);

/** 退出：无会话也允许（只递增 epoch），但必须有浏览器凭证与 CSRF */
auth.post('/auth/logout', requireBrowser, requireCsrf, (req, res) => {
  db.transaction(() => {
    if (req.session) revokeSession(req.session.id);
    bumpEpoch(req.bidHash, null);
  })();
  clearSessionCookie(res);
  if (req.is('application/x-www-form-urlencoded')) return res.redirect(303, '/');
  res.json({ ok: true });
});

auth.get('/api/me', (req, res) => res.json(meJson(req)));
```

### 5.16 `server/routes/account.js` — 重新验证 / 绑定 / 解绑
```js
import { Router } from 'express';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuthApi, requireBrowser } from '../middleware/auth.js';
import { requireCsrf, AuthError, logAuthError, randomToken, now } from '../security.js';
import { recentlyVerified, revokeAllSessions, insertSession, setSessionCookie } from '../auth/session.js';
import { getIdentity, removeIdentities } from '../auth/users.js';
import { googleAuthUrl } from '../auth/google.js';
import { wechatAuthUrl, wechatMode } from '../auth/wechat.js';
import { invalidateUserTx } from '../auth/tx.js';
import { bumpEpoch } from '../auth/browser.js';

export const account = Router();
account.use(requireBrowser, requireAuthApi, requireCsrf);
const requireRecent = (req, res, next) => recentlyVerified(req.session) ? next() : res.status(403).json({ error: 'reverify_required' });
const fail = (res, e, trace) => { logAuthError(e, trace); res.status(e instanceof AuthError ? 409 : 500).json({ error: e.code || 'failed' }); };

/** 用已关联身份重新验证 */
account.post('/reverify', (req, res) => {
  const trace = randomToken(6);
  try {
    const ident = getIdentity(Number(req.body?.identityId));
    if (!ident || ident.user_id !== req.user.id) throw new AuthError('not_found');
    const opts = { intent: 'reverify', returnTo: '/account', userId: req.user.id, targetIdentityId: ident.id, targetLinkVersion: ident.link_version };
    let url;
    if (ident.provider === 'google') url = googleAuthUrl(req, opts);
    else {
      if (wechatMode(req) !== ident.channel) throw new AuthError('channel_unavailable');  // 扫码身份只能在普通浏览器验证，公众号身份只能在微信内
      url = wechatAuthUrl(req, { ...opts, channel: ident.channel });
    }
    res.json({ url });
  } catch (e) { fail(res, e, trace); }
});

/** 绑定新方式（需近期验证） */
account.post('/bind', requireRecent, (req, res) => {
  const trace = randomToken(6);
  try {
    const { provider } = req.body || {};
    const opts = { intent: 'bind', returnTo: '/account', userId: req.user.id, verifiedAt: req.session.last_verified_at };
    const url = provider === 'google' ? googleAuthUrl(req, opts) : provider === 'wechat' ? wechatAuthUrl(req, opts) : null;
    if (!url) throw new AuthError('unknown_provider');
    res.json({ url });
  } catch (e) { fail(res, e, trace); }
});

/**
 * 解绑（需近期验证）。{provider:'wechat'} 整组移除；{identityId} 单条（google）。
 * 同一事务：删身份与归属 → 该用户未完成事务失效 → 撤销全部会话 → 重签当前会话（继承验证时间；依据被移除则清零）→ epoch+1
 */
account.post('/unbind', requireRecent, (req, res) => {
  const trace = randomToken(6);
  try {
    const body = req.body || {};
    const sel = body.provider === 'wechat' ? { provider: 'wechat' } : { identityId: Number(body.identityId) };
    const out = db.transaction(() => {
      const removed = removeIdentities(req.user.id, sel);
      invalidateUserTx(req.user.id);
      const keepVerified = removed.includes(req.session.verified_by_identity_id) ? 0 : req.session.last_verified_at;
      revokeAllSessions(req.user.id);
      const s = insertSession(req.user.id, { lastVerifiedAt: keepVerified, verifiedBy: keepVerified ? req.session.verified_by_identity_id : null });
      bumpEpoch(req.bidHash, s.id);
      return s;
    })();
    setSessionCookie(res, out.token);
    res.json({ ok: true });
  } catch (e) { fail(res, e, trace); }
});
```

### 5.17 `server/index.js`
```js
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import './db.js';
import { attachBrowser, cleanupBrowsers } from './auth/browser.js';
import { attachUser, noStore, requireEntitlementApi, requireEntitlementPage } from './middleware/auth.js';
import { auth } from './routes/auth.js';
import { account } from './routes/account.js';
import { cleanupTx } from './auth/tx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);                 // 按实际代理层数配置
app.disable('x-powered-by');

// 支付回调：在任何 body 解析之前注册，保留原始字节供验签。当前未接入 → 501，不发放权益
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => res.status(501).json({ error: 'payment_not_configured' }));

app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(attachBrowser);
app.use(attachUser);
app.use(['/api', '/auth', '/login', '/member', '/account'], noStore);

app.use(auth);
app.use('/api/account', account);

// 受保护页面与接口（示例权益 code: member）；views/ 不在静态目录
app.get('/member', requireEntitlementPage('member'), (req, res) => res.sendFile(path.join(__dirname, '../views/member.html')));
app.get('/api/member/content', requireEntitlementApi('member'), (req, res) =>
  res.json({ items: [{ title: '示例：会员内容 1' }, { title: '示例：会员内容 2' }] }));

app.use(express.static(path.join(__dirname, '../public'), { extensions: ['html'], index: 'index.html' }));

app.use((err, req, res, next) => {
  console.error(JSON.stringify({ at: 'server', type: err?.constructor?.name, code: err?.code }));
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'server_error' });
  res.status(500).type('text').send('服务暂时不可用，请稍后重试');
});

setInterval(() => { cleanupTx(); cleanupBrowsers(); }, 10 * 60 * 1000).unref();
app.listen(config.port, () => console.log(`listening :${config.port} base=${config.baseUrl}`));
```

### 5.18 `scripts/grant-entitlement.js` — 运维脚本（服务器本地执行，非 HTTP 接口）
```js
// 用法：node scripts/grant-entitlement.js <userId> <entitlement> <days|permanent> [备注]
import { db } from '../server/db.js';
import { grantEntitlement } from '../server/auth/entitlements.js';

const [userId, entitlement, period, note = ''] = process.argv.slice(2);
if (!userId || !entitlement || !period) { console.error('用法: <userId> <entitlement> <days|permanent> [备注]'); process.exit(1); }
const id = db.transaction(() => grantEntitlement({
  userId: Number(userId), entitlement, sourceType: 'manual', sourceRef: `cli-${Date.now()}-${note}`,
  mode: period === 'permanent' ? 'permanent' : 'days', days: period === 'permanent' ? null : Number(period),
}))();
console.log('granted id=', id);
```

---

## 6. 会费制基础

### 6.1 首期边界
已交付：账号、会话、身份关联、权益模型、权限检查。支付未接入时页面显示"会费功能尚未开放"，不展示价格、不显示任何付款成功 / 资格已记录提示，不部署用户可自行发权益的接口（测试权益只用 §5.18 脚本在隔离环境发）。

### 6.2 权益字段语义
| 字段 | 含义 |
|---|---|
| `active` | 当前时刻被有效区间覆盖 |
| `permanentNow` | 当前已有生效的永久权益 |
| `continuousUntil` | 从当前覆盖区间起，合并相接/重叠区间后的终点；遇永久为 `null` |
| `scheduled` | 空档之后的未来区间（单独展示，不算入连续期限） |

### 6.3 收费前站主必须决定的规则（当前代码按天计算为临时规则）
方案与权益；一次性 / 自动续费；固定天数 / 自然月年；时区与月末；升级降级；退款、拒付、取消续订、宽限期。

**退款两种时间线对字段的影响（待选择）**

| 规则 | 操作 | `active` | `continuousUntil` | `scheduled` |
|---|---|---|---|---|
| A 保持日期 | 先撤销被退款来源（它可能本身就在未来）；其余区间日期不变 | 重算；若被撤销的是当前区间则可能立即为 false | 重算，可能缩短或出现空档 | 空档后的区间保留原日期并明确展示空档 |
| B 链式重排 | 撤销来源后，按政策把其后关联续费区间前移；保留原记录 + 调整记录 | 重算 | 重算（通常无空档） | 前移后重算 |

两种规则都只影响同一来源链，不触碰其他来源（如赠送）。部分退款默认不自动撤销权益，人工处理作为受控兜底；收费上线前必须选定并测试。

### 6.4 支付流程（收费阶段实施）
后端定价与归属 → 建 `orders(pending)` → 渠道下单 → 回调（raw body 验签）→ **单事务**：`payment_events` 插入（唯一键 `provider+merchant_id+event_id`）→ 校验商户、订单、金额、币种、状态 → 订单 `paid` → `grantEntitlement({sourceType:'order', sourceRef: merchant_order_no})` → 提交。重复事件只有在 `processed_at` 已写入时返回成功；未处理完的并发重复返回 5xx 让渠道重试；验签失败一律拒绝。浏览器成功页只轮询订单状态。对账任务查超时 `pending` 订单主动查单。自动续费用独立 `subscriptions` 表，取消续订只停下期。

---

## 7. 视觉与交互模板（候选，占位文案）

两套主题并列候选：**深墨 + 香槟金**（`<html>` 默认）与 **暖白 + 深金**（`<html data-theme="light">`），布局与组件完全相同，依据原站内容和品牌选定。`【】`内必须替换为原网站真实内容；不编造客户数、合作方、服务承诺。

### 7.1 `public/index.html`
```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>【品牌名】</title>
<meta name="description" content="【一句话说明网站提供什么】">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#main">跳到主内容</a>
<header class="nav">
  <a class="brand" href="/">【品牌名】<span class="brand-dot">.</span></a>
  <button class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-menu" aria-label="打开菜单"><span></span><span></span></button>
  <div class="nav-menu" id="nav-menu">
    <nav class="nav-links" aria-label="主导航"><a href="#about">【栏目一】</a><a href="#features">【栏目二】</a><a href="#membership">会员</a></nav>
    <div class="nav-auth" id="nav-auth"><noscript><a class="btn btn-ghost" href="/login">登录</a></noscript></div>
  </div>
</header>

<main id="main">
  <section class="hero">
    <div class="hero-glow" aria-hidden="true"></div>
    <p class="eyebrow fade-in">【品牌定位短语】</p>
    <h1 class="fade-in d1">【首屏标题：<em>一句话</em>说明价值】</h1>
    <p class="lead fade-in d2">【首屏副标题：对谁、解决什么、为什么选择这里】</p>
    <div class="hero-actions fade-in d3">
      <button class="btn btn-gold" id="hero-cta" type="button">【主要行动】</button>
      <a class="btn btn-link" href="#about">了解更多 →</a>
    </div>
  </section>

  <section class="section" id="about">
    <div class="section-head"><p class="eyebrow">【栏目一】</p><h2>【栏目一标题】</h2></div>
    <div class="about-grid"><p>【原站正文段落 1】</p><p>【原站正文段落 2】</p></div>
  </section>

  <section class="section" id="features">
    <div class="section-head"><p class="eyebrow">【栏目二】</p><h2>【栏目二标题】</h2></div>
    <div class="cards">
      <article class="card"><span class="card-index">01</span><h3>【服务/内容 1】</h3><p>【说明】</p></article>
      <article class="card"><span class="card-index">02</span><h3>【服务/内容 2】</h3><p>【说明】</p></article>
      <article class="card"><span class="card-index">03</span><h3>【服务/内容 3】</h3><p>【说明】</p></article>
    </div>
  </section>

  <section class="section" id="membership">
    <div class="section-head">
      <p class="eyebrow">会员</p><h2>会员计划</h2>
      <p class="muted">会费功能尚未开放。价格、周期与权益确定并接入支付后，这里将展示可购买的方案。现在可以先登录建立账号。</p>
    </div>
    <div class="notice" id="membership-status" role="status"></div>
  </section>
</main>

<footer class="footer">
  <div>© <span id="year"></span> 【品牌名】</div>
  <nav class="footer-right" aria-label="页脚"><!-- 正式发布前替换为真实页面，没有则删除 -->
    <a href="/privacy">隐私政策</a><a href="/terms">服务条款</a><a href="mailto:【联系邮箱】">联系我们</a>
  </nav>
</footer>

<dialog class="modal" id="login-modal" aria-labelledby="login-title">
  <div class="modal-panel">
    <button class="modal-close" type="button" data-close aria-label="关闭">×</button>
    <p class="eyebrow" id="login-eyebrow">欢迎</p>
    <h2 id="login-title">登录或注册</h2>
    <p class="muted" id="login-desc">使用您常用的账号登录；首次登录将自动创建账号。</p>
    <div class="login-buttons" id="login-buttons"></div>
    <p class="fine">登录即表示您同意 <a href="/terms">服务条款</a> 与 <a href="/privacy">隐私政策</a>。</p>
  </div>
</dialog>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script src="/app.js"></script>
</body>
</html>
```

### 7.2 `public/account.html`（公开壳，内容由接口决定）
```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>账号设置 · 【品牌名】</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="nav">
  <a class="brand" href="/">【品牌名】<span class="brand-dot">.</span></a>
  <button class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-menu" aria-label="打开菜单"><span></span><span></span></button>
  <div class="nav-menu" id="nav-menu"><div class="nav-auth" id="nav-auth"><noscript><a class="btn btn-ghost" href="/login?return_to=/account">登录</a></noscript></div></div>
</header>
<main id="main">
  <section class="section narrow">
    <div class="section-head"><p class="eyebrow">账号</p><h2>账号设置</h2></div>
    <div id="account-root" class="account"><p class="muted">加载中…</p></div>
  </section>
</main>
<dialog class="modal" id="login-modal" aria-labelledby="login-title">
  <div class="modal-panel">
    <button class="modal-close" type="button" data-close aria-label="关闭">×</button>
    <p class="eyebrow" id="login-eyebrow">欢迎</p><h2 id="login-title">登录</h2><p class="muted" id="login-desc"></p>
    <div class="login-buttons" id="login-buttons"></div>
  </div>
</dialog>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script src="/app.js"></script>
</body>
</html>
```

### 7.3 `views/member.html`（仅经鉴权路由返回）
```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>会员专区 · 【品牌名】</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="nav">
  <a class="brand" href="/">【品牌名】<span class="brand-dot">.</span></a>
  <button class="nav-toggle" id="nav-toggle" aria-expanded="false" aria-controls="nav-menu" aria-label="打开菜单"><span></span><span></span></button>
  <div class="nav-menu" id="nav-menu"><div class="nav-auth" id="nav-auth"></div></div>
</header>
<main id="main">
  <section class="section">
    <div class="section-head"><p class="eyebrow">会员专区</p><h2>欢迎回来</h2></div>
    <div class="cards" id="member-content"><p class="muted">加载中…</p></div>
  </section>
</main>
<dialog class="modal" id="login-modal" aria-labelledby="login-title">
  <div class="modal-panel">
    <button class="modal-close" type="button" data-close aria-label="关闭">×</button>
    <p class="eyebrow" id="login-eyebrow">欢迎</p><h2 id="login-title">登录</h2><p class="muted" id="login-desc"></p>
    <div class="login-buttons" id="login-buttons"></div>
  </div>
</dialog>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>
<script src="/app.js"></script>
<script>
(() => {
  const box = document.getElementById('member-content');
  const el = (t, p = {}, ...k) => { const n = document.createElement(t); Object.assign(n, p); n.append(...k); return n; };
  const show = (msg, retry) => {
    const p = el('p', { className: 'muted', textContent: msg });
    if (retry) { const b = el('button', { className: 'btn btn-outline', type: 'button', textContent: '重试' }); b.addEventListener('click', load); box.replaceChildren(p, b); }
    else box.replaceChildren(p);
  };
  async function load() {
    show('加载中…');
    try {
      const r = await fetch('/api/member/content', { headers: { accept: 'application/json' } });
      if (r.status === 401) { show('登录已失效，请重新登录。'); return window.SiteAuth?.openLogin({ returnTo: '/member' }); }
      if (r.status === 403) return show('当前账号没有会员权益。');
      if (!r.ok) return show('内容加载失败。', true);
      const d = await r.json();
      if (!d.items?.length) return show('暂无内容。');
      box.replaceChildren(...d.items.map((it, i) => el('article', { className: 'card' },
        el('span', { className: 'card-index', textContent: String(i + 1).padStart(2, '0') }), el('h3', { textContent: it.title }))));
    } catch { show('网络错误。', true); }
  }
  load();
})();
</script>
</body>
</html>
```

### 7.4 `public/app.js`
```javascript
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const el = (t, p = {}, ...k) => { const n = document.createElement(t); Object.assign(n, p); n.append(...k); return n; };
  const hidden = (name, value) => el('input', { type: 'hidden', name, value });

  // 状态：loading | authenticated | anonymous | failed
  const S = { status: 'loading', user: null, providers: null, csrf: '', returnTo: initialReturnTo() };
  const dialog = $('#login-modal'), toastEl = $('#toast');
  let lastFocus = null;

  function initialReturnTo() {
    const p = new URLSearchParams(location.search).get('return_to');
    if (p && /^\/(account|member)?(#[\w-]{1,40})?$/.test(p)) return p;
    return /^\/(account|member)?$/.test(location.pathname) ? location.pathname + location.hash : '/';
  }
  function toast(msg, ms = 4000) {
    if (!toastEl) return;
    toastEl.textContent = msg; toastEl.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (toastEl.hidden = true), ms);
  }
  async function postJson(url, body) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': S.csrf, accept: 'application/json' }, body: JSON.stringify(body || {}) });
      const d = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, ...d };
    } catch { return { ok: false, status: 0, error: 'network' }; }
  }
  /** 提交期间禁用按钮，防重复 */
  const busy = (btn, fn) => async () => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };

  // ---------- bootstrap（必须先于其他请求） ----------
  async function bootstrap() {
    S.status = 'loading';
    try {
      const r = await fetch('/api/auth/bootstrap', { headers: { accept: 'application/json' } });
      if (!r.ok) throw 0;
      const d = await r.json();
      S.user = d.user; S.providers = d.providers; S.csrf = d.csrf; S.status = d.status;
    } catch { S.status = 'failed'; }
    renderAll();
  }
  function renderAll() { renderNav(); renderMembership(); renderAccount(); if (dialog?.open) renderLoginForms(dialog.dataset.intent || 'login'); }

  // ---------- 移动端导航 ----------
  const navToggle = $('#nav-toggle'), navMenu = $('#nav-menu');
  navToggle?.addEventListener('click', () => {
    const open = navMenu.classList.toggle('open');
    navToggle.setAttribute('aria-expanded', String(open));
    navToggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  });

  // ---------- 登录 / 切换弹窗（<dialog>；表单 POST，与无 JS 路径一致） ----------
  function renderLoginForms(intent) {
    const box = $('#login-buttons'); if (!box) return;
    const focused = document.activeElement?.dataset?.provider;       // 重绘后恢复焦点
    box.replaceChildren();
    if (S.status === 'loading') return box.append(el('p', { className: 'muted', textContent: '正在获取登录方式…' }));
    if (S.status === 'failed') {
      const b = el('button', { className: 'btn btn-outline', type: 'button', textContent: '加载失败，重试' });
      b.addEventListener('click', bootstrap); return box.append(b);
    }
    const p = S.providers;
    if (!p?.wechat?.available && !p?.google?.available) return box.append(el('p', { className: 'muted', textContent: '登录功能尚未开放。' }));
    const form = (provider, label) => {
      const f = el('form', { method: 'post', action: '/api/auth/start' },
        hidden('_csrf', S.csrf), hidden('provider', provider), hidden('intent', intent), hidden('return_to', S.returnTo),
        el('button', { className: 'btn btn-provider', type: 'submit', textContent: label }));
      f.lastChild.dataset.provider = provider; return f;
    };
    if (p.wechat.available) box.append(form('wechat', p.wechat.mode === 'mp' ? '微信登录' : '微信扫码登录'));
    if (p.google.available) { box.append(form('google', 'Google 登录')); if (p.google.hint) box.append(el('p', { className: 'fine', textContent: p.google.hint })); }
    (box.querySelector(`[data-provider="${focused}"]`) || (dialog.open ? box.querySelector('button') : null))?.focus();
  }
  function openLogin({ intent = 'login', returnTo } = {}) {
    if (!dialog || typeof dialog.showModal !== 'function') return location.assign(`/login?return_to=${encodeURIComponent(returnTo || S.returnTo)}`);
    if (returnTo) S.returnTo = returnTo;
    dialog.dataset.intent = intent;
    $('#login-eyebrow').textContent = intent === 'switch' ? '切换账号' : '欢迎';
    $('#login-title').textContent = intent === 'switch' ? '选择要切换到的登录方式' : '登录或注册';
    const desc = $('#login-desc'); if (desc) desc.textContent = intent === 'switch' ? '当前账号将退出登录，切换到所选身份对应的账号。' : '使用您常用的账号登录；首次登录将自动创建账号。';
    lastFocus = document.activeElement;
    renderLoginForms(intent);
    dialog.showModal();                                   // 原生焦点陷阱 / 背景 inert / Esc
    (dialog.querySelector('.btn-provider') || dialog.querySelector('.modal-close'))?.focus();
  }
  dialog?.addEventListener('close', () => { if (lastFocus?.isConnected) lastFocus.focus(); });
  dialog?.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });  // 点击背景
  dialog?.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dialog.close()));
  window.SiteAuth = { openLogin };

  // ---------- 导航登录态 ----------
  const isMember = () => !!S.user?.entitlements?.some((e) => e.code === 'member' && e.active);
  function renderNav() {
    const box = $('#nav-auth'); if (!box) return;
    box.replaceChildren();
    if (S.status === 'loading') return;
    if (S.status === 'failed') { const b = el('button', { className: 'btn btn-ghost', type: 'button', textContent: '重试' }); b.addEventListener('click', bootstrap); return box.append(b); }
    if (!S.user) { const b = el('button', { className: 'btn btn-ghost', type: 'button', textContent: '登录' }); b.addEventListener('click', () => openLogin()); return box.append(b); }
    if (S.user.avatar && /^https:\/\//.test(S.user.avatar)) {
      const img = el('img', { className: 'avatar', src: S.user.avatar, alt: '', referrerPolicy: 'no-referrer' });
      img.addEventListener('error', () => img.remove()); box.append(img);
    }
    box.append(el('span', { className: 'user-name', textContent: S.user.name || '用户', title: S.user.name || '' }));
    if (isMember()) box.append(el('span', { className: 'badge', textContent: '会员' }), el('a', { className: 'btn btn-ghost', href: '/member', textContent: '会员专区' }));
    box.append(el('a', { className: 'btn btn-link', href: '/account', textContent: '账号' }));
    const out = el('button', { className: 'btn btn-link', type: 'button', textContent: '退出' });
    out.addEventListener('click', busy(out, async () => {
      const r = await postJson('/auth/logout');
      if (!r.ok) return toast(r.error === 'csrf' ? '页面状态已过期，请刷新后重试' : '退出失败，请重试');
      toast('已退出登录');
      if (/^\/(member|account)/.test(location.pathname)) return location.assign('/');
      await bootstrap();
    }));
    box.append(out);
  }

  // ---------- 首页 ----------
  $('#hero-cta')?.addEventListener('click', () => {
    if (S.status === 'failed') return bootstrap();
    if (!S.user) return openLogin();
    location.assign(isMember() ? '/member' : '/#membership');
  });
  function renderMembership() {
    const box = $('#membership-status'); if (!box) return;
    box.replaceChildren();
    if (S.status !== 'authenticated') {
      if (S.status === 'anonymous') { const b = el('button', { className: 'btn btn-outline', type: 'button', textContent: '登录以建立账号' }); b.addEventListener('click', () => openLogin()); box.append(b); }
      return;
    }
    const m = S.user.entitlements.find((e) => e.code === 'member');
    let text = '您已登录。会费功能开放后可在此购买会员。';
    if (m?.active) text = m.permanentNow ? '您的会员权益：永久有效。' : `您的会员权益连续有效至 ${fmt(m.continuousUntil)}。`;
    if (m?.scheduled?.length) text += ` 另有 ${m.scheduled.length} 段尚未开始的权益（${m.scheduled.map((s) => `${fmt(s.startsAt)} 起`).join('、')}）。`;
    box.append(el('p', { className: 'muted', textContent: text }));
  }
  const fmt = (sec) => new Date(sec * 1000).toLocaleDateString('zh-CN');

  // ---------- 账号设置页 ----------
  function renderAccount() {
    const root = $('#account-root'); if (!root) return;
    root.replaceChildren();
    if (S.status === 'loading') return root.append(el('p', { className: 'muted', textContent: '加载中…' }));
    if (S.status === 'failed') { const b = el('button', { className: 'btn btn-outline', type: 'button', textContent: '加载失败，重试' }); b.addEventListener('click', bootstrap); return root.append(b); }
    if (!S.user) { root.append(el('p', { className: 'muted', textContent: '请先登录。' })); return openLogin({ returnTo: '/account' }); }

    const names = { google: 'Google', wechat: '微信' }, chan = { mp: '公众号', open: '扫码' };
    const ids = S.user.identities, providersHeld = new Set(ids.map((i) => i.provider));
    const canRemove = providersHeld.size > 1 || ids.filter((i) => i.provider === 'google').length > 1;
    const needVerify = () => toast('为了安全，请先用已关联的登录方式"重新验证"，15 分钟内再操作', 6000);
    const list = el('ul', { className: 'id-list' });

    // 微信：整组展示，一个解绑按钮
    const wx = ids.filter((i) => i.provider === 'wechat');
    if (wx.length) {
      const li = el('li', {}, el('span', { textContent: `微信 · ${wx.map((i) => `${chan[i.channel] || ''}${i.display_name ? ' ' + i.display_name : ''}`).join(' / ')}` }));
      const ops = el('div', { className: 'ops' });
      for (const i of wx) {
        const ok = S.providers.wechat.available && S.providers.wechat.mode === (i.channel === 'mp' ? 'mp' : 'qr');
        const b = el('button', { className: 'btn btn-link', type: 'button', textContent: `重新验证（${chan[i.channel]}）`, disabled: !ok, title: ok ? '' : '此入口只能在对应环境（微信内 / 普通浏览器）验证' });
        b.addEventListener('click', busy(b, () => reverify(i.id))); ops.append(b);
      }
      if (canRemove) { const b = el('button', { className: 'btn btn-link', type: 'button', textContent: '解绑微信' }); b.addEventListener('click', busy(b, () => unbind({ provider: 'wechat' }, '将移除此账号的全部微信登录入口（扫码与公众号）。其他设备上的登录将全部失效，需要重新登录。确定？'))); ops.append(b); }
      li.append(ops); list.append(li);
    }
    for (const i of ids.filter((i) => i.provider === 'google')) {
      const li = el('li', {}, el('span', { textContent: `Google${i.display_name ? ' · ' + i.display_name : ''}` }));
      const ops = el('div', { className: 'ops' });
      const rv = el('button', { className: 'btn btn-link', type: 'button', textContent: '重新验证', disabled: !S.providers.google.available });
      rv.addEventListener('click', busy(rv, () => reverify(i.id))); ops.append(rv);
      if (canRemove) { const b = el('button', { className: 'btn btn-link', type: 'button', textContent: '解绑' }); b.addEventListener('click', busy(b, () => unbind({ identityId: i.id }, '将移除此 Google 登录方式。其他设备上的登录将全部失效，需要重新登录。确定？'))); ops.append(b); }
      li.append(ops); list.append(li);
    }
    root.append(el('h3', { textContent: '已关联的登录方式' }), list);

    const bindRow = el('div', { className: 'bind-row' });
    for (const p of ['wechat', 'google']) {
      if (!S.providers[p]?.available) continue;
      if (p === 'google' && providersHeld.has('google')) continue;
      if (p === 'wechat' && wx.some((i) => i.channel === (S.providers.wechat.mode === 'mp' ? 'mp' : 'open'))) continue;
      const b = el('button', { className: 'btn btn-outline', type: 'button', textContent: `关联${names[p]}` });
      b.addEventListener('click', busy(b, async () => {
        if (!S.user.recentlyVerified) return needVerify();
        const r = await postJson('/api/account/bind', { provider: p });
        if (r.ok && r.url) return location.assign(r.url);
        toast(r.error === 'reverify_required' ? '请先重新验证' : r.error === 'csrf' ? '页面状态已过期，请刷新' : '发起关联失败，请重试');
      }));
      bindRow.append(b);
    }
    if (bindRow.children.length) root.append(el('h3', { textContent: '关联更多登录方式' }), bindRow);
    root.append(el('p', { className: 'fine', textContent: S.user.recentlyVerified ? '您在最近 15 分钟内完成过身份验证，可以进行关联 / 解绑。' : '关联 / 解绑需要先用已关联的登录方式"重新验证"。' }));

    const sw = el('button', { className: 'btn btn-link', type: 'button', textContent: '切换到其他账号' });
    sw.addEventListener('click', () => openLogin({ intent: 'switch', returnTo: '/account' })); root.append(el('h3', { textContent: '其他' }), sw);

    async function reverify(identityId) {
      const r = await postJson('/api/account/reverify', { identityId });
      if (r.ok && r.url) return location.assign(r.url);
      toast(r.error === 'channel_unavailable' ? '此入口需要在对应环境中验证' : '发起验证失败，请重试');
    }
    async function unbind(sel, confirmText) {
      if (!S.user.recentlyVerified) return needVerify();
      if (!confirm(confirmText)) return;
      const r = await postJson('/api/account/unbind', sel);
      if (r.ok) { toast('已解绑'); return bootstrap(); }
      toast({ last_identity: '至少保留一种登录方式', reverify_required: '请先重新验证', csrf: '页面状态已过期，请刷新', network: '网络错误，请重试' }[r.error] || '操作失败');
    }
  }

  // ---------- URL 提示 ----------
  function handleQuery() {
    const q = new URLSearchParams(location.search);
    const login = q.get('login'), op = q.get('op');
    const L = { required: '请先登录', cancelled: '已取消登录', failed: '登录失败，请重试', expired: '登录链接已失效，请重新发起', stale: '登录状态已变化，请重新发起', unavailable: '该登录方式尚未开放', busy: '服务繁忙，请稍后重试',
      welcome: '欢迎，账号已创建', ok: '登录成功', switched: '已切换到另一个账号', reverified: '身份已重新验证' };
    const O = { bound: '关联成功', already: '该登录方式已关联', identity_conflict: '该第三方账号已关联到其他用户，无法关联。如需合并请联系客服',
      bind_reverify_expired: '验证已超时，请重新验证后再关联', reverify_mismatch: '返回的身份与所选不一致，验证失败', stale_tx: '登录状态已变化，请重新发起' };
    if (login && L[login]) toast(L[login], 6000);
    if (op && O[op]) toast(O[op], 7000);
    if (login === 'required' || (login === 'stale' && S.status === 'anonymous')) openLogin();   // 已登录时只提示，不弹普通登录框
    if (login || op) history.replaceState(null, '', location.pathname + location.hash);          // 不清 S.returnTo
  }

  const y = $('#year'); if (y) y.textContent = String(new Date().getFullYear());
  bootstrap().then(handleQuery);
})();
```

### 7.5 `public/styles.css`
```css
/* ===== 主题令牌：默认深墨+金；<html data-theme="light"> 切换暖白 ===== */
:root {
  --bg:#0a0d14; --bg-2:#10141d; --bg-3:#151a25;
  --ink:#e9e6df; --ink-2:#b3b0a8; --ink-3:#7d7b74;
  --gold:#c9a962; --gold-2:#e6cf8b; --btn-gold-fg:#15120a;
  --line:rgba(233,230,223,.12); --backdrop:rgba(5,7,11,.7); --glow:rgba(201,169,98,.14);
  --serif:'Cormorant Garamond','Noto Serif SC','Songti SC',Georgia,serif;
  --sans:'Inter','Noto Sans SC','PingFang SC','Microsoft YaHei',-apple-system,sans-serif;
  --max:1180px; --ease:cubic-bezier(.2,.7,.2,1);
}
[data-theme="light"] {
  --bg:#faf8f3; --bg-2:#f1eee6; --bg-3:#e8e4da;
  --ink:#17181c; --ink-2:#4a4c52; --ink-3:#6c6e75;
  --gold:#8a6d26; --gold-2:#6e5618; --btn-gold-fg:#ffffff;
  --line:rgba(23,24,28,.14); --backdrop:rgba(23,24,28,.45); --glow:rgba(138,109,38,.12);
}
/* 对比度需按最终配色实测（正文 ≥ 4.5:1，大标题 ≥ 3:1） */

* { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { margin:0; background:var(--bg); color:var(--ink); font-family:var(--sans); font-weight:300; line-height:1.7; -webkit-font-smoothing:antialiased; }
a { color:inherit; text-decoration:none; }
:focus-visible { outline:2px solid var(--gold-2); outline-offset:3px; }
.skip { position:absolute; left:-999px; top:0; background:var(--gold); color:var(--btn-gold-fg); padding:.5rem 1rem; z-index:999; }
.skip:focus { left:1rem; top:1rem; }
h1,h2,h3 { font-family:var(--serif); font-weight:500; letter-spacing:.01em; margin:0; overflow-wrap:anywhere; }
h1 { font-size:clamp(2.4rem,6vw,5rem); line-height:1.1; }
h2 { font-size:clamp(1.8rem,3.4vw,2.7rem); }
h3 { font-size:1.4rem; }
em { font-style:italic; color:var(--gold-2); }
.eyebrow { font-size:.72rem; letter-spacing:.28em; text-transform:uppercase; color:var(--gold); margin:0 0 1rem; }
.muted { color:var(--ink-2); }
.fine { font-size:.78rem; color:var(--ink-3); margin-top:1.2rem; }
.fine a { border-bottom:1px solid var(--line); }

/* 导航 */
.nav { position:sticky; top:0; z-index:50; display:flex; align-items:center; justify-content:space-between; gap:2rem; padding:1rem clamp(1.2rem,4vw,3rem);
  background:color-mix(in srgb,var(--bg) 72%,transparent); backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px); border-bottom:1px solid var(--line); }
.brand { font-family:var(--serif); font-size:1.4rem; letter-spacing:.06em; white-space:nowrap; }
.brand-dot { color:var(--gold); }
.nav-menu { display:flex; align-items:center; gap:2.2rem; min-width:0; }
.nav-links { display:flex; gap:2rem; font-size:.88rem; letter-spacing:.08em; color:var(--ink-2); }
.nav-links a:hover { color:var(--ink); }
.nav-auth { display:flex; align-items:center; gap:.8rem; min-width:0; }
.avatar { width:32px; height:32px; border-radius:50%; object-fit:cover; border:1px solid var(--line); flex:none; }
.user-name { font-size:.88rem; max-width:10em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.badge { font-size:.66rem; letter-spacing:.12em; padding:.2rem .55rem; border:1px solid var(--gold); color:var(--gold); border-radius:999px; flex:none; }
.nav-toggle { display:none; background:none; border:1px solid var(--line); width:42px; height:42px; border-radius:2px; cursor:pointer; flex-direction:column; justify-content:center; gap:6px; align-items:center; }
.nav-toggle span { display:block; width:18px; height:1px; background:var(--ink); }

/* 按钮 */
.btn { display:inline-flex; align-items:center; justify-content:center; gap:.6rem; padding:.8rem 1.5rem; border-radius:2px; font:500 .86rem/1 var(--sans); letter-spacing:.1em;
  border:1px solid transparent; cursor:pointer; transition:all .3s var(--ease); background:none; color:var(--ink); white-space:nowrap; }
.btn[disabled] { opacity:.45; cursor:not-allowed; }
.btn-gold { background:linear-gradient(135deg,var(--gold-2),var(--gold)); color:var(--btn-gold-fg); }
.btn-gold:hover:not([disabled]) { transform:translateY(-1px); box-shadow:0 10px 30px var(--glow); }
.btn-outline { border-color:var(--line); }
.btn-outline:hover:not([disabled]) { border-color:var(--gold); color:var(--gold-2); }
.btn-ghost { border-color:var(--line); padding:.6rem 1.1rem; }
.btn-ghost:hover { border-color:var(--ink-2); }
.btn-link { padding:.6rem .2rem; color:var(--ink-2); }
.btn-link:hover:not([disabled]) { color:var(--gold-2); }
.btn-provider { width:100%; background:var(--bg-3); border-color:var(--line); padding:.95rem; }
.btn-provider:hover { border-color:var(--ink-2); }
.login-buttons form { margin:0; }

/* Hero：光晕保持绝对定位，不被通用子元素规则覆盖 */
.hero { position:relative; overflow:hidden; text-align:center; padding:clamp(5rem,16vh,11rem) 1.5rem clamp(4rem,12vh,8rem); max-width:var(--max); margin:0 auto; }
.hero-glow { position:absolute; inset:auto 0 0 0; height:70%; pointer-events:none; background:radial-gradient(60% 70% at 50% 100%,var(--glow),transparent 70%); }
.hero > :not(.hero-glow) { position:relative; }
.lead { max-width:560px; margin:1.8rem auto 0; font-size:1.08rem; color:var(--ink-2); }
.hero-actions { display:flex; justify-content:center; gap:1.4rem; margin-top:2.6rem; flex-wrap:wrap; }

/* 区块 */
.section { max-width:var(--max); margin:0 auto; padding:clamp(4rem,9vh,7rem) clamp(1.2rem,4vw,3rem); border-top:1px solid var(--line); }
.section.narrow { max-width:720px; }
.section-head { max-width:640px; margin-bottom:2.6rem; }
.section-head .muted { margin-top:.8rem; }
.about-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:3rem; font-size:1.05rem; color:var(--ink-2); }
.about-grid p { margin:0; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:1px; background:var(--line); border:1px solid var(--line); }
.card { background:var(--bg); padding:2.3rem 2rem; transition:background .3s var(--ease); overflow-wrap:anywhere; }
.card:hover { background:var(--bg-2); }
.card-index { font-family:var(--serif); color:var(--gold); font-size:.95rem; letter-spacing:.1em; }
.card h3 { margin:1.1rem 0 .7rem; }
.card p { margin:0; color:var(--ink-2); font-size:.95rem; }
.notice { margin-top:1rem; }

/* 账号页 */
.account h3 { margin:2rem 0 .8rem; font-size:1.15rem; }
.id-list { list-style:none; padding:0; margin:0; border-top:1px solid var(--line); }
.id-list li { display:flex; justify-content:space-between; align-items:center; gap:1rem; padding:.9rem 0; border-bottom:1px solid var(--line); overflow-wrap:anywhere; flex-wrap:wrap; }
.ops { display:flex; gap:.6rem; flex-wrap:wrap; }
.bind-row { display:flex; gap:.8rem; flex-wrap:wrap; }

/* 页脚 */
.footer { display:flex; justify-content:space-between; flex-wrap:wrap; gap:1rem; max-width:var(--max); margin:0 auto; padding:2.5rem clamp(1.2rem,4vw,3rem); border-top:1px solid var(--line); font-size:.8rem; color:var(--ink-3); }
.footer-right { display:flex; gap:1.6rem; flex-wrap:wrap; }
.footer a:hover { color:var(--ink); }

/* 弹窗（原生 dialog） */
dialog.modal { border:0; padding:0; background:transparent; max-width:min(440px,calc(100vw - 2rem)); width:100%; color:inherit; }
dialog.modal::backdrop { background:var(--backdrop); backdrop-filter:blur(6px); }
.modal-panel { position:relative; background:var(--bg-2); border:1px solid var(--line); padding:2.6rem 2.2rem; animation:rise .4s var(--ease); }
.modal-close { position:absolute; top:.6rem; right:.8rem; background:none; border:0; color:var(--ink-2); font-size:1.6rem; cursor:pointer; width:40px; height:40px; }
.modal-close:hover { color:var(--ink); }
.login-buttons { display:grid; gap:.8rem; margin-top:1.6rem; }

/* 提示 */
.toast { position:fixed; bottom:1.6rem; left:50%; transform:translateX(-50%); background:var(--bg-2); border:1px solid var(--line); padding:.7rem 1.2rem; font-size:.85rem; z-index:200; max-width:min(90vw,480px); color:var(--ink); }
.toast[hidden] { display:none; }

/* 动效 */
.fade-in { opacity:0; transform:translateY(14px); animation:fade .8s var(--ease) forwards; }
.d1 { animation-delay:.1s } .d2 { animation-delay:.2s } .d3 { animation-delay:.3s }
@keyframes fade { to { opacity:1; transform:none } }
@keyframes rise { from { opacity:0; transform:translateY(12px) } }
@media (prefers-reduced-motion: reduce) { .fade-in,.modal-panel { animation:none; opacity:1; transform:none; } html { scroll-behavior:auto; } }

/* 折叠：960px 以下收起整条菜单（初始值；需按真实品牌名与登录态宽度复核） */
@media (max-width: 960px) {
  .nav { flex-wrap:wrap; }
  .nav-toggle { display:flex; }
  .nav-menu { display:none; width:100%; flex-direction:column; align-items:stretch; gap:1rem; padding-top:1rem; }
  .nav-menu.open { display:flex; }
  .nav-links { flex-direction:column; gap:.6rem; }
  .nav-auth { flex-wrap:wrap; }
  .user-name { max-width:100%; }
}
@media (max-width: 600px) { .hero-actions { flex-direction:column; align-items:center; } }
```

---

## 8. 平台申请与配置清单（与 §1 并行启动；资格、费用、审核周期以申请时官方页面为准）

**Google Cloud Console**
1. 创建项目 → APIs & Services → OAuth consent screen（External；填应用名、支持邮箱、隐私政策链接；scope 仅 `openid email profile`）。
2. Credentials → Create OAuth client ID → Web application → Authorized redirect URIs：`https://你的域名/auth/google/callback`（本地调试另加 `http://localhost:3000/auth/google/callback`）。
3. 发布应用（Publishing status → In production），否则只有测试用户能登录。
4. 把 Client ID / Secret 填入部署环境的 `GOOGLE_*`。

**微信开放平台（网站扫码登录）** open.weixin.qq.com
1. 注册开发者账号并完成开发者资质认证（当前要求企业主体）。
2. 管理中心 → 网站应用 → 创建应用：填网站信息；**授权回调域**填裸域名（`www.your-domain.com`，不带协议和路径）。
3. 审核通过后：AppID / AppSecret 填 `WECHAT_OPEN_*`；`WECHAT_OPEN_UNION_DOMAIN` 填一个代表该开放平台账号的稳定字符串。

**微信公众号（微信内登录，可选）** mp.weixin.qq.com
1. 需具备网页授权能力的公众号（通常为已认证服务号）。
2. 设置与开发 → 公众号设置 → 功能设置 → 网页授权域名：填域名，并把校验文件放到 `public/`。
3. 开发 → 基本配置 → IP 白名单：加服务器出口 IP；AppID / AppSecret 填 `WECHAT_MP_*`。
4. 要让扫码与公众号共享 UnionID：到开放平台 → 管理中心 → 公众账号 → 绑定该公众号，然后 `WECHAT_MP_UNION_DOMAIN` 与 `WECHAT_OPEN_UNION_DOMAIN` 填相同值；否则留空（两种入口各自独立账号，可在账号页手动关联）。

**服务器**：HTTPS（Let's Encrypt）；Nginx 反代到 3000 并传递 `X-Forwarded-Proto`；`BASE_URL` 与证书域名一致；`SESSION_SECRET=$(openssl rand -hex 32)`；`NODE_ENV=production`；`data/` 定期备份。

**渠道验收**：每个渠道单独走 §9.1 用例；未通过的渠道保持 `available:false`。

---

## 9. 运行与验收（每项记录：通过 / 失败 / 未执行 / 不适用；**当前全部未执行**）

```bash
cp .env.example .env && npm i && npm run dev
npm run grant -- 1 member 30 "test"     # 服务器本地发测试权益
```

### 9.1 认证与身份
- [ ] 新用户 login 创建账号并进入 `welcome`；老用户进入 `ok`
- [ ] 错误 / 过期 / 已消费 `state` → `expired` 或 `failed`；回调无 `bid` cookie → 拒绝且不补发
- [ ] 换浏览器打开回调链接 → 被拒；**原浏览器的事务仍可完成**（消费条件含浏览器摘要）
- [ ] 同一浏览器两个标签页分别发起 login：先完成者成功；后完成者 `stale`（epoch 已变）并提示重发
- [ ] **无会话退出 → 旧回调失效（可执行步骤）**：① 无会话浏览器 `GET /api/auth/bootstrap` 取 csrf；② 通过 `/login` 表单创建 login 事务但不去平台授权；③ `POST /auth/logout` 携带有效 csrf，确认 `browser_auth_state.auth_epoch` +1；④ 伪造携带该 state 的回调 → `login=expired`（消费失败），`sessions` 无新行；⑤ 重复 ③ 但不带 csrf → 403，且 epoch 不变、② 的事务仍有效
- [ ] 登录 A → 发起 switch → 在另一标签退出 → 完成 switch 回调 → `stale_tx`，不切换、不创建会话
- [ ] login 事务在已登录状态下完成 → `stale_tx`（login 要求发起与回调均无会话）
- [ ] switch 到同一用户 → `reverified`；到他人 → `switched`，旧会话被撤销
- [ ] reverify：选身份 X 却用身份 Y 授权 → `reverify_mismatch`，验证时间不变；X 被解绑/重绑（`link_version` 变）后再回调 → 拒绝
- [ ] bind：未近期验证 → 403 `reverify_required`；发起后超 15 分钟回调 → `bind_reverify_expired`；成功后 `last_verified_at` **不变**；身份属他人 → `identity_conflict`；已关联且 UnionID 与他人冲突 → `identity_conflict` 并回滚
- [ ] Google：`nonce` 不匹配、`iss` 非允许值、`azp` ≠ clientId → 拒绝；两个 Google 账号同邮箱不合并
- [ ] 微信：无 UnionID 按 openid 登录；身份域未配置不关联；两处 UnionID 不一致 → `wx_bad_response`；`userinfo.openid ≠ token.openid` → 拒绝
- [ ] **解绑微信后**：用同一微信扫码与公众号各登录一次 → 均进入**新**账号；原账号其他设备会话全部失效；当前设备仍登录且验证时间继承（若验证依据是被解绑身份则需重新验证）
- [ ] 解绑最后一种登录方式 → `last_identity`
- [ ] 退出后旧 `sid` 不能访问 `/api/me`；禁用账号不能登录
- [ ] 状态变更接口：缺 `x-csrf-token`、令牌对应旧 epoch / 旧会话、`Origin` 不符、无 `Origin` 且 `Sec-Fetch-Site` 非 same-origin → 403
- [ ] 外部请求超时 → `failed`，日志仅含 trace / code / type / errcode

### 9.2 权限与权益
- [ ] 未登录 `GET /api/member/content` → JSON 401；无权益 → JSON 403；`GET /member` → `/login?...reason=required` 或 `/#membership`
- [ ] `/member.html`、`/views/member.html` → 404
- [ ] 先 30 天再永久 → `permanentNow=true` 立即；先永久再 30 天 → 仍永久
- [ ] 两段相接续费 → `continuousUntil` 为第二段终点；中间有空档 → `continuousUntil` 为第一段终点且 `scheduled` 含第二段
- [ ] 同来源同参数重复授予 → 返回同一 id；参数不同 → `grant_param_mismatch`
- [ ] 撤销来源后摘要重算正确；其他来源不受影响

### 9.3 页面
- [ ] 无 JS：`/login` 可完成登录；`login=required` 跳转正确
- [ ] `status=failed` 时显示"重试"而不是"登录"；`return_to` 在清理 URL 后仍保留
- [ ] 会员页 401 → 弹出登录框并在登录后返回 `/member`；内容失败可重试
- [ ] `<dialog>`：打开聚焦首个按钮、背景不可交互、Esc 关闭、关闭后焦点回到触发元素；重绘不丢焦点
- [ ] 解绑 / 退出 / 绑定：网络错误有提示，提交中按钮禁用
- [ ] 两套主题对比度实测；960px 以下菜单可用；长昵称、长品牌名不溢出；`prefers-reduced-motion` 生效

### 9.4 收费开放前追加
伪造签名 / 错误商户 / 金额币种不符 / 未知订单被拒；重复、并发、不同事件同一付款只发一次；乱序（退款先于支付）与漏送通过对账收敛；浏览器成功页不开通；退款按选定规则（§6.3 A/B）影响字段正确；取消续订不撤销已付期限。

---

## 10. 实施阶段与完成标准

| 阶段 | 交付 | 完成条件 |
|---|---|---|
| 0. 平台申请（与 1 并行） | 微信开放平台 / 公众号 / Google 凭证 | 至少一个渠道凭证到手 |
| 1. 网站梳理 | §1.1 的 5 份清单 | 结论有依据，改造范围明确 |
| 2. 视觉预览 | 用真实内容套 §7 模板，桌面 + 手机，两套主题 | 品牌一致，业务入口完整 |
| 3. 登录接入 | 按原站技术栈适配 §5，已配置渠道可用 | §9.1 通过 |
| 4. 账号与权益 | 账号页、权益摘要、受保护页面与接口 | §9.2–9.3 通过 |
| 5. 整合发布 | 迁移、配置、验证记录、回滚（含数据库恢复边界） | 原业务回归通过 |
| 后续收费 | §6.3 规则确定 → 订单、支付、退款、对账 | §9.4 通过 |

最终交付：与原站一致的完整代码与配置、数据迁移与备份步骤、平台配置记录、页面预览、§9 验收记录（含证据）、发布与回滚步骤。只有真实配置并验证成功的渠道才标"已接入"；只有实际发布并验证的版本才标"已上线"。