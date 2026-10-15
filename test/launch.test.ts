// test/launch.test.ts — 命令行 agent 的查找与启动方式（重点：Windows 的 npm 包装脚本）
// 运行：npm test。Windows 分支通过临时把 process.platform 改成 win32 来模拟，目录布局与 npm 在 Windows 上生成的一致。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realPlatform = process.platform;
const realPath = process.env.PATH;
let tmp: string;
let launch: typeof import("../agents/launch.ts");

const NPM_SHIM = (rel: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*\r\n`;

function touch(p: string, content = "") { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pg-launch-"));
  const npm = path.join(tmp, "npm");
  // npm -g 在 Windows 上为每个命令生成三个文件：无扩展名的 sh 脚本、.cmd、.ps1
  touch(path.join(npm, "codex"), "#!/bin/sh\nexec node ...\n");
  touch(path.join(npm, "codex.cmd"), NPM_SHIM("node_modules\\@openai\\codex\\bin\\codex.js"));
  touch(path.join(npm, "codex.ps1"), "#!/usr/bin/env pwsh\n");
  touch(path.join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"), "// launcher\n");
  touch(path.join(npm, "node_modules", "@openai", "codex", "vendor", process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc", "codex", "codex.exe"), "MZ");
  touch(path.join(npm, "claude"), "#!/bin/sh\n");
  touch(path.join(npm, "claude.cmd"), NPM_SHIM("node_modules\\@anthropic-ai\\claude-code\\cli.js"));
  touch(path.join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js"), "// cli\n");
  // 手写的 .cmd（不是 npm 生成的）→ 只能退回 cmd.exe
  touch(path.join(npm, "custom.cmd"), "@echo off\r\nsomething.exe %*\r\n");
  // 原生安装：claude.exe 与 .cmd 同时存在时应优先 .exe
  const local = path.join(tmp, "localbin");
  touch(path.join(local, "qwen.cmd"), NPM_SHIM("x.js"));
  touch(path.join(local, "qwen.exe"), "MZ");

  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = [npm, local].join(path.delimiter);
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

test("找不到时返回 null", () => {
  assert.equal(launch.findBin("definitely-not-installed-xyz"), null);
});

test("解析 npm 包装脚本得到真正的 node 脚本", () => {
  const script = launch.parseNpmShim(launch.findBin("claude")!);
  assert.ok(script && script.endsWith(path.join("@anthropic-ai", "claude-code", "cli.js")), `got ${script}`);
});

test("Codex 的 npm 包直接定位到自带的原生二进制，不经 cmd.exe", () => {
  const l = launch.launcherFor(launch.findBin("codex")!);
  assert.equal(l.shell, false);
  assert.ok(l.file.endsWith("codex.exe"), `got ${l.file}`);
  assert.deepEqual(l.prefix, []);
});

test("普通 npm 包用 node 运行脚本，不经 cmd.exe", () => {
  const l = launch.launcherFor(launch.findBin("claude")!);
  assert.equal(l.shell, false);
  assert.equal(l.prefix.length, 1);
  assert.ok(l.prefix[0].endsWith("cli.js"));
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

test("给用户看的路径：Windows 用双引号", () => {
  assert.equal(launch.quoteForDisplay("C:\\Users\\a b\\x.cmd"), '"C:\\Users\\a b\\x.cmd"');
});
