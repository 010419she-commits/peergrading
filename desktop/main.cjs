// desktop/main.cjs — Electron 外壳：在本机启动服务（桌面模式），窗口里打开工作台
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

// Finder 启动的应用 PATH 很短，拿不到 claude / qwen / codex；用登录 shell 的 PATH 补上
function fixPath() {
  if (process.platform === "win32") return fixWindowsPath();
  try {
    const shellPath = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "echo -n $PATH"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch {}
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", path.join(app.getPath("home"), ".local", "bin")]) if (!process.env.PATH.includes(d)) process.env.PATH += `:${d}`;
}
// Windows：从开始菜单 / 安装器启动时继承的 PATH 可能是登录时的旧值（装完 npm / Claude Code 后没重新登录就看不到它们）。
// 把注册表里当前的系统 PATH 与用户 PATH 合并进来，并展开 %VAR%。
function fixWindowsPath() {
  const read = (key) => {
    try {
      const out = execFileSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      return out.match(/\bPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i)?.[1]?.trim() || "";
    } catch { return ""; }
  };
  const expand = (s) => s.replace(/%([^%;]+)%/g, (m, k) => process.env[k] ?? m);
  const parts = [process.env.PATH || "", read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), read("HKCU\\Environment")]
    .flatMap((s) => expand(s).split(";")).map((s) => s.trim()).filter(Boolean);
  const seen = new Set(); const merged = [];
  for (const p of parts) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); merged.push(p); } }
  process.env.PATH = merged.join(";");
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on("error", reject); });
const waitFor = (url, ms = 15000) => new Promise((resolve, reject) => { const t0 = Date.now(); (function tick() { fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry); function retry() { Date.now() - t0 > ms ? reject(new Error("服务未启动")) : setTimeout(tick, 200); } })(); });

let win;
async function start() {
  fixPath();
  const userData = app.getPath("userData");
  process.env.LOCAL_MODE = "1";
  process.env.DATA_DIR = path.join(userData, "data");
  process.env.SESSIONS_DIR = path.join(userData, "sessions");
  process.env.CLOUD_URL = process.env.CLOUD_URL || "https://peergrading.ai";
  process.env.PORT = String(await freePort());
  process.env.HOST = "127.0.0.1";
  process.env.BASE_URL = `http://127.0.0.1:${process.env.PORT}`;   // 窗口打开的就是这个地址，CSRF 的同源判断以它为准
  await import(pathToFileURL(path.join(__dirname, "..", "dist", "server.mjs")).href);
  const base = `http://127.0.0.1:${process.env.PORT}`;
  await waitFor(`${base}/api/auth/bootstrap`);

  win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 980, minHeight: 640, backgroundColor: "#10141b", title: "PeerGrading",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // 页面里 target=_blank 的链接（登录 / 账号 / 购买）用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); shell.openExternal(url); } });
  await win.loadURL(`${base}/`);
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
]));
app.whenReady().then(start).catch((e) => { console.error(e); app.quit(); });
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (!win) start(); });
