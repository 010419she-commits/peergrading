# 邮箱验证码登录配置

PeerGrading 使用 6 位邮箱验证码，用户不需要设置密码。软件内输入邮箱 → 接收验证码 → 在原窗口验证并进入工作台；Google / GitHub 仍使用系统浏览器授权。微信登录已停用；微信支付与登录无关，继续单独配置。

目前没有邮件账号或服务也能部署：保持 `EMAIL_PROVIDER` 留空，邮箱区域会明确显示“尚未开放”，发送按钮不可用。代码不会把未发送的验证码当作成功，也不会向用户显示测试验证码。可继续使用已配置的其他登录方式。

## 选择发送服务

配置只放在**生产服务器** `/srv/peergrading/.env`，桌面安装包不需要邮件凭证。不要在聊天或 GitHub 中提交密钥。

### 方案 A：SMTP

申请能发送事务邮件的邮箱 / 邮件服务，在服务商控制台开启 SMTP，取得主机名、端口、账号与专用 SMTP 密码。以服务商给出的参数为准，不要把 PeerGrading 用户的邮箱密码当成发送凭证。

```dotenv
EMAIL_PROVIDER=smtp
EMAIL_FROM="PeerGrading <login@auth.peergrading.ai>"
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-smtp-username
SMTP_PASS=your-smtp-app-password
```

465 通常用 `SMTP_SECURE=true`；服务商要求 587 时改为 `SMTP_PORT=587` 和 `SMTP_SECURE=false`，通过 STARTTLS 加密。程序要求加密与有效证书，不要关闭证书校验。`EMAIL_FROM` 必须是服务商批准的地址，按其要求完成 SPF / DKIM / DMARC 设置。端口与 TLS 规则可核对 [Nodemailer SMTP 官方文档](https://nodemailer.com/smtp)。

### 方案 B：Resend

注册 Resend，在控制台添加自己控制的发件域名或子域名，例如 `auth.peergrading.ai`，按照其页面向 DNS 服务商添加验证记录并等待验证成功，然后创建只具备发送所需权限的 API key。Resend 的发送要求 API key 与已验证的域名，详见 [官方发送指南](https://resend.com/docs/send-with-nodejs) 和 [域名验证](https://resend.com/docs/dashboard/domains/introduction)。

```dotenv
EMAIL_PROVIDER=resend
EMAIL_FROM="PeerGrading <login@auth.peergrading.ai>"
RESEND_API_KEY=your-resend-api-key
```

`EMAIL_FROM` 需使用已验证域名。真实 key 不要写进本文示例。使用 Resend 时无需配置 SMTP 参数。

## 上线与验收

1. 在服务器写入所选方案的配置，保留现有 `SESSION_SECRET`、Google / GitHub 和支付配置，并确保 `.env` 只允许管理员读取。
2. 在 `/srv/peergrading` 执行 `docker compose up -d --build` 重建服务，让新环境变量生效。登录能力可能在客户端缓存约 60 秒，稍后重新打开软件账号页或刷新页面。
3. 用自己的真实邮箱发起一次验证码请求。只有邮件服务确认接受发送后，界面才进入验证码步骤；这仍不能替代实际收到邮件的验收。
4. 收到后在 10 分钟内验证，确认软件进入工作台，账号与会员页可刷新；退出后再登录应回到同一账号。确认错误验证码失败、成功验证码不能重复使用、重发会替换本次验证码。
5. 已有 Google / GitHub 账号请先登录原账号，在账号管理页完成近期身份验证后**关联邮箱**。不要直接用同名邮箱创建账号后假定会合并，系统不会按邮箱文本自动合并第三方身份。

## 验证与账号安全

- 验证码 10 分钟有效；发送有至少 60 秒间隔及服务端限流，连续输错会失效。重发、过期或失效后使用新验证码。
- 网页验证码与发起的浏览器事务绑定；桌面验证码与对应设备请求绑定，一次成功后消费，不能拿到另一台设备兑换。
- 关联 / 解绑需要近期验证，且至少保留一种登录方式；登录、切换账号与验证事务分别处理。邮箱已属于其他账号时会拒绝关联，不会合并会员或身份。
- 验证码只通过邮件发送，应用数据库保存不可逆校验信息，日志与 API 响应不返回验证码。不要开启邮件正文调试日志。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 邮箱登录尚未开放 | 检查 `EMAIL_PROVIDER` 与对应发送参数是否完整，重建服务后刷新账号页；未配置时不能发送 |
| 邮件暂未发出 | 检查服务商凭证、发件地址授权、网络及发送额度；修复后重试，不要把失败误当已发出 |
| 显示已发送但没收到 | 查看垃圾邮件与服务商投递记录，确认发件域名验证 / DNS；平台接受不保证进入收件箱 |
| 验证码不正确 / 已过期 | 确认使用最新邮件，重发后旧验证码失效，10 分钟内输入 |
| 操作过于频繁 | 等待倒计时或服务端限流窗口结束，不要连续重发 |
| 关联邮箱提示冲突 | 此邮箱已关联其他 PeerGrading 账号，需要用相应身份登录，不会自动合并 |

隔离自动化测试可在 `NODE_ENV=test` 下显式设置 `EMAIL_TEST_OUTBOX_DIR` 写入临时测试邮件，生产环境忽略此变量。测试目录必须放在仓库、静态文件及安装包之外；该模拟只验证流程，不代表真实邮件已送达。
