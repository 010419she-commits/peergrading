import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, randomBytes } from "node:crypto";
import { spawnSync as systemSpawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function security(spawnSync, args) {
  let result;
  try {
    result = spawnSync("/usr/bin/security", args, { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(`macOS signing: security ${args[0]} failed.`);
  }
  // Child errors and stderr can contain passwords or identity details.
  if (result.error || result.status !== 0) throw new Error(`macOS signing: security ${args[0]} failed.`);
  return result.stdout || "";
}

function searchList(spawnSync) {
  return security(spawnSync, ["list-keychains", "-d", "user"])
    .split(/\r?\n/).map(line => line.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
}

function decodeBase64(value) {
  const compact = value.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const decoded = Buffer.from(compact, "base64");
  return decoded.toString("base64").replace(/=+$/, "") === compact.replace(/=+$/, "") ? decoded : null;
}

function completeDer(value) {
  if (value.length < 2 || value[0] !== 0x30) return false;
  const count = value[1] & 0x7f;
  if (value[1] < 128) return value[1] + 2 === value.length;
  if (count === 0 || count > 4 || value.length < count + 2) return false;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + value[i + 2];
  return length + count + 2 === value.length;
}

export function normalizeNotaryKey(value) {
  const invalid = () => new Error("macOS signing: APPLE_API_KEY must contain a valid EC P-256 private key (.p8).");
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 65_536) throw invalid();
  const queue = [{ value, depth: 0 }];
  const seen = new Set();
  const canonical = key => {
    if (key.type !== "private" || key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key.export({ format: "pem", type: "pkcs8" });
  };
  for (let i = 0; i < queue.length && i < 24; i++) {
    const { value: candidate, depth } = queue[i];
    const text = candidate.replace(/^\uFEFF/, "").trim().replace(/\r\n?/g, "\n");
    if (seen.has(text)) continue;
    seen.add(text);
    const add = next => { if (depth < 4 && typeof next === "string") queue.push({ value: next, depth: depth + 1 }); };
    // Accept one complete key, never a key embedded in unrelated text.
    const pem = text.match(/^-----BEGIN (PRIVATE KEY|EC PRIVATE KEY)-----\n([A-Za-z0-9+/=\n \t]+)\n-----END \1-----$/);
    if (pem) {
      const der = decodeBase64(pem[2]);
      if (der && completeDer(der)) {
        try {
          const result = canonical(createPrivateKey({ key: text, format: "pem" }));
          if (result) return result;
        } catch { /* try only the supported outer encodings below */ }
      }
    }
    const decoded = decodeBase64(text);
    if (decoded && depth < 4) {
      if (completeDer(decoded)) {
        try {
          const result = canonical(createPrivateKey({ key: decoded, format: "der", type: "pkcs8" }));
          if (result) return result;
        } catch { /* it may instead be base64-wrapped PEM text */ }
      }
      try { add(new TextDecoder("utf-8", { fatal: true }).decode(decoded)); } catch { /* not text */ }
    }
    if (text.startsWith('"') && text.endsWith('"')) {
      try { add(JSON.parse(text)); } catch { /* not a JSON string */ }
    }
    if (text.startsWith("'") && text.endsWith("'")) add(text.slice(1, -1));
    const fence = text.match(/^```(?:pem|text)?[ \t]*\n([\s\S]*?)\n```$/);
    if (fence) add(fence[1]);
    if (text.includes("-----BEGIN ") && text.includes("\\n")) add(text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n"));
  }
  throw invalid();
}

export function prepareNotaryKey({ env = process.env, writeEnv } = {}) {
  // Parse before creating any file or changing the environment export.
  const pem = normalizeNotaryKey(env.APPLE_API_KEY);
  if (!env.RUNNER_TEMP || (!writeEnv && !env.GITHUB_ENV)) throw new Error("macOS signing: RUNNER_TEMP and GITHUB_ENV are required.");
  const keyFile = path.resolve(env.RUNNER_TEMP, "PeerGrading-AuthKey.p8");
  if (/[\r\n]/.test(keyFile)) throw new Error("macOS signing: invalid temporary directory.");
  writeEnv ||= text => fs.appendFileSync(env.GITHUB_ENV, text);
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(keyFile, "wx", 0o600);
    created = true;
    fs.writeFileSync(descriptor, pem);
    fs.closeSync(descriptor);
    descriptor = undefined;
    writeEnv(`APPLE_API_KEY=${keyFile}\n`);
    return { keyFile };
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (created) fs.rmSync(keyFile, { force: true });
    throw new Error("macOS signing: could not prepare the temporary notarization key.");
  }
}

export function prepareSigning({ env = process.env, spawnSync = systemSpawnSync, writeEnv, cwd = process.cwd() } = {}) {
  const encoded = (env.CSC_LINK || "").replace(/\s/g, "");
  if (!encoded) return { skipped: true };
  const certificate = Buffer.from(encoded, "base64");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || certificate.length === 0 ||
      certificate.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new Error("macOS signing: CSC_LINK must contain a base64 PKCS#12 file.");
  }
  if (!writeEnv) {
    if (!env.GITHUB_ENV) throw new Error("macOS signing: GITHUB_ENV is required.");
    writeEnv = text => fs.appendFileSync(env.GITHUB_ENV, text);
  }
  const roots = path.resolve(cwd, "node_modules/app-builder-lib/certs/root_certs.keychain");
  if (!fs.existsSync(roots)) throw new Error("macOS signing: bundled certificate roots are missing.");
  const directory = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "peergrading-signing-"));
  const keychainFile = path.join(directory, "signing.keychain-db");
  const certificateFile = path.join(directory, "identity.p12");
  const keychainPassword = randomBytes(32).toString("base64");
  const certificatePassword = env.CSC_KEY_PASSWORD || "";
  let originalList;
  let created = false;
  let changedList = false;
  try {
    if (/[\r\n]/.test(keychainFile)) throw new Error("macOS signing: invalid temporary directory.");
    fs.writeFileSync(certificateFile, certificate, { mode: 0o600 });
    originalList = searchList(spawnSync);
    created = true;
    security(spawnSync, ["create-keychain", "-p", keychainPassword, keychainFile]);
    security(spawnSync, ["unlock-keychain", "-p", keychainPassword, keychainFile]);
    security(spawnSync, ["set-keychain-settings", "-lut", "21600", keychainFile]);
    security(spawnSync, ["import", certificateFile, "-k", keychainFile, "-f", "pkcs12",
      "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild", "-P", certificatePassword]);
    security(spawnSync, ["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]);
    changedList = true;
    security(spawnSync, ["list-keychains", "-d", "user", "-s", ...new Set([keychainFile, roots, ...originalList])]);
    const identities = security(spawnSync, ["find-identity", "-v", "-p", "codesigning", keychainFile]);
    if (!/^\s*\d+\)\s+[a-f\d]{40}\s+"Developer ID Application:[^"\r\n]+"\s*$/im.test(identities) ||
        !/\b[1-9]\d* valid identities found\b/.test(identities)) {
      throw new Error("macOS signing: no valid Developer ID Application identity was imported.");
    }
    // Clear inherited credential data; the build shell must then unset CSC_LINK.
    writeEnv(`CSC_KEYCHAIN=${keychainFile}\nCSC_LINK=\n`);
    return { skipped: false, keychainFile };
  } catch (error) {
    if (changedList) {
      try { security(spawnSync, ["list-keychains", "-d", "user", "-s", ...originalList]); } catch { /* retain the original failure */ }
    }
    if (created) {
      try { security(spawnSync, ["delete-keychain", keychainFile]); } catch { /* retain the original failure */ }
    }
    fs.rmSync(directory, { recursive: true, force: true });
    // Do not let filesystem errors expose certificate paths or credential data.
    throw new Error(error.message.startsWith("macOS signing:") ? error.message : "macOS signing: preparation failed.");
  } finally {
    certificate.fill(0);
    fs.rmSync(certificateFile, { force: true });
  }
}

export function cleanupSigning({ env = process.env, spawnSync = systemSpawnSync } = {}) {
  if (!env.CSC_KEYCHAIN) return { skipped: true };
  const keychainFile = path.resolve(env.CSC_KEYCHAIN);
  const directory = path.dirname(keychainFile);
  if (path.basename(keychainFile) !== "signing.keychain-db" ||
      !/^peergrading-signing-[A-Za-z0-9]+$/.test(path.basename(directory)) ||
      path.dirname(directory) !== path.resolve(env.RUNNER_TEMP || os.tmpdir())) {
    throw new Error("macOS signing: refusing to clean an unmanaged keychain.");
  }
  const remaining = searchList(spawnSync).filter(file => file !== keychainFile);
  security(spawnSync, ["list-keychains", "-d", "user", "-s", ...remaining]);
  security(spawnSync, ["delete-keychain", keychainFile]);
  fs.rmSync(directory, { recursive: true, force: true });
  return { skipped: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const action = process.argv[2];
    if (action === "prepare") {
      const result = prepareSigning();
      console.log(result.skipped ? "macOS signing: no certificate configured; skipping preparation." : "macOS signing: temporary keychain is ready.");
    } else if (action === "cleanup") {
      cleanupSigning();
    } else if (action === "notary-key") {
      prepareNotaryKey();
      console.log("macOS signing: notarization key format validated.");
    } else {
      throw new Error("macOS signing: expected prepare, cleanup or notary-key.");
    }
  } catch (error) {
    console.error(error.message.startsWith("macOS signing:") ? error.message : "macOS signing: operation failed.");
    process.exitCode = 1;
  }
}
