import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Windows installer allows choosing the directory and creates shortcuts", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.build.nsis.oneClick, false);
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(pkg.build.nsis.createDesktopShortcut, true);
  assert.equal(pkg.build.nsis.createStartMenuShortcut, true);
  assert.equal(pkg.build.nsis.shortcutName, "PeerGrading");
  assert.notEqual(pkg.build.nsis.removeDefaultUninstallWelcomePage, true);
  assert.notEqual(pkg.build.nsis.deleteAppDataOnUninstall, true);

  const script = fs.readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
  assert.ok(script.includes('WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"'));
  assert.ok(script.includes('WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$appExe,0"'));
});
