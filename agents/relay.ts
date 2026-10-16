// agents/relay.ts — 网页中转：把消息交给你手上的任意桌面应用，再把它的回答收回来
import { execFile } from "node:child_process";
import type { Backend, ChatRequest, ChatResult } from "./types.ts";
import { POWERSHELL, stripNestedClaudeEnv } from "./launch.ts";

export type RelayMode = "manual" | "clipboard";

export interface RelayContext {
  emit: (ev: any) => void;
}

type Pending = { resolve: (text: string) => void; own: Set<string> };
const pending = new Map<string, Pending>();

/** 一键发送时登记“这是我们放进剪贴板的内容”，防止被当成回复 */
export function markOwnClipboardText(requestId: string, text: string) {
  pending.get(requestId)?.own.add(text);
}

/** 由 POST /api/relay/reply 调用 */
export function submitRelayReply(requestId: string, text: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  p.own.add(text);
  p.resolve(text);
  return true;
}

/** 用户说“这不是回答”：以后忽略这段剪贴板内容 */
export function ignoreRelayText(requestId: string, text: string): boolean {
  const p = pending.get(requestId);
  if (!p) return false;
  p.own.add(text);
  return true;
}

// pbcopy/pbpaste 按 locale 解码；若环境没有 UTF-8 locale，中文会丢失，所以显式指定
const PB_ENV = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

const isWin = process.platform === "win32";
const normalizeEol = (s: string) => s.replace(/\r\n?/g, "\n");
/** 运行一段 PowerShell。脚本以 -EncodedCommand（UTF-16LE base64）传入，不受命令行引号规则影响 */
function psRun(script: string, input?: string, opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    // 统一把输出编码设成 UTF-8：PowerShell 5.1 默认按本地代码页（中文系统是 GBK）输出，Node 这边按 UTF-8 读会变成乱码
    const encoded = Buffer.from(`[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, "utf16le").toString("base64");
    const child = execFile(POWERSHELL, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: opts.env, timeout: opts.timeout },
      (err, stdout, stderr) => {
        // 报错优先给 PowerShell 自己的 stderr；execFile 的 message 里带着整段 base64 命令行，没有信息量
        const detail = String(stderr ?? "").split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? "";   // 只要第一行，不要 "At line:… + ~~~" 那一堆
        const msg = err ? (detail || ((err as any).killed ? "powershell timed out" : String(err.message).split("\n")[0].replace(/ -EncodedCommand \S+/, ""))) : detail;
        resolve({ ok: !err, out: String(stdout ?? ""), err: msg });
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? "");
  });
}
const ps = (script: string, input?: string) => psRun(script, input, { timeout: 10_000 }).then((r) => (r.ok ? r.out : ""));
function pb(cmd: "pbcopy" | "pbpaste", input?: string): Promise<string> {
  if (isWin) {
    // Windows：通过 PowerShell 读写剪贴板（UTF-8）。写入时换行转成 CRLF（Windows 程序的惯例）；
    // 读取时用 [Console]::Out.Write 而不是默认输出，否则 PowerShell 会在末尾多补一个换行，导致读回的内容与我们写入的不相等
    if (cmd === "pbcopy") return ps("[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t", (input ?? "").replace(/\r?\n/g, "\r\n"));
    return ps("$t = Get-Clipboard -Raw; if ($t -ne $null) { [Console]::Out.Write([string]$t) }").then((t) => t.replace(/\r\n/g, "\n"));
  }
  return new Promise((resolve) => {
    const child = execFile(cmd, [], { maxBuffer: 16 * 1024 * 1024, env: PB_ENV }, (err, stdout) => resolve(err ? "" : stdout));
    if (cmd === "pbcopy") child.stdin?.end(input ?? "");
  });
}

export function clipboardAvailable(): boolean {
  return process.platform === "darwin" || isWin;
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve) => execFile("osascript", ["-e", script], { timeout: 8000 }, (err, stdout) => resolve(err ? "" : stdout.trim())));
}

/** 当前正在运行的、有窗口的应用名（供用户选择目标应用） */
export async function listRunningApps(): Promise<string[]> {
  if (isWin) {
    const out = await ps("Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName -Unique");
    const skip = new Set(["explorer", "powershell", "cmd", "WindowsTerminal", "PeerGrading", "electron"]);
    return out.split(/\r?\n/).map((n) => n.trim()).filter((n) => n && !skip.has(n)).sort((a, b) => a.localeCompare(b));
  }
  if (!clipboardAvailable()) return [];
  const out = await osascript('tell application "System Events" to get name of every process whose background only is false');
  const names = out.split(", ").map((n) => n.trim()).filter(Boolean);
  const skip = new Set(["Finder", "Terminal", "iTerm2", "node", "System Events", "Dock", "Electron", "PeerGrading"]);
  return [...new Set(names.filter((n) => !skip.has(n)))].sort((a, b) => a.localeCompare(b));
}

/** 一键发送：把文本放进剪贴板，并把目标应用切到前台；粘贴与回车由用户自己完成。
 *  Windows 下进程名常与应用名不同（VS Code 是 Code），processNames 给出候选，再退回按窗口标题匹配 */
export async function sendToApp(text: string, app?: string, processNames: string[] = []): Promise<{ ok: boolean; message: string }> {
  await pb("pbcopy", text);
  if (!app) return { ok: true, message: "copied" };
  const safe = app.replace(/["']/g, "");
  if (isWin) {
    const names = [...new Set([...processNames, safe].map((n) => n.replace(/\.exe$/i, "").replace(/["']/g, "")))];
    const like = safe.replace(/[\[\]*?`]/g, "`$&");   // -like 的通配符用反引号转义（单引号字符串里反引号是普通字符，-like 自己会解释）
    const list = names.map((n) => `'${n}'`).join(",");
    // 先按进程名找有窗口的进程，再按窗口标题；最小化的窗口先还原（AppActivate 只给焦点，不还原）
    const r = await psRun(`$names = @(${list})
$p = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($names -contains $_.ProcessName) } | Select-Object -First 1
if (-not $p) { $p = Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle -like '*${like}*' } | Select-Object -First 1 }
if ($p) {
  Add-Type -Namespace PG -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'
  $h = $p.MainWindowHandle
  if ([PG.Win]::IsIconic($h)) { [PG.Win]::ShowWindowAsync($h, 9) | Out-Null }
  [PG.Win]::SetForegroundWindow($h) | Out-Null
  (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null
  'activated'
} else { 'not running' }`, undefined, { timeout: 15000 });
    const msg = r.out.trim();
    if (!r.ok) return { ok: false, message: r.err.slice(0, 300) || "powershell failed" };
    return { ok: msg === "activated", message: msg || "not running" };
  }
  const r = await osascript(`tell application "${safe}" to activate`);
  return { ok: true, message: r === "" ? "activated" : r };
}

export class RelayBackend implements Backend {
  mode: RelayMode;
  app?: string;
  ctx: RelayContext;
  turnCount = 0;
  ownTexts = new Set<string>();   // 我们自己放进剪贴板的内容，不能被当成回复

  constructor(mode: RelayMode, ctx: RelayContext, app?: string) {
    this.mode = mode;
    this.ctx = ctx;
    this.app = app;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const latest = req.turns[req.turns.length - 1].text;
    const first = this.turnCount === 0;
    this.turnCount++;
    // 桌面应用自己会保留对话上下文，所以只有第一条消息需要附带协作规则
    const text = normalizeEol(first ? `${req.system}\n\n---\n\n${latest}` : latest);   // 剪贴板读回来一律是 LF，自己放进去的也按 LF 记
    const requestId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (this.mode === "clipboard") {
      await pb("pbcopy", text);
      this.ownTexts.add(text);
    }
    this.ctx.emit({ type: "relay_wait", requestId, mode: this.mode, first, text, app: this.app });

    const reply = await new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (t: string) => { if (done) return; done = true; cleanup(); resolve(t.trim()); };
      const onAbort = () => { if (done) return; done = true; cleanup(); reject(new Error("aborted")); };
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => { pending.delete(requestId); req.signal.removeEventListener("abort", onAbort); if (timer) clearInterval(timer); };

      pending.set(requestId, { resolve: finish, own: this.ownTexts });
      req.signal.addEventListener("abort", onAbort, { once: true });

      if (this.mode === "clipboard") {
        let last = "", stableSince = 0, inFlight = false;
        const announced = new Set<string>();
        // 是不是我们自己放进剪贴板的内容：剪贴板读回来可能多/少首尾空白，按去空白后比较
        const isOwn = (cur: string, trimmed: string) => {
          if (this.ownTexts.has(cur) || this.ownTexts.has(trimmed)) return true;
          for (const t of this.ownTexts) if (normalizeEol(t).trim() === trimmed) return true;
          return false;
        };
        // Windows 上每次读剪贴板都要起一个 PowerShell（几百毫秒），上一次没读完就不再发起新的
        timer = setInterval(async () => {
          if (done || inFlight) return;
          inFlight = true;
          const cur = normalizeEol(await pb("pbpaste").finally(() => { inFlight = false; }));
          if (done) return;
          const trimmed = cur.trim();
          if (!trimmed || isOwn(cur, trimmed) || announced.has(cur)) { last = ""; return; }
          if (cur !== last) { last = cur; stableSince = Date.now(); return; }
          if (Date.now() - stableSince >= 800) {
            announced.add(cur);
            // 交给页面：显示预览并倒计时，用户可取消；倒计时结束页面调用 /api/relay/reply
            this.ctx.emit({ type: "relay_candidate", requestId, text: cur });
          }
        }, isWin ? 1000 : 600);
      }
    });

    this.ctx.emit({ type: "relay_done", requestId });
    req.onDelta(reply);
    return { text: reply };
  }
}

/** 在新终端窗口里运行一条命令并切到前台（用于一次性登录）。
 *  macOS：Terminal.app 执行 command（已含代理前缀）；
 *  Windows：新开一个 PowerShell 窗口执行 argv（与页面上显示的 $env: 代理前缀写法一致），代理通过环境变量继承给它；
 *  内层脚本同样用 -EncodedCommand 传，路径里有空格、括号、& 都不怕 */
export async function runInTerminal(cmd: { command: string; argv: string[]; env?: Record<string, string> }): Promise<{ ok: boolean; message: string }> {
  if (isWin) {
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const inner = `$Host.UI.RawUI.WindowTitle = 'PeerGrading'\n& ${cmd.argv.map(q).join(" ")}`;
    const encoded = Buffer.from(inner, "utf16le").toString("base64");
    const env = { ...stripNestedClaudeEnv(), ...(cmd.env || {}) };   // 与启动 CLI 时一样去掉嵌套会话标记
    const r = await psRun(`Start-Process -FilePath ${q(POWERSHELL)} -ArgumentList @('-NoExit','-EncodedCommand','${encoded}')`, undefined, { env, timeout: 15000 });
    return r.ok ? { ok: true, message: "opened" } : { ok: false, message: r.err.slice(0, 300) || "failed to open PowerShell" };
  }
  if (process.platform !== "darwin") return { ok: false, message: "only supported on macOS / Windows" };
  const escaped = cmd.command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const r = await osascript(`tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`);
  return { ok: true, message: r };
}
