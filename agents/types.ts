// agents/types.ts — 统一的智能体描述与调用接口

export type Lang = "zh" | "en";

export type Turn = { role: "user" | "assistant"; text: string };

export interface ChatRequest {
  system: string;
  turns: Turn[];              // 该智能体自己的完整对话历史（最后一条是本次要回复的 user 消息）
  lang: Lang;
  cwd: string;                // CLI 类后端的工作目录
  /** Repository phases explicitly opt into file tools; ordinary conversations stay text-only. */
  repositoryAccess?: "read-only" | "write";
  signal: AbortSignal;
  onDelta: (text: string) => void;
  onProgress?: (p: { phase: "reasoning" | "running"; chars?: number }) => void;
}

export interface ChatResult {
  text: string;
  model?: string;
  usage?: { input: number; output: number };
}

export interface Backend {
  chat(req: ChatRequest): Promise<ChatResult>;
}

export type RunnerSpec =
  | { type: "claude-code"; bin: string; model?: string }
  | { type: "qwen-code"; bin: string; model?: string; openai?: { baseUrl: string; apiKey: string } }
  | { type: "gemini-cli"; bin: string; model?: string }
  | { type: "codex"; bin: string; model?: string }
  | { type: "kimi-code"; bin: string; model?: string }
  | { type: "openai"; baseUrl: string; apiKey: string; model: string }
  | { type: "anthropic"; model: string; effort: string }
  | { type: "relay"; mode: "manual" | "clipboard"; app?: string }
  | { type: "generic"; bin: string; args: string[]; promptVia: "stdin" | "arg"; parse: "jsonl" | "text" };

export type AgentStatus = "ready" | "unverified" | "not_logged_in" | "server_off" | "error";

export type Text = string | { zh: string; en: string };

export interface AgentInfo {
  id: string;
  kind: "cli" | "local" | "api" | "relay";
  title: Text;          // Claude Code / Qwen Code / LM Studio …
  subtitle: Text;       // 一句话描述接入方式
  model: Text;          // 当前接入的模型
  local: boolean;       // 本地部署 or 云端
  status: AgentStatus;
  auto: boolean;        // true = 一键全自动；false = 需要你在应用里手动粘贴/复制
  repository?: boolean; // supports the restricted repository file-tool protocol
  statusDetail?: Text;
  hintCommand?: Text;   // 需要用户在终端执行的命令（登录等）
  service?: "lmstudio" | "ollama"; // 可由网页一键启动的本地服务
  runner: RunnerSpec;
  icon: string;
}
