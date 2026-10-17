# 国内云 API 接入

PeerGrading 本地桌面不要求 PeerGrading 登录或会员。用户可以直接配置自己拥有的第三方 API；供应商可能要求独立账号、实名、额度或付费，这些均属于供应商服务。

在桌面应用左侧点击「接入云端 API」，选择供应商，填写自己的 API Key，核对 Base URL 和模型 ID 后保存。在下方卡片中选作 A，再点击 B 的智能体卡片选择另一模型；双方也可以使用同一个 API。预设均可编辑，模型是否可用以供应商控制台中已开通的服务为准。Base URL 不要带 `/chat/completions`，程序会补上该路径。

| 供应商 | Base URL | 可编辑模型示例 | 创建 API Key |
| --- | --- | --- | --- |
| Kimi 国内 | `https://api.moonshot.cn/v1` | 以控制台可用模型为准 | [Kimi API Keys](https://platform.kimi.com/console/api-keys) |
| DeepSeek | `https://api.deepseek.com` | 以控制台可用模型为准 | [DeepSeek API Keys](https://platform.deepseek.com/api_keys) |
| 通义千问中国区 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 以控制台可用模型为准 | [百炼北京 API Key](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | 以控制台可用模型为准 | [智谱 API Keys](https://bigmodel.cn/usercenter/proj-mgmt/apikeys) |
| 豆包火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 从控制台复制已开通的 Model ID，或自己的 `ep-…` 接入点 ID | [方舟 API Key](https://ark.volcengine.com/region:cn-beijing/apikey) |

Kimi 的旧文档站目前跳转至 `platform.kimi.com`，国内调用地址仍为 `api.moonshot.cn`。百炼此预设对应华北2（北京），其他地域的 API Key 和地址不能混用；官方也支持将地址改为业务空间专属域名。智谱请选择“模型标准 API”的 Key；Kimi Code、GLM Coding Plan、方舟 Agent/Coding Plan 的订阅或专用 Key 不能直接当作这里的标准 API 凭证使用。

这些连接用于文字协作、代码内容生成与审查。要让 Agent 直接读取、编辑本机 Git 仓库并交替提交任务快照，仍需选择支持仓库协作的 Codex、Claude Code 或 Kimi Code CLI；通用云 API 模型本身没有本机文件工具。

当前兼容调用使用 `model`、`messages`、`stream`，不强加采样参数。不同供应商和模型的思考开关、温度及推理历史约束并不相同，基础接入采用供应商默认值。对于要求保留推理历史的模型，程序会在同一 Agent 的内存对话中保留并回传供应商要求的字段，界面只展示适合公开的最终回复和进度；推理文本不写入另一位审查者的输入。更换型号后仍需以真实账号权限和供应商响应为准。

配置保存在本机数据目录的 `api-models.json`，不会把已保存的 Key 回传到界面。编辑同一服务商和地址时，Key 留空表示保留；更换地址或服务商时必须重新填写。删除连接即可移除对应配置。保存只检查字段及公网 HTTPS 地址，不会为验证而付费生成内容；密钥、余额和模型权限在开始协作请求时由供应商验证。

只在本机应用的密钥输入框填写 Key，不把它写进代码、聊天、日志或截图，也不要放入公网站点的 `.env`。选择云 API 后，发送给供应商的内容及其保留规则由该供应商决定；PeerGrading 公网下载站点不接收这些密钥。

通用 Chat API 没有可移植的跨请求 token/KV 共享计算能力。即使两个请求有相同前缀，也不能承诺供应商只计算一次；应用层的完整快照和精确缓存不等于模型内部缓存。详见 [加速算法与 API 边界](acceleration.md)。

官方资料入口（具体模型、参数和费用以使用时页面为准）：

- Kimi：[快速开始](https://platform.kimi.com/docs/get-api-key)、[模型参数约束](https://platform.kimi.com/docs/api/models-overview)。
- DeepSeek：[首次调用](https://api-docs.deepseek.com/zh-cn/)、[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)。
- 通义千问：[OpenAI 兼容 Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[获取 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)。
- 智谱：[快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start)。
- 火山方舟：[OpenAI 兼容](https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh)、[鉴权与 Base URL](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh)、[接入点调用示例](https://docs.volcengine.com/docs/ark/intelligent-model-routing?lang=zh)。
