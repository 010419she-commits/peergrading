// agents/launch.ts — 找到并启动命令行 agent，重点处理 Windows：
//  · 可执行文件只认 .exe / .cmd / .bat / .com（npm 还会生成一个无扩展名的 sh 脚本，Windows 上不能运行，之前会被误选中）
//  · npm 的 .cmd 包装脚本不经 cmd.exe，直接运行它背后的 node 脚本或原生二进制（避免 cmd 的引号规则与孤儿进程）
//  · 补上 npm / pnpm / bun / scoop / winget 等 Windows 常见的全局 bin 目录
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";

export const WIN = process.platform === "win32";
const HOME = os.homedir();

const EXTRA_BIN_DIRS = [
  path.join(HOME, ".local", "bin"),          // Claude Code 原生安装（macOS / Linux / Windows）、pipx、uv
  path.join(HOME, ".claude", "local"),
  path.join(HOME, ".npm-global", "bin"),
  path.join(HOME, ".lmstudio", "bin"),
  path.join(HOME, ".bun", "bin"),
  path.join(HOME, ".cargo", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];

/** Windows 上各包管理器 / 安装器放全局命令的目录（PATH 里缺了也能找到） */
export function windowsBinDirs(name?: string): string[] {
  if (!WIN) return [];
  const e = process.env;
  const appData = e.APPDATA || path.join(HOME, "AppData", "Roaming");
  const local = e.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
  const dirs = [
    path.join(appData, "npm"),                                   // npm -g
    path.join(local, "pnpm"),                                    // pnpm -g（PNPM_HOME 默认值）
    e.PNPM_HOME || "",
    path.join(local, "Yarn", "bin"),                             // yarn global
    path.join(HOME, "scoop", "shims"),                           // scoop
    path.join(local, "Microsoft", "WinGet", "Links"),            // winget 便携包
    path.join(local, "Microsoft", "WindowsApps"),                // 商店应用的执行别名
    e.ProgramFiles ? path.join(e.ProgramFiles, "nodejs") : "C:\\Program Files\\nodejs",
    path.join(e.ProgramData || "C:\\ProgramData", "chocolatey", "bin"),
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

/** 解析 npm 生成的 .cmd 包装脚本，找出它真正运行的 node 脚本（形如 "%dp0%\node_modules\<pkg>\bin\x.js"） */
export function parseNpmShim(cmdFile: string): string | null {
  let text: string;
  try { text = fs.readFileSync(cmdFile, "latin1"); } catch { return null; }
  const m = text.match(/"%(?:~)?dp0%?\\?([^"]+?\.[cm]?js)"/i);
  if (!m) return null;
  const script = path.join(path.dirname(cmdFile), ...m[1].replace(/^\\/, "").split("\\"));
  return fs.existsSync(script) ? script : null;
}

/** 有些 npm 包只是原生二进制的壳（Codex）：直接找出该平台的二进制，省掉 node 这一层 */
function vendoredNative(script: string): string | null {
  const m = script.match(/^(.*[\\/]node_modules[\\/]@openai[\\/]codex)[\\/]bin[\\/]codex\.[cm]?js$/i);
  if (!m) return null;
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  for (const p of [path.join(m[1], "vendor", triple, "codex", "codex.exe"), path.join(m[1], "vendor", triple, "codex.exe")]) {
    if (fs.existsSync(p)) return p;
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
    const script = parseNpmShim(bin);
    const native = script ? vendoredNative(script) : null;
    if (native) l = { file: native, prefix: [], shell: false };
    else if (script) { const n = nodeFor(bin); l = { file: n.file, prefix: [script], shell: false, env: n.env }; }
    else l = { file: bin, prefix: [], shell: true };
  }
  launcherCache.set(bin, l);
  return l;
}

/** 退路：经 cmd.exe 时的参数写法。cmd 自己没有转义机制：含空格/特殊字符的加引号，内部引号写成 \"（node 侧按 MSVCRT 规则还原） */
export const quoteForCmd = (a: string) => (a === "" || /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export function spawnCli(bin: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }): ChildProcess {
  const l = launcherFor(bin);
  const env = l.env ? { ...opts.env, ...l.env } : opts.env;
  if (!l.shell) return spawn(l.file, [...l.prefix, ...args], { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  return spawn(`"${l.file}"`, args.map(quoteForCmd), { env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true });
}

/** 结束子进程及其子孙（Windows 上 cmd.exe / node 包装层下面还有真正的 agent 进程） */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (!child.pid) return;
  if (WIN) { execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }, () => {}); return; }
  child.kill(signal);
}

/** 给用户看的命令行写法：Windows 用双引号（PowerShell / cmd 都认），其他平台用单引号 */
export const quoteForDisplay = (p: string) => (WIN ? `"${p.replace(/"/g, "")}"` : `'${p.replace(/'/g, `'\\''`)}'`);
