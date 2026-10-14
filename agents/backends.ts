// agents/backends.ts — 把不同来源的模型统一成 Backend.chat()
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import type { Backend, ChatRequest, ChatResult, RunnerSpec, Turn, Lang } from "./types.ts";
import { RelayBackend, type RelayContext } from "./relay.ts";
import { getProxyEnv } from "./proxy.ts";
import { needsShell } from "./detect.ts";

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) continue;
    env[k] = v;
  }
  // 境外服务（Anthropic / OpenAI）在国内直连会被拒，给命令行 agent 带上系统代理
  for (const [k, v] of Object.entries(getProxyEnv())) if (!env[k]) env[k] = v;
  return env;
}

/** CLI 类后端是无状态的：把该智能体之前的往来记录渲染进本次输入 */
function renderTranscript(turns: Turn[], lang: Lang): string {
  const L = lang === "zh"
    ? { open: "【以下是你之前在本次协作中收到的消息与你的回复，按时间顺序】", recv: "收到的消息", mine: "你的回复", close: "【记录结束】", now: "【现在收到的新消息】", instr: "请直接回复上面这条新消息。" }
    : { open: "[Below is the history of messages you received and your replies in this collaboration, in order]", recv: "Message received", mine: "Your reply", close: "[End of history]", now: "[New message]", instr: "Reply directly to the new message above." };
  const prior = turns.slice(0, -1);
  const latest = turns[turns.length - 1];
  const parts: string[] = [];
  if (prior.length) {
    parts.push(L.open);
    let n = 0;
    for (const t of prior) {
      if (t.role === "user") { n++; parts.push(`\n### ${L.recv} ${n}\n${t.text}`); }
      else parts.push(`\n### ${L.mine} ${n}\n${t.text}`);
    }
    parts.push(`\n${L.close}\n`);
  }
  parts.push(`${L.now}\n${latest.text}\n\n${L.instr}`);
  return parts.join("\n");
}

type ParsedLine = { delta?: string; assistantText?: string; model?: string; result?: string; isError?: boolean; error?: string; usage?: { input: number; output: number } };

/** 兼容 Claude Code / Qwen Code / Gemini CLI / Codex 的 JSONL 输出 */
function parseLine(line: string): ParsedLine | null {
  if (!line.startsWith("{")) return null;
  let d: any; try { d = JSON.parse(line); } catch { return null; }
  const out: ParsedLine = {};
  switch (d.type) {
    case "stream_event": {
      const e = d.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") out.delta = e.delta.text;
      if (e?.type === "message_start" && e.message?.model) out.model = e.message.model;
      return out;
    }
    case "assistant": {
      if (d.message?.model && d.message.model !== "<synthetic>") out.model = d.message.model;
      const t = (d.message?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
      if (t) out.assistantText = t;
      return out;
    }
    case "result": {
      if (typeof d.result === "string") out.result = d.result;
      if (d.is_error) { out.isError = true; out.error = d.error?.message ?? d.result ?? "error"; }
      return out;
    }
    // Gemini CLI 风格
    case "message": if (d.role === "assistant" && typeof d.content === "string") out.assistantText = d.content; return out;
    // Codex CLI 风格
    case "item.completed":
      if (d.item?.type === "agent_message" && d.item.text) out.assistantText = d.item.text;
      else if (d.item?.type === "error" && !/deprecated/i.test(d.item.message ?? "")) { out.isError = true; out.error = d.item.message; }
      return out;
    case "turn.completed": if (d.usage) out.usage = { input: d.usage.input_tokens ?? 0, output: d.usage.output_tokens ?? 0 }; return out;
    case "item.delta": case "agent_message_delta": if (typeof d.delta === "string") out.delta = d.delta; return out;
    case "error": out.isError = true; out.error = d.message ?? JSON.stringify(d); return out;
    default: return out;
  }
}

function buildCliArgs(spec: RunnerSpec, system: string, prompt: string): { args: string[]; useStdin: boolean; prefixSystem: boolean; textMode: boolean } {
  switch (spec.type) {
    case "generic":
      return { useStdin: spec.promptVia === "stdin", prefixSystem: true, textMode: spec.parse === "text",
        args: spec.promptVia === "arg" ? [...spec.args, prompt] : spec.args };
    case "claude-code":
      return { useStdin: true, prefixSystem: false, textMode: false, args: ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--tools", "", "--max-turns", "1", "--no-session-persistence", "--system-prompt", system, ...(spec.model ? ["--model", spec.model] : [])] };
    case "qwen-code":
      return { useStdin: true, prefixSystem: false, textMode: false, args: ["--safe-mode", "--approval-mode", "plan", "--output-format", "stream-json",
        "--include-partial-messages", "--max-session-turns", "1", "--system-prompt", system,
        ...(spec.model ? ["-m", spec.model] : []),
        ...(spec.openai ? ["--auth-type", "openai", "--openai-base-url", spec.openai.baseUrl, "--openai-api-key", spec.openai.apiKey] : []),
        "-p", "(see above)"] };
    case "gemini-cli":
      return { useStdin: true, prefixSystem: true, textMode: false, args: ["--output-format", "stream-json", "--approval-mode", "plan",
        ...(spec.model ? ["-m", spec.model] : []), "-p", "(see above)"] };
    case "codex":
      // --ephemeral 不落盘会话；notify=[] 关掉用户配置里的回合结束钩子；只读沙箱
      return { useStdin: true, prefixSystem: true, textMode: false, args: ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
        "-c", "notify=[]", ...(spec.model ? ["-m", spec.model] : []), "-"] };
    default: throw new Error("not a CLI runner");
  }
}

class CliBackend implements Backend {
  spec: RunnerSpec;
  constructor(spec: RunnerSpec) { this.spec = spec; }

  chat(req: ChatRequest): Promise<ChatResult> {
    let input = renderTranscript(req.turns, req.lang);
    const prefixed = `[System instructions]\n${req.system}\n\n${input}`;
    const bin = (this.spec as any).bin as string;
    const viaShell = needsShell(bin);
    // Windows .cmd 包装脚本：经 shell 启动时无法安全传递含换行/引号的长参数，系统提示词改从 stdin 前置
    let { args, useStdin, prefixSystem, textMode } = buildCliArgs(this.spec, viaShell ? "" : req.system, prefixed);
    if (viaShell) {
      const i = args.indexOf("--system-prompt"); if (i >= 0) args.splice(i, 2);
      prefixSystem = true;
    }
    if (prefixSystem) input = prefixed;

    return new Promise((resolve, reject) => {
      const child = viaShell
        ? spawn(`"${bin}"`, args.map((a) => (/[\s"]/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)), { env: cleanEnv(), cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"], shell: true })
        : spawn(bin, args, { env: cleanEnv(), cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "", streamed = "", assistantText = "", result: string | undefined, model: string | undefined, stderr = "";
      let usage: { input: number; output: number } | undefined;
      let error: string | undefined;

      const onAbort = () => child.kill("SIGTERM");
      req.signal.addEventListener("abort", onAbort, { once: true });

      let raw = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        if (textMode) { raw += chunk; return; }
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          const p = parseLine(line); if (!p) continue;
          if (p.delta) { streamed += p.delta; req.onDelta(p.delta); }
          if (p.assistantText) assistantText = p.assistantText;
          if (p.model) model = p.model;
          if (p.result !== undefined) result = p.result;
          if (p.isError) error = p.error;
          if (p.usage) usage = p.usage;
        }
      });
      child.stderr.on("data", (d) => { stderr += d; req.onProgress?.({ phase: "running" }); });
      child.on("error", (e) => { req.signal.removeEventListener("abort", onAbort); reject(e); });
      child.on("close", (code) => {
        req.signal.removeEventListener("abort", onAbort);
        if (req.signal.aborted) return reject(new Error("aborted"));
        const text = textMode
          ? raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").trim()   // 去掉 ANSI 颜色码
          : (result && result.trim()) || assistantText || streamed;
        if (error && !text) return reject(new Error(`${this.spec.type}: ${error}`));
        if (/^Not logged in/i.test(text)) return reject(new Error(`${this.spec.type}: 命令行尚未登录，请在终端运行并登录后重试`));
        if (!text) return reject(new Error(`${this.spec.type} 没有返回内容（exit ${code}）${stderr ? "：" + stderr.slice(-400) : ""}`));
        // 若没有逐字流式输出（例如 CLI 不支持 partial），把完整文本一次性推给前端
        if (!streamed) req.onDelta(text);
        resolve({ text, model, usage });
      });
      if (useStdin) child.stdin.end(input); else child.stdin.end();
    });
  }
}

class OpenAICompatBackend implements Backend {
  spec: Extract<RunnerSpec, { type: "openai" }>;
  constructor(spec: Extract<RunnerSpec, { type: "openai" }>) { this.spec = spec; }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const res = await fetch(`${this.spec.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.spec.apiKey}` },
      body: JSON.stringify({
        model: this.spec.model,
        stream: true,
        messages: [{ role: "system", content: req.system }, ...req.turns.map((t) => ({ role: t.role, content: t.text }))],
      }),
      signal: req.signal,
    });
    if (!res.ok || !res.body) {
      let msg = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); msg = j.error?.message ?? JSON.stringify(j); } catch {}
      throw new Error(`本地模型服务返回错误：${msg}`);
    }
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = "", text = "", model: string | undefined, reasoningChars = 0, lastProgress = 0;
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const d = JSON.parse(payload);
          if (d.model) model = d.model;
          const delta = d.choices?.[0]?.delta?.content;
          if (delta) { text += delta; req.onDelta(delta); }
          const rc = d.choices?.[0]?.delta?.reasoning_content;
          if (rc) { reasoningChars += rc.length; if (Date.now() - lastProgress > 1000) { lastProgress = Date.now(); req.onProgress?.({ phase: "reasoning", chars: reasoningChars }); } }
          if (d.error) throw new Error(d.error.message ?? JSON.stringify(d.error));
        } catch (e: any) { if (e?.message && !/JSON/.test(e.message)) throw e; }
      }
    }
    if (!text) throw new Error("本地模型没有返回内容");
    return { text, model };
  }
}

const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

class AnthropicBackend implements Backend {
  spec: Extract<RunnerSpec, { type: "anthropic" }>;
  client = new Anthropic();
  useFallback: boolean;
  constructor(spec: Extract<RunnerSpec, { type: "anthropic" }>) {
    this.spec = spec;
    this.useFallback = FALLBACK_MODELS.has(spec.model) && !process.env.DISABLE_FALLBACKS;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const base = {
      model: this.spec.model,
      max_tokens: 32000,
      system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }],
      messages: req.turns.map((t) => ({ role: t.role, content: t.text })),
      output_config: { effort: this.spec.effort },
    };
    const run = async (withFallback: boolean) => {
      const params: any = withFallback ? { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : base;
      const stream = this.client.beta.messages.stream(params, { signal: req.signal });
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") req.onDelta(ev.delta.text);
      }
      return stream.finalMessage();
    };
    let final: Anthropic.Beta.BetaMessage;
    try {
      final = await run(this.useFallback);
    } catch (err) {
      if (this.useFallback && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        this.useFallback = false;
        final = await run(false);
      } else throw err;
    }
    if (final.stop_reason === "refusal") {
      throw new Error(`模型拒绝了该请求（${final.stop_details?.category ?? "refusal"}）：${final.stop_details?.explanation ?? ""}`);
    }
    const text = final.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
    return { text, model: final.model, usage: { input: final.usage.input_tokens, output: final.usage.output_tokens } };
  }
}

export function createBackend(spec: RunnerSpec, ctx: RelayContext): Backend {
  switch (spec.type) {
    case "openai": return new OpenAICompatBackend(spec);
    case "anthropic": return new AnthropicBackend(spec);
    case "relay": return new RelayBackend(spec.mode, ctx, spec.app);
    default: return new CliBackend(spec);
  }
}
