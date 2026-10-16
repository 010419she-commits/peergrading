import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const actualPlatform = process.platform;
const actualPath = process.env.PATH;
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-repo-win-"));
let run: typeof import("../repository/process.ts");
before(async () => {
  const target = path.join(temporary, "node_modules", "npm", "bin", "npm-cli.js");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  await fs.writeFile(path.join(temporary, "npm.cmd"), '@ECHO off\r\n"%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
  await fs.writeFile(path.join(temporary, "unknown.cmd"), "@echo unsafe shell wrapper\r\n");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  process.env.PATH = temporary;
  run = await import("../repository/process.ts");
});
after(async () => {
  Object.defineProperty(process, "platform", { value: actualPlatform, configurable: true });
  process.env.PATH = actualPath;
  await fs.rm(temporary, { recursive: true, force: true });
});

test("Windows validation resolves npm and npm.cmd without cmd.exe and preserves argv boundaries", async () => {
  const args = ["test", "argument with spaces", "literal&value;$(echo)"];
  for (const executable of ["npm", "npm.cmd"]) {
    const result = await run.runRepositoryProcess([executable, ...args], temporary);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  }
});

test("Windows unknown command wrappers cannot fall back to shell execution", async () => {
  await assert.rejects(run.runRepositoryProcess(["unknown", "x&y"], temporary), /无法安全启动/);
});
