import { test } from "node:test";
import assert from "node:assert/strict";
import { runCollaboration, type AgentConfig, type Event, type RunConfig } from "../orchestrator.ts";
import type { Backend, ChatRequest, Turn } from "../agents/types.ts";
import { savedApiAgents } from "../agents/api.ts";
import { detectLocalOpenAIAgents } from "../agents/local.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function slot(name: string, deployment: "local" | "cloud"): AgentConfig {
  return { name, persona: "", agent: {
    id: name, kind: deployment === "local" ? "local" : "api", title: name, subtitle: "", model: "fixture-model",
    local: deployment === "local", deployment, status: "ready", auto: true, icon: "",
    runner: { type: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture-not-a-secret", model: "fixture-model" },
  } };
}
function config(acceleration?: RunConfig["acceleration"]): RunConfig {
  return { task: "Write and review", lang: "en", cwd: process.cwd(), maxRounds: 1, discussionTurns: 0,
    agentA: slot("A", "local"), agentB: slot("B", "cloud"), acceleration };
}
function snapshot(request: ChatRequest) {
  return { system: request.system, turns: structuredClone(request.turns), cache: request.cache };
}
function waitForAbort(signal: AbortSignal, onAbort: () => void): Promise<never> {
  return new Promise((_, reject) => {
    const aborted = () => { onAbort(); reject(new Error("aborted")); };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

test("cloud and local OpenAI factories declare explicit deployment without probing generation", async () => {
  const cloud = savedApiAgents([{ id: "cloud-fixture", name: "Cloud", provider: "custom", baseUrl: "https://api.example.com/v1", model: "cloud-model", apiKey: "fixture-key" }]);
  assert.equal(cloud[0].deployment, "cloud");
  const local = await detectLocalOpenAIAgents({
    env: { NINFER_URL: "http://127.0.0.1:8080/v1" }, timeoutMs: 100,
    fetch: async (url) => {
      assert.match(String(url), /\/models$/);
      return Response.json({ data: [{ id: "local-model" }] });
    },
  });
  assert.ok(local.length > 0);
  assert.ok(local.every((agent) => agent.deployment === "local" && agent.local));
});

test("candidate review starts during author output and an approval is replayed in normal event order", async () => {
  const candidateStarted = deferred();
  let authorFinished = false;
  const seenB: ReturnType<typeof snapshot>[] = [];
  const A: Backend = { async chat(request) {
    assert.equal(request.cache, true);
    request.onDelta("<deliverable>Version one</deliverable>");
    await candidateStarted.promise;
    assert.equal(authorFinished, false, "the candidate must start before the author returns");
    request.onDelta("\nTrailing author note");
    authorFinished = true;
    return { text: "<deliverable>Version one</deliverable>\nTrailing author note" };
  } };
  const B: Backend = { async chat(request) {
    seenB.push(snapshot(request));
    assert.equal(request.cache, true);
    assert.equal(authorFinished, false);
    candidateStarted.resolve();
    request.onDelta("Cloud review.\n");
    request.onDelta("VERDICT: APPROVE");
    return { text: "Cloud review.\nVERDICT: APPROVE", cacheHit: true,
      apiMessage: { role: "assistant", content: "Cloud review.\nVERDICT: APPROVE", reasoning_content: "PRIVATE_CANDIDATE_REASONING" } };
  } };
  const events: Event[] = [];
  const result = await runCollaboration(config({ speculativeReview: true, cache: true }), (event) => events.push(event), new AbortController().signal, { A, B });

  assert.equal(result.approved, true);
  assert.equal(seenB.length, 1, "approval must reuse the candidate instead of requesting another review");
  assert.deepEqual(result.acceleration, { started: 1, adopted: 1, fallbacks: 0, cacheHits: 1, overlapMs: result.acceleration!.overlapMs });
  const reviewStart = events.findIndex((event) => event.type === "message_start" && event.agent === "B" && event.kind === "review");
  const reviewId = (events[reviewStart] as any).id;
  const firstReviewDelta = events.findIndex((event) => event.type === "delta" && event.id === reviewId);
  const reviewEnd = events.findIndex((event) => event.type === "message_end" && event.id === reviewId);
  const version = events.findIndex((event) => event.type === "version");
  assert.ok(version >= 0 && reviewStart > version && firstReviewDelta > reviewStart && reviewEnd > firstReviewDelta);
  assert.deepEqual(events.filter((event) => event.type === "delta" && event.id === reviewId).map((event) => event.text), ["Cloud review.\n", "VERDICT: APPROVE"]);
  const adopted = events.findIndex((event) => event.type === "status" && event.assist?.phase === "adopted");
  assert.ok(adopted > reviewEnd, "the adoption notice follows the normal message_end commit");
  const assists = events.filter((event) => event.type === "status" && event.assist);
  assert.deepEqual(assists.map((event) => event.assist!.phase), ["started", "adopted"]);
  assert.doesNotMatch(JSON.stringify(assists), /Cloud review|PRIVATE_CANDIDATE_REASONING|apiMessage|reasoning_content/);
  assert.doesNotMatch(JSON.stringify({ events, result }), /PRIVATE_CANDIDATE_REASONING|apiMessage|reasoning_content/);
});

test("A/B simulated latency shortens post-author review waiting with the identical formal review request", async () => {
  async function timedRun(enabled: boolean) {
    let authorDone = 0, reviewDone = 0;
    let reviewRequest: ReturnType<typeof snapshot> | undefined;
    const A: Backend = { async chat(request) {
      request.onDelta("<deliverable>Timed version</deliverable>");
      await delay(80);
      authorDone = Date.now();
      return { text: "<deliverable>Timed version</deliverable>\nAuthor trailing text" };
    } };
    const B: Backend = { async chat(request) {
      reviewRequest = snapshot(request);
      await delay(160);
      reviewDone = Date.now();
      request.onDelta("VERDICT: APPROVE");
      return { text: "VERDICT: APPROVE" };
    } };
    const result = await runCollaboration(config(enabled ? { speculativeReview: true } : undefined), () => {}, new AbortController().signal, { A, B });
    return { wait: reviewDone - authorDone, result, reviewRequest };
  }
  const baseline = await timedRun(false);
  const accelerated = await timedRun(true);
  assert.ok(accelerated.wait < baseline.wait - 45, `accelerated wait ${accelerated.wait}ms should be well below baseline ${baseline.wait}ms`);
  assert.ok(accelerated.result.acceleration!.overlapMs >= 40);
  assert.deepEqual(accelerated.reviewRequest, baseline.reviewRequest, "candidate and formal review must use the same system, turns and prompt");
  assert.deepEqual(accelerated.result.versions, baseline.result.versions);
  assert.equal(accelerated.result.reason, baseline.result.reason);
  assert.equal(accelerated.result.approved, baseline.result.approved);
});

test("a revise verdict is reused and its private protocol history enters only the reviewer's next request", async () => {
  const seenA: ReturnType<typeof snapshot>[] = [], seenB: ReturnType<typeof snapshot>[] = [];
  const A: Backend = { async chat(request) {
    seenA.push(snapshot(request));
    const text = seenA.length === 1 ? "<deliverable>Version one</deliverable>" : "Second version is ready.\nVERDICT: APPROVE";
    request.onDelta(text);
    return { text };
  } };
  const B: Backend = { async chat(request) {
    seenB.push(snapshot(request));
    if (seenB.length === 1) {
      const text = "Needs changes.\nVERDICT: REVISE";
      request.onDelta(text);
      request.turns.push({ role: "user", text: "CANDIDATE_ONLY_MUTATION" });
      return { text, apiMessage: { role: "assistant", content: text, reasoning_content: "B_PRIVATE_REASONING" } };
    }
    const text = "<deliverable>Version two</deliverable>";
    request.onDelta(text);
    return { text };
  } };
  const cfg = config({ speculativeReview: true }); cfg.maxRounds = 2;
  const events: Event[] = [];
  const result = await runCollaboration(cfg, (event) => events.push(event), new AbortController().signal, { A, B });

  assert.equal(result.approved, true); assert.equal(result.finalVersion, 2);
  assert.equal(seenB.length, 2, "one review and one revision; no duplicate formal review");
  assert.deepEqual(seenB[1].turns.map((turn) => turn.role), ["user", "assistant", "user"]);
  assert.equal(seenB[1].turns[0].text, seenB[0].turns[0].text);
  assert.equal(seenB[1].turns[1].text, "Needs changes.\nVERDICT: REVISE");
  assert.equal(seenB[1].turns[1].apiMessage?.reasoning_content, "B_PRIVATE_REASONING");
  assert.doesNotMatch(JSON.stringify(seenB[1].turns), /CANDIDATE_ONLY_MUTATION/);
  assert.doesNotMatch(JSON.stringify(seenA), /B_PRIVATE_REASONING/);
  assert.doesNotMatch(JSON.stringify({ events, result }), /B_PRIVATE_REASONING|apiMessage|reasoning_content/);
  assert.deepEqual(events.filter((event) => event.type === "message_end" && event.verdict).map((event) => event.verdict), ["revise", "approve"]);
  assert.equal(result.acceleration?.started, 1, "the cloud-author/local-reviewer direction must not speculate");
  assert.equal(result.acceleration?.adopted, 1);
});

test("maximum rounds still stops after the reviewed version without an extra revision or request", async () => {
  let callsA = 0, callsB = 0;
  const A: Backend = { async chat(request) {
    callsA++; const text = "<deliverable>Only version</deliverable>"; request.onDelta(text); return { text };
  } };
  const B: Backend = { async chat(request) {
    callsB++; const text = "Still needs work.\nVERDICT: REVISE"; request.onDelta(text); return { text };
  } };
  const events: Event[] = [];
  const result = await runCollaboration(config({ speculativeReview: true }), (event) => events.push(event), new AbortController().signal, { A, B });
  assert.equal(result.approved, false); assert.equal(result.finalVersion, 1); assert.equal(result.versions.length, 1);
  assert.equal(callsA, 1); assert.equal(callsB, 1);
  assert.equal(events.filter((event) => event.type === "version").length, 1);
  assert.equal(events.filter((event) => event.type === "message_start" && event.kind === "revision").length, 0);
  assert.equal(result.acceleration?.adopted, 1);
});

test("a final deliverable hash/content mismatch discards the candidate and reviews the final content", async () => {
  const seenB: Turn[][] = [];
  const A: Backend = { async chat(request) {
    request.onDelta("<deliverable>snapshot</deliverable>");
    return { text: "<deliverable>final</deliverable>" };
  } };
  const B: Backend = { async chat(request) {
    seenB.push(structuredClone(request.turns));
    const text = seenB.length === 1 ? "STALE_REVIEW\nVERDICT: APPROVE" : "FORMAL_REVIEW\nVERDICT: APPROVE";
    request.onDelta(text);
    return { text, apiMessage: { role: "assistant", content: text, reasoning_content: seenB.length === 1 ? "STALE_REASONING" : "FORMAL_REASONING" } };
  } };
  const events: Event[] = [];
  const result = await runCollaboration(config({ speculativeReview: true }), (event) => events.push(event), new AbortController().signal, { A, B });
  assert.equal(result.approved, true); assert.equal(result.versions[0].content, "final");
  assert.equal(seenB.length, 2);
  assert.match(seenB[0].at(-1)!.text, /<deliverable>\nsnapshot\n<\/deliverable>/);
  assert.match(seenB[1].at(-1)!.text, /<deliverable>\nfinal\n<\/deliverable>/);
  assert.deepEqual(result.acceleration, { started: 1, adopted: 0, fallbacks: 1, cacheHits: 0, overlapMs: result.acceleration!.overlapMs });
  assert.equal(events.filter((event) => event.type === "message_start" && event.agent === "B").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /STALE_REVIEW|STALE_REASONING/);
});

test("candidate failure falls back without exposing partial candidate deltas", async () => {
  let callsB = 0;
  const A: Backend = { async chat(request) {
    const text = "<deliverable>Version</deliverable>"; request.onDelta(text); return { text };
  } };
  const B: Backend = { async chat(request) {
    callsB++;
    if (callsB === 1) { request.onDelta("HIDDEN_CANDIDATE_DELTA"); throw new Error("candidate failed"); }
    const text = "FORMAL_REVIEW\nVERDICT: APPROVE"; request.onDelta(text); return { text };
  } };
  const events: Event[] = [];
  const result = await runCollaboration(config({ speculativeReview: true }), (event) => events.push(event), new AbortController().signal, { A, B });
  assert.equal(result.approved, true); assert.equal(callsB, 2);
  assert.equal(result.acceleration?.started, 1); assert.equal(result.acceleration?.adopted, 0); assert.equal(result.acceleration?.fallbacks, 1);
  assert.doesNotMatch(JSON.stringify(events), /HIDDEN_CANDIDATE_DELTA/);
  const start = events.findIndex((event) => event.type === "message_start" && event.agent === "B");
  const reviewId = (events[start] as any).id;
  const end = events.findIndex((event) => event.type === "message_end" && event.id === reviewId);
  assert.ok(start >= 0 && end > start);
});

test("author failure aborts the candidate and never starts a replacement review", async () => {
  let callsB = 0, candidateAborted = false;
  const A: Backend = { async chat(request) {
    request.onDelta("<deliverable>Unfinished</deliverable>");
    await delay(10);
    throw new Error("author exploded");
  } };
  const B: Backend = { async chat(request) {
    callsB++;
    await waitForAbort(request.signal, () => { candidateAborted = true; });
    throw new Error("unreachable");
  } };
  const events: Event[] = [];
  await assert.rejects(runCollaboration(config({ speculativeReview: true }), (event) => events.push(event), new AbortController().signal, { A, B }), /author exploded/);
  assert.equal(candidateAborted, true); assert.equal(callsB, 1);
  assert.equal(events.some((event) => event.type === "version" || event.type === "done"), false);
  assert.deepEqual(events.filter((event) => event.type === "status" && event.assist).map((event) => event.assist!.phase), ["started", "fallback"]);
});

test("main cancellation terminates the candidate and never falls back to another request", async () => {
  const candidateStarted = deferred();
  let callsB = 0, authorAborted = false, candidateAborted = false;
  const A: Backend = { async chat(request) {
    request.onDelta("<deliverable>Cancelled</deliverable>");
    await waitForAbort(request.signal, () => { authorAborted = true; });
    throw new Error("unreachable");
  } };
  const B: Backend = { async chat(request) {
    callsB++; candidateStarted.resolve();
    await waitForAbort(request.signal, () => { candidateAborted = true; });
    throw new Error("unreachable");
  } };
  const controller = new AbortController(), events: Event[] = [];
  const running = runCollaboration(config({ speculativeReview: true }), (event) => events.push(event), controller.signal, { A, B });
  await candidateStarted.promise;
  controller.abort();
  await assert.rejects(running, /aborted/);
  assert.equal(authorAborted, true); assert.equal(candidateAborted, true); assert.equal(callsB, 1);
  assert.equal(events.some((event) => event.type === "done"), false);
  assert.deepEqual(events.filter((event) => event.type === "status" && event.assist).map((event) => event.assist!.phase), ["started"]);
});

test("default, reverse deployment, non-OpenAI and media runs never start speculative review", async () => {
  for (const scenario of ["default", "reverse", "cli", "media"] as const) {
    const cfg = config(scenario === "default" ? undefined : { speculativeReview: true });
    if (scenario === "reverse") { cfg.agentA = slot("A", "cloud"); cfg.agentB = slot("B", "local"); }
    if (scenario === "cli") { cfg.agentA.agent.kind = "cli"; cfg.agentA.agent.runner = { type: "codex", bin: "unused" }; }
    if (scenario === "media") cfg.media = { provider: { id: "fixture", label: "Fixture", async generate() { throw new Error("no media expected"); } }, dir: process.cwd(), images: true, videos: false };
    let authorFinished = false;
    const A: Backend = { async chat(request) {
      const text = "<deliverable>Gated</deliverable>"; request.onDelta(text); authorFinished = true; return { text };
    } };
    const B: Backend = { async chat(request) {
      assert.equal(authorFinished, true, `${scenario}: review must not overlap the author`);
      const text = "VERDICT: APPROVE"; request.onDelta(text); return { text };
    } };
    const events: Event[] = [];
    const result = await runCollaboration(cfg, (event) => events.push(event), new AbortController().signal, { A, B });
    assert.equal(result.approved, true);
    assert.equal(events.some((event) => event.type === "status" && event.assist), false);
    if (scenario === "default") assert.equal(result.acceleration, undefined);
    else assert.equal(result.acceleration?.started, 0);
  }
});

test("cache-only mode preserves serial review while reporting backend cache hits", async () => {
  let authorFinished = false;
  const backend = (reviewer: boolean): Backend => ({ async chat(request) {
    assert.equal(request.cache, true);
    if (reviewer) assert.equal(authorFinished, true);
    const text = reviewer ? "VERDICT: APPROVE" : "<deliverable>Cached run</deliverable>";
    if (!reviewer) authorFinished = true;
    request.onDelta(text);
    return { text, cacheHit: true };
  } });
  const events: Event[] = [];
  const result = await runCollaboration(config({ cache: true }), (event) => events.push(event), new AbortController().signal, { A: backend(false), B: backend(true) });
  assert.deepEqual(result.acceleration, { started: 0, adopted: 0, fallbacks: 0, cacheHits: 2, overlapMs: 0 });
  assert.equal(events.some((event) => event.type === "status" && event.assist), false);
});
