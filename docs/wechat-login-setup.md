# 微信登录：大陆主体申请与配置

适用于还没有微信开放平台账号、网站应用或公众号的站主。核对日期：2026-10-16。申请资格、材料、认证费用及审核时限以微信当前后台为准，代码接通不等于微信已审核开通。

## 先选择要开通的入口

| 用户在哪登录 | 微信产品 | 本项目配置 | 是否必须 |
| --- | --- | --- | --- |
| 电脑或系统浏览器 | 微信开放平台「网站应用」微信登录 | `WECHAT_OPEN_APPID`、`WECHAT_OPEN_SECRET` | 建议先完成这一项 |
| 手机微信内打开网站 | 微信公众平台具有网页授权权限的服务号 | `WECHAT_MP_APPID`、`WECHAT_MP_SECRET` | 可选，后续添加 |

网站应用走 `snsapi_login`，服务号走 `snsapi_userinfo`。普通个人订阅号不能直接代替已认证服务号；特殊主体权限以后台为准。只配网站应用时，微信内访问会显示扫码登录和“在电脑或系统浏览器打开”的提示，请在新浏览器重新点击登录。[微信登录开发指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)、[服务号网页授权](https://developers.weixin.qq.com/doc/service/guide/h5/auth.html)

**微信登录 AppID、公众号 AppID、微信支付商户号是不同的标识。**微信支付开通不会自动获得网站微信登录权限。即使某个 AppID 同时用于支付，也必须确认它本身具备相应登录渠道权限，再填入对应配置。

## 1. 准备主体、网站和审核资料

由实际经营主体的管理员操作，不要使用他人的营业执照或凭证。常规准备：主体证照、管理员实名资料和联系信息、主体有权使用的域名、网站介绍、产品图标、可访问的官网及功能演示。企业申请涉及公章及平台表单；特殊类型、个人或个体工商户能否申请对应能力，以平台资格检查为准，不要先假设可用。

官网应清楚展示 PeerGrading 的名称、功能、主体与联系方式、用户协议、隐私政策和备案信息。先用真实信息替换占位内容。大陆网站相关备案材料以及网站信息登记表，按申请后台要求提交；主体或备案信息不一致时，先解决或提交平台认可的授权材料。审核人员应能了解产品，避免官网只能看到登录框。[微信网站应用审核规范](https://developers.weixin.qq.com/doc/oplatform/Website_App/operation.html)

申请材料、认证付款、管理员扫码、审核补件、域名备案/验证均需你或主体管理员自行完成；本项目没有替你注册或提交申请。

## 2. 申请网站应用微信登录

1. 在[微信开放平台](https://open.weixin.qq.com/)注册开发者账号，按后台引导完成实际主体信息及所需资质认证。
2. 进入管理中心，创建「网站应用」，填写 PeerGrading 名称、官网、图标、用途、类目和后台要求的申请表及材料。
3. 把登录流程描述为：用户打开官网 → 点击微信登录 → 微信扫码或桌面微信确认 → 返回官网登录 → 桌面端设备配对。提供真实演示/截图。
4. 配置网站应用的「授权回调域」，如正式站点为 `https://peergrading.ai`，填写 `peergrading.ai`。如实际使用 `www.peergrading.ai`，就填该实际域名，不能假设根域与子域通用。按后台要求完成域名证明。
5. 提交网站应用及「微信登录」能力审核，处理补件；确认能力已通过审核。取得网站应用的 AppID，在后台获取/重置 AppSecret，保存到受限的服务器环境文件。

网站应用获批以及取得微信登录能力后，才可使用授权码流程。程序实际回调为：

```text
https://peergrading.ai/auth/wechat/callback
```

这是完整回调 URL；不要把完整 URL 填进只要求域名的字段。`BASE_URL` 必须与实际 HTTPS 域名一致，反向代理需保留回调查询参数，不能把回调请求重定向到另一个站点。[官方授权流程与回调要求](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)

## 3. 在本地或服务器填配置

在受控环境复制 `.env.example` 为 `.env` 后填写。不要把 AppSecret、会话密钥发送到聊天、前端页面或 Git；桌面安装包只连云端登录服务，不应打包这些密钥。

```dotenv
NODE_ENV=production
BASE_URL=https://peergrading.ai
SESSION_SECRET=在服务器本地生成的至少32字符随机值

WECHAT_OPEN_APPID=网站应用AppID
WECHAT_OPEN_SECRET=网站应用AppSecret
WECHAT_OPEN_UNION_DOMAIN=

# 没申请服务号时这三项留空
WECHAT_MP_APPID=
WECHAT_MP_SECRET=
WECHAT_MP_UNION_DOMAIN=
```

`SESSION_SECRET` 可在本机用 `openssl rand -hex 32` 生成并存入环境文件。只设置 AppID 或只设置 Secret 都不会启用该渠道。配置修改需要重启对应服务，数据库和已有登录身份应保留。生产必须使用 HTTPS；密钥只部署在提供 `/auth/wechat/callback` 的服务端。

## 4. 可选：开通微信内服务号授权

1. 在[微信公众平台](https://mp.weixin.qq.com/)申请具有网页授权资格的服务号并完成认证，确认后台确有网页授权接口权限。
2. 在「设置与开发 → 账号设置 → 功能设置」找到「网页授权域名」，填写正式站点的实际域名，例如 `peergrading.ai`，不带 `https://` 或路径。
3. 如后台要求下载校验文件，把**后台给出的原始文件**发布到它要求的域名路径，能被公网访问后再验证。此处是网页授权域名；仅设置 JS 接口安全域名不能替代它。
4. 把该服务号自己的 AppID、AppSecret 填入 `WECHAT_MP_APPID`、`WECHAT_MP_SECRET` 后重启。
5. 用手机微信从站点点击“微信登录”，应进入该服务号的网页授权；正常浏览器仍使用网站应用扫码。

当前官方说明：常规网页授权支持已认证服务号，另有已认证政府、事业单位、媒体类型公众号的特殊权限；域名配置精确到实际域名。网页授权 `access_token` 不等于服务端基础接口的 `access_token`。[服务号官方说明](https://developers.weixin.qq.com/doc/service/guide/h5/auth.html)

## 5. 跨渠道识别同一微信账号

同一个微信用户在网站应用和服务号下的 OpenID 通常不同。本项目用 `(provider, AppID, OpenID)` 识别渠道身份。要自动关联两种渠道，需要先在微信开放平台把服务号绑定到**与网站应用同一个开放平台账号**，并获得该用户的 UnionID。[UnionID 官方说明](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Authorized_Interface_Calling_UnionID.html)

只有确认绑定完成，才把下面两项填成同一个自定义、稳定、唯一的标记，例如 `company-platform-primary`：

```dotenv
WECHAT_OPEN_UNION_DOMAIN=company-platform-primary
WECHAT_MP_UNION_DOMAIN=company-platform-primary
```

这是本项目对真实开放平台账号的命名空间，不是微信给出的 UnionID，也不是回调域名。不要因为两个应用属于同一公司就直接填写相同标记；它们必须实际绑定到同一个开放平台账号。没有确认时保持空值。不同开放平台账号应使用不同标记；上线后不要随意更改。

没有 UnionID 或关联域时仍能登录，但不会跨渠道自动合并。已有 Google 或其他登录账号的用户，应先登录原账号，再从账号页“关联微信”，避免新建独立账号。身份已属于另一个账号时会拒绝绑定；本项目不会因昵称/头像相同而合并账号，也不自动合并两个已有账户的订单及会员。

## 6. 验证步骤

无需真实凭证的本地自动化验证：

```bash
node --test test/wechat-login.test.ts
```

测试使用临时数据库和假微信 API，覆盖扫码/服务号授权、建用户、重复登录、关联幂等、UnionID 隔离、防 CSRF、一次性 state、防回调重放、换账号期间的旧回调、重新验证与绑定窗口。它证明本地实现通过，不代表真实应用审核或网络联调已经完成。

凭证申请成功后，在正式站点完成这些人工联调：

1. 普通浏览器访问 `/api/auth/bootstrap`：网站应用配置完整时，应看到 `providers.wechat.available=true`、`mode=qr`；响应中不应含 AppSecret 或微信令牌。
2. 从站点点击微信扫码登录，检查授权页显示正确应用名称，确认后回到同一浏览器，账号页显示微信身份。退出后用同一微信再登录，应为同一用户 ID。
3. 在另一个浏览器重放旧回调或刷新已完成回调，应失败且不创建新账号；应从站点重新点击登录，不能复制旧授权链接到新浏览器。
4. 如已配服务号，用手机微信完成 `mode=mp` 授权；如已正确配 UnionID，同一微信在两渠道登录应返回同一用户 ID。
5. 用已有账号“关联微信”再重新登录；验证其他账号无法抢绑这一微信。只有微信一种登录方式时不能解绑最后一种身份。
6. 桌面版使用云端网站登录后完成设备配对，确认会员及账号显示一致。不要在 Electron 内嵌窗口复制云端 OAuth 会话。

## 常见配置问题

| 现象 | 检查 |
| --- | --- |
| 没有微信登录按钮 | 两个登录渠道是否至少有一组 AppID + Secret；是否已重启服务 |
| 微信内只有扫码入口 | 未开通/配置服务号；按提示在电脑或系统浏览器重新打开本站并发起登录 |
| “该链接无法访问”或 `10003` | `BASE_URL` 的实际域名与对应平台回调域是否一致；是否混用网站/服务号 AppID |
| `10005` / `10016` | 能力未获批、没有 scope 权限，或把网站应用 AppID 用在服务号网页授权 |
| 回到网站仍未登录 | 在发起登录的同一浏览器完成；允许本站 Cookie；不要复用旧 code/state；服务端能否访问 `api.weixin.qq.com` |
| 微信内出现快照页 | 从站点明确点击登录后授权；快照模式虚拟账号会被本项目拒绝，不能视为已登录 |
| 绑定显示身份冲突 | 该微信身份/同命名空间 UnionID 已属于另一个账号，需先核对实际归属 |
| 同一微信出现两个用户 ID | 核对是否真正绑定同一开放平台、是否返回 UnionID、两边关联域是否相同；已有分裂账户需人工核对，不能直接改数据库合并 |

服务端认证错误仅记录脱敏错误码和 trace，不要为了排错把授权码、请求密钥 URL、access_token 或完整个人资料写入日志。

网页授权资料撤回、账号注销等消息推送和个人信息处理义务需在正式运营前按实际场景落实；当前模块实现 OAuth 登录和主动解绑，没有实现微信消息推送接收端。[官方用户信息变更说明](https://developers.weixin.qq.com/doc/service/guide/h5/authorization_change.html)
