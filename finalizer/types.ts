// finalizer/types.ts — 收尾 Agent：类型与限额（按《第 4 版：在成果版本后增加收尾 Agent》移植）
export interface SourceFile { path: string; content: string; }

export interface Version {
  sessionId: string;
  id: string;
  round: number;
  author: string;
  reviewStatus: "passed" | "not-passed" | "unknown";
  content: string;
  files?: SourceFile[];
}

export type Status = "success" | "failure" | "unconfirmed" | "cancelled" | "skipped";
export type Stage = "prepare" | "layout" | "environment" | "plan" | "setup" | "run" | "verify" | "repair" | "report";

export interface Config {
  enabled: boolean;
  versionId?: string;
  model?: string;
  sandbox: "docker" | "host";
  image?: string;
  pull: boolean;
  allowInstallNetwork: boolean;
  maxFixAttempts: number;
  totalTimeoutMs: number;
  commandTimeoutMs: number;
  cleanupTimeoutMs: number;
  promptTimeoutMs: number;
}

export const DEFAULTS: Config = {
  enabled: false,
  sandbox: "docker",
  pull: false,
  allowInstallNetwork: true,
  maxFixAttempts: 0,
  totalTimeoutMs: 600_000,
  commandTimeoutMs: 120_000,
  cleanupTimeoutMs: 30_000,
  promptTimeoutMs: 60_000,
};

export interface Agent {
  complete(input: { system: string; user: string; model?: string; signal: AbortSignal }): Promise<string>;
}

export interface Command { id: string; argv: string[]; }

export type Check =
  | { kind: "stdout-includes" | "stdout-not-includes"; commandId: string; value: string }
  | { kind: "json-field-equals"; commandId: string; field: string[]; value: string | number | boolean | null }
  | { kind: "file-includes"; commandId: string; path: string; value: string }
  | { kind: "file-exists"; commandId: string; path: string };

export interface Plan { files: SourceFile[]; setup: Command[]; run: Command[]; checks: Check[]; entrypoint: string; notes: string; }

export interface CommandResult {
  commandId: string;
  stage: "probe" | "setup" | "run";
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  startupError?: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface CheckResult { check: Check; passed: boolean; detail: string; }
export interface Change { path: string; before: string | null; after: string | null; error?: string; }

export interface Attempt {
  index: number;
  plan: Plan;
  results: CommandResult[];
  checks: CheckResult[];
  approvedChanges: Change[];
  runtimeChanges: { commandId: string; changes: Change[] }[];
  archiveChanges: Change[];
  status: Status;
  summary: string;
  agentVerdict?: { verdict: "success" | "failure" | "unconfirmed"; summary: string; fixable: boolean };
}

export interface Cleanup { ok: boolean; detail: string; residuals: string[]; }

export interface Environment {
  sandbox: "docker" | "host";
  image?: string;
  imageId?: string;
  workDirectory: string;
  setupNetwork: string;
  runNetwork: string;
  conventions: string[];
  probes: CommandResult[];
}

export interface Result {
  runId: string;
  versionId: string;
  contentSha256: string;
  status: Status;
  successBasis?: "original" | "repaired";
  summary: string;
  failureCategory?: string;
  runDirectory?: string;
  reportPath?: string;
  warnings: string[];
  sourceManifest: { path: string; sha256: string }[];
  layoutDecisions: unknown;
  environment?: Environment;
  attempts: Attempt[];
  cleanup?: Cleanup;
}

export class FinalizerError extends Error {
  category: string;
  constructor(category: string, message: string) {
    super(message);
    this.name = "FinalizerError";
    this.category = category;
  }
}

export const LIMITS = {
  files: 128,
  fileChars: 65_536,
  totalFileChars: 1_048_576,
  modelChars: 2_097_152,
  commands: 32,
  checks: 64,
  outputChars: 262_144,
};
