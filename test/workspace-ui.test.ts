import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function actualFunction(name: string, nextBoundary: string, isAsync = false) {
  const start = source.indexOf(`${isAsync ? "async " : ""}function ${name}(`);
  const end = source.indexOf(nextBoundary, start);
  if (start < 0 || end < 0) throw new Error(`Cannot load the actual ${name} function`);
  return source.slice(start, end);
}
const functions = [
  actualFunction("resetView", "function setRunning("),
  actualFunction("replay", "/* ---------- 初始化 ---------- */", true),
  actualFunction("refreshRepositoryResult", "function renderRepository(", true),
  actualFunction("stop", "async function loadHistory(", true),
].join("\n");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function savedSession(id: string) {
  return {
    config: { task: `Saved task ${id}`, acceleration: { speculativeReview: false, cache: true } },
    status: "completed",
    events: [{ type: "version", n: 1, content: `Saved result ${id}` }],
  };
}

function workspace() {
  const elements = new Map<string, any>();
  const element = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: "", textContent: "", value: "", checked: false, hidden: false });
    return elements.get(selector);
  };
  const requests: {
    route: string;
    options: any;
    headers: ReturnType<typeof deferred<any>>;
    body: ReturnType<typeof deferred<any>>;
    jsonRequested: boolean;
  }[] = [];
  const tasks: string[] = [], events: any[] = [], renderedRepositories: any[] = [];
  const state: Record<string, any> = {
    viewEpoch: 0, isRunning: false, currentSessionId: "current-session", currentVersion: 1,
    repositoryRun: false, repositoryManifest: null, replayStatus: null, diffRequest: 0,
    activeTask: "Current task", displayedRound: 1,
    runId: "running-session", controller: new AbortController(),
    msgs: new Map(), versions: [{ n: 1 }],
    $: element,
    clearInterval, cancelAnimationFrame: () => {},
    resetAssist: () => {}, updateConversationHeading: () => {}, resizeTask: () => {},
    updateRepositoryMode: () => {}, renderRepository: () => renderedRepositories.push(state.repositoryManifest),
    addUserTask: (task: string) => { tasks.push(task); state.activeTask = task; },
    handle: (event: any) => events.push(event),
    t: (key: string) => key,
    fetch: (route: string, options: any) => {
      const request = { route, options, headers: deferred<any>(), body: deferred<any>(), jsonRequested: false };
      requests.push(request);
      return request.headers.promise;
    },
  };
  element("#timeline").innerHTML = "Current conversation";
  const context = vm.createContext(state);
  vm.runInContext(functions, context, { filename: "app.js" });
  function sendHeaders(index: number) {
    const request = requests[index];
    request.headers.resolve({ ok: true, json: () => { request.jsonRequested = true; return request.body.promise; } });
  }
  function reply(index: number, id: string) {
    sendHeaders(index);
    requests[index].body.resolve(savedSession(id));
  }
  return {
    state, requests, tasks, events, renderedRepositories, element, sendHeaders, reply,
    replay: (id: string) => vm.runInContext(`replay(${JSON.stringify(id)})`, context) as Promise<void>,
    reset: () => vm.runInContext("resetView()", context),
    refreshRepository: () => vm.runInContext("refreshRepositoryResult()", context) as Promise<void>,
    stop: () => vm.runInContext("stop()", context) as Promise<void>,
  };
}

test("saved history still loads its task, mode, preferences and events", async () => {
  const page = workspace();
  const loading = page.replay("ready-history");
  assert.equal(page.requests[0].route, "/api/sessions/ready-history");
  page.reply(0, "ready-history");
  await loading;
  assert.equal(page.state.currentSessionId, "ready-history");
  assert.deepEqual(page.tasks, ["Saved task ready-history"]);
  assert.deepEqual(page.events, savedSession("ready-history").events);
  assert.equal(page.element("#work-mode").value, "text");
  assert.equal(page.element("#acceleration-speculative-review").checked, false);
  assert.equal(page.element("#acceleration-cache").checked, true);
});

test("a delayed history response cannot replace a run that has started", async () => {
  const page = workspace();
  const loading = page.replay("old-history");
  page.state.isRunning = true;
  page.reply(0, "old-history");
  await loading;
  assert.equal(page.state.currentSessionId, "current-session");
  assert.equal(page.element("#timeline").innerHTML, "Current conversation");
  assert.deepEqual(page.tasks, []);
  assert.deepEqual(page.events, []);
});

test("a reset for a new task invalidates history whose JSON is still loading", async () => {
  const page = workspace();
  const loading = page.replay("old-history");
  page.sendHeaders(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(page.requests[0].jsonRequested, true);
  page.reset();
  page.element("#task").value = "A new unsent task";
  const epochAfterReset = page.state.viewEpoch;
  page.requests[0].body.resolve(savedSession("old-history"));
  await loading;
  assert.equal(page.state.currentSessionId, null);
  assert.equal(page.state.viewEpoch, epochAfterReset);
  assert.equal(page.element("#task").value, "A new unsent task");
  assert.equal(page.element("#timeline").innerHTML, "");
  assert.deepEqual(page.tasks, []);
  assert.deepEqual(page.events, []);
});

test("the latest requested history wins in either network response order", async () => {
  for (const newestArrivesFirst of [false, true]) {
    const page = workspace();
    const older = page.replay("older-history");
    const newer = page.replay("newer-history");
    if (newestArrivesFirst) {
      page.reply(1, "newer-history"); await newer;
      page.reply(0, "older-history"); await older;
    } else {
      page.reply(0, "older-history"); await older;
      assert.deepEqual(page.tasks, [], "An older response must not flash while the latest history is loading");
      page.reply(1, "newer-history"); await newer;
    }
    assert.equal(page.state.currentSessionId, "newer-history");
    assert.deepEqual(page.tasks, ["Saved task newer-history"]);
    assert.deepEqual(page.events, savedSession("newer-history").events);
  }
});

test("a repository result for the current conversation is retained and rendered", async () => {
  const page = workspace();
  page.state.repositoryRun = true;
  const loading = page.refreshRepository();
  assert.equal(page.requests[0].route, "/api/sessions/current-session/repository");
  const repository = { branch: "task/current", status: "completed", snapshots: [{ n: 1, commit: "current-tree" }] };
  page.sendHeaders(0);
  page.requests[0].body.resolve({ repository });
  await loading;
  assert.equal(page.state.repositoryManifest, repository);
  assert.deepEqual(page.renderedRepositories, [repository]);
});

test("delayed repository JSON cannot insert another session's evidence after a reset", async () => {
  const page = workspace();
  page.state.repositoryRun = true;
  const loading = page.refreshRepository();
  page.sendHeaders(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(page.requests[0].jsonRequested, true);
  page.reset();
  page.state.currentSessionId = "new-repository-session";
  page.state.repositoryRun = true;
  const currentRepository = { branch: "task/new", status: "running" };
  page.state.repositoryManifest = currentRepository;
  page.requests[0].body.resolve({ repository: { branch: "task/old", status: "completed" } });
  await loading;
  assert.equal(page.state.currentSessionId, "new-repository-session");
  assert.equal(page.state.repositoryManifest, currentRepository);
  assert.deepEqual(page.renderedRepositories, []);
});

test("stopping still aborts the local stream when the stop request fails", async () => {
  const page = workspace();
  const controller = page.state.controller as AbortController;
  const stopping = page.stop();
  assert.equal(page.requests[0].route, "/api/stop/running-session");
  assert.equal(page.requests[0].options.method, "POST");
  assert.equal(page.element("#stop").disabled, true);
  page.requests[0].headers.reject(new Error("The local service disconnected"));
  await stopping;
  assert.equal(controller.signal.aborted, true);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].type, "status");
  assert.equal(page.events[0].text, "stopped");
});

test("a delayed stop response aborts its own stream and leaves a newer run untouched", async () => {
  const page = workspace();
  const oldController = page.state.controller as AbortController;
  const stopping = page.stop();
  const newController = new AbortController();
  page.state.controller = newController;
  page.state.runId = "new-running-session";
  page.state.isRunning = true;
  page.sendHeaders(0);
  await stopping;
  assert.equal(oldController.signal.aborted, true);
  assert.equal(newController.signal.aborted, false);
  assert.equal(page.state.runId, "new-running-session");
  assert.deepEqual(page.events, [], "An old stop must not announce that the new run was stopped");
});
