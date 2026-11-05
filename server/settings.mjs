// 本地设置：data/settings.json（已在 .gitignore 中）。API Key 只存本机，不回传前端明文。
// 生图（image）和生文（text：识别 / 策划）各自选通道、各自配 API，互不影响。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.mjs";
import { resolveProxy } from "./proxy.mjs";

const FILE = join(DATA_DIR, "settings.json");
export const OPENAI_BASE = "https://api.openai.com/v1";

const DEFAULTS = {
  concurrency: 3,
  proxy: "", // 空 = 自动（环境变量 / 系统代理）；"direct" = 不走代理
  codex: { model: "gpt-6.1-terra" }, // 两条 Codex 通道共用；空或不可用时用 model/list 的默认模型
  image: {
    backend: "codex", // "codex" | "api"
    baseUrl: OPENAI_BASE,
    apiKey: "",
    model: "gpt-image-2.6-sunburst",
    quality: "medium", // low | medium | high
    size: "1024x1024",
  },
  text: {
    backend: "codex", // "codex" | "api"
    baseUrl: OPENAI_BASE,
    apiKey: "", // 空 = Base URL 和生图相同时沿用生图的 Key
    model: "gpt-6.1-terra",
    format: "responses", // "responses"（OpenAI Responses API）| "chat"（兼容 /chat/completions）
    effort: "medium",
  },
};

const pickKey = (k) => {
  const raw = String(k ?? "").trim();
  // 粘贴时常带上"openai api key:"之类的前缀，有 sk- 段就只取那一段
  return raw.match(/sk-[A-Za-z0-9_\-]{16,}/)?.[0] ?? raw;
};

let current = load();

// 旧版：imageBackend + api{...}（文字跟随出图通道）+ text{apiModel, effort}
function migrate(s) {
  if (s.image || !s.api) return s;
  const { apiKey, proxy, ...img } = s.api;
  return {
    concurrency: s.concurrency,
    proxy: proxy ?? "",
    codex: s.codex,
    image: { ...img, backend: s.imageBackend === "api" ? "api" : "codex", apiKey: apiKey ?? "" },
    text: {
      backend: s.imageBackend === "api" ? "api" : "codex",
      baseUrl: img.baseUrl,
      apiKey: "",
      model: s.text?.apiModel,
      effort: s.text?.effort,
    },
  };
}

function load() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(FILE)) return structuredClone(DEFAULTS);
  try {
    const s = migrate(JSON.parse(readFileSync(FILE, "utf8")));
    const clean = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
    const out = {
      ...DEFAULTS,
      ...clean({ concurrency: s.concurrency, proxy: s.proxy }),
      codex: { ...DEFAULTS.codex, ...clean(s.codex) },
      image: { ...DEFAULTS.image, ...clean(s.image) },
      text: { ...DEFAULTS.text, ...clean(s.text) },
    };
    out.image.apiKey = pickKey(out.image.apiKey);
    out.text.apiKey = pickKey(out.text.apiKey);
    return out;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function getSettings() {
  return current;
}

const norm = (u) => (u || OPENAI_BASE).trim().replace(/\/+$/, "");
const isOpenAI = (u) => { try { return new URL(norm(u)).host === "api.openai.com"; } catch { return false; } };

// 生图 Key：设置里填的 → 环境变量 OPENAI_API_KEY（只给官方地址用，不把它发给第三方）
export function imageKey() {
  const s = current.image;
  return s.apiKey || (isOpenAI(s.baseUrl) ? process.env.OPENAI_API_KEY || "" : "");
}
// 生文 Key：设置里填的 → Base URL 与生图相同时沿用生图 Key → 官方地址时用环境变量
export function textKey() {
  const t = current.text;
  if (t.apiKey) return t.apiKey;
  if (norm(t.baseUrl) === norm(current.image.baseUrl) && current.image.apiKey) return current.image.apiKey;
  return isOpenAI(t.baseUrl) ? process.env.OPENAI_API_KEY || "" : "";
}

function keyInfo(own, effective) {
  return {
    apiKey: "",
    hasKey: !!effective,
    keyHint: effective ? `${effective.slice(0, 3)}…${effective.slice(-4)}` : "",
    keyFrom: !effective ? "" : own ? "self" : effective === current.image.apiKey ? "image" : "env",
  };
}

// 给前端看的版本：Key 打码
export function publicSettings() {
  return {
    ...current,
    effectiveProxy: resolveProxy(current.proxy) ?? "",
    image: { ...current.image, ...keyInfo(current.image.apiKey, imageKey()) },
    text: { ...current.text, ...keyInfo(current.text.apiKey, textKey()) },
  };
}

const str = (v) => String(v ?? "").trim();

function patchSection(sec, patch, extra) {
  if (!patch) return;
  if (patch.backend !== undefined) sec.backend = patch.backend === "api" ? "api" : "codex";
  if (patch.baseUrl !== undefined) sec.baseUrl = norm(str(patch.baseUrl));
  if (patch.model !== undefined) sec.model = str(patch.model);
  if (patch.apiKey) sec.apiKey = pickKey(patch.apiKey);
  if (patch.clearKey) sec.apiKey = "";
  extra(sec, patch);
}

export function updateSettings(patch) {
  const next = structuredClone(current);
  if (patch.concurrency) next.concurrency = Math.max(1, Math.min(8, Number(patch.concurrency) || 3));
  if (patch.proxy !== undefined) next.proxy = str(patch.proxy);
  if (patch.codex?.model !== undefined) next.codex.model = str(patch.codex.model);
  patchSection(next.image, patch.image, (sec, p) => {
    if (["low", "medium", "high", "auto"].includes(p.quality)) sec.quality = p.quality;
    if (p.size !== undefined) sec.size = str(p.size) || "1024x1024";
  });
  patchSection(next.text, patch.text, (sec, p) => {
    if (["responses", "chat"].includes(p.format)) sec.format = p.format;
    if (["low", "medium", "high"].includes(p.effort)) sec.effort = p.effort;
  });
  current = next;
  writeFileSync(FILE, JSON.stringify(current, null, 2), { mode: 0o600 });
  return publicSettings();
}
