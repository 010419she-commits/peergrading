// agents/proxy.ts — 找到可用的 HTTPS 代理（环境变量或 macOS 系统代理），供命令行 agent 访问境外服务
import { execFileSync } from "node:child_process";

let cached: Record<string, string> | null = null;

export function getProxyEnv(): Record<string, string> {
  if (cached) return cached;
  const env: Record<string, string> = {};
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (fromEnv) {
    env.HTTPS_PROXY = fromEnv; env.HTTP_PROXY = process.env.HTTP_PROXY ?? process.env.http_proxy ?? fromEnv;
  } else if (process.platform === "win32") {
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"], { encoding: "utf8", timeout: 3000, windowsHide: true });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/.test(out);
      const server = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/)?.[1];
      if (enabled && server) {
        const https = server.includes("=") ? (server.match(/https=([^;]+)/)?.[1] || server.match(/http=([^;]+)/)?.[1]) : server;
        if (https) { env.HTTPS_PROXY = /^https?:\/\//.test(https) ? https : `http://${https}`; env.HTTP_PROXY = env.HTTPS_PROXY; }
      }
    } catch {}
  } else if (process.platform === "darwin") {
    try {
      const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 });
      const get = (k: string) => out.match(new RegExp(`${k}\\s*:\\s*(\\S+)`))?.[1];
      if (get("HTTPSEnable") === "1" && get("HTTPSProxy")) env.HTTPS_PROXY = `http://${get("HTTPSProxy")}:${get("HTTPSPort") ?? "80"}`;
      if (get("HTTPEnable") === "1" && get("HTTPProxy")) env.HTTP_PROXY = `http://${get("HTTPProxy")}:${get("HTTPPort") ?? "80"}`;
      if (env.HTTPS_PROXY && !env.HTTP_PROXY) env.HTTP_PROXY = env.HTTPS_PROXY;
    } catch {}
  }
  if (env.HTTPS_PROXY) env.NO_PROXY = process.env.NO_PROXY ?? "localhost,127.0.0.1,::1,.cn";
  cached = env;
  return env;
}

/** 拼进终端命令的代理前缀：macOS / Linux 为 `env K='v' `，Windows 为 PowerShell 写法 `$env:K='v'; ` */
export function proxyEnvPrefix(): string {
  const e = getProxyEnv();
  const entries = Object.entries(e);
  if (!entries.length) return "";
  if (process.platform === "win32") return entries.map(([k, v]) => `$env:${k}='${v.replace(/'/g, "''")}'; `).join("");
  return `env ${entries.map(([k, v]) => `${k}='${v}'`).join(" ")} `;
}
