// desktop/main.cjs — Electron 外壳：在本机启动服务（桌面模式），窗口里打开工作台
const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("node:path");
const net = require("node:net");
const { execFileSync, execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");

// 同一时间只跑一份：第二次双击图标时把已开的窗口提到前面，而不是再起一个服务
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// Finder 启动的应用 PATH 很短，拿不到 claude / qwen / codex；用登录 shell 的 PATH 补上
async function fixPath() {
  if (process.platform === "win32") return fixWindowsPath();
  try {
    const shellPath = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "echo -n $PATH"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch {}
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", path.join(app.getPath("home"), ".local", "bin")]) if (!process.env.PATH.includes(d)) process.env.PATH += `:${d}`;
}
// Windows：从开始菜单 / 安装器启动时继承的环境变量可能是登录时的旧值（装完 npm / Claude Code / pnpm 后没重新登录就看不到它们）。
// 用 PowerShell 读出注册表里当前的系统与用户环境变量（未展开的原文、UTF-8 输出，reg.exe 会按本地代码页输出，中文用户名会被读坏），
// 把缺少的变量补进来，再把两份 PATH 合并进当前 PATH，%VAR% 用合并后的变量表迭代展开（PNPM_HOME 这类只在注册表里的变量也能展开）。
// PowerShell 启动要半秒到一秒多，所以模块加载时就开始查，start() 里再等结果，不阻塞 Electron 自己的初始化
const USER = "HKCU:\\Environment", MACHINE = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
function queryWindowsRegistryEnv() {
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
$o = @{}
foreach ($k in @('${USER}', '${MACHINE}')) {
  $h = @{}
  try { $i = Get-Item -LiteralPath $k -ErrorAction Stop; foreach ($n in $i.GetValueNames()) { if ($n) { $h[$n] = [string]$i.GetValue($n, '', 'DoNotExpandEnvironmentNames') } } } catch {}
  $o[$k] = $h
}
$o | ConvertTo-Json -Compress -Depth 3`;
  const ps = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve) => {
    execFile(ps, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
      (err, out) => { try { resolve(err ? null : JSON.parse(out)); } catch { resolve(null); } });
  });
}
const registryEnv = process.platform === "win32" ? queryWindowsRegistryEnv() : Promise.resolve(null);
async function fixWindowsPath() {
  const data = await registryEnv;
  if (!data) return;
  const user = data[USER] || {}, machine = data[MACHINE] || {};
  // 变量表：注册表系统级 → 当前进程的 → 注册表用户级（后者覆盖前者），键名不分大小写。
  // 系统级不能压过当前进程：HKLM 里 USERNAME 永远是 SYSTEM，登录时才被换成真实用户名
  const vars = new Map();
  const isPath = (k) => /^path$/i.test(k);
  for (const [k, v] of Object.entries(machine)) if (!isPath(k) && typeof v === "string") vars.set(k.toUpperCase(), v);
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") vars.set(k.toUpperCase(), v);
  for (const [k, v] of Object.entries(user)) if (!isPath(k) && typeof v === "string") vars.set(k.toUpperCase(), v);
  const expand = (s) => { for (let i = 0; i < 3 && /%[^%;]+%/.test(s); i++) s = s.replace(/%([^%;]+)%/g, (m, k) => vars.get(k.toUpperCase()) ?? m); return s; };
  // 注册表里有、当前进程里没有的变量（如 PNPM_HOME、CODEX_HOME）补进来；用户级覆盖系统级，和 Windows 登录时的规则一致
  const have = new Set(Object.keys(process.env).map((k) => k.toUpperCase()));
  for (const src of [user, machine]) for (const [k, v] of Object.entries(src)) if (!isPath(k) && typeof v === "string" && !have.has(k.toUpperCase())) { process.env[k] = expand(v); have.add(k.toUpperCase()); }
  const regPath = (src) => Object.entries(src).find(([k]) => isPath(k))?.[1] || "";
  const parts = [process.env.PATH || "", regPath(machine), regPath(user)]
    .flatMap((s) => expand(String(s)).split(";")).map((s) => s.trim()).filter(Boolean);
  const seen = new Set(); const merged = [];
  for (const p of parts) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); merged.push(p); } }
  process.env.PATH = merged.join(";");
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on("error", reject); });
const waitFor = (url, ms = 15000) => new Promise((resolve, reject) => { const t0 = Date.now(); (function tick() { fetch(url).then((r) => (r.ok ? resolve() : retry())).catch(retry); function retry() { Date.now() - t0 > ms ? reject(new Error("服务未启动")) : setTimeout(tick, 200); } })(); });

let win;
async function start() {
  await fixPath();
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
if (gotLock) app.whenReady().then(start).catch((e) => { console.error(e); app.quit(); });
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (!win) start(); });
