/** Official China-region Chat Completions examples checked on 2026-10-17.
 * These are editable starting points, not a claim that every account has model access.
 * Keep credentials and provider-specific request bodies out of this public catalog.
 */
export type ApiPresetId = "kimi" | "deepseek" | "qwen" | "glm" | "doubao" | "custom";
export interface ApiPreset {
  id: ApiPresetId;
  name: { zh: string; en: string };
  baseUrl: string;
  model: string;
  keyUrl: string;
  docsUrl: string;
  modelHint?: { zh: string; en: string };
}

export const API_PRESETS: readonly ApiPreset[] = [
  {
    id: "kimi", name: { zh: "Kimi（国内）", en: "Kimi (China)" },
    baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6",
    keyUrl: "https://platform.kimi.com/console/api-keys",
    docsUrl: "https://platform.kimi.com/docs/get-api-key",
    modelHint: {
      zh: "示例 kimi-k2.6；可改为平台已开通的模型。使用国内开放平台 API Key，Kimi 会员与 Kimi Code 账号不能直接代替。",
      en: "Example: kimi-k2.6. Use a model enabled for your China API account; a Kimi or Kimi Code subscription is not an API key.",
    },
  },
  {
    id: "deepseek", name: { zh: "DeepSeek", en: "DeepSeek" },
    baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    keyUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/",
    modelHint: {
      zh: "官方示例 deepseek-flash；可改为账号可调用的模型 ID，例如 deepseek-v4-pro。",
      en: "Official example: deepseek-flash. You can use another available model ID, such as deepseek-v4-pro.",
    },
  },
  {
    id: "qwen", name: { zh: "通义千问（中国区）", en: "Qwen (China)" },
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus",
    keyUrl: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
    docsUrl: "https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions",
    modelHint: {
      zh: "示例 qwen-plus。此地址使用华北2（北京）API Key；其他地域或业务空间专属域名请按控制台修改。",
      en: "Example: qwen-plus. This endpoint uses a Beijing API key; edit it for another region or a workspace-specific domain.",
    },
  },
  {
    id: "glm", name: { zh: "智谱 GLM", en: "Zhipu GLM" },
    baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.7",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    docsUrl: "https://docs.bigmodel.cn/cn/guide/start/quick-start",
    modelHint: {
      zh: "示例 glm-4.7；请使用模型标准 API Key。Coding Plan 与其他套餐的专用 Key、地址不能混用。",
      en: "Example: glm-4.7. Use a standard model API key; Coding Plan and other plans have separate keys and endpoints.",
    },
  },
  {
    id: "doubao", name: { zh: "豆包（火山方舟）", en: "Doubao (Volcengine Ark)" },
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "",
    keyUrl: "https://ark.volcengine.com/region:cn-beijing/apikey",
    docsUrl: "https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=zh",
    modelHint: {
      zh: "从方舟控制台复制已开通的 Model ID，或填写自定义推理接入点 ID（ep-…）。普通方舟 API 与 Agent/Coding Plan 的 Key、地址不同。",
      en: "Copy an enabled Model ID from Ark, or enter your endpoint ID (ep-…). Standard Ark API and Agent/Coding Plans use different keys and endpoints.",
    },
  },
  {
    id: "custom", name: { zh: "自定义 OpenAI 兼容 API", en: "Custom OpenAI-compatible API" },
    baseUrl: "", model: "", keyUrl: "", docsUrl: "",
    modelHint: {
      zh: "按服务商文档填写 Base URL 和完整模型 ID；Base URL 不包含 /chat/completions。",
      en: "Enter the provider's Base URL and full model ID. Do not include /chat/completions in the Base URL.",
    },
  },
];
