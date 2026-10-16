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

function touch(p: string, content = "") { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }

let npm: string, hoisted: string, legacy: string, broken: string, pnpmHome: string, yarnBin: string;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-launch-"));
  npm = path.join(tmp, "npm");
  // npm -g 在 Windows 上为每个命令生成三个文件：无扩展名的 sh 脚本、.cmd、.ps1
  touch(path.join(npm, "codex"), "#!/bin/sh\nexec node ...\n");
  touch(path.join(npm, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(npm, "codex.ps1"), "#!/usr/bin/env pwsh\n");
  touch(path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  // 当前 @openai/codex 的布局：原生二进制在可选依赖 @openai/codex-win32-x64 里，嵌套在主包下
  touch(path.join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), "MZ\u0090\u0000");
  touch(path.join(npm, "claude"), "#!/bin/sh\n");
  touch(path.join(npm, "claude.cmd"), NPM_SHIM("node_modules\\@anthropic-ai\\claude-code\\cli.js"));
  touch(path.join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "// cli\n");
  // 包装脚本直接指向 .exe（bin 是原生二进制的 npm 包）
  touch(path.join(npm, "native.cmd"), NPM_SHIM("node_modules\\some-tool\\bin\\native.exe"));
  touch(path.join(npm, "node_modules", "some-tool", "bin", "native.exe"), "MZ");
  // 包装脚本指向没有扩展名的 node 脚本（如 @tencent-ai/codebuddy-code 的 bin/codebuddy）
  touch(path.join(npm, "codebuddy.cmd"), NPM_SHIM("node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy"));
  touch(path.join(npm, "node_modules", "@tencent-ai", "codebuddy-code", "bin", "codebuddy"), "#!/usr/bin/env node\n");
  // 手写的 .cmd（不是 npm 生成的）→ 只能退回 cmd.exe
  touch(path.join(npm, "custom.cmd"), "@echo off\r\nsomething.exe %*\r\n");
  // 原生安装：claude.exe 与 .cmd 同时存在时应优先 .exe
  const local = path.join(tmp, "localbin");
  touch(path.join(local, "qwen.cmd"), NPM_SHIM("x.js"));
  touch(path.join(local, "qwen.exe"), "MZ");
  // 商店应用的执行别名目录：这里的 claude.exe 是桌面版，不是命令行，即使排在 PATH 最前面也要跳过
  const winApps = path.join(tmp, "AppData", "Local", "Microsoft", "WindowsApps");
  touch(path.join(winApps, "claude.exe"), "MZ");

  // 可选依赖被提升到上一层的布局
  hoisted = path.join(tmp, "hoisted");
  touch(path.join(hoisted, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(hoisted, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(hoisted, "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), "MZ");
  // 旧版本：主包自带 vendor/<triple>/codex/codex.exe
  legacy = path.join(tmp, "legacy");
  touch(path.join(legacy, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(legacy, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(legacy, "node_modules", "@openai", "codex", "vendor", TRIPLE, "codex", "codex.exe"), "MZ");
  // postinstall 没跑：codex.exe 是占位脚本而不是 PE 文件 → 退回 node + codex.js
  broken = path.join(tmp, "broken");
  touch(path.join(broken, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(broken, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(broken, "node_modules", "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), "#!/bin/sh\necho placeholder\n");
  // pnpm：垫片在 PNPM_HOME\bin，脚本路径以 ..\ 开头
  pnpmHome = path.join(tmp, "pnpm");
  touch(path.join(pnpmHome, "bin", "gemini.cmd"), PNPM_SHIM("..\\global\\5\\.pnpm\\@google+gemini-cli@1.0.0\\node_modules\\@google\\gemini-cli\\dist\\index.js"));
  touch(path.join(pnpmHome, "global", "5", ".pnpm", "@google+gemini-cli@1.0.0", "node_modules", "@google", "gemini-cli", "dist", "index.js"), "// cli\n");

  // yarn classic 全局安装：%LOCALAPPDATA%\Yarn\bin\x.cmd 只是转调 Data\global\node_modules\.bin\x.cmd（global.js updateBins 用 cmd-shim 再包一层）
  yarnBin = path.join(tmp, "Yarn", "bin");
  const yarnNm = path.join(tmp, "Yarn", "Data", "global", "node_modules");
  touch(path.join(yarnBin, "codex"), "#!/bin/sh\n");
  touch(path.join(yarnBin, "codex.cmd"), `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\codex.cmd"   %*\r\n`);
  touch(path.join(yarnNm, ".bin", "codex"), "#!/bin/sh\nexec node ...\n");
  touch(path.join(yarnNm, ".bin", "codex.cmd"), PNPM_SHIM("..\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(yarnNm, "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(yarnNm, "@openai", "codex", "node_modules", "@openai", PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe"), "MZ");
  // 外层包装脚本指向 sh 脚本（而不是 .cmd）→ node 跑不了，退回 cmd.exe
  touch(path.join(yarnBin, "gemini.cmd"), `@"%~dp0\\..\\Data\\global\\node_modules\\.bin\\gemini"   %*\r\n`);
  touch(path.join(yarnNm, ".bin", "gemini"), "#!/bin/sh\nexec node ...\n");
  // 自己调自己的 .cmd：链解析不了 → 退回 cmd.exe
  touch(path.join(yarnBin, "loop.cmd"), `@"%~dp0\\loop.cmd"   %*\r\n`);
  // npm 的 postinstall 没跑：包装脚本指向的 .exe 只是占位脚本 → 退回 cmd.exe（让它自己的报错显示出来）
  touch(path.join(npm, "stub.cmd"), NPM_SHIM("node_modules\\stub-tool\\bin\\stub.exe"));
  touch(path.join(npm, "node_modules", "stub-tool", "bin", "stub.exe"), "#!/bin/sh\necho 'run node install.cjs'\n");

  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = [winApps, npm, local, path.join(pnpmHome, "bin")].join(path.delimiter);
  launch = await import("../agents/launch.ts");
});
after(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  process.env.PATH = realPath;
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

test("解析 npm 包装脚本得到真正的 node 脚本", () => {
  const script = launch.parseNpmShim(launch.findBin("claude")!);
  assert.ok(script && script.endsWith(path.join("@anthropic-ai", "claude-code", "cli.js")), `got ${script}`);
});

test("解析 pnpm 包装脚本（相对路径带 ..\\）", () => {
  const bin = launch.findBin("gemini");
  assert.ok(bin && bin.endsWith("gemini.cmd"), `got ${bin}`);
  const l = launch.launcherFor(bin!);
  assert.equal(l.shell, false);
  assert.ok(l.prefix[0]?.endsWith(path.join("@google", "gemini-cli", "dist", "index.js")), `got ${l.prefix[0]}`);
});

test("Codex 的 npm 包直接定位到自带的原生二进制（嵌套在主包下），不经 cmd.exe", () => {
  const l = launch.launcherFor(launch.findBin("codex")!);
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith(path.join(PLAT_PKG, "vendor", TRIPLE, "bin", "codex.exe")), `got ${l.file}`);
  assert.deepEqual(l.prefix, []);
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

test("普通 npm 包用 node 运行脚本，不经 cmd.exe", () => {
  const l = launch.launcherFor(launch.findBin("claude")!);
  assert.equal(l.shell, false);
  assert.equal(l.prefix.length, 1);
  assert.ok(l.prefix[0].endsWith("cli.js"));
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
