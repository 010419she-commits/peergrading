// agents/proxy.ts — 找到可用的 HTTPS 代理（环境变量或 macOS 系统代理），供命令行 agent 访问境外服务
import { execFileSync } from "node:child_process";

let cached: Record<string, string> | null = null;

export function getProxyEnv(): Record<string, string> {
  if (cached) return cached;
  const env: Record<string, string> = {};
  const fromEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  if (fromEnv) {
    env.HTTPS_PROXY = fromEnv; env.HTTP_PROXY = process.env.HTTP_PROXY ?? process.env.http_proxy ?? fromEnv;
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

/** 形如 `env HTTPS_PROXY=... HTTP_PROXY=...`，用于拼进终端命令 */
export function proxyEnvPrefix(): string {
  const e = getProxyEnv();
  const parts = Object.entries(e).map(([k, v]) => `${k}='${v}'`);
  return parts.length ? `env ${parts.join(" ")} ` : "";
}
