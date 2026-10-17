# Kimi Code CLI 仓库协作

PeerGrading 支持新版 **Kimi Code CLI 2.x**，可与 Codex、Claude Code 或另一组 Kimi Code 配置配对修改已有 Git 仓库。本地使用不要求 PeerGrading 账号；Kimi Code CLI 自身的安装、登录、订阅或 API 额度仍由 Moonshot AI 的对应产品规则决定。

Kimi 网页、Kimi 聊天桌面应用和旧 Python `kimi-cli` 的启动参数不同；安装聊天应用不等于安装命令行。

## 安装与登录

按 [Kimi Code 官方安装说明](https://github.com/MoonshotAI/kimi-code#install)安装当前 CLI，然后在终端检查：

```sh
kimi --version
kimi --help
kimi login
```

PeerGrading 依据当前 CLI 的帮助与本地配置检测能力，不用旧版参数推断新版行为。软件会从 PATH 和常见用户安装位置查找 `kimi`；安装后点击重新扫描。缺少命令或认证时，按检测提示在终端完成登录。

CLI 与 Kimi Code 桌面版默认共用 `~/.kimi-code/config.toml`；设置了 `KIMI_CODE_HOME` 时使用该目录。检测过程只检查命令帮助和本地认证状态，不应发送付费模型请求。显示“可用”表示本地配置已找到，实际额度、网络和账号状态在运行任务时确认。

若官方配置中已有 API Key，软件只通过该子进程的环境变量传递，不将 Key 写入临时 TOML 或任务文本。OAuth 凭据如需临时副本，应限制文件权限并在回合结束后删除；CLI 不应覆盖原认证文件。请勿将配置或凭据提交到 GitHub。

未配置 CLI 的用户也可显式提供 `KIMI_API_KEY`（或 `MOONSHOT_API_KEY`），配合 `KIMI_BASE_URL`、`KIMI_MODEL` 使用开放平台兼容接口。开放平台 API 额度与 Kimi Code 订阅不同，应使用对应平台允许的模型；已有 Kimi Code 默认配置时优先使用该配置。密钥只在本机使用，不写入公网下载站点。

## 在软件里操作

1. 选择“修改已有仓库”，选择一个工作区干净且已有提交的 Git 仓库。
2. 两个 Agent 分别选择 **Kimi Code CLI** 和另一支持仓库编辑的 CLI；输入具体修改需求，以及项目适用的测试命令。
3. 启动后，作者在任务工作树内修改文件；另一位 Agent 阅读实际累计差异并提出意见。修改、审查、讨论按轮次交替运行。
4. 查看测试结果、代码差异和任务分支。检查完成后，再按 [仓库协作文档](repository-collaboration.md) 将需要的提交合入原仓库。

## 文件工具与本地配置边界

PeerGrading 为每回合创建独立的临时配置、工作目录和完整 Agent 定义文件；任务和仓库内容不会进入命令行参数。运行时：

- 作者只提供 `Read`、`Glob`、`Grep`、`Edit`、`Write`。
- 审查、讨论只提供 `Read`、`Glob`、`Grep`。
- 普通文本协作的工具列表为空。
- 不开放 `Bash`、子 Agent、MCP 或网络工具，不传 `--auto`、`--yolo`。
- 不继承用户配置里的 hooks、插件、MCP 或自动发现的项目技能；CLI 从临时空目录启动，通过 `--add-dir` 指向任务工作树。
- 测试与 Git 提交由 PeerGrading 编排；回合结束或取消时停止子进程，并删除临时配置、凭据副本和 CLI 会话记录。

这些是文件工具与启动配置限制，**不是操作系统级沙箱**。作者的本地文件访问仍以当前用户权限运行，应先审查不可信仓库；Git worktree 提供改动隔离，原仓库不会被自动合并或推送。

并行预审和缓存不会改变上述权限。预审绑定完整快照，采纳前核对 SHA-256；缓存只在全部有效输入完全一致时复用。通用 API 或 CLI 的流式输出不代表跨请求 token 级共享计算，详见 [加速算法](acceleration.md)。

参考：[官方 CLI 参数](https://moonshotai.github.io/kimi-code/en/reference/kimi-command)、[自定义 Agent 与工具允许列表](https://moonshotai.github.io/kimi-code/en/customization/agents)、[配置文件](https://moonshotai.github.io/kimi-code/en/configuration/config-files)。
