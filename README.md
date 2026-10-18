# PeerGrading

**Open-source, local-first dual-agent AI code review and collaboration desktop app.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Download](https://img.shields.io/badge/download-GitHub%20Releases-brightgreen.svg)](https://github.com/010419she-commits/peergrading/releases)
[![Website](https://img.shields.io/badge/website-peergrading.ai-orange.svg)](https://peergrading.ai)

Two AI coding agents take turns writing and reviewing. PeerGrading supports local-first Git worktree collaboration, cloud-assisted parallel pre-review, exact request caching, Electron for Windows and macOS, and OpenAI-compatible providers including Kimi, Codex, Claude Code, Ollama and LM Studio—without requiring a PeerGrading account.

PeerGrading 是一个以 [MIT](LICENSE) 发布的开源双 Agent 协作工具。两个智能体轮流担任**作者**与**审查者**：阅读实际成果、提出意见、交换角色并继续修改。0.6.0 不要求 PeerGrading 登录、会员或付费，本地桌面安装后即可使用；公网站点只用于项目展示和安装包下载。

- 源码：<https://github.com/010419she-commits/peergrading>
- 安装包：<https://github.com/010419she-commits/peergrading/releases>
- 架构：[本地与公网边界](docs/architecture.md)
- 加速：[快照、并行预审与精确缓存](docs/acceleration.md)

## 功能

- **双 Agent 互审**：A 修改、B 审查和讨论，随后交换角色；支持设置模型、人设、审查轮数和讨论次数，并保留每轮成果。
- **真实仓库协作**：在独立 Git worktree 和任务分支中修改已有仓库，保存提交、补丁、审查结论及验证结果，由用户审阅后自行合并。
- **本地与云模型**：可接入本机 Agent CLI、本地兼容模型服务、OpenAI 兼容 Chat API，或剪贴板中转。不同后端可以组合成不同的作者与审查者。
- **本地会话与版本**：版本、验证输出和中断历史保存在本机，便于回放和核对；不会把“模型说通过”冒充测试通过。
- **加速而不跳过审查**：完整快照支持并行预审，SHA-256 防止采纳陈旧结果，精确缓存避免相同输入的重复计算。
- **无账号公网站点**：官网只展示功能并提供 `/installers.json` 与 GitHub Releases 下载，不开放服务器端仓库操作或协作工作台。

## 下载与安装

从 [GitHub Releases](https://github.com/010419she-commits/peergrading/releases) 选择对应系统的安装包：

| 平台 | 发布资产 |
| --- | --- |
| Windows x64 | `PeerGrading-<版本>-windows-x64.exe` |
| Windows ARM64 | `PeerGrading-<版本>-windows-arm64.exe` |
| macOS Intel | `PeerGrading-<版本>-macos-x64.dmg` |
| macOS Apple Silicon | `PeerGrading-<版本>-macos-arm64.dmg` |

每个 Release 同时提供 `SHA256SUMS`。macOS 可用 `shasum -a 256 <文件>`，Windows 可用 `certutil -hashfile <文件> SHA256` 后对照清单。

Windows 安装程序使用安装向导，可查看并更改安装目录，并默认创建 PeerGrading 桌面和开始菜单快捷方式。

macOS 是否签名和公证取决于 Release Runner 实际配置的 Apple 凭证；没有凭证时，项目不会把产物描述为已签名或已公证。不要仅凭下载页面推断签名状态，也不要用绕过 Gatekeeper 的方式替代可信发布。

桌面应用不需要 PeerGrading 账号。所选的 Kimi Code、Codex、Claude Code 等 CLI 可能需要各自登录，云 API 也可能由供应商计费；这些是第三方服务要求，不是 PeerGrading 会员或付费墙。

## 本地与云模型

- **仓库编辑**：使用支持文件工具的 Kimi Code、Codex 或 Claude Code CLI。安装、授权与可用额度由各 CLI 自己管理。
- **文字与代码审查**：可使用本地模型、OpenAI 兼容 API 或其他已支持后端。Base URL 和模型权限以供应商为准。
- **剪贴板中转**：没有 CLI 或 API 时，可在用户选择的桌面 AI 应用之间手动转发内容。
- **配置位置**：模型连接和密钥应只在本机应用的安全配置入口中维护，不要写入仓库、文档、截图或公网站点环境变量。

国内供应商的配置示例见 [国内云 API 接入](docs/china-api-setup.md)，Kimi Code CLI 见 [Kimi Code 配置](docs/kimi-code-setup.md)。保存连接不代表模型权限或余额已验证，只有用户实际发起请求时才能由供应商确认。

## 互审与仓库协作

普通协作围绕文字或代码成果轮换作者和审查者。仓库模式则把成果落到真实文件中：

1. 选择已有提交且工作区干净的 Git 仓库。
2. PeerGrading 从原仓库 HEAD 创建独立 worktree 与任务分支。
3. 作者修改文件，审查者读取实际累计差异；每轮保存提交和补丁。
4. 用户配置的测试或构建命令在任务目录运行，验证记录与对应 Git 文件树绑定。
5. 用户检查差异和验证结果后，自行 merge、cherry-pick 或应用补丁。

程序不会自动推送、合并或清理原仓库。worktree 只隔离 Git 文件与分支，不是操作系统安全沙箱；测试命令仍以本机用户权限运行。完整限制、审查结论规则和中断恢复说明见 [仓库协作](docs/repository-collaboration.md)。

## 加速算法

加速由三个相互约束的机制组成：

1. **完整快照并行预审**：每个后台预审绑定完整输入快照，不直接写当前工作区；相互独立的预审可以并行，而不是串行等待。
2. **SHA-256 采纳/回退**：结果带有来源快照摘要。采纳前重新核对当前内容；一致才进入正常审查流程，不一致则丢弃候选或回到已知快照，绝不把旧结论贴到新版本。
3. **精确缓存**：缓存键由完整快照和全部影响结果的上下文计算。内容、模型、角色或审查输入变化即不能复用；缓存命中也不能绕过验证。

通用 Chat API 通常只暴露消息和 token 流，没有可移植的跨请求 KV cache 或逐 token 中间计算共享接口。因此，相同前缀的并行请求不能被宣传成“只计算一次”，流式传输也不等于共享计算。供应商特定的提示缓存须按其文档单独确认；PeerGrading 自身保证的是应用层快照与缓存边界。详见 [加速算法与 API 边界](docs/acceleration.md)。

## 隐私与安全

- 本地仓库、会话、版本和缓存由本机服务处理，不需要上传到 PeerGrading 公网站点。
- 使用云模型时，提示词、代码片段或仓库上下文会按用户所选后端发送给对应供应商；其保留、训练和计费规则由供应商决定。本地模型或剪贴板中转有不同的数据路径，应按实际选择评估。
- 公网站点不接收 PeerGrading 账号、订单或仓库任务。主机服务商仍可能产生常规网络日志，不应把“无账号”理解成所有基础设施都没有日志。
- 不提交 `.env`、API Key、CLI 认证文件、私钥、用户数据库或会话目录。公开的 `.env.example` 只包含无账号站点的非敏感配置。

## 开发与测试

需要 Node.js 24 或更高版本以及 Git。跨平台复制源码后应重新安装依赖，不要复用另一台机器的 `node_modules/`。

```bash
npm ci
npm test
npm run dev       # 本地开发服务与本地功能
```

自动测试默认使用模拟后端和临时目录，不应消耗真实模型额度。`npm run desktop` 可启动桌面开发外壳；真实 CLI、模型权限和各平台安装体验仍需在对应环境单独验证。

## 构建与运行

```bash
npm run bundle
```

构建契约：

| 产物 | 用途 |
| --- | --- |
| `dist/server.mjs` | 本地桌面和本地协作服务 |
| `dist/site-server.mjs` | 无账号公网展示与下载站点 |
| `public/app-vendor.js` | 浏览器工作台依赖包 |

公网运行：

```bash
npm start         # 等价于启动公网站点入口，不提供本地协作 API
```

也可在构建后直接运行 `node dist/site-server.mjs`。`.env.example` 中只有端口、公开 Base URL 和 GitHub 仓库等站点设置；不需要 SESSION_SECRET、OAuth、SMTP、支付、设备或会员配置。

安装包构建使用现有 `dist:win` / `dist:mac` 脚本或 Release 工作流中的显式架构矩阵。Electron 首次安装或打包可能需要下载平台运行时。

## GitHub Actions 与 Releases

- **Test**：Push、Pull Request 和手动触发时在 Node 24 上执行 `npm ci`、`npm test`、`npm run bundle`；若仓库提供 `scripts/check-open-source.mjs`，还会执行开源安全检查。
- **Release**：`v*` 标签触发 Windows x64/arm64、macOS x64/arm64 矩阵构建，收集安装包，生成 `SHA256SUMS`，再由 Runner 上的 `gh` 发布到 GitHub Releases。发布不依赖开发者本机安装 `gh`，也不依赖服务器 `downloads/` 或旧上传脚本。
- **Deploy**：只部署无账号站点，排除本地秘密、数据、会话、交接、迁移和安装包目录，并检查首页、`/installers.json` 以及代表性旧 API 的 404 响应。

发布前应确认 `package.json` 版本与标签一致、四个架构产物均存在、校验清单匹配，并如实记录 macOS 签名/公证状态。不要以 CI 构建成功代替真实模型、安装或平台签名验收。

## 文档与许可

- [架构与部署边界](docs/architecture.md)
- [加速算法与 Chat API 边界](docs/acceleration.md)
- [仓库协作](docs/repository-collaboration.md)
- [国内云 API 接入](docs/china-api-setup.md)
- [Kimi Code 配置](docs/kimi-code-setup.md)

Copyright (c) 2026 PeerGrading contributors。依据 [MIT License](LICENSE) 使用、修改和分发。
