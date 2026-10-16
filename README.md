# PeerGrading · 双 Agent 协作循环

Two AI coding agents take turns as author and reviewer, critiquing, debating and revising each other's work until it passes. Desktop app for macOS / Windows + companion site at https://peergrading.ai.

两个 AI 智能体轮流担任**作者**与**审查者**：A 完成第 1 版 → B 审查并与 A 讨论 → B 修改出第 2 版 → A 审查…… 直到审查者判定「通过」。网页自动识别你电脑上的 agent（Claude Code、Codex、Qwen Code、Kimi Code 等），一键选两个开始。

本版按三份评审稿重建：功能与账号体系按《网站微信 / Google 登录接入、会费制基础与视觉改造 · v9》，视觉按《品牌网站 · 视觉方向 A 样稿（第 4 版）》（深色 · 暖白 · 浅金），成果验证按《第 4 版：在成果版本后增加收尾 Agent》。前两份原稿在 `docs/`。

## 运行

需要 Node.js ≥ 24（直接运行 TypeScript，无需编译；SQLite 使用 Node 内置模块）。

```bash
npm install
npm run dev      # 本地开发：启用“开发者登录”，打开 http://localhost:3000
```

```bash
npm start        # 正式运行：需要 .env（见 .env.example）
```

## 站点结构

| 路径 | 说明 |
|---|---|
| `/` | 首页：理念 / 接入方式 / 流程 / 定价，登录弹窗 |
| `/app` | 工作台（必须登录，且在试用期内或已购买） |
| `/account` | 账号：使用权与剩余天数、订阅方案、邀请码、内测微信群、订单、关联 / 解绑 / 重新验证登录方式 |
| `/admin` | 站主后台（仅管理员）：内测开关、收款设置、早鸟 / 邀请参数、微信群二维码、用户剩余天数、订单确认、赠送会员 |
| `/login` | 无 JS 也可用的登录页 |
| `/terms` `/privacy` | 占位页，正式发布前替换 |

## 登录与账号（v9 规格）

- Google 登录（面向海外发布；微信登录已移除）；首次登录自动建账号。
- 浏览器认证版本 `auth_epoch`、一次性认证事务、服务端会话（HttpOnly Cookie）、与会话绑定的 CSRF 令牌、返回位置白名单。
- 账号页支持切换账号、重新验证、绑定 / 解绑，至少保留一种登录方式。
- 本地开发可用 `DEV_LOGIN=1` 启用“开发者登录”，不需要任何第三方凭证即可走通全部流程；生产环境该入口不存在。

Google OAuth 申请步骤见 `docs/final-v9-login-membership.md` §8（微信部分不再适用）。

## 内测免费 → 开放订阅

- **内测免费默认开**：所有登录用户免费使用全部功能，网站不显示购买入口（方案卡片标「内测结束后开放」），下单接口返回 403 `beta_free`，桌面软件不弹付费提示。徽标显示「内测免费」。
- **开放订阅**：管理员在 `/admin` 关掉「内测免费」即可（或 `.env` 设 `FREE_BETA=0` 作为没有后台设置时的默认值）。关闭那一刻起：按会员 / 试用规则放行，试用结束或会员到期即停止使用；**内测期间注册的用户从关闭时起重新计算试用**（内测期间的用量不计）；内测期间登记的邀请奖励立即发放。
- **管理员**：`.env` 里 `ADMIN_USER_IDS=<用户 ID>`（账号页「用户 ID」一行可查），或 `npm run grant -- <用户ID> admin permanent`。非管理员访问 `/admin` 得到 404。

## 试用、方案与邀请

- 试用：注册后 **3 天内可免费使用 5 次**协作（先到者为准）；`TRIAL_DAYS` / `TRIAL_USES` 可改。
- **早鸟终身版**：前 **200 名** ¥99 一次买断、永久使用（`EARLY_BIRD_LIMIT` / `EARLY_BIRD_PRICE_CENTS`，后台可改）。名额 = 已付订单 + 24 小时内的待支付订单；售罄后下单返回 409 `sold_out`，网站显示「已售罄」。
- **月付**：默认 **每月 18 元**（`PLAN_MODE=days`、`PLAN_DAYS=30`、`PRICE_CENTS=1800`）：每次付款延长 30 天，会员期内可提前续费（顺延累加），到期不自动扣费。改 `CURRENCY=USD` 即按美元计价；`PLAN_MODE=permanent` 改为一次买断。自动扣费的订阅需要接 Stripe 等渠道的 subscription，当前未接。
- **邀请奖励**：每个用户有 8 位邀请码与邀请链接（`/?ref=码`）。好友通过链接注册（或注册后 7 天内在账号页填码），**双方各得 7 天会员**（`REFERRAL_DAYS`，后台可改）；顺延累加到现有会员期之后。内测期间先登记、内测结束时统一发放。防刷：一个用户只能被邀请一次、不能填自己的码、每人最多因邀请获奖 `REFERRAL_MAX`（默认 20）次。
- **内测微信群**：后台上传群二维码与说明后，账号页出现「内测微信群」入口。
- 权益模型按 v9 §5.10 / §6：区间、永久、幂等授予、撤销。

### 收款怎么接

订单、支付事件、权益发放已按 v9 §6.4 实现（单事务、幂等、验签），支付渠道本身需要商户资质，留了三种接法：

1. **个人收款（线下 / 扫码）**：在 `/admin` 填付款说明并上传收款码（或 `.env` 的 `PAY_INSTRUCTIONS` / `PAY_QR_URL`），用户下单后看到订单号、方案、金额与收款码；你在 `/admin` 的订单列表点「确认到账」（或执行 `npm run confirm-order -- <订单号>`），会员立即生效。
2. **支付回调**：`POST /api/payments/webhook`，raw body 用 `PAYMENT_WEBHOOK_SECRET` 做 HMAC-SHA256，签名放 `x-signature` 头；body 为 `{event_id, merchant_order_no, amount_cents, currency, provider_txn_id, provider}`。接微信支付 / 支付宝时把它们的验签逻辑替换进 `billing/orders.ts` 的 `verifyWebhookSignature`。
3. **本地模拟**：`npm run dev` 下订单面板有“模拟支付成功”按钮，用于验证整条链路。

运维脚本：`npm run users`（用户、状态与剩余天数）、`npm run grant -- <userId> member <days|permanent>`（手动发权益；后台用户列表也能直接赠送天数 / 永久）。

## 自动识别规则（以 agent 为单位）

| agent | 识别方式 | 接入方式 | 需要的准备 |
|---|---|---|---|
| Claude Code | PATH 上的 `claude`，或 Claude 桌面版内置的命令行 | 命令行直连 | 一次性登录：卡片上点「打开终端登录」，会带上系统代理运行 `claude auth login`，浏览器里点一次授权即可 |
| Codex | PATH 上的 `codex`，或 ChatGPT 桌面版内置的 codex-cli | 命令行直连 | 在 ChatGPT 应用的 Codex 里登录即可 |
| Qwen Code | PATH 上的 `qwen` | 命令行直连 | 终端运行 `qwen` 完成一次登录 |
| Kimi Code | 环境变量 `KIMI_API_KEY`（或 `MOONSHOT_API_KEY`） | Kimi 开放平台接口直连 | 已有 key 即可；可用 `KIMI_MODEL` 指定模型 |
| Gemini CLI、Kimi Code CLI、OpenCode、Cursor Agent、Copilot CLI、Amp、Droid、Crush、Goose、auggie、iFlow、CodeBuddy、Aider | PATH 上的可执行文件 | 命令行直连（实验性） | 自行登录 |
| Kimi Code、Kimi、Claude 桌面版、ChatGPT/Codex 桌面版、Qwen Code 桌面版、Cursor、Windsurf、Trae、Kiro、Qoder、CodeBuddy、Antigravity、Zed、VS Code | `/Applications` 里的 .app | 剪贴板中转（预设目标应用，一键发送即切到前台） | 应用里登录即可 |
| 剪贴板中转 / 手动中转（不指定应用） | 始终可用 | 中转 | 无 |

选择器分「一键全自动」与「需要手动粘贴」两组；默认只扫描 agent，`SCAN_MODELS=1` 时额外列出 LM Studio / Ollama 本地模型与 `ANTHROPIC_API_KEY` 直连。

**网络代理**：国内直连 Anthropic / OpenAI 会被拒绝（403）。程序自动读取 macOS 系统代理（或 `HTTPS_PROXY`），在调用 Claude Code、Codex 命令行及「打开终端登录」时带上；Kimi 等国内接口不走代理。

## 中转模式（不装 CLI、不登录）

1. 选桌面应用卡片（或「剪贴板中转」并填目标应用）。
2. 轮到它时点「发送到 ××」：内容已复制并切到该应用，⌘V（Windows 上 Ctrl+V）回车；第一条消息请在应用里新建对话再贴。
3. 复制整段回答。网页检测到剪贴板新内容后显示预览与 6 秒倒计时，可确认或拒绝；也可把回答粘贴到卡片里提交。

## 收尾 Agent（把成果真正跑起来）

协作结束后，右侧版本面板下方出现「收尾 Agent」：选一个全自动 agent（命令行或接口直连）作为收尾模型，选执行环境，点「运行第 N 版」。流程与原稿一致：

```
冻结选定版本 → 识别代码围栏并布局成文件（带 title= 的直接用；匿名块由 Agent 决定）
→ 探测环境（node / python3 / cargo / go / java 版本）→ Agent 生成运行计划（只允许新增辅助文件）
→ 安装 / 构建 → 实际运行 → 机器检查（stdout / JSON 字段 / 产物文件）+ Agent 判定
→ 可选修复（0–3 次，只处理依赖、入口、路径、明显语法错误）→ 清理 → 报告
```

- **执行环境**：有 Docker 时默认 Docker（每条命令独立容器，根目录只读，运行阶段禁网，限制内存 / CPU / 进程数）；没有 Docker 时只能「本机直接运行」，页面会提示无隔离。
- **成功的条件**：至少一条运行命令真实执行、安装与运行均成功、所有检查通过且至少一条是实质性检查、Agent 判定 success、本次尝试没有未批准的源码变化。否则为失败 / 未确认。
- **版本冻结**：每次协作结束时，各版本按「轮次 + 作者 + SHA-256」冻结在 `sessions/<会话>/versions/`；收尾只针对冻结记录，不用当前工作区冒充历史。
- **报告**：`sessions/<会话>/finalizer/<运行 ID>/report.md`（含完整命令输出、检查结果、批准的辅助文件与运行期实际差异），页面上可直接打开。
- 对原稿的两处适配：原稿是命令行交互（`[F]/[N]` 提示、`--finalize-*` 参数），这里改成页面按钮与选项；模型回复的 JSON 结构不合规时会把校验错误反馈给模型最多重试两次，宿主校验本身不放宽。
- 作者 / 审查者的提示词已按原稿建议补充：代码围栏标注 `title=<相对路径>`，示例 / 旧代码 / 输出标注 `role=example|old|output`。

## 工作台

- 为 A、B 选 agent、设名称与人设；设最大审查轮数与每轮讨论次数；随时停止。
- 左侧时间线实时流式显示全部发言，等待时显示已等待秒数与模型推理进度；右侧是各版本成果，结束后定位最终版。
- 会话按用户保存在 `sessions/<时间>/session.json`，可回放。

### 协作中生成图片 / 视频

- 侧栏「图片 / 视频生成」里填 OpenAI API Key（桌面版任何人可填，网页版仅管理员；也可用 `.env` 的 `MEDIA_API_KEY` / `OPENAI_API_KEY`）。Key 只写进本机 / 服务器 `data/media.json`（0600），前端只看到首尾几位。
- 勾选「允许生成图片 / 视频」后，系统提示词多出第 6 条规则：成果需要配图或视频时，智能体写 ```` ```image aspect=16:9 ```` / ```` ```video seconds=8 ```` 围栏描述画面，服务端在每条发言结束后调用 `gpt-image-1` / `sora-2` 生成，把围栏替换成 `![描述](media://文件名)`。替换后的正文进入对方的上下文与成果版本，所以另一位智能体审查时看到的是同一个引用，修改成果时按规则原样保留。
- 文件存在 `sessions/<时间>/media/`，只有会话所有者能通过 `/api/sessions/:id/media/:file` 读取；相同描述在同一次协作中只生成一次。每条消息最多 3 图 1 视频，每次协作合计最多 6 图 2 视频（`MEDIA_MAX_IMAGES` / `MEDIA_MAX_VIDEOS`）；失败、超限或未开启时围栏被替换为一行说明，协作照常进行。
- 请求走系统代理（`HTTPS_PROXY` / `NO_PROXY`），`MEDIA_BASE_URL` 可指向兼容 OpenAI 的中转站。

## 文件

- `server.ts` — Express 服务：静态站点、登录、账号、付费、受保护的协作接口
- `auth/` — v9 参考实现的移植：`config` `db`（node:sqlite）`security` `browser` `tx` `session` `users` `entitlements` `finish` `google` `wechat` `dev` `middleware` `routes`；`device`（桌面软件配对，云端）；`localmode`（桌面模式，本机）
- `desktop/main.cjs` — Electron 外壳；`views/pair.html` — 配对页
- `billing/` — `settings`（站点设置：内测开关等）`access`（使用权）`catalog`（方案：早鸟 / 常规）`orders`（订单与支付事件）`referral`（邀请奖励）`plan`（公开方案信息）`routes`（定价 / 下单 / 回调 / 邀请）`admin`（站主后台接口）
- `agents/` — 自动识别（`detect`）、统一调用层（`backends`）、中转（`relay`）、系统代理（`proxy`）、图片 / 视频生成（`media` 围栏解析与流水线、`media-openai` 接口、`http` 带代理的 fetch）
- `finalizer/` — 收尾 Agent：`types` `extract`（围栏识别与布局）`validate`（计划校验、路径与文件快照、机器检查）`executor`（Docker / 宿主执行）`service`（版本冻结、主流程、报告）`agent`（接入项目 agent）
- `orchestrator.ts` — 协作循环与中英文提示词
- `public/` — 首页 `index.html` + `site.css` + `site.js` + `site-i18n.js`；账号页；后台脚本 `admin.js`；工作台脚本 `app.js` / `style.css` / `i18n.js`
- `views/app.html` — 工作台页面（仅经鉴权路由返回）；`views/admin.html` — 站主后台（仅管理员）
- `scripts/` — `grant-entitlement` `confirm-order` `list-users`
- `docs/` — 两份评审稿原文

## 桌面软件（保留本机 agent 识别与剪贴板中转）

同一套代码可以打包成桌面应用：服务在用户自己的电脑上运行，识别本机 agent、剪贴板中转、一键发送全部可用；只有账号与使用权向 peergrading.ai 核对。

**配对流程**：软件首次打开显示 8 位配对码 → 点「在浏览器中登录并确认」打开 `peergrading.ai/device?code=…` → 登录（首次自动建号）并确认 → 软件拿到长期设备令牌。此后每次开始协作前向云端记一次试用用量并取回最新使用权；离线时沿用 72 小时内的缓存。账号页可查看并断开设备。

```bash
npm run desktop               # 本地开发：打包并启动 Electron（连接 https://peergrading.ai）
npm run desktop:local-cloud   # 连接本机 3001 端口的开发用云端
npm run dist:mac              # 生成 release/PeerGrading-*.dmg（有 Developer ID 证书与公证凭证时自动签名 + 公证，见下）
npm run dist:win              # Windows 安装包（需在 Windows 或配好交叉打包环境）
npm test                      # 单元测试（agent 查找 / 启动方式，含 Windows 模拟）
```

**macOS 签名与公证**（没有这一步，Apple 芯片的 Mac 打开下载的应用会提示「已损坏」；临时办法是 `xattr -cr /Applications/PeerGrading.app`，下载页已写明）：

1. 加入 [Apple Developer Program](https://developer.apple.com/programs/enroll/)（个人，99 美元/年）。
2. 在打包用的 Mac 上装好 Xcode（或 Command Line Tools），Xcode → Settings → Accounts 登录 Apple ID → Manage Certificates → 「+」→ **Developer ID Application**。证书进入钥匙串后 electron-builder 会自动选用。
3. 公证凭证二选一，打包前以环境变量给出（不要写进仓库）：
   - 推荐 App Store Connect API 密钥：`APPLE_API_KEY`（.p8 文件路径）、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`；
   - 或 Apple ID：`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`（在 appleid.apple.com 生成的 App 专用密码）、`APPLE_TEAM_ID`。
4. `npm run dist:mac`。配置里已开启 Hardened Runtime（`build/entitlements.mac.plist`）与 `notarize`；缺少凭证时只签名不公证并打印警告。公证通常几分钟，完成后 `spctl -a -vv release/mac-arm64/PeerGrading.app` 应显示 `accepted`。

- Windows 版：在 macOS 上直接 `npm run dist:win` 即可产出 `release/PeerGrading Setup <版本>.exe`（NSIS 安装包，含 x64 与 arm64）。Windows 上的差异都集中在 `agents/launch.ts` 与 `agents/relay.ts`：
  - 命令行 agent 的查找只认 `.exe/.cmd/.bat/.com`（npm 还会生成一个无扩展名的 sh 脚本，不能运行），`.exe` 优先；除 PATH 外还扫描 npm / pnpm / yarn / bun / scoop / winget / volta / chocolatey 的全局目录、`~/.npmrc` 里自定义的 `prefix`、Codex / Cursor / CodeBuddy / droid 的官方安装目录；跳过 `%LOCALAPPDATA%\Microsoft\WindowsApps`（里面的 `Claude.exe` 是桌面版的别名，不是命令行），也跳过 PE 头标成图形界面的 `.exe`（桌面版 Kimi / CodeBuddy 与命令行同名）和背后是图形程序的 IDE 启动脚本（VS Code 系 IDE 的 `bin\x.cmd`）；`%LOCALAPPDATA%\Programs\<name>\` 只看 `bin\` 子目录。
  - npm / pnpm / yarn 生成的 `.cmd` 包装脚本不经 cmd.exe：解析出它背后的 node 脚本或原生 `.exe` 直接运行（Codex 直接定位到 `@openai/codex-win32-*` 里的 `codex.exe`）；只有手写的 `.cmd` 才退回 cmd.exe。
  - Codex 找不到命令时，还会查官方 `install.ps1`（`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`）、winget 便携包、`CODEX_CLI_PATH`，以及商店版 ChatGPT（Codex）应用自带的 `codex.exe`（通过 `Get-AppxPackage` 找安装目录）。登录状态从 `%USERPROFILE%\.codex\auth.json` 读（`CODEX_HOME` 可改）。
  - 桌面壳启动时用 PowerShell 读注册表里最新的系统 / 用户环境变量（UTF-8，未展开的原文），补齐缺失的变量并合并 PATH（装完 npm / pnpm / Claude Code 后不用重新登录）。
  - 子进程环境去掉 `CLAUDECODE` 等嵌套会话标记，但保留 `CLAUDE_CODE_GIT_BASH_PATH`、`CLAUDE_CONFIG_DIR`、OAuth token 等其余 `CLAUDE_*` 配置。
  - 剪贴板与切换应用通过 PowerShell（`-EncodedCommand`，不受引号规则影响）实现；最小化的目标窗口会先还原；「打开终端登录」新开一个 PowerShell 窗口执行登录命令，与页面上显示的 `$env:` 代理前缀写法一致。
  - 收尾 Agent 在 Windows 上需要 Docker（宿主模式仅限 macOS / Linux）。
- 桌面模式由环境变量 `LOCAL_MODE=1` 开启（Electron 自动设置），数据放在系统的应用数据目录；`CLOUD_URL` 指向云端（默认 `https://peergrading.ai`）。
- Electron 44 自带 Node 24，直接运行 `dist/server.mjs`（esbuild 打包的同一份服务）。
- 云端接口：`POST /api/device/start|poll`（软件）、`POST /api/device/approve|deny`（网页确认）、`GET /api/device/me`、`POST /api/device/usage`（Bearer 设备令牌）、`GET /api/device/list`、`POST /api/device/revoke`。

## 部署到 peergrading.ai

网站需要常驻进程、本地 SQLite 与文件目录，还要能启动子进程，所以用一台 VPS（不能用 Vercel 这类无服务器平台）。`.ai` 域名无法做 ICP 备案，服务器放在香港 / 新加坡 / 美国即可直接绑定域名；代价是大陆访问稍慢，申请微信登录时审核方也可能要求备案，申请前先确认。

云端能用的 agent 只有接口直连（Kimi、以及你自己 key 的 Claude / OpenAI API）和手动中转；剪贴板中转、桌面应用、服务器上登录的个人 CLI 账号都不适合公开服务。

**第一次部署**

1. 把代码推到 GitHub（仓库名 `dual-agent-review-loop`）。
2. 域名 DNS：`peergrading.ai` 与 `www` 各加一条 A 记录指向服务器 IP。
3. 在服务器上执行一次 `deploy/setup-server.sh <你的GitHub用户名>`：装 Docker 与 Caddy，拉代码，生成 `.env` 骨架并把 Caddy 配成自动 HTTPS。
4. 编辑服务器上的 `/srv/peergrading/.env`：`BASE_URL=https://peergrading.ai`、`SESSION_SECRET`（脚本已生成）、Google 登录（`GOOGLE_CLIENT_ID/SECRET`，回调填 `https://peergrading.ai/auth/google/callback`）、收款信息。
   域名在 Cloudflare：DNS 里给 `peergrading.ai` 和 `www` 各加一条 **A 记录指向服务器 IP，代理状态先选「仅 DNS」（灰色云）**，Caddy 才能自动申请证书；需要 Cloudflare 代理时再切橙色云并把 SSL 模式设为 Full (strict)。
5. 运行 `deploy/deploy.sh`，访问 https://peergrading.ai。

**之后每次修改**

本地改好并用 `npm run dev` 验证 → `git push` → GitHub Actions 自动把代码 rsync 到服务器并重建容器（仓库 Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`；私钥在本机 `deploy/keys/github-actions`，不入库，公钥已装在服务器上）。也可以在本机直接 rsync 后执行 `deploy/deploy.sh`。数据在 `data/`、`sessions/`、`downloads/` 三个挂载目录里，重新部署不会丢。

文件：`Dockerfile`、`docker-compose.yml`、`deploy/Caddyfile`、`deploy/setup-server.sh`、`deploy/deploy.sh`、`.github/workflows/deploy.yml`。

## 上线前清单

- 填好 `.env`：`BASE_URL`（https）、`SESSION_SECRET`、至少一个登录渠道；`NODE_ENV=production`。
- Nginx 反代并传递 `X-Forwarded-Proto`；`data/` 定期备份。
- 替换 `/terms`、`/privacy` 占位内容；按 v9 §9 验收清单逐项测试已配置的渠道。
