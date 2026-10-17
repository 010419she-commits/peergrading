import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareRepository, type RepositoryCheck, type RepositoryReview } from "../repository/workspace.ts";
import { runCollaboration, type RunConfig } from "../orchestrator.ts";
import type { Backend } from "../agents/types.ts";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pg-check-binding-"));
after(async () => {
  const resolved = path.resolve(temporary);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(resolved, { recursive: true, force: true });
});
function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const signal = () => new AbortController().signal;
const command = (script: string): RepositoryCheck => ({ argv: [process.execPath, "-e", script] });
async function fixture(name: string, checks: RepositoryCheck[]) {
  const repo = path.join(temporary, name); await fs.mkdir(repo);
  git(repo, ["init", "-b", "main"]); git(repo, ["config", "user.name", "Test"]); git(repo, ["config", "user.email", "test@example.invalid"]);
  await fs.writeFile(path.join(repo, "app.txt"), "valid\n");
  await fs.writeFile(path.join(repo, ".gitignore"), ".cache/\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-m", "baseline"]);
  const config = { path: repo, sessionDir: path.join(temporary, `${name}-session`), checks };
  return { repo, config };
}

test("unchanged checks bind tracked and new files to the final Git tree and persist execution receipts", async () => {
  const { repo, config } = await fixture("stable", [command("const fs=require('fs'); if(fs.readFileSync('added.txt','utf8')!=='new input')process.exit(1); console.log('verified')")]);
  const workspace = await prepareRepository(config, signal());
  await fs.writeFile(path.join(workspace.manifest.worktreePath, "added.txt"), "new input");
  const checks = await workspace.runChecks(1, signal());
  const snapshot = await workspace.snapshot(1, "A", "Add verified input", checks, signal());
  const check = checks[0];
  assert.equal(check.ok, true); assert.equal(check.evidenceValid, true); assert.equal(check.stdout.trim(), "verified");
  assert.match(check.id, /^[0-9a-f-]{36}$/); assert.ok(Date.parse(check.finishedAt) >= Date.parse(check.startedAt));
  assert.equal(check.treeBefore, snapshot.tree); assert.equal(check.treeAfter, snapshot.tree);
  assert.equal(snapshot.tree, git(workspace.manifest.worktreePath, ["rev-parse", `${snapshot.commit}^{tree}`]));
  const review: RepositoryReview = { id: randomUUID(), round: 1, version: 1, commit: snapshot.commit, reviewer: "B", kind: "review", verdict: "approve", checkIds: [check.id], createdAt: new Date().toISOString() };
  await workspace.recordReview(review, signal());
  const manifest = JSON.parse(await fs.readFile(path.join(workspace.artifactDir, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.reviews, [review]); assert.equal(manifest.checks[0].treeAfter, manifest.snapshots[0].tree);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  await workspace.close("approved");
});

test("a later passing command that changes deliverables invalidates every earlier check and prevents approval", async () => {
  const { repo, config } = await fixture("mutating-batch", [
    command("const fs=require('fs');if(fs.readFileSync('app.txt','utf8').trim()!=='valid')process.exit(1)"),
    command("require('fs').writeFileSync('app.txt','invalid\\n')"),
  ]);
  const agent = (name: string) => ({ name, persona: "", agent: { id: name, kind: "cli", title: name, subtitle: "", model: "fake", local: true, status: "ready", auto: true, runner: { type: "codex", bin: "unused" }, icon: "" } as any });
  const backend = (text: string): Backend => ({ async chat() { return { text }; } });
  const cfg: RunConfig = { task: "Keep app.txt valid", lang: "en", agentA: agent("A"), agentB: agent("B"), maxRounds: 1, discussionTurns: 0, cwd: repo, repository: config };
  const result = await runCollaboration(cfg, () => {}, signal(), { A: backend("No edits"), B: backend("VERDICT: APPROVE") });
  const snapshot = result.repository!.snapshots[0];
  assert.equal(result.approved, false); assert.equal(result.repository!.status, "max_rounds");
  assert.deepEqual(snapshot.checks.map((check) => check.code), [0, 0]);
  assert.ok(snapshot.checks.every((check) => !check.ok && !check.evidenceValid));
  assert.notEqual(snapshot.checks[0].treeAfter, snapshot.tree);
  assert.equal(await fs.readFile(path.join(result.repository!.worktreePath, "app.txt"), "utf8"), "invalid\n");
  assert.equal(await fs.readFile(path.join(repo, "app.txt"), "utf8"), "valid\n");
});

test("changes to new untracked deliverables invalidate evidence while ignored cache writes do not", async () => {
  for (const ignored of [false, true]) {
    const name = ignored ? "ignored-cache" : "new-deliverable";
    const script = ignored
      ? "const fs=require('fs');fs.mkdirSync('.cache',{recursive:true});fs.writeFileSync('.cache/result','built')"
      : "require('fs').writeFileSync('generated.txt','not previously tested')";
    const { config } = await fixture(name, [command(script)]);
    const workspace = await prepareRepository(config, signal());
    const checks = await workspace.runChecks(1, signal());
    const snapshot = await workspace.snapshot(1, "A", name, checks, signal());
    assert.equal(checks[0].ok, ignored); assert.equal(checks[0].evidenceValid, ignored);
    if (ignored) {
      assert.equal(checks[0].treeBefore, snapshot.tree);
      assert.equal(git(workspace.manifest.worktreePath, ["status", "--porcelain"]), "");
    } else assert.notEqual(checks[0].treeBefore, checks[0].treeAfter);
    await workspace.close("max_rounds");
  }
});

test("edits made between validation and snapshot cannot inherit old passing evidence", async () => {
  const { config } = await fixture("after-check-drift", [command("console.log('passed')")]);
  const workspace = await prepareRepository(config, signal());
  const checks = await workspace.runChecks(1, signal()); assert.equal(checks[0].ok, true);
  await fs.writeFile(path.join(workspace.manifest.worktreePath, "app.txt"), "changed after checking\n");
  const snapshot = await workspace.snapshot(1, "A", "Late edit", checks, signal());
  assert.equal(checks[0].ok, false); assert.equal(checks[0].evidenceValid, false); assert.notEqual(checks[0].treeAfter, snapshot.tree);
  await assert.rejects(workspace.recordReview({ id: randomUUID(), round: 1, version: 1, commit: snapshot.commit, reviewer: "B", kind: "review", verdict: "approve", checkIds: [checks[0].id], createdAt: new Date().toISOString() }, signal()), /校验未通过或证据已失效/);
  await workspace.close("max_rounds");
});

test("review receipts reject another revision, mismatched evidence and writes during review", async () => {
  const { config } = await fixture("review-identity", [command("console.log('passed')")]);
  const workspace = await prepareRepository(config, signal());
  const checks = await workspace.runChecks(1, signal());
  const snapshot = await workspace.snapshot(1, "A", "Candidate", checks, signal());
  const receipt: RepositoryReview = { id: randomUUID(), round: 1, version: 1, commit: snapshot.commit, reviewer: "B", kind: "review", verdict: "approve", checkIds: [checks[0].id], createdAt: new Date().toISOString() };
  await assert.rejects(workspace.recordReview({ ...receipt, commit: snapshot.baseCommit }, signal()), /不匹配/);
  await assert.rejects(workspace.recordReview({ ...receipt, checkIds: [randomUUID()] }, signal()), /不匹配/);
  assert.equal(workspace.manifest.reviews?.length ?? 0, 0);
  await fs.writeFile(path.join(workspace.manifest.worktreePath, "app.txt"), "reviewer's change\n");
  await assert.rejects(workspace.recordReview(receipt, signal()), /审查或讨论阶段意外修改/);
  assert.equal(workspace.manifest.reviews?.length ?? 0, 0);
  await workspace.close("failed");
});

test("validation commands cannot replace the application-owned Git checkpoint", async () => {
  const { repo, config } = await fixture("git-mutation", [command("require('node:child_process').execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','unauthorized'],{stdio:'ignore'})")]);
  const original = git(repo, ["rev-parse", "HEAD"]);
  const workspace = await prepareRepository(config, signal());
  await assert.rejects(workspace.runChecks(1, signal()), /意外修改了 Git 分支或提交/);
  assert.equal(git(repo, ["rev-parse", "HEAD"]), original);
  assert.equal(workspace.manifest.snapshots.length, 0);
  await workspace.close("failed");
});

test("cancelled validation preserves partial files without inventing passing evidence and releases its lock", async () => {
  const { repo, config } = await fixture("cancel-binding", [command("const fs=require('fs');fs.writeFileSync('partial.txt','partial');fs.writeFileSync('ready.txt','ready');setInterval(()=>{},1000)")]);
  const workspace = await prepareRepository(config, signal());
  const controller = new AbortController();
  const stopped = assert.rejects(workspace.runChecks(1, controller.signal), /aborted/);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      ready = await fs.stat(path.join(workspace.manifest.worktreePath, "ready.txt")).then(() => true, () => false);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ready, true);
    controller.abort(); await stopped;
    assert.equal(workspace.manifest.checks.length, 0); assert.equal(workspace.manifest.snapshots.length, 0);
    assert.equal(await fs.readFile(path.join(workspace.manifest.worktreePath, "partial.txt"), "utf8"), "partial");
    await workspace.close("cancelled");
    const next = await prepareRepository({ path: repo, sessionDir: path.join(temporary, "after-cancel-session") }, signal());
    await next.close("cancelled");
  } finally { controller.abort(); }
});
