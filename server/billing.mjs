// 计费：按 OpenAI 官方标准价折算。
// - API 通道：用响应里的 usage 算实际费用，并据此校准估算表
// - Codex 订阅：文字部分用 app-server 上报的 token 用量；图片部分 Codex 不报 token，按官方价估算
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, DATA_DIR } from "./paths.mjs";
import { getSettings } from "./settings.mjs";
import { recordSpend } from "./spend.mjs";

const PRICING = JSON.parse(readFileSync(join(ROOT, "server/pricing.json"), "utf8"));
const CAL_FILE = join(DATA_DIR, "pricing-calibration.json");
let cal = existsSync(CAL_FILE) ? safeJson(readFileSync(CAL_FILE, "utf8")) ?? {} : {};

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function saveCal() { try { writeFileSync(CAL_FILE, JSON.stringify(cal, null, 2)); } catch {} }

// 滑动平均
function observe(key, value) {
  if (!Number.isFinite(value) || value <= 0) return;
  const c = cal[key] ?? { avg: 0, n: 0 };
  c.n = Math.min(c.n + 1, 50);
  c.avg = c.avg + (value - c.avg) / c.n;
  cal[key] = c;
  saveCal();
}
const calAvg = (key) => (cal[key]?.n ? cal[key].avg : null);

export const usdToCny = () => PRICING.usdToCny;
const M = 1e6;

export function sizeClass(w, h) {
  if (!w || !h) return "square";
  const r = w / h;
  return r > 1.15 ? "landscape" : r < 0.87 ? "portrait" : "square";
}
export function sizeClassFromSetting(size) {
  const m = /^(\d+)x(\d+)$/.exec(size ?? "");
  return m ? sizeClass(+m[1], +m[2]) : "square";
}

function imagePrice(model) {
  return PRICING.imageModels[model] ?? PRICING.imageModels[PRICING.defaultImageModel];
}
function textPrice(model) {
  return PRICING.textModels[model] ?? PRICING.textModels[PRICING.defaultTextModel];
}

// ---------- 文字（Codex agent turn） ----------
export function priceText(model, u) {
  if (!u) return 0;
  const p = textPrice(model);
  const cached = u.cachedInputTokens ?? 0;
  const fresh = Math.max(0, (u.inputTokens ?? 0) - cached);
  return (fresh * p.in + cached * p.cached + (u.outputTokens ?? 0) * p.out) / M;
}

// ---------- 图片 ----------
function estOutputTokens(model, quality, cls) {
  return calAvg(`out:${model}:${quality}:${cls}`) ?? PRICING.imageOutputTokens[quality]?.[cls] ?? PRICING.imageOutputTokens.medium[cls];
}
function estRefTokens(model) {
  return calAvg(`ref:${model}`) ?? PRICING.refImageInputTokens;
}
const estPromptTokens = (chars) => Math.round((chars ?? 600) * 1.1);

export function estimateImage({ model, quality, cls, refCount, promptChars }) {
  const p = imagePrice(model);
  const t = {
    textIn: estPromptTokens(promptChars),
    imageIn: refCount * estRefTokens(model),
    imageOut: estOutputTokens(model, quality, cls),
  };
  return { usd: (t.textIn * p.textIn + t.imageIn * p.imageIn + t.imageOut * p.imageOut) / M, tokens: t };
}

// API 返回的 usage → 实际费用，并校准估算
export function priceApiImage({ model, quality, cls, refCount, usage }) {
  const p = imagePrice(model);
  const inD = usage?.input_tokens_details ?? {};
  const outD = usage?.output_tokens_details ?? {};
  const imageIn = inD.image_tokens ?? 0;
  const textIn = inD.text_tokens ?? Math.max(0, (usage?.input_tokens ?? 0) - imageIn);
  const cachedImg = inD.cached_tokens_details?.image_tokens ?? 0;
  const cachedTxt = inD.cached_tokens_details?.text_tokens ?? (inD.cached_tokens ?? 0);
  const imageOut = outD.image_tokens ?? usage?.output_tokens ?? 0;
  const textOut = outD.text_tokens ?? 0;
  const usd =
    ((textIn - cachedTxt) * p.textIn + cachedTxt * p.textCached + (imageIn - cachedImg) * p.imageIn + cachedImg * p.imageCached + (imageOut + textOut) * p.imageOut) / M;
  observe(`out:${model}:${quality}:${cls}`, imageOut);
  if (refCount && imageIn) observe(`ref:${model}`, imageIn / refCount);
  return { usd, tokens: { textIn, imageIn, imageOut, textOut } };
}

export function observeCodexAgentTurn(u) {
  if (!u) return;
  observe("codexTurn:in", u.inputTokens);
  observe("codexTurn:cached", (u.cachedInputTokens ?? 0) + 1); // +1 避免 0 被忽略
  observe("codexTurn:out", u.outputTokens);
}
function codexTurnDefault() {
  const d = PRICING.codexAgentTurnDefault;
  return {
    inputTokens: calAvg("codexTurn:in") ?? d.inputTokens,
    cachedInputTokens: Math.max(0, (calAvg("codexTurn:cached") ?? d.cachedInputTokens + 1) - 1),
    outputTokens: calAvg("codexTurn:out") ?? d.outputTokens,
  };
}

// ---------- 动图 ----------
export const gifClass = (frames, size = "512x512") => `gif${frames}@${size}`;
// 实测 8 帧 512² 输出 974 token；没有校准数据时按帧数线性估
export function estimateGif({ frames = 8, refCount = 2 } = {}) {
  const s = getSettings().api;
  const model = s.model;
  const quality = s.quality || "medium";
  const p = imagePrice(model);
  const out = calAvg(`out:${model}:${quality}:${gifClass(frames)}`) ?? Math.round((974 * frames) / 8);
  const t = { textIn: 250, imageIn: refCount * estRefTokens(model), imageOut: out };
  const usd = (t.textIn * p.textIn + t.imageIn * p.imageIn + t.imageOut * p.imageOut) / M;
  return {
    usd,
    parts: { image: usd, agent: 0 },
    basis: `API ${model} · ${quality} · GIF ${frames} 帧 × 512²（${refCount} 张参考图）`,
    calibrated: calAvg(`out:${model}:${quality}:${gifClass(frames)}`) != null,
  };
}

// ---------- 单张预估（给"开始生成"前的确认用） ----------
export function estimatePerSticker({ codexModel, edit = false, gif = null } = {}) {
  if (gif) return estimateGif({ frames: gif.frames, refCount: gif.refCount ?? 2 });
  const s = getSettings();
  const refCount = edit ? 2 : 1;
  if (s.imageBackend === "api") {
    const cls = sizeClassFromSetting(s.api.size);
    const img = estimateImage({ model: s.api.model, quality: s.api.quality, cls, refCount, promptChars: 700 });
    return {
      usd: img.usd,
      parts: { image: img.usd, agent: 0 },
      basis: `API ${s.api.model} · ${s.api.quality} · ${s.api.size}`,
      calibrated: calAvg(`out:${s.api.model}:${s.api.quality}:${cls}`) != null,
    };
  }
  const a = PRICING.codexImageAssume;
  const img = estimateImage({ model: a.model, quality: a.quality, cls: "square", refCount, promptChars: 700 });
  const agent = priceText(codexModel, codexTurnDefault());
  return {
    usd: img.usd + agent,
    parts: { image: img.usd, agent },
    basis: `Codex 订阅（按 ${a.model} ${a.quality} 的官方价折算 + ${codexModel ?? "agent"} 文字 token）`,
    calibrated: calAvg("codexTurn:in") != null,
  };
}

export function pricingInfo() {
  return {
    usdToCny: PRICING.usdToCny,
    imageModels: PRICING.imageModels,
    textModels: PRICING.textModels,
    note: PRICING._note,
    calibration: cal,
  };
}

// ---------- 记账 ----------
export function addCost(p, entry) {
  p.costs = p.costs ?? [];
  const e = { t: Date.now(), ...entry, usd: Math.round(entry.usd * 1e6) / 1e6 };
  p.costs.push(e);
  if (p.costs.length > 2000) p.costs.splice(0, p.costs.length - 2000);
  p.costTotal = Math.round(p.costs.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6;
  recordSpend(e);
  return e;
}
