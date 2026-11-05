// 出网代理：设置里的代理 → HTTPS_PROXY 等环境变量 → macOS 系统代理。
// Node 自带的 fetch 不会自动走代理，国内网络下直连 api.openai.com 会 ECONNRESET。
import { execFileSync } from "node:child_process";
import { ProxyAgent } from "undici";

let systemProxy; // undefined = 未探测
function macSystemProxy() {
  if (systemProxy !== undefined) return systemProxy;
  systemProxy = null;
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 3000 });
    const get = (k) => out.match(new RegExp(`${k}\\s*:\\s*(\\S+)`))?.[1];
    if (get("HTTPSEnable") === "1" && get("HTTPSProxy")) systemProxy = `http://${get("HTTPSProxy")}:${get("HTTPSPort") ?? 80}`;
    else if (get("HTTPEnable") === "1" && get("HTTPProxy")) systemProxy = `http://${get("HTTPProxy")}:${get("HTTPPort") ?? 80}`;
  } catch {}
  return systemProxy;
}

export function resolveProxy(configured) {
  if (configured === "direct") return null;
  if (configured) return configured;
  const env = process.env;
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy || macSystemProxy();
}

const agents = new Map();
export function dispatcherFor(configured) {
  const url = resolveProxy(configured);
  if (!url || !/^https?:\/\//i.test(url)) return { dispatcher: undefined, proxy: null };
  if (!agents.has(url)) agents.set(url, new ProxyAgent(url));
  return { dispatcher: agents.get(url), proxy: url };
}

// 按目标地址选代理：本机 / 局域网地址（自建或本地模型服务）一律直连
export function dispatcherForUrl(target, configured) {
  let host = "";
  try { host = new URL(target).hostname; } catch {}
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/.test(host) || host.endsWith(".local");
  return dispatcherFor(local ? "direct" : configured);
}
