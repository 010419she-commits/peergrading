// test/launch.test.ts — 命令行 agent 的查找与启动方式（重点：Windows 的 npm 包装脚本）
// 运行：npm test。Windows 分支通过临时把 process.platform 改成 win32 来模拟，目录布局与 npm / pnpm 在 Windows 上生成的一致。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realPlatform = process.platform;
const realPath = process.env.PATH;
let tmp: string;
let launch: typeof import("../agents/launch.ts");

const TRIPLE = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
const PLAT_PKG = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";

const NPM_SHIM = (rel: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;
// pnpm（@zkochan/cmd-shim）生成的样子：相对路径里带 ..\
const PNPM_SHIM = (rel: string) => `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${rel}" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\${rel}" %*\r\n)\r\n`;

// bin 指向原生 .exe（文件没有 shebang）时 cmd-shim 生成的样子：没有 node 那一段，直接运行目标
const NPM_DIRECT_SHIM = (rel: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${rel}"   %*\r\n`;
// pnpm 配置了 nodeExecPath 时的样子：node 写成绝对路径
const PNPM_NODE_SHIM = (rel: string) => `@SETLOCAL\r\n@"C:\\Program Files\\nodejs\\node.exe"  "%~dp0\\${rel}" %*\r\n`;
// pnpm（@zkochan/cmd-shim）为没有 shebang 的目标生成的样子
const PNPM_DIRECT_SHIM = (rel: string) => `@SETLOCAL\r\n@"%~dp0\\${rel}"   %*\r\n`;

function touch(p: string, content: string | Buffer = "") { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
/** 最小的 PE 文件：DOS 头（MZ、e_lfanew=64）+ "PE\0\0" + COFF 头 + 可选头的 Subsystem 字段。2 = 图形界面，3 = 控制台 */
function pe(subsystem: number): Buffer {
  const b = Buffer.alloc(64 + 94);
  b.write("MZ", 0, "latin1"); b.writeUInt32LE(64, 0x3c);
  b.write("PE\0\0", 64, "latin1"); b.writeUInt16LE(0x8664, 64 + 4);
  b.writeUInt16LE(subsystem, 64 + 4 + 20 + 68);
  return b;
}
const CUI = pe(3), GUI = pe(2);

let npm: string, hoisted: string, legacy: string, broken: string, pnpmHome: string, yarnBin: string, localAppData: string, cacheDir: string, pnpmClaude: string, wrapperClaude: string, pnpmStore: string;
// 查找逻辑会看 HOME / APPDATA / LOCALAPPDATA 下的真实安装目录：测试期间全部指到临时目录，开发机上装了什么都不影响结果
const ENV_KEYS = ["LOCALAPPDATA", "APPDATA", "HOME", "USERPROFILE"] as const;
const realEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const CLAUDE_PLAT = process.arch === "arm64" ? "claude-code-win32-arm64" : "claude-code-win32-x64";

before(async () => {
  // 用真实路径：macOS 的 /var 是 /private/var 的符号链接，查找逻辑按真实路径（pnpm 的 junction）解析平台包，断言里的期望路径要和它一致
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pg-launch-")));
  npm = path.join(tmp, "npm");
  // npm -g 在 Windows 上为每个命令生成三个文件：无扩展名的 sh 脚本、.cmd、.ps1
  touch(path.join(npm, "codex"), "#!/bin/sh\nexec node ...\n");
  touch(path.join(npm, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(npm, "codex.ps1"), "#!/usr/bin/env pwsh\n");
  touch(path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  // 当前 @openai/codex 的布局：原生二进制在可选依赖 @openai/codex-win32-x64 里，嵌套在主包下
  touch(path.join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), CUI);
  touch(path.join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "codex-path", "rg.exe"), CUI);   // 随附的 ripgrep（新版 codex.js 不再把它加进 PATH）
  // @anthropic-ai/claude-code 2.1.x：bin 指向 bin\claude.exe，postinstall 之后是真正的原生程序
  touch(path.join(npm, "claude"), "#!/bin/sh\n");
  touch(path.join(npm, "claude.cmd"), NPM_DIRECT_SHIM("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  touch(path.join(npm, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), CUI);
  // 普通的 node 脚本包
  touch(path.join(npm, "amp.cmd"), NPM_SHIM("node_modules\\@sourcegraph\\amp\\dist\\main.js"));
  touch(path.join(npm, "node_modules", "@sourcegraph", "amp", "dist", "main.js"), "// cli\n");
  // 包装脚本直接指向 .exe（bin 是原生二进制的 npm 包）
  touch(path.join(npm, "native.cmd"), NPM_DIRECT_SHIM("node_modules\\some-tool\\bin\\native.exe"));
  touch(path.join(npm, "node_modules", "some-tool", "bin", "native.exe"), CUI);
  // 包装脚本指向没有扩展名的 node 脚本（如 @tencent-ai/codebuddy-code 的 bin/codebuddy）
  touch(path.join(npm, "codebuddy.cmd"), NPM_SHIM("node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"));
  touch(path.join(npm, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"), "#!/usr/bin/env node\n");
  // 手写的 .cmd（不是 npm 生成的）→ 只能退回 cmd.exe
  touch(path.join(npm, "custom.cmd"), "@echo off\r\nsomething.exe %*\r\n");
  // 原生安装：claude.exe 与 .cmd 同时存在时应优先 .exe
  const local = path.join(tmp, "localbin");
  touch(path.join(local, "qwen.cmd"), NPM_SHIM("x.js"));
  touch(path.join(local, "qwen.exe"), CUI);
  // 同名的图形界面程序排在前面也不能选：它不是命令行
  touch(path.join(local, "kimi.exe"), GUI);
  touch(path.join(local, "kimi.cmd"), NPM_SHIM("node_modules\\@moonshot-ai\\kimi-cli\\bin\\kimi.js"));
  touch(path.join(local, "node_modules", "@moonshot-ai", "kimi-cli", "bin", "kimi.js"), "// cli\n");
  // 商店应用的执行别名目录：这里的 claude.exe 是桌面版，不是命令行，即使排在 PATH 最前面也要跳过
  localAppData = path.join(tmp, "AppData", "Local");
  const winApps = path.join(localAppData, "Microsoft", "WindowsApps");
  touch(path.join(winApps, "claude.exe"), "");   // 真实的执行别名是 0 字节的重解析点，读不出 PE 头，只能靠跳过整个目录
  // %LOCALAPPDATA%\Programs\<name>\<name>.exe 多半是同名桌面应用（Electron，图形界面）：不能当成命令行；只有 Programs\<name>\bin\ 才看
  touch(path.join(localAppData, "Programs", "Cody", "Cody.exe"), GUI);
  touch(path.join(localAppData, "Programs", "bare", "bare.exe"), CUI);
  touch(path.join(localAppData, "Programs", "droid", "bin", "droid.exe"), CUI);
  // VS Code 系 IDE 的 bin\<name>.cmd：用 IDE 本体（图形程序）跑 cli.js，是打开 IDE 的命令，不是 agent 命令行
  const ideLauncher = (name: string, exe: string) => {
    const root = path.join(localAppData, "Programs", name);
    touch(path.join(root, "bin", `${name}.cmd`), `@echo off\r\nsetlocal\r\nset VSCODE_DEV=\r\nset ELECTRON_RUN_AS_NODE=1\r\n"%~dp0..\\${exe}" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\nendlocal\r\n`);
    touch(path.join(root, exe), GUI);
    touch(path.join(root, "resources", "app", "out", "cli.js"), "// ide cli\n");
    return path.join(root, "bin");
  };
  ideLauncher("trae", "Trae.exe");                                 // 只有 IDE：什么都不该选中
  const qoderIdeBin = ideLauncher("qoder", "Qoder.exe");           // IDE 的 bin 排在 PATH 最前面，同名的 npm 命令行在后面：应选 npm 的
  touch(path.join(npm, "qoder.cmd"), NPM_SHIM("node_modules\\qoder-cli\\bin\\qoder.js"));
  touch(path.join(npm, "node_modules", "qoder-cli", "bin", "qoder.js"), "// cli\n");

  // 可选依赖被提升到上一层的布局
  hoisted = path.join(tmp, "hoisted");
  touch(path.join(hoisted, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(hoisted, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(hoisted, "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), CUI);
  // 旧版本：主包自带 vendor/<triple>/codex/codex.exe
  legacy = path.join(tmp, "legacy");
  touch(path.join(legacy, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(legacy, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(legacy, "node_modules", "@openai", "codex", "vendor", TRIPLE, "codex", "codex.exe"), CUI);
  touch(path.join(legacy, "node_modules", "@openai", "codex", "vendor", TRIPLE, "path", "rg.exe"), CUI);   // 旧版 codex.js 会把这个目录加进 PATH
  // 可选依赖没装上或 codex.exe 不是 PE 文件（下载失败、被安全软件替换）→ 退回 node + codex.js，让 codex.js 自己报错
  broken = path.join(tmp, "broken");
  touch(path.join(broken, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(broken, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(broken, "node_modules", "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), "#!/bin/sh\necho placeholder\n");
  // pnpm：垫片在 PNPM_HOME\bin，脚本路径以 ..\ 开头
  pnpmHome = path.join(tmp, "pnpm");
  touch(path.join(pnpmHome, "bin", "gemini.cmd"), PNPM_SHIM("..\\global\\5\\.pnpm\\@google+gemini-cli@1.0.0\\node_modules\\@google\\gemini-cli\\dist\\index.js"));
  touch(path.join(pnpmHome, "global", "5", ".pnpm", "@google+gemini-cli@1.0.0", "node_modules", "@google", "gemini-cli", "dist", "index.js"), "// cli\n");
  // pnpm 配置了 nodeExecPath：node 是绝对路径，不能把它当成目标
  touch(path.join(pnpmHome, "bin", "crush.cmd"), PNPM_NODE_SHIM("..\\global\\5\\.pnpm\\crush@1.0.0\\node_modules\\crush\\dist\\index.js"));
  touch(path.join(pnpmHome, "global", "5", ".pnpm", "crush@1.0.0", "node_modules", "crush", "dist", "index.js"), "// cli\n");
  // npm install -g --ignore-scripts：@anthropic-ai/claude-code 的 bin\claude.exe 还是 sh 占位脚本，真正的程序在被提升到同级的平台包里
  pnpmClaude = path.join(tmp, "noscripts-claude");
  touch(path.join(pnpmClaude, "claude.cmd"), NPM_DIRECT_SHIM("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  touch(path.join(pnpmClaude, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "#!/bin/sh\necho 'run install'\n");
  touch(path.join(pnpmClaude, "node_modules", "@anthropic-ai", "claude-code", "cli-wrapper.cjs"), "// wrapper\n");
  touch(path.join(pnpmClaude, "node_modules", "@anthropic-ai", CLAUDE_PLAT, "claude.exe"), CUI);
  // pnpm 全局安装的真实布局：PNPM_HOME\x.cmd → global\5\node_modules\<pkg>（指向 .pnpm\<pkg>@<ver>\node_modules\<pkg> 的 junction），
  // 平台可选依赖是虚拟目录里的同级包；pnpm 默认不跑依赖的 postinstall，所以 claude.exe 还是占位脚本
  pnpmStore = path.join(tmp, "pnpm-store");
  const g5 = path.join(pnpmStore, "global", "5", "node_modules");
  touch(path.join(g5, ".modules.yaml"), "layoutVersion: 5\n");
  const claudeReal = path.join(g5, ".pnpm", "@anthropic-ai+claude-code@2.1.301", "node_modules", "@anthropic-ai", "claude-code");
  touch(path.join(claudeReal, "bin", "claude.exe"), "#!/bin/sh\necho 'run install'\n");
  touch(path.join(claudeReal, "cli-wrapper.cjs"), "// wrapper\n");
  touch(path.join(path.dirname(claudeReal), CLAUDE_PLAT, "claude.exe"), CUI);
  fs.mkdirSync(path.join(g5, "@anthropic-ai"), { recursive: true });
  fs.symlinkSync(claudeReal, path.join(g5, "@anthropic-ai", "claude-code"), "junction");
  touch(path.join(pnpmStore, "claude.cmd"), PNPM_DIRECT_SHIM("global\\5\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  const codexReal = path.join(g5, ".pnpm", "@openai+codex@0.163.0", "node_modules", "@openai", "codex");
  touch(path.join(codexReal, "bin", "codex.js"), "// launcher\n");
  touch(path.join(path.dirname(codexReal), PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), CUI);
  fs.mkdirSync(path.join(g5, "@openai"), { recursive: true });
  fs.symlinkSync(codexReal, path.join(g5, "@openai", "codex"), "junction");
  touch(path.join(pnpmStore, "codex.cmd"), PNPM_SHIM("global\\5\\node_modules\\@openai\\codex\\bin\\codex.js"));
  // 平台包也没有：退到主包的 cli-wrapper.cjs
  wrapperClaude = path.join(tmp, "wrapper-claude");
  touch(path.join(wrapperClaude, "claude.cmd"), NPM_DIRECT_SHIM("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  touch(path.join(wrapperClaude, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "#!/bin/sh\necho 'run install'\n");
  touch(path.join(wrapperClaude, "node_modules", "@anthropic-ai", "claude-code", "cli-wrapper.cjs"), "// wrapper\n");
  // 缓存失效测试用
  cacheDir = path.join(tmp, "cache");
  touch(path.join(cacheDir, "x.cmd"), NPM_SHIM("node_modules\\x\\x.js"));
  touch(path.join(cacheDir, "node_modules", "x", "x.js"), "// v1\n");

  // yarn classic 全局安装：%LOCALAPPDATA%\Yarn\bin\x.cmd 只是转调 Data\global\node_modules\.bin\x.cmd（global.js updateBins 用 cmd-shim 再包一层）
  yarnBin = path.join(tmp, "Yarn", "bin");
  const yarnNm = path.join(tmp, "Yarn", "Data", "global", "node_modules");
  touch(path.join(yarnBin, "codex"), "#!/bin/sh\n");
  touch(path.join(yarnBin, "codex.cmd"), `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\codex.cmd"   %*\r\n`);
  touch(path.join(yarnNm, ".bin", "codex"), "#!/bin/sh\nexec node ...\n");
  touch(path.join(yarnNm, ".bin", "codex.cmd"), PNPM_SHIM("..\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(yarnNm, "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(yarnNm, "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), CUI);
  // 外层包装脚本指向 sh 脚本（而不是 .cmd）→ node 跑不了，退回 cmd.exe
  touch(path.join(yarnBin, "gemini.cmd"), `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\gemini"   %*\r\n`);
  touch(path.join(yarnNm, ".bin", "gemini"), "#!/bin/sh\nexec node ...\n");
  // 自己调自己的 .cmd：链解析不了 → 退回 cmd.exe
  touch(path.join(yarnBin, "loop.cmd"), `@"%~dp0\\loop.cmd"   %*\r\n`);
  // npm 的 postinstall 没跑：包装脚本指向的 .exe 只是占位脚本 → 退回 cmd.exe（让它自己的报错显示出来）
  touch(path.join(npm, "stub.cmd"), NPM_DIRECT_SHIM("node_modules\\stub-tool\\bin\\stub.exe"));
  touch(path.join(npm, "node_modules", "stub-tool", "bin", "stub.exe"), "#!/bin/sh\necho 'run node install.cjs'\n");

  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = [winApps, qoderIdeBin, npm, local, path.join(pnpmHome, "bin")].join(path.delimiter);
  process.env.LOCALAPPDATA = localAppData;
  process.env.APPDATA = path.join(tmp, "AppData", "Roaming");
  process.env.HOME = process.env.USERPROFILE = path.join(tmp, "home");
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  launch = await import("../agents/launch.ts");   // HOME 在模块加载时读取，必须在设好环境变量之后再 import
});
after(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  process.env.PATH = realPath;
  for (const k of ENV_KEYS) { if (realEnv[k] === undefined) delete process.env[k]; else process.env[k] = realEnv[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("Windows 上跳过无扩展名的 sh 脚本，选中 .cmd", () => {
  const bin = launch.findBin("codex");
  assert.ok(bin && bin.endsWith("codex.cmd"), `got ${bin}`);
});

test("同目录有 .exe 与 .cmd 时优先 .exe", () => {
  const bin = launch.findBin("qwen");
  assert.ok(bin && bin.endsWith("qwen.exe"), `got ${bin}`);
});

test("跳过商店应用的执行别名目录（WindowsApps 里的 claude.exe 是桌面版）", () => {
  const bin = launch.findBin("claude");
  assert.ok(bin && bin.endsWith(path.join("npm", "claude.cmd")), `got ${bin}`);
});

test("找不到时返回 null", () => {
  assert.equal(launch.findBin("definitely-not-installed-xyz"), null);
});

test("PE 头：读出 Subsystem，非 PE 文件返回 null", () => {
  assert.equal(launch.peSubsystem(path.join(tmp, "localbin", "qwen.exe")), 3);
  assert.equal(launch.peSubsystem(path.join(tmp, "localbin", "kimi.exe")), 2);
  assert.equal(launch.peSubsystem(path.join(npm, "node_modules", "stub-tool", "bin", "stub.exe")), null);
  assert.equal(launch.peSubsystem(path.join(npm, "codex.cmd")), null);
  assert.equal(launch.peSubsystem(path.join(tmp, "nope.exe")), null);
});

test("图形界面的 .exe 不算命令行：PATH 上同名的桌面版被跳过，选中后面的 .cmd", () => {
  const bin = launch.findBin("kimi");
  assert.ok(bin && bin.endsWith(path.join("localbin", "kimi.cmd")), `got ${bin}`);
});

test("%LOCALAPPDATA%\\Programs\\<name>\\ 只看 bin\\ 子目录：同名桌面应用不会被当成命令行", () => {
  assert.equal(launch.findBin("Cody"), null);
  assert.equal(launch.findBin("bare"), null);
  const droid = launch.findBin("droid");
  assert.ok(droid && droid.endsWith(path.join("Programs", "droid", "bin", "droid.exe")), `got ${droid}`);
});

test("IDE 自带的 bin\\<name>.cmd 背后是图形程序：不当成命令行，排在 PATH 前面也让给后面同名的 npm 命令", () => {
  assert.equal(launch.findBin("trae"), null);
  const bin = launch.findBin("qoder");
  assert.ok(bin && bin.endsWith(path.join("npm", "qoder.cmd")), `got ${bin}`);
});

test("解析 npm 包装脚本得到真正的 node 脚本", () => {
  const script = launch.parseNpmShim(launch.findBin("amp")!);
  assert.ok(script && script.endsWith(path.join("@sourcegraph", "amp", "dist", "main.js")), `got ${script}`);
});

test("解析 pnpm 配置了 nodeExecPath 的包装脚本：绝对路径的 node.exe 不是目标", () => {
  const l = launch.launcherFor(launch.findBin("crush")!);
  assert.equal(l.shell, false);
  assert.ok(l.prefix[0]?.endsWith(path.join("crush", "dist", "index.js")), `got ${JSON.stringify(l)}`);
});

test("解析 pnpm 包装脚本（相对路径带 ..\\）", () => {
  const bin = launch.findBin("gemini");
  assert.ok(bin && bin.endsWith("gemini.cmd"), `got ${bin}`);
  const l = launch.launcherFor(bin!);
  assert.equal(l.shell, false);
  assert.ok(l.prefix[0]?.endsWith(path.join("@google", "gemini-cli", "dist", "index.js")), `got ${l.prefix[0]}`);
});

test("Codex 的 npm 包直接定位到自带的原生二进制（嵌套在主包下），不经 cmd.exe，并补上 codex.js 会设置的环境", () => {
  const l = launch.launcherFor(launch.findBin("codex")!);
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join(PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe")), `got ${l.file}`);
  assert.deepEqual(l.prefix, []);
  assert.deepEqual(l.env, { CODEX_MANAGED_BY_NPM: "1", CODEX_MANAGED_PACKAGE_ROOT: fs.realpathSync.native(path.join(npm, "node_modules", "@openai", "codex")) });
  assert.equal(l.pathPrepend, undefined);   // 新版布局里 rg 在 codex-path\，codex.js 不改 PATH
  const env = launch.envForLauncher(l, { Path: "C:\\Windows", FOO: "1" });
  assert.equal(env.Path, "C:\\Windows");
  assert.equal(env.CODEX_MANAGED_BY_NPM, "1");
  assert.equal(env.FOO, "1");
  assert.equal(launch.envForLauncher({ file: "x", prefix: [], shell: false }, { Path: "p" }).Path, "p");
});

test("Codex：pnpm 全局安装（junction + 虚拟目录）也能找到同级平台包，并按 pnpm 标记由谁管理", () => {
  const l = launch.launcherFor(path.join(pnpmStore, "codex.cmd"));
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join("@openai+codex@0.163.0", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe")), `got ${l.file}`);
  assert.deepEqual(l.env, { CODEX_MANAGED_BY_PNPM: "1", CODEX_MANAGED_PACKAGE_ROOT: fs.realpathSync.native(path.join(pnpmStore, "global", "5", "node_modules", "@openai", "codex")) });
});

test("Codex：可选依赖被提升到上一层时也能找到", () => {
  const l = launch.launcherFor(path.join(hoisted, "codex.cmd"));
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join("node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe")), `got ${l.file}`);
});

test("Codex：旧版本主包自带的 vendor/<triple>/codex/codex.exe", () => {
  const l = launch.launcherFor(path.join(legacy, "codex.cmd"));
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join("vendor", TRIPLE, "codex", "codex.exe")), `got ${l.file}`);
});

test("Codex：codex.exe 只是占位脚本（postinstall 没跑）时退回 node + codex.js", () => {
  const l = launch.launcherFor(path.join(broken, "codex.cmd"));
  assert.equal(l.shell, false);
  assert.equal(l.prefix.length, 1);
  assert.ok(l.prefix[0].endsWith("codex.js"), `got ${l.prefix[0]}`);
});

test("Codex：旧版本随附的 vendor/<triple>/path 加进 PATH 最前面；没有这个目录就不动 PATH", () => {
  const l = launch.launcherFor(path.join(legacy, "codex.cmd"));
  const rg = path.join(legacy, "node_modules", "@openai", "codex", "vendor", TRIPLE, "path");
  assert.deepEqual(l.pathPrepend, [rg]);
  assert.equal(launch.envForLauncher(l, { Path: "C:\\Windows" }).Path, `${rg}${path.delimiter}C:\\Windows`);
  assert.equal(launch.launcherFor(path.join(hoisted, "codex.cmd")).pathPrepend, undefined);
});

test("普通 npm 包用 node 运行脚本，不经 cmd.exe", () => {
  const l = launch.launcherFor(launch.findBin("amp")!);
  assert.equal(l.shell, false);
  assert.equal(l.prefix.length, 1);
  assert.ok(l.prefix[0].endsWith("main.js"));
});

test("Claude Code 的 npm 包：包装脚本指向 bin\\claude.exe，直接运行它", () => {
  const l = launch.launcherFor(launch.findBin("claude")!);
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join("@anthropic-ai", "claude-code", "bin", "claude.exe")), `got ${l.file}`);
  assert.deepEqual(l.prefix, []);
});

test("Claude Code：bin\\claude.exe 还是占位脚本（没跑 postinstall）时用提升到同级的平台包里的 claude.exe", () => {
  const l = launch.launcherFor(path.join(pnpmClaude, "claude.cmd"));
  assert.equal(l.shell, false);
  assert.equal(l.file, path.join(pnpmClaude, "node_modules", "@anthropic-ai", CLAUDE_PLAT, "claude.exe"));
  assert.deepEqual(l.prefix, []);
});

test("Claude Code：pnpm 全局安装（junction + 虚拟目录）时找到虚拟目录里同级的平台包", () => {
  const l = launch.launcherFor(path.join(pnpmStore, "claude.cmd"));
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join("@anthropic-ai+claude-code@2.1.301", "node_modules", "@anthropic-ai", CLAUDE_PLAT, "claude.exe")), `got ${l.file}`);
  assert.deepEqual(l.prefix, []);
});

test("Claude Code：平台包也没有时用 node 跑主包的 cli-wrapper.cjs", () => {
  const l = launch.launcherFor(path.join(wrapperClaude, "claude.cmd"));
  assert.equal(l.shell, false);
  assert.ok(l.prefix[0]?.endsWith(path.join("@anthropic-ai", "claude-code", "cli-wrapper.cjs")), `got ${JSON.stringify(l)}`);
});

test("启动方式缓存：目标文件没了就重新解析；resetLaunchers 强制重新解析", () => {
  const cmd = path.join(cacheDir, "x.cmd");
  const first = launch.launcherFor(cmd);
  assert.ok(first.prefix[0]?.endsWith(path.join("x", "x.js")), `got ${JSON.stringify(first)}`);
  // 包升级：脚本换了位置，旧目标被删
  fs.rmSync(path.join(cacheDir, "node_modules", "x", "x.js"));
  touch(path.join(cacheDir, "node_modules", "x", "dist", "x.js"), "// v2\n");
  fs.writeFileSync(cmd, NPM_SHIM("node_modules\\x\\dist\\x.js"));
  const second = launch.launcherFor(cmd);
  assert.ok(second.prefix[0]?.endsWith(path.join("x", "dist", "x.js")), `got ${JSON.stringify(second)}`);
  // 旧目标还在但包装脚本改了：缓存照旧，直到 resetLaunchers
  touch(path.join(cacheDir, "node_modules", "x", "x.js"), "// v3\n");
  fs.writeFileSync(cmd, NPM_SHIM("node_modules\\x\\x.js"));
  assert.ok(launch.launcherFor(cmd).prefix[0]?.endsWith(path.join("x", "dist", "x.js")));
  launch.resetLaunchers();
  assert.ok(launch.launcherFor(cmd).prefix[0]?.endsWith(path.join("x", "x.js")));
});

test("包装脚本指向没有扩展名的脚本时也用 node 运行", () => {
  const l = launch.launcherFor(launch.findBin("codebuddy")!);
  assert.equal(l.shell, false);
  assert.ok(l.prefix[0]?.endsWith(path.join("bin", "codebuddy")), `got ${l.prefix[0]}`);
});

test("包装脚本直接指向 .exe 时直接运行该 .exe", () => {
  const l = launch.launcherFor(launch.findBin("native")!);
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith("native.exe"), `got ${l.file}`);
  assert.deepEqual(l.prefix, []);
});

test("yarn global 的两层 .cmd 包装：顺着链找到真正的脚本 / 原生二进制，不把 .cmd 交给 node", () => {
  const l = launch.launcherFor(path.join(yarnBin, "codex.cmd"));
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join(PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe")), `got ${JSON.stringify(l)}`);
  for (const p of [l.file, ...l.prefix]) assert.ok(!/\.(cmd|bat)$/i.test(p), `batch file handed to node: ${p}`);
});

test("包装脚本指向 sh 脚本或自己调自己时退回 cmd.exe", () => {
  assert.equal(launch.launcherFor(path.join(yarnBin, "gemini.cmd")).shell, true);
  assert.equal(launch.launcherFor(path.join(yarnBin, "loop.cmd")).shell, true);
});

test("包装脚本指向的 .exe 只是占位脚本时退回 cmd.exe", () => {
  const l = launch.launcherFor(launch.findBin("stub")!);
  assert.equal(l.shell, true);
  assert.ok(l.file.endsWith("stub.cmd"), `got ${l.file}`);
});

test("非 npm 生成的 .cmd 退回 cmd.exe，参数按 cmd 规则加引号", () => {
  const l = launch.launcherFor(launch.findBin("custom")!);
  assert.equal(l.shell, true);
  assert.equal(launch.quoteForCmd(""), '""');
  assert.equal(launch.quoteForCmd("plain"), "plain");
  assert.equal(launch.quoteForCmd("has space"), '"has space"');
  assert.equal(launch.quoteForCmd('say "hi"'), '"say \\"hi\\""');
  assert.equal(launch.quoteForCmd("notify=[]"), "notify=[]");
});

test("子进程环境：只去掉嵌套会话标记，其余 CLAUDE_* 配置（git-bash 路径、配置目录、OAuth token）保留", () => {
  const env = launch.stripNestedClaudeEnv({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "1", CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe", CLAUDE_CONFIG_DIR: "D:\\claude", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "x" });
  assert.deepEqual(env, { CLAUDE_CODE_GIT_BASH_PATH: "C:\\Git\\bin\\bash.exe", CLAUDE_CONFIG_DIR: "D:\\claude", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "x" });
});

test("给用户看的路径：Windows 按 PowerShell 写法，带引号的路径用 & 调用", () => {
  assert.equal(launch.quoteForDisplay("C:\\Users\\a b\\x.cmd"), "& 'C:\\Users\\a b\\x.cmd'");
  assert.equal(launch.quoteForDisplay("C:\\it's\\x.cmd"), "& 'C:\\it''s\\x.cmd'");
});
