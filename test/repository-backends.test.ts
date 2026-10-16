import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackend, buildCliArgs } from "../agents/backends.ts";
import type { ChatRequest } from "../agents/types.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-repo-backends-"));
after(() => fs.rm(temporary, { recursive: true, force: true }));
test("repository CLI arguments grant phase-specific tools while ordinary conversations retain text-only arguments", () => {
  const claude = { type: "claude-code", bin: "claude" } as const;
  const codex = { type: "codex", bin: "codex" } as const;
  const author = buildCliArgs(claude, "system", "prompt", "write").args;
  const review = buildCliArgs(claude, "system", "prompt", "read-only").args;
  assert.equal(author[author.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write");
  assert.equal(review[review.indexOf("--tools") + 1], "Read,Glob,Grep"); assert.ok(review.includes("plan")); assert.ok(author.includes("--restricted"));
  const ordinary = buildCliArgs(claude, "system", "prompt").args;
  assert.equal(ordinary[ordinary.indexOf("--tools") + 1], ""); assert.equal(ordinary[ordinary.indexOf("--max-turns") + 1], "1");
  assert.ok(buildCliArgs(codex, "system", "prompt", "write").args.includes("workspace-write"));
  assert.ok(buildCliArgs(codex, "system", "prompt", "read-only").args.includes("read-only"));
  assert.throws(() => buildCliArgs({ type: "gemini-cli", bin: "gemini" }, "", "", "write"), /只支持/);
});
function request(signal = new AbortController().signal): ChatRequest { return { system: "test", turns: [{ role: "user", text: "test" }], lang: "en", cwd: temporary, signal, onDelta: () => {} }; }
async function fake(body: string) {
  const filename = path.join(temporary, `fake-${Math.random().toString(36).slice(2)}.mjs`); await fs.writeFile(filename, body);
  // Generic text mode lets the test use the exact Node binary on Windows as well.
  return createBackend({ type: "generic", bin: process.execPath, args: [filename], promptVia: "stdin", parse: "text" }, { emit: () => {} });
}
test("nonzero CLI exits are failures even after emitting usable answer text", async () => {
  const backend = await fake(`console.log('VERDICT: APPROVE'); process.exitCode=7;`);
  await assert.rejects(backend.chat(request()), /exit 7/);
});
test("a pre-aborted request never starts the CLI", async () => {
  const marker = path.join(temporary, "unexpected");
  const backend = await fake(`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran'); console.log('done');`);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(backend.chat(request(controller.signal)), /aborted/);
  assert.equal(await fs.stat(marker).then(() => true, () => false), false);
});
