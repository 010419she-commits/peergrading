# 微信收款与海外 Visa / Mastercard 配置

适用主体：中国大陆企业。实现已接好真实渠道 API，但只有完成开户、审核、凭证和公网回调配置后才能收款。当前没有代为开通账户、配置真实密钥或发起真实扣款。

## 选择的渠道

| 用户付款方式 | 实现 | 需要开通 |
| --- | --- | --- |
| 微信扫码 | 微信支付普通商户 Native API v3，逐订单生成二维码 | 微信支付商户号、Native 权限、商户号绑定的合格 AppID |
| 海外 Visa / Mastercard | Airwallex PaymentIntent + 官方 Hosted Payment Page | Airwallex 企业账户及全球收单审批、相应卡组织与交易币种权限 |
| 人工确认 | 保留原有收款说明、人工核账与权益发放脚本 | 自行核对商户后台实际到账 |

Airwallex 中国官网提供面向中国企业的全球收单方案；能否接受本软件业务、支持哪些卡与币种、费率和结算方式，以其对你的主体和业务审核后的合同为准。开立企业账户不等于已经获批银行卡收单。此实现没有默认中国大陆主体可以开通 Stripe。[Airwallex 中国官网](https://www.airwallex.com/cn)

银行卡号、CVV 和 3DS 认证全部在 Airwallex 托管页面处理，本站后端只创建 PaymentIntent，向已登录的订单所有者返回该次付款的临时 `client_secret`。不会收集或保存卡号。

## 先准备账号与业务资料

1. 为收款准备企业主体、结算账户、实际运营网站、真实商品描述、服务条款、隐私政策、退款与售后说明，按各平台入驻页面提交所需材料。
2. 微信扫码登录需要微信开放平台的「网站应用」。Native 收款另需商户号与合格支付 AppID：当前官方文档列出已认证服务号、政府/媒体公众号、小程序和移动应用；网站登录应用 AppID 不在此清单中。可按业务情况申请服务号或其他合格应用，然后绑定商户号。[微信 Native 开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015614538)
3. 在微信支付商户平台申请普通商户号与 Native 产品权限，确认支付 AppID 与商户号的授权绑定，设置技术负责人和安全联系人。[微信 Native 下单说明](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)
4. 向 Airwallex 申请企业账户和「全球收单 / Online Payments」，明确销售的是软件会员服务、面向海外持卡人、拟接受 Visa / Mastercard。申请通过后确认 CNY 是否属于该商户已获批的交易币种；软件不会代你进行隐式换汇。

## 服务端公共配置

```dotenv
NODE_ENV=production
BASE_URL=https://你的正式域名
SESSION_SECRET=在服务端生成的至少32字符随机密钥
MERCHANT_ID=peergrading-main
FREE_BETA=0
CURRENCY=CNY
```

也可以在管理后台关闭免费内测；数据库中的内测设置优先于 `FREE_BETA`。内测免费状态下保留会员方案展示，禁止创建收费订单。生产环境关闭 `DEV_LOGIN`。

`MERCHANT_ID` 是本站的商店命名空间，不是微信商户号或 Airwallex Account ID。上线后保持稳定，变更前先核对未结订单。订单金额和币种均从服务端方案快照读取，客户端无法指定价格。

当前同一方案、同一订单使用一个币种。默认人民币微信与银行卡都按原订单 CNY 请求；必须确保 Airwallex 已为该主体开通 CNY 收单。若只能获批 USD，请先向渠道确认合适的币种与结算方案，再调整产品定价；将全站 `CURRENCY=USD` 会使微信付款因非人民币而被拒绝。本版本没有独立的美元价目表或自动汇率换算。

## 微信支付 Native

从商户平台 API 安全设置获取商户 API 证书序列号、商户私钥、32 字节 API v3 密钥、微信支付公钥及其公钥 ID。商户证书序列号和微信支付公钥 ID 是不同字段，不能互换。请使用微信支付官方提供的公钥资料，不接受浏览器请求上传公钥。

```dotenv
WECHAT_PAY_MCH_ID=你的普通商户号
WECHAT_PAY_APP_ID=已与上述商户号绑定的支付AppID
WECHAT_PAY_CERT_SERIAL=商户API证书序列号
WECHAT_PAY_PRIVATE_KEY_PATH=/etc/peergrading/secrets/apiclient_key.pem
WECHAT_PAY_API_V3_KEY=32字节的APIv3密钥
WECHAT_PAY_PLATFORM_KEY_ID=PUB_KEY_ID_你的微信支付公钥ID
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH=/etc/peergrading/secrets/wechatpay_public.pem
```

私钥路径允许绝对路径；相对路径按项目根目录解析。私钥和公钥要求 RSA，至少 2048 位。私钥文件仅供运行服务的系统账户读取。不要把私钥、API 密钥、真实 `.env` 放进 Git、桌面安装包或前端。

本软件以 `BASE_URL` 自动生成逐订单 `notify_url`：

```text
https://你的正式域名/api/billing/webhooks/wechat
```

该地址必须公网 HTTPS 可达，反向代理保留原始请求体和 `Wechatpay-*` 头，不得要求网页登录或对通知做 JS 挑战。代码会在 JSON 解析前验证 RSA 签名、5 分钟时间窗和配置的微信支付公钥 ID，再用 AES-256-GCM 解密通知，校验商户号、AppID、订单、金额和人民币币种，仅处理 `TRANSACTION.SUCCESS` 且交易状态 `SUCCESS`。微信渠道 API 响应同样执行验签。[微信支付成功回调说明](https://pay.wechatpay.cn/doc/v3/merchant/4012791861)

应用使用「微信支付公钥」模式；目前只配置一组公钥 ID 和文件，不自动轮换平台证书。微信更新公钥时，按商户平台的迁移指引同步更新 ID 和文件并重启服务。遇到未知 ID 或失效签名会拒绝发放权益。

微信二维码由后端本地生成 PNG 数据，付款内容来自验签后的 `code_url`，不把二维码发给第三方图片服务。当前收款流程针对电脑网站与桌面账号页展示二维码，手机微信扫码；没有实现同一手机的 H5 / JSAPI 调起支付。

## Airwallex 海外银行卡

先使用 Sandbox 环境。按 [Airwallex Sandbox 官方说明](https://www.airwallex.com/docs/developer-tools/sandbox-environment)，在相应环境创建 Client ID / API Key。付款创建、查询、取消权限需满足此集成使用的 PaymentIntent API。

```dotenv
AIRWALLEX_ENV=sandbox
AIRWALLEX_CLIENT_ID=Sandbox的ClientID
AIRWALLEX_API_KEY=Sandbox的APIKey
AIRWALLEX_ACCOUNT_ID=该收单账户的AccountID
AIRWALLEX_WEBHOOK_SECRET=该通知订阅的签名密钥
AIRWALLEX_COUNTRY_CODE=CN
```

`AIRWALLEX_COUNTRY_CODE` 是默认买家国家的两位大写 ISO 代码，用于 Hosted Payment Page 的展示；按目标买家市场修改，例如 `US`。该参数不改变你的中国大陆公司主体或账户资质。SDK 的 `demo` 环境对应服务端 `sandbox`；生产使用 `AIRWALLEX_ENV=production` 与 SDK `prod`，不可混用两套凭证。

服务端 Sandbox API 固定为 `https://api.sandbox.airwallex.com`，生产固定为 `https://api.airwallex.com`。服务器先取得 Access Token，再创建 PaymentIntent；请求的 `request_id` 在首次外部调用前持久化，因此超时重试沿用同一 UUID。[PaymentIntent 官方说明](https://www.airwallex.com/docs/payments/get-started/using-payments-intent-api)

在 Airwallex 后台创建 Webhook 订阅：

```text
https://你的正式域名/api/billing/webhooks/airwallex
事件：payment_intent.succeeded
账户：与 AIRWALLEX_ACCOUNT_ID 相同的收单账户
签名密钥：填写到 AIRWALLEX_WEBHOOK_SECRET
```

应用验证 `x-timestamp`（毫秒）与原始请求体拼接后的 HMAC-SHA256，限制 5 分钟时间窗，并校验事件 `accountId`、PaymentIntent ID、商户订单号和本站商店 metadata 绑定；只接受 `SUCCEEDED` 且实捕获金额与订单金额完整相等的付款。授权成功、等待 3DS、`REQUIRES_CAPTURE`、部分捕获和失败事件都不会发会员。回跳 `/account?order=...` 只触发服务端查询，无法直接设置付款成功。[Webhook 官方说明](https://www.airwallex.com/docs/developer-tools/webhooks/listen-for-webhook-events)

## 本地验收与上线前验证

无需真实凭证即可运行隔离测试：

```sh
node --test test/payments.test.ts test/billing.test.ts
```

测试使用临时数据库、临时 RSA 密钥和模拟 HTTP 渠道，不发真实交易，覆盖伪造通知、原文被修改、过期签名、错误公钥 ID、错误商户与 AppID、错误金额与币种、重复通知、并发创建、超时幂等重试、查询补单以及过期订单先渠道关单。

渠道获批并配置 Sandbox 后，在实际可访问的测试网站完成成功、失败、取消、3DS、刷新页面、重复通知及回跳中断的验收；银行卡测试号码以该平台 Sandbox 文档为准。微信 Native 需按商户平台提供的正式联调流程验证，现有本地模拟不能替代获批商户的实测。

将 Airwallex 改为生产凭证后，支付与退款的真实验收需要商户本人决定并执行。启用付费前，也要完成实际网站政策页面和桌面安装包的正式发布准备。

## 状态与排错

| 现象 / 代码 | 处理 |
| --- | --- |
| 按钮未出现 / `payment_not_configured` | 在服务端配置该渠道全部字段并重启；没有凭证时不会假装已接通 |
| `beta_free` | 在管理后台结束免费内测，确认是否确实要开启收费 |
| `payment_https_required` | `BASE_URL` 需为公网 HTTPS 正式或测试域名 |
| `payment_key_invalid` / `payment_config_invalid` | 检查变量、文件访问权限、RSA PEM、API v3 密钥长度和环境名称 |
| `payment_bad_response_signature` / 回调 401 | 检查微信公钥 ID、对应公钥、代理是否改写原始请求体和服务器校时 |
| `payment_provider_auth` | 检查 Airwallex Sandbox / Production 凭证是否混用、密钥权限和账户审核状态 |
| `payment_provider_error` | 在渠道后台按本站订单号核对下单记录与权限；先查询到账，不要让用户盲目重复支付 |
| `checkout_provider_locked` | 该订单已选择一个渠道，继续在该渠道支付；防止同一订单重复付款 |
| `checkout_expired` | 重新点购买。服务端会先查询旧渠道，必要时确认关单后创建新订单；旧单实际已付则恢复付款结果 |
| `payment_checkout_incomplete` | 创建请求可能超时且尚未恢复渠道 ID。先重试相同渠道或在商户后台按订单号核对，不手动删除绑定 |
| 已扣款、会员未更新 | 在账号页点刷新到账状态；服务端向渠道查询补单，或在渠道后台重发通知。仍异常时按订单号核账 |

所有成功事件通过数据库事务原子完成「支付事件去重、订单置为 paid、权益发放」，同一订单重复成功只发一次权益。回调失败不应由代理改成 200；渠道重试才有机会完成补单。早鸟方案保留原有限额与预留规则，极晚到账且名额已耗尽的异常需要商户核账、退款或人工发放，不能仅凭付款截图确认。

人工确认流程和旧的通用 `/api/payments/webhook` 保留；通用回调默认未配置密钥时拒绝处理。它使用本站独立 HMAC 密钥，不是微信/Airwallex 的官方通知接口。真实渠道只应连接上文两个专用 URL。

本版本没有自动退款、拒付处理、税务开票或自动撤销退款后会员；退款、拒付和争议在渠道后台处理后，应按实际业务人工调整权益并留存核账记录。
