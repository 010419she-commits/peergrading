import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRepositoryProcess } from "../repository/process.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-process-output-"));
after(() => fs.rm(temporary, { recursive: true, force: true }));
const nodeCommand = (script: string) => [process.execPath, "-e", script];

test("tail mode retains bounded stdout/stderr tails and lets verbose passing checks finish", async () => {
  const max = 200_000;
  const result = await runRepositoryProcess(nodeCommand(`
    process.stdout.write('old stdout\\n' + 'x'.repeat(400000) + '\\nALL TESTS PASSED\\n');
    process.stderr.write('old stderr\\n' + 'y'.repeat(410000) + '\\nFINAL WARNING\\n');
  `), temporary, { maxOutput: max, outputMode: "tail", timeoutMs: 5000 });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.length, max);
  assert.equal(result.stderr.length, max);
  assert.match(result.stdout, /\nALL TESTS PASSED\n$/);
  assert.match(result.stderr, /\nFINAL WARNING\n$/);
  assert.equal(result.stdout.includes("old stdout"), false);
  assert.equal(result.stderr.includes("old stderr"), false);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("tail mode preserves a failing exit even when verbose output ends in an approval", async () => {
  const result = await runRepositoryProcess(nodeCommand(`
    process.stdout.write('x'.repeat(250000) + '\\nVERDICT: APPROVE\\n');
    process.stderr.write('actual check failed\\n');
    process.exitCode = 7;
  `), temporary, { maxOutput: 200_000, outputMode: "tail", timeoutMs: 5000 });
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /VERDICT: APPROVE\n$/);
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderr, "actual check failed\n");
  assert.equal(result.stderrTruncated, undefined);
});

test("strict output remains the default and rejects oversized data instead of returning a partial result", async () => {
  await assert.rejects(runRepositoryProcess(nodeCommand(`
    process.stdout.write('x'.repeat(250000));
  `), temporary, { maxOutput: 200_000, timeoutMs: 5000 }), /命令输出超过安全大小限制/);
});

test("tail mode still times out a verbose command rather than treating its last PASS as success", async () => {
  const result = await runRepositoryProcess(nodeCommand(`
    process.stdout.write('x'.repeat(250000) + '\\nPASS\\n');
    setInterval(() => {}, 1000);
  `), temporary, { maxOutput: 200_000, outputMode: "tail", timeoutMs: 500 });
  assert.equal(result.timedOut, true);
  assert.match(result.stdout, /PASS\n$/);
  assert.equal(result.stdoutTruncated, true);
});

test("tail mode cancellation still stops a running verbose command and rejects with aborted", async () => {
  const controller = new AbortController();
  const pidFile = path.join(temporary, "verbose.pid");
  const running = runRepositoryProcess(nodeCommand(`
    const fs = require('node:fs');
    process.stdout.write('x'.repeat(250000), () => {
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    });
    setInterval(() => {}, 1000);
  `), temporary, { signal: controller.signal, maxOutput: 200_000, outputMode: "tail", timeoutMs: 10_000 });
  const stopped = assert.rejects(running, /aborted/);
  let pid = 0;
  try {
    for (let attempt = 0; attempt < 500; attempt++) {
      pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
      if (pid) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(pid > 0, "the command must finish its verbose output before cancellation");
    controller.abort();
    await stopped;
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    controller.abort();
    await stopped;
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
});

test("tail mode marks no truncation when output fits, including an exact limit", async () => {
  const result = await runRepositoryProcess(nodeCommand(`
    process.stdout.write('x'.repeat(100)); process.stderr.write('y'.repeat(100));
  `), temporary, { maxOutput: 100, outputMode: "tail" });
  assert.equal(result.stdout, "x".repeat(100));
  assert.equal(result.stderr, "y".repeat(100));
  assert.equal(result.stdoutTruncated, undefined);
  assert.equal(result.stderrTruncated, undefined);
});
