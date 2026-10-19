// Render the shared vector source: npx electron desktop/make-icon.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { ICON_SIZES, encodeIco } = require("./icon-assets.cjs");

const root = path.resolve(__dirname, "..");
const size = 1024;
let win;
const timeout = setTimeout(() => {
  console.error("Icon rendering timed out");
  app.exit(1);
}, 30_000);

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(root, "build/icon.svg"), "utf8");
  const source = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  win = new BrowserWindow({
    show: false,
    width: size,
    height: size,
    useContentSize: true,
    enableLargerThanScreen: true,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 },
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
    img{display:block;width:100%;height:100%}
    </style></head><body><img id="icon" src="${source}"></body></html>`;
  await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  // Wait for decoding and frame submission, independent of machine speed.
  await win.webContents.executeJavaScript(`(async () => {
    await document.getElementById("icon").decode();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  const image = await win.webContents.capturePage(
    { x: 0, y: 0, width: size, height: size },
    { stayHidden: true },
  );
  const actual = image.getSize();
  if (actual.width !== size || actual.height !== size) {
    throw new Error(`Unexpected icon size: ${actual.width}x${actual.height}`);
  }
  const pixels = image.toBitmap();
  const centerAlpha = pixels[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3];
  if (pixels[3] !== 0 || centerAlpha !== 255) {
    throw new Error("Icon render must preserve transparent corners and an opaque center");
  }
  const icons = ICON_SIZES.map((width) => ({
    size: width,
    png: image.resize({ width, height: width, quality: "best" }).toPNG(),
  }));
  const ico = encodeIco(icons);
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "build/icon.png"), image.toPNG());
  fs.writeFileSync(path.join(root, "public/icon.png"), icons.at(-1).png);
  fs.writeFileSync(path.join(root, "build/icon.ico"), ico);
  fs.writeFileSync(path.join(root, "public/favicon.ico"), ico);
  console.log("Generated build/icon.png (1024), public/icon.png (256), and ICOs (" + ICON_SIZES.join(", ") + ")");
  clearTimeout(timeout);
  win.destroy();
  app.quit();
}).catch((error) => {
  clearTimeout(timeout);
  console.error(error);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});
