// agents/backends.ts — 把不同来源的模型统一成 Backend.chat()
import Anthropic from "@anthropic-ai/sdk";
import { prepareKimiLaunch, type KimiLaunchFiles } from "./kimi.ts";
import type { Backend, ChatRequest, ChatResult, RunnerSpec, Turn, Lang } from "./types.ts";
import { RelayBackend, type RelayContext } from "./relay.ts";
import { getProxyEnv } from "./proxy.ts";
import { WIN, launcherFor, spawnCli, killTree, stripNestedClaudeEnv } from "./launch.ts";
import { abortError, assertActive, spawnRepositoryProcess, stopRepositoryProcess, repositoryEnv } from "../repository/process.ts";
import { readOpenAIResponseCache, writeOpenAIResponseCache } from "../acceleration.ts";

function cleanEnv(): NodeJS.ProcessEnv {
  const env = stripNestedClaudeEnv();
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
  // Current Kimi Code JSONL uses role/content records, with tool progress kept separate.
  if (d.role === "assistant" && typeof d.content === "string") return { assistantText: d.content };
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

export function buildCliArgs(spec: RunnerSpec, system: string, prompt: string, repositoryAccess?: ChatRequest["repositoryAccess"], kimi?: KimiLaunchFiles): { args: string[]; useStdin: boolean; prefixSystem: boolean; textMode: boolean } {
  if (spec.type === "kimi-code") {
    if (!kimi) throw new Error("Kimi Code 需要独立的受限工具配置，不能使用默认工具启动");
    return { useStdin: false, prefixSystem: false, textMode: false, args: [
      "--agent-file", kimi.agentFile, "--skills-dir", kimi.skillsDir,
      "--output-format", "stream-json", ...(kimi.repositoryDir ? ["--add-dir", kimi.repositoryDir] : []),
      ...(spec.model ? ["--model", spec.model] : []),
      "--prompt", "Complete the task in your agent instructions. Reply to the latest message. Do not resume or create other tasks.",
    ] };
  }
  if (repositoryAccess) {
    if (spec.type === "claude-code") {
      return { useStdin: true, prefixSystem: false, textMode: false, args: [
        "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--no-session-persistence",
        "--restricted", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--permission-mode", repositoryAccess === "write" ? "acceptEdits" : "plan",
        "--tools", repositoryAccess === "write" ? "Read,Glob,Grep,Edit,Write" : "Read,Glob,Grep",
        "--max-turns", "40", "--system-prompt", system, ...(spec.model ? ["--model", spec.model] : []),
      ] };
    }
    if (spec.type === "codex") return { useStdin: true, prefixSystem: true, textMode: false, args: [
      "exec", "--json", "--ephemeral", "-s", repositoryAccess === "write" ? "workspace-write" : "read-only",
      "-c", 'approval_policy="never"', "-c", "notify=[]", "-c", "sandbox_workspace_write.network_access=false",
      "-c", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "-c", "sandbox_workspace_write.exclude_slash_tmp=true",
      ...(spec.model ? ["-m", spec.model] : []), "-",
    ] };
    throw new Error("仓库协作只支持 Claude Code、Codex 或 Kimi Code 命令行，所选后端无法安全执行文件操作");
  }
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

  async chat(req: ChatRequest): Promise<ChatResult> {
    assertActive(req.signal);
    let input = renderTranscript(req.turns, req.lang);
    const prefixed = `[System instructions]\n${req.system}\n\n${input}`;
    const bin = (this.spec as any).bin as string;
    // 只有退回 cmd.exe 启动的 .cmd 包装脚本才无法安全传递含换行/引号的长参数：那时系统提示词改从 stdin 前置
    const viaShell = launcherFor(bin).shell;
    const kimi = this.spec.type === "kimi-code" ? await prepareKimiLaunch(req, process.env, this.spec.model) : undefined;
    try {
    assertActive(req.signal);
    let { args, useStdin, prefixSystem, textMode } = buildCliArgs(this.spec, viaShell ? "" : req.system, prefixed, req.repositoryAccess, kimi);
    if (viaShell) {
      const i = args.indexOf("--system-prompt"); if (i >= 0) args.splice(i, 2);
      prefixSystem = true;
    }
    if (prefixSystem) input = prefixed;

    // 把整段提示词当命令行参数传的工具，在 Windows 上受限：cmd.exe 传不了含换行的参数；CreateProcess 的命令行上限 32767 字符
    const promptInArgs = this.spec.type === "generic" && this.spec.promptVia === "arg";
    if (promptInArgs && viaShell) return Promise.reject(new Error(`${this.spec.type}: 这个工具在 Windows 上通过 .cmd 脚本启动，无法把提示词作为参数传入；请改用它的 .exe 安装方式`));
    if (promptInArgs && WIN && [bin, ...args].reduce((n, a) => n + a.length + 3, 0) > 32_000) return Promise.reject(new Error(`${this.spec.type}: 对话记录太长，超出了 Windows 命令行参数的长度上限，请新开一轮协作`));

    return await new Promise<ChatResult>((resolve, reject) => {
      const cwd = kimi?.cwd ?? req.cwd;
      const env = kimi?.env ?? cleanEnv();
      const child = req.repositoryAccess
        ? spawnRepositoryProcess(bin, args, cwd, repositoryEnv(env))
        : spawnCli(bin, args, { env, cwd });
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      let buf = "", streamed = "", assistantText = "", result: string | undefined, model: string | undefined, stderr = "";
      let usage: { input: number; output: number } | undefined;
      let error: string | undefined;

      let escalation: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (req.repositoryAccess) {
          stopRepositoryProcess(child);
          escalation ??= setTimeout(() => stopRepositoryProcess(child, "SIGKILL"), 1000);
          escalation.unref();
        } else killTree(child, "SIGTERM");
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
      if (req.signal.aborted) onAbort();

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
      child.on("error", (e) => { req.signal.removeEventListener("abort", onAbort); if (escalation) clearTimeout(escalation); reject(e); });
      child.on("close", (code) => {
        req.signal.removeEventListener("abort", onAbort);
        if (escalation) { stopRepositoryProcess(child, "SIGKILL"); clearTimeout(escalation); }
        if (req.repositoryAccess && !WIN) stopRepositoryProcess(child, "SIGKILL");
        if (req.signal.aborted) return reject(new Error("aborted"));
        // Some CLIs emit a final JSON object without a trailing newline.
        if (!textMode && buf.trim()) {
          const p = parseLine(buf.trim());
          if (p?.result !== undefined) result = p.result;
          if (p?.assistantText) assistantText = p.assistantText;
          if (p?.isError) error = p.error;
          if (p?.model) model = p.model;
          if (p?.usage) usage = p.usage;
        }
        const text = textMode
          ? raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").trim()   // 去掉 ANSI 颜色码
          : (result && result.trim()) || assistantText || streamed;
        if (code !== 0) return reject(new Error(`${this.spec.type} 运行失败（exit ${code}）${error || stderr ? "：" + (error || stderr).slice(-1000) : ""}`));
        if (error) return reject(new Error(`${this.spec.type}: ${error}`));
        if (/^Not logged in/i.test(text)) return reject(new Error(`${this.spec.type}: 命令行尚未登录，请在终端运行并登录后重试`));
        if (!text) return reject(new Error(`${this.spec.type} 没有返回内容（exit ${code}）${stderr ? "：" + stderr.slice(-400) : ""}`));
        // 若没有逐字流式输出（例如 CLI 不支持 partial），把完整文本一次性推给前端
        if (!streamed) req.onDelta(text);
        resolve({ text, model, usage });
      });
      if (useStdin) child.stdin.end(input); else child.stdin.end();
    });
    } finally { await kimi?.cleanup(); }
  }
}

class OpenAICompatBackend implements Backend {
  spec: Extract<RunnerSpec, { type: "openai" }>;
  constructor(spec: Extract<RunnerSpec, { type: "openai" }>) { this.spec = spec; }

  private safeError(message: unknown): string {
    const text = String(message);
    return this.spec.apiKey ? text.replaceAll(this.spec.apiKey, "[redacted]") : text;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    assertActive(req.signal);
    const timeoutMs = this.spec.timeoutMs ?? 900_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new Error("模型请求超时须在 1 毫秒至 15 分钟之间");
    const wireBody = {
      model: this.spec.model, stream: true,
      messages: [{ role: "system", content: req.system }, ...req.turns.map((turn) => turn.role === "assistant" && turn.apiMessage
        ? { role: "assistant", content: turn.apiMessage.content, ...(turn.apiMessage.reasoning_content !== undefined ? { reasoning_content: turn.apiMessage.reasoning_content } : {}) }
        : { role: turn.role, content: turn.text })],
    };
    if (req.cache) {
      const cached = readOpenAIResponseCache(this.spec, wireBody);
      if (cached) {
        for (const delta of cached.deltas) {
          assertActive(req.signal);
          req.onDelta(delta);
          assertActive(req.signal);
        }
        assertActive(req.signal);
        return cached.result;
      }
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs); timer.unref();
    const signal = AbortSignal.any([req.signal, deadline.signal]);
    const maxResponse = 16 * 1024 * 1024, maxText = 2_000_000, maxEvent = 1_000_000;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const res = await fetch(`${this.spec.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/json", ...(this.spec.apiKey ? { Authorization: `Bearer ${this.spec.apiKey}` } : {}) },
        // Leave sampling/token defaults to the provider: thinking models reject
        // some otherwise valid OpenAI temperature/max_tokens combinations.
        body: JSON.stringify(wireBody),
        signal,
      });
      if (!res.body) throw new Error(`模型服务返回空响应（HTTP ${res.status}）`);
      reader = res.body.getReader();
      const dec = new TextDecoder();
      if (!res.ok) {
        // A proxy may return megabytes of HTML or an endless error body. Read
        // only a bounded prefix, then release the connection in finally.
        let body = "", bytes = 0;
        while (bytes < 16_384) {
          const { value, done } = await reader.read(); if (done) break;
          const kept = value.subarray(0, 16_384 - bytes); bytes += kept.length;
          body += dec.decode(kept, { stream: true });
        }
        body += dec.decode();
        let message = body;
        try { const data = JSON.parse(body); message = data.error?.message ?? data.message ?? body; } catch {}
        throw new Error(`模型服务返回错误（HTTP ${res.status}）：${this.safeError(message).slice(0, 1000)}`);
      }
      let text = "", model: string | undefined, usage: ChatResult["usage"], reasoningText = "", hasReasoning = false, reasoningChars = 0, lastProgress = 0, pendingSecret = "";
      let finished = false, doneMarker = false;
      const deltas: string[] = [];
      const emitContent = (content: string, final = false) => {
        const key = this.spec.apiKey;
        let visible = pendingSecret + content; pendingSecret = "";
        if (key) {
          // Hold an incomplete credential prefix across SSE chunks, so a key
          // echoed in several deltas never enters session events or the UI.
          let from = 0, found: number; const safe: string[] = [];
          while ((found = visible.indexOf(key, from)) >= 0) { safe.push(visible.slice(from, found), "[redacted]"); from = found + key.length; }
          let remainder = visible.slice(from);
          if (!final) for (let length = Math.min(key.length - 1, remainder.length); length > 0; length--) {
            if (remainder.endsWith(key.slice(0, length))) { pendingSecret = remainder.slice(-length); remainder = remainder.slice(0, -length); break; }
          }
          safe.push(remainder); visible = safe.join("");
        }
        if (text.length + visible.length > maxText) throw new Error("模型回复超过安全大小限制，任务已停止");
        text += visible;
        if (visible) { deltas.push(visible); req.onDelta(visible); }
        signal.throwIfAborted();
      };
      const consume = (data: any) => {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("模型服务返回了无效的响应对象");
        if (data.error) throw new Error(`模型服务返回错误：${this.safeError(data.error.message ?? (typeof data.error === "string" ? data.error : JSON.stringify(data.error)))}`);
        if (typeof data.model === "string") model = this.safeError(data.model);
        if (Number.isFinite(data.usage?.prompt_tokens) && Number.isFinite(data.usage?.completion_tokens)) usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
        const choice = data.choices?.find((item: any) => item && (item.index === undefined || item.index === 0));
        if (!choice) return;
        if (choice.error || choice.error_msg) throw new Error(`模型服务返回错误：${this.safeError(JSON.stringify(choice.error ?? choice.error_msg))}`);
        const message = choice.delta ?? choice.message;
        const content = message?.content;
        if (content !== undefined && content !== null && typeof content !== "string") throw new Error("模型回复 content 必须是文本字符串");
        if (typeof content === "string") emitContent(content);
        const reasoning = message?.reasoning_content;
        if (typeof reasoning === "string") {
          hasReasoning = true;
          if (reasoningText.length + reasoning.length > maxText) throw new Error("模型推理记录超过安全大小限制，任务已停止");
          reasoningText += reasoning;
          reasoningChars += reasoning.length;
          if (reasoning && Date.now() - lastProgress > 1000) { lastProgress = Date.now(); req.onProgress?.({ phase: "reasoning", chars: reasoningChars }); }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (choice.finish_reason !== "stop") throw new Error(`模型回复未正常完成（finish_reason: ${this.safeError(choice.finish_reason)}）`);
          finished = true;
        }
      };
      if ((res.headers.get("content-type") ?? "").toLowerCase().includes("json")) {
        let body = "", bytes = 0;
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.length; if (bytes > maxResponse) throw new Error("模型响应超过安全大小限制，任务已停止");
          body += dec.decode(value, { stream: true });
        }
        body += dec.decode();
        let data; try { data = JSON.parse(body); } catch { throw new Error("模型服务返回了无效的 JSON 响应"); }
        consume(data);
      } else {
        let buf = "", eventName = "", eventData: string[] = [], eventSize = 0, bytes = 0;
        const dispatch = () => {
          const payload = eventData.join("\n").trim(); eventData = []; eventSize = 0;
          const name = eventName; eventName = "";
          if (!payload) { if (name === "error") throw new Error("模型服务返回了流式错误"); return; }
          if (payload === "[DONE]") { doneMarker = true; return; }
          let data; try { data = JSON.parse(payload); } catch { throw new Error("模型服务返回了无效的流式 JSON 响应"); }
          if (name === "error") throw new Error(`模型服务返回错误：${this.safeError(data.error?.message ?? data.message ?? payload)}`);
          consume(data);
        };
        const line = (value: string) => {
          if (value.endsWith("\r")) value = value.slice(0, -1);
          if (!value) { dispatch(); return; }
          if (value.startsWith(":")) return;
          const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0, colon);
          let content = colon < 0 ? "" : value.slice(colon + 1); if (content.startsWith(" ")) content = content.slice(1);
          if (field === "event") eventName = content;
          if (field === "data") { eventSize += content.length + 1; if (eventSize > maxEvent) throw new Error("模型流式记录超过安全大小限制"); eventData.push(content); }
        };
        while (!doneMarker) {
          const { value, done } = await reader.read();
          if (done) { buf += dec.decode(); if (buf) line(buf); if (!doneMarker) dispatch(); break; }
          bytes += value.length; if (bytes > maxResponse) throw new Error("模型响应超过安全大小限制，任务已停止");
          buf += dec.decode(value, { stream: true });
          let index: number;
          while (!doneMarker && (index = buf.indexOf("\n")) >= 0) { const value = buf.slice(0, index); buf = buf.slice(index + 1); line(value); }
          if (buf.length > maxEvent) throw new Error("模型流式记录超过安全大小限制");
        }
        if (!doneMarker && !finished) throw new Error("模型流式响应提前结束，未收到完成标记");
      }
      emitContent("", true);
      if (!text.trim()) throw new Error(reasoningChars ? "模型仅返回了推理过程，没有最终回复" : "模型没有返回内容");
      const result = { text, model, usage, apiMessage: { role: "assistant" as const, content: text, ...(hasReasoning ? { reasoning_content: this.safeError(reasoningText) } : {}) } };
      if (req.cache) writeOpenAIResponseCache(this.spec, wireBody, result, deltas);
      return result;
    } catch (error: any) {
      if (req.signal.aborted) throw abortError();
      if (deadline.signal.aborted) throw new Error(`模型请求超时（${timeoutMs} 毫秒）`);
      throw new Error(this.safeError(error?.message ?? error).slice(0, 2000));
    } finally {
      clearTimeout(timer);
      try { await reader?.cancel(); } catch {}
      reader?.releaseLock();
    }
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
