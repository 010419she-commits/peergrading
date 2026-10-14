// 用 Electron 离屏渲染生成应用图标：node_modules/.bin/electron desktop/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, transparent: true, frame: false, backgroundColor: "#00000000", webPreferences: { offscreen: true } });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1d2632"/><stop offset="1" stop-color="#10141b"/></linearGradient></defs>
    <rect x="48" y="48" width="928" height="928" rx="210" fill="url(#g)"/>
    <rect x="48" y="48" width="928" height="928" rx="210" fill="none" stroke="#353f4d" stroke-width="6"/>
    <circle cx="430" cy="530" r="236" fill="none" stroke="#d6ba81" stroke-width="30"/>
    <circle cx="594" cy="530" r="236" fill="none" stroke="#f3f0e9" stroke-opacity=".5" stroke-width="30"/>
    <text x="512" y="615" text-anchor="middle" font-family="'Noto Serif SC','Songti SC','STSong',Georgia,serif" font-weight="500" font-size="320" fill="#d6ba81">P</text>
  </svg>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.mkdirSync("build", { recursive: true });
  fs.writeFileSync("build/icon.png", img.toPNG());
  fs.writeFileSync("public/icon.png", img.resize({ width: 256 }).toPNG());
  console.log("icon written", img.getSize());
  app.quit();
});
