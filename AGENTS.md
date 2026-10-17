# PeerGrading 开发约定

PeerGrading 是以 MIT 许可证发布的开源项目。开始修改前阅读 [README.md](README.md)、[架构说明](docs/architecture.md) 和 [加速算法](docs/acceleration.md)。

## 产品边界

- 本地桌面与本地开发服务不得要求 PeerGrading 账号、登录、会员、设备授权或付费；全部核心功能可直接使用。
- 公网站点只展示项目与安装包，提供 `/`、`/installers.json` 和 GitHub Releases 下载，不提供协作工作台、服务器仓库操作、账号、支付或旧版兼容 API。
- 本地运行构建为 `dist/server.mjs`，公网运行构建为 `dist/site-server.mjs`；两者不得因为共用源码而重新打通上述边界。
- 安装包统一通过 GitHub Releases 发布。不要恢复把安装包上传到服务器目录或扫描 `downloads/` 的发布方式。
- 第三方 Agent CLI 的登录和用户自有的模型 API Key 属于用户所选服务，不是 PeerGrading 账号体系。

## 正确性与安全

- 不提交 API Key、OAuth/SMTP 凭证、设备令牌、私钥、用户数据库或会话内容。`.env.example` 只能包含无账号站点所需的非敏感示例。
- 不发布或引用私人交接材料；`data/`、`sessions/`、`handoff/`、`migration/`、`release/`、本地密钥和构建缓存不得进入公开仓库或部署同步。
- 仓库协作保留 worktree、差异审查、验证命令与版本绑定。Git worktree 不是操作系统安全沙箱，文档不得把它描述成沙箱。
- 加速只能改变等待时间和重复计算，不能改变审查结论。并行预审必须绑定完整快照；采纳前核对 SHA-256，失配结果不得套用；缓存必须按全部有效输入精确匹配。
- 通用 Chat API 不具备可移植的跨请求 token/KV 共享计算接口。不得把供应商可选的提示缓存或应用层缓存宣传成保证发生的 token 级共享计算。
- 保留用户未提交的工作。未经明确请求，不执行破坏性 Git 操作、真实付费 API、推送、部署或发布。

## 开发验证

使用 Node.js 24 或更高版本：

```bash
npm ci
npm test
npm run bundle
```

`bundle` 必须同时生成 `dist/server.mjs`、`dist/site-server.mjs` 和 `public/app-vendor.js`。本地开发使用 `npm run dev`；`npm start` 只用于无账号公网站点。

测试默认使用模拟模型和临时目录，不依赖真实付费服务。新增行为应补充对应测试；修改快照采纳、缓存键、公开路由或构建产物时，必须同时更新相关文档与 CI 检查。不要把历史测试数量、真实模型可用性或 macOS 签名/公证状态写成未经验证的结论。

## 发布

- 测试工作流验证 Node 24 下的依赖安装、测试和构建。
- `v*` 标签触发 Windows x64/arm64 与 macOS x64/arm64 矩阵构建，安装包使用带 OS/架构的稳定文件名，并发布 SHA-256 校验清单到 GitHub Releases。
- macOS 仅在 Runner 实际配置凭证时签名和公证；缺少凭证时不得声称产物已签名或已公证。
- 部署工作流只同步无账号站点，并验证首页、`installers.json` 及旧 API 的 404 响应。
