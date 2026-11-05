// 本地设置：data/settings.json（已在 .gitignore 中）。API Key 只存本机，不回传前端明文。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.mjs";
import { resolveProxy } from "./proxy.mjs";

const FILE = join(DATA_DIR, "settings.json");

const DEFAULTS = {
  imageBackend: "codex", // "codex" | "api"
  concurrency: 3,
  codex: { model: "gpt-6.1-terra" }, // 空或不可用时用 model/list 的默认模型
  // 识别/策划这类文字步骤跟随出图通道：codex 通道用上面的 codex.model，API 通道用 apiModel
  text: { apiModel: "gpt-6.1-terra", effort: "medium" },
  api: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-image-2.6-sunburst",
    quality: "medium", // low | medium | high
    size: "1024x1024",
    proxy: "", // 空 = 自动（环境变量 / 系统代理）；"direct" = 不走代理
  },
};

let current = load();
{
  const k = current.api.apiKey;
  const m = k && !k.startsWith("sk-") ? k.match(/sk-[A-Za-z0-9_\-]{16,}/) : null;
  if (m) current.api.apiKey = m[0];
}

function load() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(FILE)) return structuredClone(DEFAULTS);
  try {
    const s = JSON.parse(readFileSync(FILE, "utf8"));
    return { ...DEFAULTS, ...s, codex: { ...DEFAULTS.codex, ...s.codex }, text: { ...DEFAULTS.text, ...s.text }, api: { ...DEFAULTS.api, ...s.api } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function getSettings() {
  return current;
}

export function apiKey() {
  return current.api.apiKey || process.env.OPENAI_API_KEY || "";
}

// 给前端看的版本：Key 打码
export function publicSettings() {
  const k = apiKey();
  return {
    ...current,
    api: {
      ...current.api,
      apiKey: "",
      hasKey: !!k,
      keyHint: k ? `${k.slice(0, 3)}…${k.slice(-4)}` : "",
      keyFromEnv: !current.api.apiKey && !!process.env.OPENAI_API_KEY,
      effectiveProxy: resolveProxy(current.api.proxy) ?? "",
    },
  };
}

export function updateSettings(patch) {
  const next = structuredClone(current);
  if (patch.imageBackend) next.imageBackend = patch.imageBackend === "api" ? "api" : "codex";
  if (patch.concurrency) next.concurrency = Math.max(1, Math.min(8, Number(patch.concurrency) || 3));
  if (patch.codex) Object.assign(next.codex, patch.codex);
  if (patch.text) {
    if (patch.text.apiModel !== undefined) next.text.apiModel = String(patch.text.apiModel).trim();
    if (["low", "medium", "high"].includes(patch.text.effort)) next.text.effort = patch.text.effort;
  }
  if (patch.api) {
    const { apiKey: k, clearKey, ...rest } = patch.api;
    Object.assign(next.api, rest);
    if (k) {
      // 粘贴时常带上"openai api key:"之类的前缀，只取 sk- 开头的那一段
      const raw = String(k).trim();
      next.api.apiKey = raw.match(/sk-[A-Za-z0-9_\-]{16,}/)?.[0] ?? raw;
    }
    if (clearKey) next.api.apiKey = "";
  }
  current = next;
  writeFileSync(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
  return publicSettings();
}
