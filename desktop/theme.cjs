const fs = require("node:fs");
const path = require("node:path");

const isTheme = (value) => value === "light" || value === "dark";

// UI preferences stay separate from model credentials and session data. Electron
// uses a new localhost port each launch, so browser localStorage cannot retain them.
function createThemePreferences(userData, systemIsDark) {
  const file = path.join(userData, "ui-preferences.json");
  let savedTheme;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isTheme(value?.theme)) savedTheme = value.theme;
  } catch {}

  return {
    getTheme() {
      return savedTheme || (systemIsDark() ? "dark" : "light");
    },
    setTheme(theme) {
      if (!isTheme(theme)) throw new TypeError("Theme must be light or dark");
      fs.mkdirSync(userData, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(temporary, `${JSON.stringify({ theme })}\n`, { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally {
        try { fs.unlinkSync(temporary); } catch {}
      }
      savedTheme = theme;
      return theme;
    },
  };
}

function registerThemeIpc(ipcMain, trusted, preferences, onThemeChanged) {
  // A cached, read-only sync value lets the head script choose colors before
  // first paint. Untrusted requests always receive a reply without reading data.
  ipcMain.removeAllListeners("peergrading:initial-theme");
  ipcMain.on("peergrading:initial-theme", (event) => {
    event.returnValue = null;
    try { trusted(event); event.returnValue = preferences.getTheme(); } catch {}
  });
  ipcMain.removeHandler("peergrading:get-theme");
  ipcMain.handle("peergrading:get-theme", (event) => { trusted(event); return preferences.getTheme(); });
  ipcMain.removeHandler("peergrading:set-theme");
  ipcMain.handle("peergrading:set-theme", (event, theme) => {
    trusted(event);
    const saved = preferences.setTheme(theme);
    onThemeChanged(saved);
    return saved;
  });
}

module.exports = { createThemePreferences, registerThemeIpc };
