// agents/launch.ts — 找到并启动命令行 agent，重点处理 Windows：
//  · 可执行文件只认 .exe / .cmd / .bat / .com（npm 还会生成一个无扩展名的 sh 脚本，Windows 上不能运行，之前会被误选中）
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

/** 用户自定义的 npm 全局目录（`npm config set prefix …`，国内教程常见）：读 ~/.npmrc 的 prefix= */
function npmPrefixDirs(): string[] {
  const out: string[] = [];
  for (const rc of [path.join(HOME, ".npmrc")]) {
    try {
      const m = fs.readFileSync(rc, "utf8").match(/^\s*prefix\s*=\s*(.+?)\s*$/m);
      if (!m) continue;
      let p = m[1].replace(/^["']|["']$/g, "").replace(/^~(?=$|[\\/])/, HOME).replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
      if (!p) continue;
      out.push(WIN ? p : path.join(p, "bin"));     // Windows 上 prefix 本身就是 bin 目录，没有 bin\ 子目录
    } catch {}
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
  if (name) dirs.push(path.join(local, "Programs", name), path.join(local, "Programs", name, "bin"));   // 独立安装器常用 %LOCALAPPDATA%\Programs\<name>\
  return dirs.filter(Boolean);
}

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
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

/** Windows 上的 .cmd / .bat 包装脚本不能直接 spawn（Node 18.20+ 会 EINVAL） */
export const needsShell = (bin: string) => WIN && /\.(cmd|bat)$/i.test(bin);

export interface Launcher { file: string; prefix: string[]; shell: boolean; env?: Record<string, string> }

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
/** 包装脚本的目标是不是原生可执行文件（否则当作 node 脚本运行） */
const isNativeTarget = (p: string) => /\.(exe|com)$/i.test(p);

/** 文件是不是真的 Windows 可执行文件（PE 头 "MZ"）；npm 的 postinstall 没跑时，占位的 .exe 其实是脚本 */
function isPE(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(2); return fs.readSync(fd, b, 0, 2, 0) === 2 && b.toString("latin1") === "MZ"; } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** 有些 npm 包只是原生二进制的壳（Codex）：直接找出该平台的二进制，省掉 node 这一层。
 *  @openai/codex 的 bin/codex.js 只做一件事：按平台 spawn 可选依赖 @openai/codex-win32-{x64,arm64} 里的 vendor/<triple>/bin/codex.exe
 *  （旧版本放在 vendor/<triple>/codex/codex.exe，更老的版本直接随主包携带 vendor/）。可选依赖可能嵌套在主包下，也可能被提升到上一层 */
function vendoredNative(script: string): string | null {
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
      if (isPE(p)) return p;
    }
  }
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
/** 决定怎么启动一个命令：直接运行 / node + 脚本 / 退回 cmd.exe */
export function launcherFor(bin: string): Launcher {
  const hit = launcherCache.get(bin); if (hit) return hit;
  let l: Launcher = { file: bin, prefix: [], shell: false };
  if (needsShell(bin)) {
    const target = parseNpmShim(bin);
    if (target && isNativeTarget(target)) l = { file: target, prefix: [], shell: false };
    else {
      const native = target ? vendoredNative(target) : null;
      if (native) l = { file: native, prefix: [], shell: false };
      else if (target) { const n = nodeFor(bin); l = { file: n.file, prefix: [target], shell: false, env: n.env }; }
      else l = { file: bin, prefix: [], shell: true };
    }
  }
  launcherCache.set(bin, l);
  return l;
}

/** 退路：经 cmd.exe 时的参数写法。cmd 自己没有转义机制：含空格/特殊字符的加引号，内部引号写成 \"（node 侧按 MSVCRT 规则还原）。
 *  含换行的参数 cmd 根本传不了（会在换行处截断命令），调用方须改走 stdin —— 见 backends.ts */
export const quoteForCmd = (a: string) => (a === "" || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** 子进程环境：去掉会让 Claude Code 误以为自己在嵌套会话里的变量，但保留它在 Windows 上需要的配置项 */
const KEEP_CLAUDE_ENV = /^CLAUDE_(CODE_GIT_BASH_PATH|CONFIG_DIR|CODE_USE_|CODE_DISABLE_)/;
export function stripNestedClaudeEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "CLAUDECODE" || (k.startsWith("CLAUDE_") && !KEEP_CLAUDE_ENV.test(k))) continue;
    env[k] = v;
  }
  return env;
}

export function spawnCli(bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): ChildProcess {
  const l = launcherFor(bin);
  const env = l.env ? { ...opts.env, ...l.env } : opts.env;
  const child = !l.shell
    ? spawn(l.file, [...l.prefix, ...args], { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    : spawn(`"${l.file}"`, args.map(quoteForCmd), { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true });
  // 子进程还没读 stdin 就退出时（命令不存在、旧版本不认参数），写入会报 EPIPE；没有监听器的话会把整个程序打崩
  child.stdin?.on("error", () => {});
  return child;
}

/** 结束子进程及其子孙（Windows 上 cmd.exe / node 包装层下面还有真正的 agent 进程） */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  if (WIN) { execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {}); return; }
  child.kill(signal);
}

/** 给用户看的命令行写法：Windows 按 PowerShell 写（登录窗口与代理前缀 $env: 都是 PowerShell），带引号的路径要用 & 调用；其他平台用单引号 */
export const quoteForDisplay = (p: string) => (WIN ? `& "${p.replace(/"/g, "")}"` : `'${p.replace(/'/g, `'\\''`)}'`);
