import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEXT_EXTENSIONS = new Set([
  ".c", ".cjs", ".cmd", ".conf", ".css", ".csv", ".env", ".example", ".gitignore", ".html", ".ini", ".js", ".json", ".jsx", ".md", ".mjs", ".mts", ".ps1", ".py", ".sample", ".sh", ".template", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const CONTENT_RULES = [
  { id: "private-key-block", regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/ },
  { id: "github-token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { id: "openai-compatible-key", regex: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/ },
  { id: "live-payment-key", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/ },
  { id: "google-api-key", regex: /\bAIza[A-Za-z0-9_-]{35}/ },
  { id: "aws-access-key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { id: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}/ },
  { id: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/ },
  { id: "url-credential", regex: /https?:\/\/[^\s/:@]+:[^\s/@]+@[A-Za-z0-9.-]+/i },
  { id: "connection-string-credential", regex: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s/:@]+:[^\s/@]+@[A-Za-z0-9.-]+/i },
  { id: "personal-local-path", regex: /(?:[A-Za-z]:\\Users\\[^\s\\]+|\/(?:Users|home)\/[^\s/]+)/ },
];
const ASSIGNMENT = /(?:api[_-]?key|access[_-]?(?:key|token)|auth[_-]?token|session[_-]?secret|client[_-]?secret|webhook[_-]?secret|password|private[_-]?key)[\s"']*[:=][\s"']*["'`]([^"'`\r\n]{12,})["'`]/gi;
const PLACEHOLDER = /(?:^|[^a-z])(?:another|change[-_ ]?me|demo|dummy|example|fake|fixture|invalid|mock|not[-_ ]?a[-_ ]?secret|old|placeholder|redacted|sample|test|your|xxxx|secret[-_ ]?pattern|private[-_ ]?candidate)(?:[^a-z]|$)/i;
const HISTORY_PATTERNS = [
  ["private-key-block", "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"],
  ["github-token", "(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})"],
  ["openai-compatible-key", "sk-(ant-)?[A-Za-z0-9_-]{20,}"],
  ["live-payment-key", "(sk|rk)_(live|test)_[A-Za-z0-9]{16,}"],
  ["google-api-key", "AIza[A-Za-z0-9_-]{35}"],
  ["aws-access-key", "(AKIA|ASIA)[A-Z0-9]{16}"],
  ["slack-token", "xox[baprs]-[A-Za-z0-9-]{20,}"],
  ["jwt", "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{12,}\\.[A-Za-z0-9_-]{12,}"],
  ["url-credential", "https?://[^[:space:]/:@]+:[^[:space:]/@]+@"],
  ["connection-string-credential", "(mongodb|postgresql|postgres|mysql|redis)(\\+srv)?://[^[:space:]/:@]+:[^[:space:]/@]+@"],
  ["personal-local-path", "([A-Za-z]:.*Users.*|/(Users|home)/[^[:space:]/]+)"],
];
const REVIEWED_TEST_FIXTURES = new Set([
  "test/api-backends.test.ts\x00openai-compatible-key\x0023de20bef96db0d8adcb8080f40eb5adf0c6cad7139daae2111d5b8c3ffc0820",
  "test/api-backends.test.ts\x00openai-compatible-key\x002ea7d97666e58f30d464f3210da39414fcd40c60ad44e132cd9e85ed12e16f30",
  "test/api-connections.test.ts\x00high-entropy-credential-assignment\x006710801594617e18a494df58d426968076158f07d25f2ce1727d6d8aac99b61e",
  "test/media.test.ts\x00high-entropy-credential-assignment\x0058888beb116f8a82e4a8fa9525e00387b06bf251e1491b712ff1c2feed9706d8",
]);
const PLACEHOLDER_USERNAMES = new Set(["user", "username", "test", "fixture", "example", "key", "token", "secret", "password", "pass"]);
const PLACEHOLDER_PASSWORDS = new Set(["pass", "password", "test", "fixture", "example", "key", "token", "secret"]);

function normalize(file) {
  return file.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export function sensitivePath(file) {
  const name = normalize(file);
  const lower = name.toLowerCase();
  const base = lower.split("/").pop();
  if (/^(?:\.env|\.env\..+)$/.test(base) && !/\.env\.(?:example|sample|template)$/.test(base)) return "environment-file";
  if (/^(?:data|sessions|handoff|migration|release|downloads|dist|node_modules|__macosx|peergrading)\//.test(lower)) return "private-or-generated-directory";
  if (/^(?:deploy\/keys|\.ssh)\//.test(lower) || lower.includes("/deploy/keys/") || lower.includes("/.ssh/")) return "key-directory";
  if (/^(?:\.session-secret|device\.json|api-models\.json|local-models\.json|media\.json|auth\.json|id_rsa|id_ed25519)$/.test(base)) return "credential-file";
  if (/\.(?:p8|p12|pfx|pem|key|keystore|jks|sqlite|sqlite3|db|db-shm|db-wal)$/.test(base)) return "key-or-database-file";
  return null;
}

function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function reviewedFixture(file, rule, value) {
  const digest = createHash("sha256").update(value).digest("hex");
  return REVIEWED_TEST_FIXTURES.has(`${file}\x00${rule}\x00${digest}`);
}

function placeholderCredential(rule, value) {
  if (rule !== "url-credential" && rule !== "connection-string-credential") return false;
  try {
    const url = new URL(value);
    return PLACEHOLDER_USERNAMES.has(url.username.toLowerCase()) && PLACEHOLDER_PASSWORDS.has(url.password.toLowerCase());
  } catch { return false; }
}

export function scanText(text, file = "") {
  const rules = new Set();
  for (const rule of CONTENT_RULES) {
    const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
    const matches = text.match(new RegExp(rule.regex.source, flags)) ?? [];
    if (matches.some((value) => !placeholderCredential(rule.id, value) && !reviewedFixture(file, rule.id, value))) rules.add(rule.id);
  }
  ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNMENT)) {
    const value = match[1].trim();
    if (value.length >= 16 && !PLACEHOLDER.test(value) && entropy(value) >= 3.8 && !reviewedFixture(file, "high-entropy-credential-assignment", value)) rules.add("high-entropy-credential-assignment");
  }
  ASSIGNMENT.lastIndex = 0;
  return [...rules];
}

function git(root, args, allowNoMatch = false) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (allowNoMatch && error.status === 1) return "";
    throw error;
  }
}

function isTextCandidate(root, file) {
  if (sensitivePath(file)) return false;
  const extension = path.extname(file).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) && ![".gitignore", ".dockerignore"].some((name) => file.endsWith(name))) return false;
  const full = path.join(root, file);
  try {
    if (!fs.statSync(full).isFile() || fs.statSync(full).size > 2 * 1024 * 1024) return false;
    const sample = fs.readFileSync(full);
    return !sample.includes(0);
  } catch { return false; }
}

function scanCurrent(root) {
  const findings = [];
  const files = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]).split("\x00").filter(Boolean).map(normalize);
  for (const file of files) {
    const pathRule = sensitivePath(file);
    if (pathRule) {
      findings.push({ scope: "workspace", file, rule: pathRule });
      continue;
    }
    if (!isTextCandidate(root, file)) continue;
    for (const rule of scanText(fs.readFileSync(path.join(root, file), "utf8"), file)) findings.push({ scope: "workspace", file, rule });
  }
  return { findings, files: files.length };
}

function scanHistory(root) {
  const findings = [];
  const commits = git(root, ["rev-list", "--all"]).split(/\r?\n/).filter(Boolean);
  for (const commit of commits) {
    const files = git(root, ["ls-tree", "-r", "--name-only", commit]).split(/\r?\n/).filter(Boolean);
    for (const file of files) {
      const rule = sensitivePath(file);
      if (rule) findings.push({ scope: `history:${commit.slice(0, 12)}`, file, rule });
    }
    for (const [rule, pattern] of HISTORY_PATTERNS) {
      const output = git(root, ["grep", "-l", "-I", "-i", "-E", "-e", pattern, commit, "--", "*.js", "*.cjs", "*.mjs", "*.ts", "*.json", "*.md", "*.txt", "*.yml", "*.yaml", "*.sh", "*.ps1", "*.env", "*.example", "*.toml", "*.html", "*.css"], true);
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const prefix = `${commit}:`;
        if (!line.startsWith(prefix)) continue;
        const file = line.slice(prefix.length);
        const content = git(root, ["show", `${commit}:${file}`]);
        if (scanText(content, file).includes(rule)) findings.push({ scope: `history:${commit.slice(0, 12)}`, file, rule });
      }
    }
  }
  return { findings, commits: commits.length };
}

export function runOpenSourceCheck(root) {
  const current = scanCurrent(root);
  const history = scanHistory(root);
  const unique = new Map();
  for (const finding of [...current.findings, ...history.findings]) unique.set(`${finding.scope}\x00${finding.file}\x00${finding.rule}`, finding);
  return { findings: [...unique.values()], files: current.files, commits: history.commits };
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const fallbackRoot = path.resolve(scriptDirectory, "..");
  const root = git(fallbackRoot, ["rev-parse", "--show-toplevel"]).trim();
  const result = runOpenSourceCheck(root);
  if (result.findings.length) {
    console.error(`Open-source safety check found ${result.findings.length} potential private-data issue(s). No matched values are printed.`);
    for (const finding of result.findings) console.error(`- ${finding.scope}: ${finding.file} [${finding.rule}]`);
    process.exitCode = 1;
    return;
  }
  console.log(`Open-source safety check passed: ${result.files} workspace candidate files and ${result.commits} commits checked; no credential patterns or private paths found.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
