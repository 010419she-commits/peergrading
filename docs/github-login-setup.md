# GitHub 登录配置

GitHub 登录与邮箱验证码并列提供，网站和桌面软件共用账号系统。没有配置凭证时不显示 GitHub 登录按钮，已有登录方式继续可用。

## 1. 创建 OAuth App

用你控制的 GitHub 账号或组织，在 **Settings → Developer settings → OAuth Apps → New OAuth App** 创建应用。也可直接打开 [GitHub OAuth App 创建页面](https://github.com/settings/applications/new)。

| 项目 | 正式环境填写内容 |
| --- | --- |
| Application name | PeerGrading |
| Homepage URL | `https://peergrading.ai` |
| Application description | `PeerGrading desktop app sign-in` |
| Authorization callback URL | `https://peergrading.ai/auth/github/callback` |

回调地址应精确匹配；如果后台提供 callback wildcard 选项，保持关闭。本功能使用网页授权，不需要启用 Device Flow。GitHub 的设备码与软件已有的设备连接码是两套流程。可以保留默认的 **Expire user access tokens**：本功能仅在回调内即时取用户资料，不依赖长期 token 或刷新 token。

创建后取得 **Client ID**，再生成 **Client secret**。个人 GitHub 账号也能创建 OAuth App；不用申请微信开放平台或提供网站应用登记表。

## 2. 只在云端配置凭证

在生产服务器 `/srv/peergrading/.env` 填入：

```dotenv
BASE_URL=https://peergrading.ai
GITHUB_CLIENT_ID=填写刚创建的ClientID
GITHUB_CLIENT_SECRET=填写生成的ClientSecret
```

保留现有 `SESSION_SECRET`、数据库和其他配置。在 `/srv/peergrading` 执行：

```bash
docker compose up -d --build
```

Client secret 不应出现在 GitHub 仓库、前端代码、安装包或聊天中。桌面软件经系统浏览器访问云端授权，再通过现有设备授权流程连接账号；桌面端不需要 GitHub Client secret。

本地调试请另外建一个测试 OAuth App，用 `http://127.0.0.1:3000/auth/github/callback` 作回调，同时将测试服务的 `BASE_URL` 设为 `http://127.0.0.1:3000`。正式和测试环境分别使用各自的 OAuth App，避免混用回调和密钥。

## 3. 验证

1. 打开网站登录页，应出现 GitHub 按钮；桌面端选择 GitHub 后应打开系统浏览器。
2. 授权页仅应请求读取个人资料；授权后回到 PeerGrading，桌面端继续自动连接。
3. 在软件里检查账号、会员和设备。退出后再次用同一个 GitHub 账号登录，应保留同一账号记录。
4. 在 GitHub 授权页取消后，可重新发起。复制回调链接重复打开不能重复登录；不同浏览器也不能使用该回调。

没有实际 Client ID / secret 时只能验证界面、不可用提示和模拟 OAuth 流程，不能声称真实 GitHub 登录已开通。

## 身份与权限

授权仅请求 `read:user`，不申请 `repo`、`public_repo`、私人邮箱或写入权限。已有仓库的双 Agent 协作通过本机 Git 和本机 Agent CLI 执行；GitHub 登录本身不会授予软件读取或推送私人仓库的权限。

服务端用 GitHub 的稳定数字用户 ID 识别账号，用户名或公开邮箱变更不会创建新身份。GitHub 与邮箱/Google 登录不会因为邮箱相同而自动合并；已有会员请先使用原登录方式，在账号页显式绑定 GitHub，避免进入一个新账号。

认证使用一次性 state、浏览器与会话版本绑定及 PKCE S256。授权 token 仅在回调内用于查询当前用户，不写入数据库、日志或桌面存储。

## 常见问题

- **看不到按钮**：确认服务端同时配置了两项凭证，且已重建应用容器；不要将密钥写到桌面客户端。
- **回调地址错误**：核对 OAuth App 的 callback 和服务端 `BASE_URL`，包括 `https`、域名、路径以及末尾斜杠。
- **登录失败或授权过期**：从软件/登录页重新发起，不复用回调 URL。检查服务器日志中的 trace 和错误类型，不记录 token 或完整回调链接。
- **登录后没有原会员**：新 GitHub 登录与原邮箱/Google 身份默认分开；使用原方式登录后在账号页绑定，不能仅凭邮箱认领其他账号。
- **无法访问 GitHub**：云端必须能访问 `github.com` 的 token 接口和 `api.github.com/user`；用户浏览器也需能打开 GitHub 授权页。

官方参考：[创建 OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)、[OAuth 网页授权与 PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)、[OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)、[读取当前用户](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)。
