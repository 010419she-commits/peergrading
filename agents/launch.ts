// agents/launch.ts — 找到并启动命令行 agent，重点处理 Windows：
//  · 可执行文件只认 .exe / .cmd / .bat / .com（npm 还会生成一个无扩展名的 sh 脚本，Windows 上不能运行，之前会被误选中），并且不认图形界面程序（桌面版 Kimi.exe 不是命令行）
//  · npm 的 .cmd 包装脚本不经 cmd.exe，直接运行它背后的 node 脚本或原生二进制（避免 cmd 的引号规则与孤儿进程）
//  · 补上 npm / pnpm / bun / scoop / winget 等 Windows 常见的全局 bin 目录；跳过商店应用的执行别名目录（那里的 Claude.exe 是桌面版，不是命令行）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";

export const WIN = process.platform === "win32";
const HOME = os.homedir();

/** Windows PowerShell 的完整路径（PATH 坏掉时也能用） */
export const POWERSHELL = WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";

/** 用户自定义的 npm 全局目录（`npm config set prefix …`，国内教程常见）：环境变量、~/.npmrc、全局 npmrc 里的 prefix= */
function npmPrefixDirs(): string[] {
  const raw: string[] = [process.env.npm_config_prefix || process.env.NPM_CONFIG_PREFIX || ""];
  const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
  for (const rc of [path.join(HOME, ".npmrc"), WIN ? path.join(appData, "npm", "etc", "npmrc") : "/usr/local/etc/npmrc"]) {
    try { raw.push(fs.readFileSync(rc, "utf8").match(/^\s*prefix\s*=\s*(.+?)\s*$/m)?.[1] ?? ""); } catch {}
  }
  const out: string[] = [];
  for (const r of raw) {
    const p = r.replace(/^["']|["']$/g, "").replace(/^~(?=$|[\\/])/, HOME).replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
    if (p) out.push(WIN ? p : path.join(p, "bin"));     // Windows 上 prefix 本身就是 bin 目录，没有 bin\ 子目录
  }
  return out;
}

const EXTRA_BIN_DIRS = [
  path.join(HOME, ".local", "bin"),          // Claude Code 原生安装（macOS / Linux / Windows）、pipx、uv、goose
  path.join(HOME, ".claude", "local"),
  WIN ? path.join(HOME, ".npm-global") : path.join(HOME, ".npm-global", "bin"),
  ...npmPrefixDirs(),
  path.join(HOME, ".lmstudio", "bin"),
  path.join(HOME, ".bun", "bin"),
  path.join(HOME, ".cargo", "bin"),
  path.join(HOME, "go", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

/** 商店应用的"执行别名"目录：里面的 Claude.exe 等是桌面应用的别名，不是命令行，必须跳过 */
const WINDOWS_APPS_DIR = /[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i;

/** Windows 上各包管理器 / 安装器放全局命令的目录（PATH 里缺了也能找到） */
export function windowsBinDirs(name?: string): string[] {
  if (!WIN) return [];
  const e = process.env;
  const appData = e.APPDATA || path.join(HOME, "AppData", "Roaming");
  const local = e.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
  const programFiles = e.ProgramFiles || "C:\\Program Files";
  const dirs = [
    path.join(appData, "npm"),                                   // npm -g
    path.join(local, "pnpm"),                                    // pnpm -g（v10：直接放在 PNPM_HOME；v11：PNPM_HOME\bin）
    path.join(local, "pnpm", "bin"),
    e.PNPM_HOME || "",
    e.PNPM_HOME ? path.join(e.PNPM_HOME, "bin") : "",
    path.join(local, "Yarn", "bin"),                             // yarn global
    path.join(HOME, "scoop", "shims"),                           // scoop（.exe 垫片）
    e.SCOOP ? path.join(e.SCOOP, "shims") : "",
    path.join(e.ProgramData || "C:\\ProgramData", "scoop", "shims"),
    path.join(local, "Microsoft", "WinGet", "Links"),            // winget 便携包（用户）
    path.join(programFiles, "WinGet", "Links"),                  // winget 便携包（--scope machine）
    path.join(local, "Volta", "bin"),                            // volta
    path.join(programFiles, "nodejs"),
    path.join(e.ProgramData || "C:\\ProgramData", "chocolatey", "bin"),
    path.join(local, "Programs", "OpenAI", "Codex", "bin"),      // Codex 官方安装脚本（install.ps1）
    e.CODEX_INSTALL_DIR || "",
    path.join(local, "cursor-agent"),                            // Cursor CLI（agent.exe / cursor-agent.exe）
    path.join(local, "codebuddy", "bin"),                        // CodeBuddy 原生安装
    path.join(HOME, "bin"),                                      // Factory droid
  ];
  // 独立安装器常用 %LOCALAPPDATA%\Programs\<name>\bin\。只看 bin\ 子目录：%LOCALAPPDATA%\Programs\<name>\<name>.exe 多半是同名桌面应用（Kimi、CodeBuddy 都是 Electron 程序）
  if (name) dirs.push(path.join(local, "Programs", name, "bin"));
  return dirs.filter(Boolean);
}

/** PE 可选头里的 Subsystem：2 = 图形界面（桌面应用），3 = 控制台；不是 PE 文件或读不出来返回 null */
export function peSubsystem(file: string): number | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const h = Buffer.alloc(64);
      if (fs.readSync(fd, h, 0, 64, 0) < 64 || h.toString("latin1", 0, 2) !== "MZ") return null;
      const b = Buffer.alloc(94);
      if (fs.readSync(fd, b, 0, 94, h.readUInt32LE(0x3c)) < 94 || b.toString("latin1", 0, 4) !== "PE\0\0") return null;
      return b.readUInt16LE(4 + 20 + 68);   // 签名 4 + COFF 头 20，Subsystem 在可选头偏移 68（PE32 与 PE32+ 相同）
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
/** 图形界面程序不是命令行 agent（桌面版 Kimi.exe / Claude.exe 这类），找命令时要跳过 */
const isGuiExe = (p: string) => /\.exe$/i.test(p) && peSubsystem(p) === 2;

/** 在 PATH 与常见安装目录里找可执行文件。Windows 只认可直接执行的扩展名，.exe 优先于 .cmd */
export function findBin(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(path.delimiter), ...EXTRA_BIN_DIRS, ...windowsBinDirs(name)];
  // 也扫描所有 node 版本目录（nvm / 自定义安装）
  for (const d of [path.join(HOME, ".local"), path.join(HOME, ".nvm", "versions", "node")]) {
    try { for (const sub of fs.readdirSync(d)) dirs.push(path.join(d, sub, "bin")); } catch {}
  }
  const exts = WIN ? [".exe", ".cmd", ".bat", ".com"] : [""];
  for (const d of dirs) {
    if (!d) continue;
    if (WIN && WINDOWS_APPS_DIR.test(d)) continue;
    for (const ext of exts) {
      const p = path.join(d, name + ext);
      try {
        fs.accessSync(p, WIN ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(p).isFile() && !(WIN && isGuiExe(p))) return p;
      } catch {}
    }
  }
  return null;
}

/** Windows 上的 .cmd / .bat 包装脚本不能直接 spawn（Node 18.20+ 会 EINVAL） */
export const needsShell = (bin: string) => WIN && /\.(cmd|bat)$/i.test(bin);

export interface Launcher {
  file: string;                    // 真正要 spawn 的程序
  prefix: string[];                // 放在用户参数前面的参数（node 脚本路径）
  shell: boolean;                  // 退回 cmd.exe
  env?: Record<string, string>;    // 额外环境变量
  pathPrepend?: string[];          // 要加到 PATH 最前面的目录（npm 包随附的 rg 等）
}

/** 解析 npm / pnpm / yarn 生成的 .cmd 包装脚本，找出它真正运行的目标："%dp0%\node_modules\<pkg>\bin\x.js"（node 脚本，也可能没有扩展名）或原生 .exe */
export function parseNpmShim(cmdFile: string): string | null {
  let text: string;
  try { text = fs.readFileSync(cmdFile, "latin1"); } catch { return null; }
  // 脚本里还会出现 "%dp0%\node.exe"（判断旁边有没有 node），那不是目标。npm 生成的包装脚本只会引用一个目标
  const rels = [...text.matchAll(/"%(?:~)?dp0%?\\?([^"%]+?)"/gi)].map((m) => m[1].replace(/^\\/, "")).filter((r) => r && !/^node\.exe$/i.test(r));
  for (const rel of rels) {
    const target = path.join(path.dirname(cmdFile), ...rel.split("\\"));
    try { if (fs.statSync(target).isFile()) return target; } catch {}
  }
  return null;
}
/** 包装脚本的目标是不是原生可执行文件 */
const isNativeTarget = (p: string) => /\.(exe|com)$/i.test(p);
/** 包装脚本的目标能不能交给 node 运行：.js/.cjs/.mjs，或没有扩展名但 shebang 是 node（yarn 的 .bin\x 是 #!/bin/sh 脚本，不能） */
function isNodeScript(p: string): boolean {
  if (/\.[cm]?js$/i.test(p)) return true;
  if (/\.[a-z0-9]{1,4}$/i.test(p)) return false;
  try {
    const fd = fs.openSync(p, "r");
    try { const b = Buffer.alloc(200); const n = fs.readSync(fd, b, 0, 200, 0); const first = b.toString("latin1", 0, n).split(/\r?\n/)[0]; return !first.startsWith("#!") || /\bnode\b/.test(first); } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** 文件是不是真的 Windows 可执行文件（PE 头 "MZ"）；npm 的 postinstall 没跑时，占位的 .exe 其实是脚本 */
function isPE(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(2); return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString("latin1") === "MZ"; } finally { fs.closeSync(fd); }
  } catch { return false; }
}

type Native = { file: string; env?: Record<string, string>; pathPrepend?: string[] };

/** 有些 npm 包只是原生二进制的壳（Codex）：直接找出该平台的二进制，省掉 node 这一层，并补上 codex.js 原本会设置的环境。
 *  @openai/codex 的 bin/codex.js 只做一件事：按平台 spawn 可选依赖 @openai/codex-win32-{x64,arm64} 里的 vendor/<triple>/bin/codex.exe，
 *  同时设置 CODEX_MANAGED_BY_NPM / CODEX_MANAGED_PACKAGE_ROOT，并把随附 rg 所在的 vendor/<triple>/path 加进 PATH
 *  （旧版本放在 vendor/<triple>/codex/codex.exe，更老的版本直接随主包携带 vendor/）。可选依赖可能嵌套在主包下，也可能被提升到上一层 */
function vendoredNative(script: string): Native | null {
  const m = script.match(/^(.*[\\/]node_modules)[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.[cm]?js$/i);
  if (!m) return null;
  const nm = m[1], pkg = path.join(nm, "@openai", "codex");
  const arm = process.arch === "arm64";
  const triple = arm ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const plat = arm ? "codex-win32-arm64" : "codex-win32-x64";
  const roots = [path.join(pkg, "node_modules", "@openai", plat), path.join(nm, "@openai", plat), pkg];
  for (const root of roots) {
    for (const rel of [["vendor", triple, "bin", "codex.exe"], ["vendor", triple, "codex", "codex.exe"]]) {
      const p = path.join(root, ...rel);
      if (!isPE(p)) continue;
      const rgDir = path.join(root, "vendor", triple, "path");
      return { file: p, env: { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: pkg }, pathPrepend: fs.existsSync(rgDir) ? [rgDir] : undefined };
    }
  }
  return null;
}

/** @anthropic-ai/claude-code 的 bin/claude.exe 在 postinstall 之前只是个 sh 脚本占位（pnpm 默认不跑依赖的安装脚本）；
 *  这时真正的二进制在平台包 @anthropic-ai/claude-code-win32-{x64,arm64} 里，主包还带了 cli-wrapper.cjs 作为 node 退路 */
function claudeNativeFallback(target: string, cmdFile: string): Launcher | null {
  const m = target.match(/^(.*[\\/]node_modules)[\\/]@anthropic-ai[\\/]claude-code[\\/]bin[\\/]claude\.exe$/i);
  if (!m) return null;
  const nm = m[1], pkg = path.join(nm, "@anthropic-ai", "claude-code");
  const plat = process.arch === "arm64" ? "claude-code-win32-arm64" : "claude-code-win32-x64";
  for (const root of [path.join(pkg, "node_modules", "@anthropic-ai", plat), path.join(nm, "@anthropic-ai", plat)]) {
    for (const rel of [["claude.exe"], ["bin", "claude.exe"]]) {
      const p = path.join(root, ...rel);
      if (isPE(p)) return { file: p, prefix: [], shell: false };
    }
  }
  const wrapper = path.join(pkg, "cli-wrapper.cjs");
  if (fs.existsSync(wrapper)) { const n = nodeFor(cmdFile); return { file: n.file, prefix: [wrapper], shell: false, env: n.env }; }
  return null;
}

/** 运行 node 脚本用哪个 node：包装脚本旁边的 node.exe → PATH 上的 node → 本程序自己（Electron 以 node 模式运行） */
function nodeFor(cmdFile: string): { file: string; env?: Record<string, string> } {
  const beside = path.join(path.dirname(cmdFile), "node.exe");
  if (fs.existsSync(beside)) return { file: beside };
  const onPath = findBin("node");
  if (onPath) return { file: onPath };
  return { file: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
}

const launcherCache = new Map<string, Launcher>();
/** 重新扫描 agent 时清掉缓存（CLI 升级后包装脚本背后的目标可能变了） */
export function resetLaunchers() { launcherCache.clear(); }
const stillValid = (l: Launcher) => [l.file, ...l.prefix].every((p) => fs.existsSync(p));

/** 决定怎么启动一个命令：直接运行 / node + 脚本 / 退回 cmd.exe */
export function launcherFor(bin: string): Launcher {
  const hit = launcherCache.get(bin);
  if (hit && stillValid(hit)) return hit;
  let l: Launcher = { file: bin, prefix: [], shell: false };
  if (needsShell(bin)) {
    // yarn global 的 bin\x.cmd 只是再调一层 Data\global\node_modules\.bin\x.cmd：顺着链找真正的目标（最多 3 层）；链解析不了就退回 cmd.exe，它能原样运行嵌套的 .cmd
    let target = parseNpmShim(bin);
    for (let i = 0; target && /\.(cmd|bat)$/i.test(target); i++) target = i < 3 ? parseNpmShim(target) : null;
    const viaCmd: Launcher = { file: bin, prefix: [], shell: true };
    if (target && isNativeTarget(target)) {
      // .exe 占位脚本（postinstall 没跑）：先找平台包里的真二进制；都没有就交给 cmd.exe，让它自己的报错显示出来
      l = isPE(target) && !isGuiExe(target) ? { file: target, prefix: [], shell: false } : claudeNativeFallback(target, bin) ?? viaCmd;
    } else if (target && isNodeScript(target)) {
      const native = vendoredNative(target);
      if (native) l = { file: native.file, prefix: [], shell: false, env: native.env, pathPrepend: native.pathPrepend };
      else { const n = nodeFor(bin); l = { file: n.file, prefix: [target], shell: false, env: n.env }; }
    } else l = viaCmd;
  }
  launcherCache.set(bin, l);
  return l;
}

/** 退路：经 cmd.exe 时的参数写法。cmd 自己没有转义机制：含空格/特殊字符的加引号，内部引号写成 \"（node 侧按 MSVCRT 规则还原）。
 *  含换行的参数 cmd 根本传不了（会在换行处截断命令），调用方须改走 stdin —— 见 backends.ts */
export const quoteForCmd = (a: string) => (a === "" || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** 子进程环境：只去掉会让 Claude Code 误以为自己在嵌套会话里的几个标记（它只看 CLAUDECODE），
 *  其余 CLAUDE_* 全部保留 —— CLAUDE_CODE_GIT_BASH_PATH / CLAUDE_CONFIG_DIR / CLAUDE_CODE_OAUTH_TOKEN / mTLS 证书等都是用户的正常配置 */
const NESTED_MARKERS = new Set(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_SESSION_ID"]);
export function stripNestedClaudeEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) if (!NESTED_MARKERS.has(k)) env[k] = v;
  return env;
}

/** 按启动方式补环境变量：额外变量直接覆盖，pathPrepend 加到 PATH 前面（Windows 上键可能叫 Path，按不分大小写找） */
export function envForLauncher(l: Launcher, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!l.env && !l.pathPrepend?.length) return base;
  const env: NodeJS.ProcessEnv = { ...base, ...(l.env ?? {}) };
  if (l.pathPrepend?.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = [...l.pathPrepend, env[key] ?? ""].filter(Boolean).join(path.delimiter);
  }
  return env;
}

export function spawnCli(bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): ChildProcess {
  const l = launcherFor(bin);
  const env = envForLauncher(l, opts.env);
  const child = !l.shell
    ? spawn(l.file, [...l.prefix, ...args], { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    : spawn(`"${l.file}"`, args.map(quoteForCmd), { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true });
  // 子进程还没读 stdin 就退出时（命令不存在、旧版本不认参数），写入会报 EPIPE；没有监听器的话会把整个程序打崩
  child.stdin?.on("error", () => {});
  return child;
}

/** 结束子进程及其子孙（Windows 上 cmd.exe / node 包装层下面还有真正的 agent 进程） */
const TASKKILL = WIN ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe") : "taskkill";
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  if (WIN) {
    // 用完整路径，PATH 坏掉时也能杀；taskkill 失败至少把直接子进程杀掉
    execFile(TASKKILL, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, (err) => { if (err) { try { child.kill("SIGKILL"); } catch {} } });
    return;
  }
  child.kill(signal);
}

/** 给用户看的命令行写法：Windows 按 PowerShell 写（登录窗口与代理前缀 $env: 都是 PowerShell），单引号里 $ 和反引号不会被展开，带引号的路径要用 & 调用；其他平台用 sh 的单引号 */
export const quoteForDisplay = (p: string) => (WIN ? `& '${p.replace(/'/g, "''")}'` : `'${p.replace(/'/g, `'\\''`)}'`);
