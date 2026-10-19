import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
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
    // CSC_LINK takes precedence over CSC_KEYCHAIN in electron-builder.
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
    } else {
      throw new Error("macOS signing: expected prepare or cleanup.");
    }
  } catch (error) {
    console.error(error.message.startsWith("macOS signing:") ? error.message : "macOS signing: operation failed.");
    process.exitCode = 1;
  }
}
