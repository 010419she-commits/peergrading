# 架构与部署边界

PeerGrading 0.6.0 将本地协作与公网下载站点拆成两个运行入口。它们共享构建能力，但不共享账号、支付或服务器端仓库权限。

## 两个运行入口

| 入口 | 构建产物 | 用途 | 明确不提供 |
| --- | --- | --- | --- |
| 本地桌面 / 本地开发 | `dist/server.mjs` | 双 Agent 协作、仓库 worktree、会话与版本记录、本机 Agent 接入 | PeerGrading 登录、会员、设备授权、付费限制 |
| 公网下载站点 | `dist/site-server.mjs` | 首页、项目说明、`/installers.json`、GitHub Releases 下载 | 协作接口、服务器仓库路径、账号、支付、旧下载 API |

`npm run bundle` 还生成浏览器工作台所需的 `public/app-vendor.js`。生成物属于构建输出，不应手工编辑。

## 本地协作数据流

1. 用户在本机选择 Agent、任务和可选的 Git 仓库。
2. 本地服务调用用户配置的 CLI、本地模型或云模型。云模型请求由用户主动选择，内容和费用由对应供应商规则决定。
3. 作者与审查者围绕同一版本交换意见；仓库模式在独立 worktree 和任务分支中保存提交、补丁及验证结果。
4. 会话、版本和缓存留在本机数据目录。PeerGrading 不要求把这些内容上传到公网站点。

仓库模式的文件工具权限和 Git worktree 隔离不等于操作系统沙箱。验证命令会以本机用户权限运行，只应对可信项目启用。

## 公网站点数据流

公网服务只返回展示内容与安装包索引。安装包的可信发布位置是：

`https://github.com/010419she-commits/peergrading/releases`

`/installers.json` 是站点发现 Releases 资产的公开接口；它不是账号接口，也不以上传服务器本地文件作为发布来源。旧 `/api/download/latest`、设备、登录、会员、支付和协作 API 不应存在，部署冒烟测试会检查代表性旧路由返回 404。

站点不需要 SQLite、会话目录、OAuth、SMTP、SESSION_SECRET 或商户凭证。容器只监听宿主机回环地址，由 Caddy 提供 HTTPS 反向代理。

## 加速与正确性

完整快照、并行预审、SHA-256 采纳/回退和精确缓存属于本地协作实现。任何缓存命中或并行结果都不能绕过当前版本核对、审查规则和实际验证命令。详细不变量见 [加速算法](acceleration.md)。

## 发布链路

1. 推送或 Pull Request 触发 Node 24 的 `npm ci`、`npm test` 和 `npm run bundle`。
2. `v*` 标签触发四个安装包目标：Windows x64、Windows arm64、macOS x64、macOS arm64。
3. Release 作业收集矩阵产物，生成 `SHA256SUMS`，通过 Runner 上的 GitHub CLI 上传到对应 GitHub Release。
4. 公网部署只同步站点源码和配置，在服务器重新构建并运行 `dist/site-server.mjs`，随后执行首页、安装包索引及旧 API 404 检查。

macOS 签名和公证不是由文件名推断的：只有构建 Runner 实际具备相应凭证时才能发生。缺少凭证的产物不得宣称已签名或已公证。

### macOS 签名与已有版本重建

Release Runner 将 `CSC_LINK`（Base64 编码的 P12）和 `CSC_KEY_PASSWORD` 导入临时钥匙串。P12 密码只用于证书导入；钥匙串创建、解锁和 `set-key-partition-list` 使用另一份随机密码。签名助手验证 Developer ID Application 身份后，通过 `CSC_KEYCHAIN` 交给 Electron Builder。构建进程须 `unset CSC_LINK` 及证书导入密码，避开自动导入路径；仅设置为空字符串仍会被 Electron Builder 当作配置值。构建结束后删除临时钥匙串和公证私钥文件，密码不写入构建日志或产物。

发布前实际运行 `codesign --verify --deep --strict`；启用公证时还必须通过 `xcrun stapler validate` 检查应用携带的票据。不能仅凭上传资产成功声称签名或公证成功。对应模拟测试覆盖两种密码的用途、失败时不导出环境变量、临时材料清理及原钥匙串列表保留。

已存在的 `vMAJOR.MINOR.PATCH` 标签可从默认分支手动触发 Release 工作流重建：保留当前工作流的签名助手，再检出指定标签源码，校验标签与包版本，构建四个平台/架构并发布校验清单。这不移动或重写原标签；用于恢复签名或构建基础设施故障。只有资产发布及校验成功后，才更新官网下载索引。
