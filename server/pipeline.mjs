// 流程编排：识别 → 风格设定 → 表情计划 → 批量生成 → 质检/修改 → 导出
// 每个阶段都可以"自动通过"或"停下等用户确认"；生成队列可暂停、单张可中断/重画/局部修改。
import { copyFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import sharp from "sharp";
import { save, addLog, getProject, listProjects, projectDir, uid } from "./store.mjs";
import { getSettings } from "./settings.mjs";
import { runCodexText, runCodexImage } from "./codex-service.mjs";
import { runApiImage } from "./api-backend.mjs";
import { runApiText } from "./api-text.mjs";
import {
  addCost, priceText, priceApiImage, estimateImage, estimatePerSticker, observeCodexAgentTurn, sizeClass, sizeClassFromSetting, usdToCny, gifClass,
} from "./billing.mjs";
import { codexEnv } from "./codex-service.mjs";
import { apiKey } from "./settings.mjs";
import { normalizeInput, prepareRaw, qaFromStats, composeSticker, resizeTo, processGif } from "./imaging.mjs";
import {
  ANALYSIS_SCHEMA, PLAN_SCHEMA, analysisPrompt, planPrompt, stylePreviewPrompt, stickerPrompt, editPrompt, animatePrompt, directGifPrompt, styleById,
  captionStyle, modelCaption, needsInputRef, isTextPack, GUIDE, IMAGE_ROLES, roleIsSubject, roleIsStyle,
} from "./prompts.mjs";

const jobs = new Map(); // key -> AbortController
const jobKey = (pid, kind, id) => `${pid}:${kind}:${id}`;

// ---------- 工具 ----------
const dir = (p) => projectDir(p.id);
const f = (p, name) => join(dir(p), name);

function setStage(p, stage, status, error = null) {
  p.stage = stage;
  p.stageStatus = status;
  p.error = error;
}

function log(p, msg) {
  addLog(p, msg);
  console.log(`[${p.id}] ${msg}`);
}

async function guarded(p, label, fn) {
  try {
    await fn();
  } catch (e) {
    if (e.code === "aborted") {
      log(p, `${label}：已中断`);
      p.stageStatus = "waiting";
    } else {
      log(p, `${label}失败：${e.message}`);
      p.stageStatus = "error";
      p.error = `${label}失败：${e.message}`;
    }
    save(p);
  }
}

function controller(p, kind, id) {
  const c = new AbortController();
  jobs.set(jobKey(p.id, kind, id), c);
  return c;
}

function abortJob(p, kind, id) {
  jobs.get(jobKey(p.id, kind, id))?.abort();
}

// 归档前：中断这个项目所有进行中的任务，把状态收拾成恢复后能继续的样子
export function stopProject(p) {
  for (const [k, c] of jobs) if (k.startsWith(p.id + ":")) c.abort();
  for (const s of p.stickers) {
    if (s.status === "generating" || s.status === "queued") { s.status = s.versions.length ? "review" : "pending"; s.job = null; s.progress = null; }
  }
  for (const k of p.character?.candidates ?? []) if (k.status === "generating") { k.status = "error"; k.error = "归档时中断"; }
  if (p.stageStatus === "running") { p.stageStatus = p.stage === "generate" ? "done" : "error"; if (p.stage !== "generate") p.error = "归档时中断，点「重试」继续"; }
  p.costConfirm = null;
}

// 统一的出图入口：根据设置走 Codex 订阅或 API，并记账
async function generateImage(p, { prompt, refImages, signal, onProgress, tmpName, cost }) {
  const s = getSettings();
  if (s.imageBackend === "api") {
    onProgress?.("drawing");
    const r = await runApiImage({ prompt, refImages, signal });
    const tmp = f(p, tmpName);
    await writeFile(tmp, r.buffer);
    const cls = sizeClassFromSetting(s.api.size);
    const priced = r.usage
      ? { ...priceApiImage({ model: s.api.model, quality: s.api.quality, cls, refCount: refImages.length, usage: r.usage }), estimated: false }
      : { ...estimateImage({ model: s.api.model, quality: s.api.quality, cls, refCount: refImages.length, promptChars: prompt.length }), estimated: true };
    const entry = addCost(p, { ...cost, backend: "api", model: s.api.model, usd: priced.usd, estimated: priced.estimated, tokens: priced.tokens });
    return { src: tmp, usedRef: r.usedRef, revisedPrompt: r.revisedPrompt, backend: "api", cost: entry };
  }
  let r;
  try {
    r = await runCodexImage({ cwd: dir(p), prompt, refImages, signal, onProgress });
  } catch (e) {
    // 失败/中断时 agent 的文字 token 也算钱
    if (e.usage) addCost(p, { ...cost, kind: "failed", label: `${cost.label}（未出图）`, backend: "codex", model: e.model, usd: priceText(e.model, e.usage), estimated: false, tokens: e.usage });
    throw e;
  }
  observeCodexAgentTurn(r.usage);
  const meta = await sharp(r.path).metadata();
  const img = estimateImage({ model: "gpt-image-2.6-sunburst", quality: "medium", cls: sizeClass(meta.width, meta.height), refCount: refImages.length, promptChars: prompt.length });
  const agent = priceText(r.model, r.usage);
  const entry = addCost(p, {
    ...cost, backend: "codex", model: r.model, usd: img.usd + agent, estimated: true,
    tokens: { agent: r.usage, image: img.tokens }, split: { image: img.usd, agent },
  });
  return { src: r.path, usedRef: r.usedRef, revisedPrompt: r.revisedPrompt, backend: "codex", cost: entry };
}

// 合成参数：文字类风格由画面自己画字，不再叠加；其余按风格的配字颜色叠加
function overlayOpts(p, s) {
  const cs = captionStyle(p.analysis);
  if (cs.mode === "model") return { caption: "", captionPos: "none" };
  return { caption: s.caption, captionPos: s.captionPos, fill: cs.fill, stroke: cs.stroke };
}

// 文字步骤（识别/策划）跟随出图通道：API 通道走 Responses API，否则走 Codex 订阅
async function runText(opts) {
  if (getSettings().imageBackend === "api") return { ...(await runApiText(opts)), backend: "api" };
  return { ...(await runCodexText(opts)), backend: "codex" };
}

// 文字步骤记账（两条通道都按官方 token 单价计算）
function chargeText(p, kind, label, r) {
  addCost(p, { kind, label, backend: r.backend ?? "codex", model: r.model, usd: priceText(r.model, r.usage), estimated: false, tokens: r.usage });
}

// 用户上传的图（旧项目只有一张）
const inputs = (p) => p.input.images ?? [p.input.image];
// 每张图的用途；没有识别结果时第一张当主体
function imageRoles(p) {
  const files = inputs(p);
  const given = p.analysis?.imageRoles ?? [];
  return files.map((file, i) => {
    const r = given.find((x) => x.index === i + 1);
    return { index: i + 1, file, role: r?.role ?? (i === 0 ? "subject" : "other"), note: r?.note ?? "" };
  });
}
// 单张表情要额外带上的用户图：实拍类风格带主体图保持真实样貌，「按参考图风格」带风格参考图
function stickerInputRefs(p) {
  const a = p.analysis;
  const fromref = styleById(a?.styleId).id === "fromref";
  const photo = needsInputRef(a);
  return imageRoles(p).filter((r) => (photo && roleIsSubject(r.role)) || (fromref && roleIsStyle(r.role))).slice(0, 3);
}

export function estimate(p, { count = 1, edit = false, gif = null, gifCount = 0 } = {}) {
  const per = estimatePerSticker({ codexModel: codexEnv().model, edit, gif });
  if (!gifCount || gif) {
    const total = per.usd * count;
    return { count, perSticker: per.usd, total, totalCny: total * usdToCny(), usdToCny: usdToCny(), basis: per.basis, parts: per.parts, calibrated: per.calibrated, spent: p.costTotal ?? 0 };
  }
  // 静图和直出动图混合：分开算
  const n = Math.min(gifCount, count);
  const g = estimatePerSticker({ gif: { frames: 8, refCount: 1 + stickerInputRefs(p).length } });
  const total = per.usd * (count - n) + g.usd * n;
  return {
    count, perSticker: per.usd, total, totalCny: total * usdToCny(), usdToCny: usdToCny(),
    basis: per.basis, parts: per.parts, calibrated: per.calibrated && g.calibrated, spent: p.costTotal ?? 0,
    gif: { count: n, per: g.usd, basis: g.basis },
  };
}

function handleUsageLimit(p, e) {
  if (e.code !== "usage_limit") return false;
  p.paused = true;
  const when = e.resetsAt ? new Date(e.resetsAt * 1000).toLocaleString("zh-CN") : "稍后";
  p.notice = `生图额度已用完，队列已暂停。预计 ${when} 恢复，届时点「继续」。`;
  log(p, p.notice);
  return true;
}

// ---------- 创建 ----------
export const MAX_INPUTS = 4;
export async function createProject({ imageDataUrls, imageDataUrl, prompt = "", count = 16, autoRun = false, styleId = "auto", name }) {
  const urls = (imageDataUrls?.length ? imageDataUrls : [imageDataUrl]).filter(Boolean).slice(0, MAX_INPUTS);
  const bufs = urls.map((u) => /^data:image\/[a-z+]+;base64,(.+)$/i.exec(u)?.[1]).filter(Boolean);
  if (!bufs.length && !prompt.trim()) throw new Error("没有图片时，请写一句想法（例如：一只戴围巾的橘猫，打工人日常）");
  const images = bufs.map((_, i) => (i === 0 ? "input.png" : `input-${i + 1}.png`));
  const id = uid("p");
  const p = {
    id,
    name: name || prompt.slice(0, 16) || "未命名表情包",
    createdAt: Date.now(),
    input: { image: images[0] ?? null, images, prompt, count: Math.max(1, Math.min(40, Number(count) || 16)), autoRun: !!autoRun, styleId },
    stage: "analyze",
    stageStatus: "running",
    paused: false,
    error: null,
    notice: null,
    analysis: null,
    character: { candidates: [], chosenId: null },
    plan: null,
    stickers: [],
    log: [],
  };
  await mkdir(projectDir(id), { recursive: true });
  for (let i = 0; i < bufs.length; i++) await normalizeInput(Buffer.from(bufs[i], "base64"), f(p, images[i]));
  log(p, images.length ? `项目已创建（${images.length} 张图），开始识别` : "项目已创建（无图，按描述策划），开始识别");
  save(p);
  runAnalyze(p);
  return p;
}

// ---------- 阶段 1：识别 ----------
async function runAnalyze(p) {
  setStage(p, "analyze", "running");
  save(p);
  await guarded(p, "识别", async () => {
    const c = controller(p, "stage", "analyze");
    const tr = await runText({
      cwd: dir(p),
      prompt: analysisPrompt({ userPrompt: p.input.prompt, count: p.input.count, imageCount: inputs(p).length }),
      images: inputs(p).map((x) => f(p, x)),
      schema: ANALYSIS_SCHEMA,
      signal: c.signal,
    });
    chargeText(p, "analyze", "识别", tr);
    const a = tr.data;
    const subjectType = a.subjectType ?? "character";
    let chars = subjectType === "text" ? [] : (a.characters ?? []).map((ch) => ({ id: uid("c"), ...ch }));
    if (chars.length && !chars.some((ch) => ch.role === "主角")) chars[0].role = "主角";
    const directions = (a.directions ?? []).slice(0, 5);
    const roles = inputs(p).map((_, i) => {
      const r = (a.imageRoles ?? []).find((x) => x.index === i + 1);
      return { index: i + 1, role: IMAGE_ROLES[r?.role] ? r.role : i === 0 ? "subject" : "other", note: r?.note ?? "" };
    });
    const hasStyleRef = roles.some((r) => roleIsStyle(r.role));
    let rec = a.styleId === "fromref" && !hasStyleRef ? (a.altStyleIds ?? []).find((x) => x !== "fromref") ?? "cream" : a.styleId;
    const styleId = p.input.styleId && p.input.styleId !== "auto" ? p.input.styleId : rec;
    p.analysis = {
      summary: a.summary,
      imageRoles: roles,
      subjectType,
      characters: chars,
      styleId,
      altStyleIds: [...new Set((a.altStyleIds ?? []).filter((x) => x !== styleId && (hasStyleRef || x !== "fromref")))].slice(0, 3),
      recommendedStyleId: rec,
      styleReason: a.styleReason,
      styleNote: "",
      toneIds: (a.toneIds ?? []).slice(0, 2),
      directions,
      directionIndex: Math.max(0, Math.min(directions.length - 1, a.recommendedDirection ?? 0)),
    };
    log(p, `识别完成：${subjectType === "text" ? "纯文字包" : chars.map((c) => `${c.role}${c.name}`).join("、")}，推荐风格 ${styleById(p.analysis.styleId).name}`);
    if (p.input.autoRun) return confirmAnalysis(p, {});
    p.stageStatus = "waiting";
    save(p);
  });
}

function applyAnalysisEdits(p, edits = {}) {
  const a = p.analysis;
  if (!a) throw new Error("还没有识别结果");
  if (edits.subjectType) a.subjectType = edits.subjectType;
  if (Array.isArray(edits.imageRoles)) a.imageRoles = edits.imageRoles.filter((r) => IMAGE_ROLES[r.role]).map((r) => ({ index: r.index, role: r.role, note: r.note ?? "" }));
  if (edits.characters) a.characters = edits.characters.map((c) => ({ id: c.id || uid("c"), ...c }));
  if (a.subjectType === "text") a.characters = [];
  if (edits.toneIds) a.toneIds = edits.toneIds;
  if (edits.styleId) a.styleId = edits.styleId;
  if (edits.styleNote !== undefined) a.styleNote = edits.styleNote;
  if (edits.directions) a.directions = edits.directions;
  if (edits.directionIndex !== undefined) a.directionIndex = edits.directionIndex;
  return a;
}

function confirmAnalysis(p, edits = {}) {
  const a = applyAnalysisEdits(p, edits);
  log(p, `已确认主体与方向，开始预览风格「${styleById(a.styleId).name}」`);
  runCharacter(p);
}

// ---------- 阶段 2：风格设定（2×2 风格设定图，可预览多种风格对比） ----------
async function runCharacter(p, note = "", opts = {}) {
  setStage(p, "character", "running");
  const a = p.analysis;
  const styleId = styleById(opts.styleId ?? a.styleId).id;
  const styleNote = opts.styleNote ?? a.styleNote ?? "";
  const cand = { id: uid("k"), status: "generating", note, styleId, styleNote, file: null, error: null };
  p.character.candidates.push(cand);
  save(p);
  try {
    const c = controller(p, "char", cand.id);
    const r = await generateImage(p, {
      prompt: stylePreviewPrompt({
        analysis: a, styleId, styleNote, userPrompt: p.input.prompt, note,
        sceneId: a.directions[a.directionIndex]?.sceneId,
        refs: imageRoles(p),
      }),
      refImages: imageRoles(p).map((r) => f(p, r.file)),
      signal: c.signal,
      tmpName: `tmp-${cand.id}.png`,
      cost: { kind: "character", label: `风格预览「${styleById(styleId).name}」` },
    });
    cand.file = `character-${cand.id}.png`;
    await sharp(r.src).png().toFile(f(p, cand.file));
    cand.status = "done";
    log(p, `风格预览「${styleById(styleId).name}」已生成`);
    if (p.input.autoRun && !p.character.chosenId) {
      if (!p.stickers.length) return confirmCharacter(p, cand.id);
      // 已有表情时重画是批量操作，先等用户确认费用
      p.costConfirm = { kind: "character", count: p.stickers.filter((s) => !s.locked).length, candidateId: cand.id };
    }
  } catch (e) {
    cand.status = "error";
    cand.error = e.code === "aborted" ? "已中断" : e.message;
    if (!handleUsageLimit(p, e)) log(p, `风格预览失败：${cand.error}`);
  }
  if (!p.character.candidates.some((k) => k.status === "generating")) p.stageStatus = "waiting";
  save(p);
}

function confirmCharacter(p, candidateId) {
  const cand = p.character.candidates.find((k) => k.id === candidateId && k.status === "done");
  if (!cand) throw new Error("请选择一张已生成的风格设定图");
  p.character.chosenId = cand.id;
  if (cand.styleId) p.analysis.styleId = cand.styleId;
  if (cand.styleNote !== undefined) p.analysis.styleNote = cand.styleNote;
  p.costConfirm = null;
  log(p, `已确认风格「${styleById(p.analysis.styleId).name}」`);
  if (p.stickers.length) {
    // 改了画风/角色：保留锁定的，其余全部按新设定重画
    for (const s of p.stickers) if (!s.locked && s.status !== "generating") queueSticker(s, redrawJob(s));
    setStage(p, "generate", "running");
    save(p);
    pumpAll();
  } else {
    runPlan(p);
  }
}

// ---------- 阶段 3：表情计划 ----------
async function runPlan(p, note = "") {
  setStage(p, "plan", "running");
  save(p);
  await guarded(p, "策划", async () => {
    const c = controller(p, "stage", "plan");
    const a = p.analysis;
    const direction = a.directions[a.directionIndex] ?? { title: "日常聊天", description: "高频聊天情绪" };
    const keep = p.stickers.filter((s) => s.locked || s.status === "approved").map((s) => s.emotion);
    const count = Math.max(1, p.input.count - keep.length);
    const tr = await runText({
      cwd: dir(p),
      prompt: planPrompt({ analysis: a, direction, count, userPrompt: p.input.prompt, note, keep }),
      schema: PLAN_SCHEMA,
      signal: c.signal,
    });
    chargeText(p, "plan", "策划", tr);
    const r = tr.data;
    p.plan = { note, items: (r.items ?? []).slice(0, count).map((it) => ({ id: uid("i"), ...it })) };
    log(p, `表情计划已生成：${p.plan.items.length} 条`);
    // 全自动模式也要在批量生成前确认预计费用
    if (p.input.autoRun) {
      p.costConfirm = { kind: "plan", count: p.plan.items.length };
      log(p, "等待确认预计费用后开始批量生成");
    }
    p.stageStatus = "waiting";
    save(p);
  });
}

function confirmPlan(p, items) {
  p.costConfirm = null;
  if (!p.character.chosenId) throw new Error("请先确认风格设定图");
  const list = (items ?? p.plan?.items ?? []).filter((it) => it.emotion || it.action);
  if (!list.length) throw new Error("表情计划是空的");
  if (list.some((it) => it.gif)) needApiForDirect();
  p.plan = { ...(p.plan ?? {}), items: list };
  // 保留锁定/已通过的，其余替换
  for (const s of p.stickers) if (!(s.locked || s.status === "approved")) abortJob(p, "sticker", s.id);
  p.stickers = p.stickers.filter((s) => s.locked || s.status === "approved");
  for (const it of list) p.stickers.push(newSticker(it));
  setStage(p, "generate", "running");
  log(p, `开始生成 ${list.length} 张表情`);
  save(p);
  pumpAll();
}

function newSticker(it) {
  const s = {
    id: uid("s"),
    emotion: it.emotion ?? "",
    action: it.action ?? "",
    caption: it.caption ?? "",
    captionPos: it.caption ? "bottom" : "none", // 文字类风格由画面绘制文字，合成时不再叠字
    status: "pending",
    progress: null,
    locked: false,
    error: null,
    versions: [],
    current: null,
    job: null,
    direct: !!it.gif, // 直出动图：不先出静图
    motion: it.motion ?? "",
  };
  queueSticker(s, redrawJob(s));
  return s;
}

// 重画时沿用这张的出图方式：直出动图的继续直出
const redrawJob = (s) => (s.direct ? { mode: "direct" } : { mode: "new" });
function needApiForDirect() {
  if (!apiKey()) throw new Error("直出动图需要 API 通道：先在设置里填好 API Key（Codex 订阅暂未开放原生 GIF）");
}

function queueSticker(s, job) {
  s.status = "queued";
  s.job = job;
  s.error = null;
}

// ---------- 阶段 4：生成队列 ----------
let pumping = false;
export function pumpAll() {
  if (pumping) return;
  pumping = true;
  try {
    const limit = getSettings().concurrency;
    let active = 0;
    for (const p of listProjects()) active += p.stickers.filter((s) => s.status === "generating").length;
    for (const p of listProjects().reverse()) {
      if (p.paused || p.stage !== "generate" || !p.character.chosenId) continue;
      for (const s of p.stickers) {
        if (active >= limit) return;
        if (s.status === "queued") {
          active++;
          runSticker(p, s);
        }
      }
    }
  } finally {
    pumping = false;
  }
}

async function runSticker(p, s) {
  const job = s.job ?? { mode: "new" };
  if (job.mode === "animate") return runAnimate(p, s, job);
  if (job.mode === "direct") return runDirect(p, s, job);
  s.status = "generating";
  s.progress = "thinking";
  s.error = null;
  save(p);
  const vid = uid("v");
  const charFile = f(p, p.character.candidates.find((k) => k.id === p.character.chosenId).file);
  const cur = s.versions.find((v) => v.id === s.current);
  const isEdit = job.mode === "edit" && cur;
  const refs = stickerInputRefs(p);
  const prompt = isEdit
    ? editPrompt({ analysis: p.analysis, item: s, instruction: job.instruction, refs })
    : stickerPrompt({ analysis: p.analysis, item: s, captionSpace: s.captionPos === "bottom" && !!s.caption && !modelCaption(p.analysis), refs });
  const refImages = [...(isEdit ? [f(p, cur.raw)] : []), charFile, ...refs.map((r) => f(p, r.file))];
  const c = controller(p, "sticker", s.id);
  try {
    const r = await generateImage(p, {
      prompt,
      refImages,
      signal: c.signal,
      tmpName: `tmp-${vid}.png`,
      onProgress: (st) => { s.progress = st; save(p); },
      cost: { kind: isEdit ? "edit" : "sticker", label: `「${s.emotion}」${isEdit ? "修改" : "生成"}`, stickerId: s.id, versionId: vid },
    });
    const raw = `v-${vid}-raw.png`;
    const fin = `v-${vid}.png`;
    const stats = await prepareRaw(r.src, f(p, raw));
    await composeSticker(f(p, raw), f(p, fin), overlayOpts(p, s));
    s.versions.push({
      id: vid, raw, final: fin, rev: 1, mode: isEdit ? "edit" : "new", instruction: job.instruction ?? null,
      prompt, revisedPrompt: r.revisedPrompt, backend: r.backend, usedRef: r.usedRef,
      qa: qaFromStats(stats, { usedRef: r.usedRef }), createdAt: Date.now(),
      costUsd: r.cost?.usd ?? 0, costEstimated: r.cost?.estimated ?? true,
    });
    s.current = vid;
    s.status = "review";
    s.job = null;
    log(p, `「${s.emotion}」${isEdit ? "已修改" : "已生成"}`);
  } catch (e) {
    if (e.code === "aborted") {
      s.status = s.versions.length ? "review" : "pending";
      s.job = null;
    } else if (handleUsageLimit(p, e)) {
      s.status = "queued"; // 恢复后自动重试
    } else {
      s.status = "error";
      s.error = e.message;
      log(p, `「${s.emotion}」失败：${e.message}`);
    }
  } finally {
    s.progress = null;
    jobs.delete(jobKey(p.id, "sticker", s.id));
    checkDone(p);
    save(p);
    setImmediate(pumpAll);
  }
}

// ---------- 动图（API 原生 GIF） ----------
async function runAnimate(p, s, job) {
  s.status = "generating";
  s.progress = "drawing";
  s.error = null;
  save(p);
  const aid = uid("a");
  const cur = s.versions.find((v) => v.id === s.current);
  const charFile = f(p, p.character.candidates.find((k) => k.id === p.character.chosenId).file);
  const frames = Math.max(2, Math.min(16, Number(job.frames) || 8));
  const ms = Math.max(20, Math.min(2000, Number(job.ms) || 120));
  const motion = (job.motion || s.motion || "").trim();
  const prompt = animatePrompt({ analysis: p.analysis, item: s, motion });
  const refImages = [f(p, cur.raw), charFile];
  const c = controller(p, "sticker", s.id);
  try {
    const r = await runApiImage({ prompt, refImages, signal: c.signal, gif: { frames, ms, size: "512x512" } });
    const raw = `a-${aid}-raw.gif`;
    await writeFile(f(p, raw), r.buffer);
    const model = getSettings().api.model;
    const quality = getSettings().api.quality || "medium";
    const priced = r.usage
      ? { ...priceApiImage({ model, quality, cls: gifClass(frames), refCount: refImages.length, usage: r.usage }), estimated: false }
      : { usd: estimatePerSticker({ gif: { frames } }).usd, estimated: true };
    const entry = addCost(p, {
      kind: "gif", label: `「${s.emotion}」动图`, stickerId: s.id, backend: "api", model,
      usd: priced.usd, estimated: priced.estimated, tokens: priced.tokens,
    });
    const anim = { id: aid, raw, final: `a-${aid}.gif`, final240: `a-${aid}-240.gif`, rev: 1, motion, frames, ms, createdAt: Date.now(), costUsd: entry.usd, costEstimated: entry.estimated };
    const out = await processGif(f(p, raw), [{ path: f(p, anim.final), size: 512 }, { path: f(p, anim.final240), size: 240 }], overlayOpts(p, s));
    anim.bytes240 = out.results.find((x) => x.size === 240)?.bytes;
    anim.qa = qaFromStats(out.stats, { usedRef: true }).filter((q) => q.code !== "edge");
    if (anim.bytes240 > 500 * 1024) anim.qa.push({ code: "size", msg: `240 尺寸 ${Math.round(anim.bytes240 / 1024)}KB，超过微信 500KB 限制` });
    s.anims = [...(s.anims ?? []), anim];
    s.currentAnim = aid;
    s.status = "review";
    s.job = null;
    log(p, `「${s.emotion}」动图已生成（${frames} 帧）`);
  } catch (e) {
    if (e.code === "aborted") {
      s.status = "review";
      s.job = null;
    } else if (handleUsageLimit(p, e)) {
      s.status = "queued";
    } else {
      s.status = "review";
      s.job = null;
      s.error = "动图失败：" + e.message;
      log(p, `「${s.emotion}」动图失败：${e.message}`);
    }
  } finally {
    s.progress = null;
    jobs.delete(jobKey(p.id, "sticker", s.id));
    checkDone(p);
    save(p);
    setImmediate(pumpAll);
  }
}

// ---------- 直出动图：不经过静图，以风格设定图为参考直接出 GIF，再从中间一帧取静图 ----------
async function runDirect(p, s, job) {
  s.status = "generating";
  s.progress = "drawing";
  s.error = null;
  save(p);
  const aid = uid("a");
  const vid = uid("v");
  const charFile = f(p, p.character.candidates.find((k) => k.id === p.character.chosenId).file);
  const refs = stickerInputRefs(p);
  const frames = Math.max(2, Math.min(16, Number(job.frames) || 8));
  const ms = Math.max(20, Math.min(2000, Number(job.ms) || 120));
  const motion = (job.motion || s.motion || "").trim();
  const prompt = directGifPrompt({ analysis: p.analysis, item: s, motion, refs });
  const refImages = [charFile, ...refs.map((r) => f(p, r.file))];
  const c = controller(p, "sticker", s.id);
  try {
    const r = await runApiImage({ prompt, refImages, signal: c.signal, gif: { frames, ms, size: "512x512" } });
    const raw = `a-${aid}-raw.gif`;
    await writeFile(f(p, raw), r.buffer);
    const model = getSettings().api.model;
    const quality = getSettings().api.quality || "medium";
    const priced = r.usage
      ? { ...priceApiImage({ model, quality, cls: gifClass(frames), refCount: refImages.length, usage: r.usage }), estimated: false }
      : { usd: estimatePerSticker({ gif: { frames, refCount: refImages.length } }).usd, estimated: true };
    const entry = addCost(p, {
      kind: "gif", label: `「${s.emotion}」直出动图`, stickerId: s.id, versionId: vid, backend: "api", model,
      usd: priced.usd, estimated: priced.estimated, tokens: priced.tokens,
    });
    const anim = { id: aid, raw, final: `a-${aid}.gif`, final240: `a-${aid}-240.gif`, rev: 1, motion, frames, ms, createdAt: Date.now(), costUsd: entry.usd, costEstimated: entry.estimated, direct: true };
    const out = await processGif(f(p, raw), [{ path: f(p, anim.final), size: 512 }, { path: f(p, anim.final240), size: 240 }], overlayOpts(p, s));
    anim.bytes240 = out.results.find((x) => x.size === 240)?.bytes;
    anim.qa = qaFromStats(out.stats, { usedRef: true }).filter((q) => q.code !== "edge");
    if (anim.bytes240 > 500 * 1024) anim.qa.push({ code: "size", msg: `240 尺寸 ${Math.round(anim.bytes240 / 1024)}KB，超过微信 500KB 限制` });

    // 静图（封面、图标、静态导出用）：取中间一帧，走和静图一样的去背景与配字
    const pages = (await sharp(f(p, raw)).metadata()).pages ?? 1;
    const tmp = f(p, `tmp-${vid}.png`);
    await sharp(f(p, raw), { page: Math.floor(pages / 2) }).png().toFile(tmp);
    const vraw = `v-${vid}-raw.png`;
    const fin = `v-${vid}.png`;
    const stats = await prepareRaw(tmp, f(p, vraw));
    await rm(tmp, { force: true });
    await composeSticker(f(p, vraw), f(p, fin), overlayOpts(p, s));
    s.versions.push({
      id: vid, raw: vraw, final: fin, rev: 1, mode: "direct", instruction: null,
      prompt, revisedPrompt: r.revisedPrompt, backend: "api", usedRef: true,
      qa: qaFromStats(stats, { usedRef: true }).filter((q) => q.code !== "edge"), createdAt: Date.now(),
      costUsd: 0, costEstimated: false, animId: aid,
    });
    s.current = vid;
    s.anims = [...(s.anims ?? []), anim];
    s.currentAnim = aid;
    s.status = "review";
    s.job = null;
    log(p, `「${s.emotion}」已直出动图（${frames} 帧）`);
  } catch (e) {
    if (e.code === "aborted") {
      s.status = s.versions.length ? "review" : "pending";
      s.job = null;
    } else if (handleUsageLimit(p, e)) {
      s.status = "queued";
    } else {
      s.status = "error";
      s.error = "直出动图失败：" + e.message;
      log(p, `「${s.emotion}」直出动图失败：${e.message}`);
    }
  } finally {
    s.progress = null;
    jobs.delete(jobKey(p.id, "sticker", s.id));
    checkDone(p);
    save(p);
    setImmediate(pumpAll);
  }
}

async function recomposeAnim(p, s) {
  const a = s.anims?.find((x) => x.id === s.currentAnim);
  if (!a) return;
  await processGif(f(p, a.raw), [{ path: f(p, a.final), size: 512 }, { path: f(p, a.final240), size: 240 }], overlayOpts(p, s));
  a.rev = (a.rev ?? 1) + 1;
}

function queueAnimate(p, s, { motion, frames, ms }) {
  if (!apiKey()) throw new Error("动图需要 API 通道：先在设置里填好 API Key（Codex 订阅暂未开放原生 GIF）");
  if (!s.current) throw new Error("先生成静图，再做动图");
  if (!p.character.chosenId) throw new Error("还没有确认风格设定图");
  // 用户写了动作就记到这张上，下次做动图/直出沿用
  if (motion?.trim()) s.motion = motion.trim();
  queueSticker(s, { mode: "animate", motion: (motion ?? "").trim() || s.motion || "", frames, ms });
}

function checkDone(p) {
  if (p.stage !== "generate") return;
  const busy = p.stickers.some((s) => s.status === "queued" || s.status === "generating");
  p.stageStatus = busy ? "running" : "done";
}

async function recompose(p, s) {
  const v = s.versions.find((x) => x.id === s.current);
  if (!v) return;
  await composeSticker(f(p, v.raw), f(p, v.final), overlayOpts(p, s));
  v.rev = (v.rev ?? 1) + 1;
}

// ---------- 导出 ----------
async function exportPack(p) {
  const pick = p.stickers.filter((s) => s.status === "approved" && s.current);
  const list = pick.length ? pick : p.stickers.filter((s) => s.current && s.status !== "rejected");
  if (!list.length) throw new Error("还没有可以导出的表情");
  const out = f(p, "export");
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, "240"), { recursive: true });
  await mkdir(join(out, "512"), { recursive: true });
  // 文件名用纯数字，避免 zip 里中文文件名在部分系统乱码；对应关系写进 list.txt
  let i = 0;
  let gifCount = 0;
  const lines = [];
  for (const s of list) {
    const v = s.versions.find((x) => x.id === s.current);
    const name = `${String(++i).padStart(2, "0")}.png`;
    await copyFile(f(p, v.final), join(out, "512", name));
    await resizeTo(f(p, v.final), join(out, "240", name), 240);
    const an = s.anims?.find((x) => x.id === s.currentAnim);
    if (an) {
      const gname = name.replace(/\.png$/, ".gif");
      await mkdir(join(out, "gif-240"), { recursive: true });
      await mkdir(join(out, "gif-512"), { recursive: true });
      await copyFile(f(p, an.final240), join(out, "gif-240", gname));
      await copyFile(f(p, an.final), join(out, "gif-512", gname));
      gifCount++;
    }
    lines.push(`${name}\t${s.emotion}\t${s.captionPos === "none" ? "" : s.caption}\t${an ? "有" : ""}`);
  }
  await writeFile(join(out, "list.txt"), "文件\t情绪\t配字\t动图\n" + lines.join("\n") + "\n");
  // 封面：第一张 240 图；图标 50
  const first = p.stickers.find((s) => s === list[0]);
  const fv = first.versions.find((x) => x.id === first.current);
  await resizeTo(f(p, fv.final), join(out, "cover-240.png"), 240);
  await resizeTo(f(p, fv.final), join(out, "icon-50.png"), 50);
  await rm(f(p, "export.zip"), { force: true });
  await new Promise((res, rej) =>
    execFile("zip", ["-rq", "../export.zip", "."], { cwd: out }, (err) => (err ? rej(err) : res())),
  );
  log(p, `已导出 ${list.length} 张${gifCount ? `（含 ${gifCount} 张动图）` : ""}`);
  p.exportedAt = Date.now();
  return { count: list.length, gifCount, zip: `/files/${p.id}/export.zip?t=${p.exportedAt}` };
}

// ---------- 动作分发 ----------
export async function act(id, a) {
  const p = getProject(id);
  if (!p) throw new Error("项目不存在");
  const stk = () => {
    const s = p.stickers.find((x) => x.id === a.id);
    if (!s) throw new Error("表情不存在");
    return s;
  };
  switch (a.type) {
    case "retryStage":
      if (p.stage === "analyze") runAnalyze(p);
      else if (p.stage === "plan") runPlan(p, p.plan?.note ?? "");
      else if (p.stage === "character") runCharacter(p);
      else { p.stageStatus = "running"; pumpAll(); }
      break;
    case "cancelStage":
      abortJob(p, "stage", p.stage);
      for (const k of p.character.candidates) if (k.status === "generating") abortJob(p, "char", k.id);
      break;
    case "confirmAnalysis":
      confirmAnalysis(p, a.edits);
      break;
    case "regenerateCharacter":
      runCharacter(p, a.note ?? "");
      break;
    case "confirmCharacter":
      confirmCharacter(p, a.candidateId);
      break;
    case "regeneratePlan":
      runPlan(p, a.note ?? "");
      break;
    case "confirmPlan":
      confirmPlan(p, a.items);
      break;
    case "previewStyle":
      if (!p.analysis) throw new Error("还没有识别结果");
      runCharacter(p, a.note ?? "", { styleId: a.styleId, styleNote: a.styleNote });
      break;
    case "editAnalysis":
      // 已过识别阶段后修改主体/语气：回到风格设定，由用户挑风格再预览
      applyAnalysisEdits(p, a.edits ?? {});
      log(p, "已更新主体/语气，回到风格设定");
      setStage(p, "character", "waiting");
      break;
    case "changeStyle":
      p.analysis.styleId = a.styleId ?? p.analysis.styleId;
      if (a.styleNote !== undefined) p.analysis.styleNote = a.styleNote;
      p.character.chosenId = null;
      log(p, `改风格为 ${styleById(p.analysis.styleId).name}，重新预览风格设定图`);
      runCharacter(p, a.note ?? "");
      break;
    case "changeDirection":
      p.analysis.directionIndex = a.directionIndex ?? p.analysis.directionIndex;
      if (a.direction) p.analysis.directions[p.analysis.directionIndex] = a.direction;
      runPlan(p, a.note ?? "");
      break;
    case "backToCharacter":
      setStage(p, "character", "waiting");
      break;
    case "setAutoRun":
      p.input.autoRun = !!a.value;
      break;
    case "pause":
      p.paused = true;
      if (a.interrupt) for (const s of p.stickers) if (s.status === "generating") abortJob(p, "sticker", s.id);
      log(p, a.interrupt ? "已暂停并中断进行中的任务" : "已暂停（进行中的会画完）");
      break;
    case "resume":
      p.paused = false;
      p.notice = null;
      if (p.stage === "generate") p.stageStatus = "running";
      log(p, "继续");
      break;
    case "sticker.regenerate": {
      const s = stk();
      if (a.emotion !== undefined) s.emotion = a.emotion;
      if (a.action !== undefined) s.action = a.action;
      if (a.caption !== undefined) s.caption = a.caption;
      if (a.captionPos !== undefined) s.captionPos = a.captionPos;
      if (a.direct !== undefined) s.direct = !!a.direct;
      if (a.motion !== undefined) s.motion = a.motion;
      if (s.direct) needApiForDirect();
      if (s.status === "generating") abortJob(p, "sticker", s.id);
      queueSticker(s, redrawJob(s));
      p.stage = "generate";
      checkDone(p);
      break;
    }
    case "sticker.edit": {
      const s = stk();
      if (!s.current) throw new Error("这张还没有图，先生成");
      if (!a.instruction?.trim()) throw new Error("请写修改要求");
      queueSticker(s, { mode: "edit", instruction: a.instruction.trim() });
      p.stage = "generate";
      checkDone(p);
      break;
    }
    case "sticker.caption": {
      const s = stk();
      s.caption = a.caption ?? s.caption;
      s.captionPos = a.captionPos ?? s.captionPos;
      if (modelCaption(p.analysis)) {
        // 文字是画面的一部分，改字需要重画
        if (s.status === "generating") abortJob(p, "sticker", s.id);
        queueSticker(s, redrawJob(s));
        p.stage = "generate";
        checkDone(p);
        break;
      }
      await recompose(p, s);
      await recomposeAnim(p, s);
      break;
    }
    case "sticker.status": {
      const s = stk();
      if (["approved", "rejected", "review"].includes(a.status) && s.current) s.status = a.status;
      break;
    }
    case "sticker.lock":
      stk().locked = !!a.locked;
      break;
    case "sticker.selectVersion": {
      const s = stk();
      const v = s.versions.find((x) => x.id === a.versionId);
      if (v) {
        s.current = v.id;
        await recompose(p, s);
        // 直出动图的静图版本：一起切到它对应的动图
        if (v.animId && s.anims?.some((x) => x.id === v.animId)) {
          s.currentAnim = v.animId;
          await recomposeAnim(p, s);
        }
      }
      break;
    }
    case "sticker.cancel": {
      const s = stk();
      if (s.status === "generating") abortJob(p, "sticker", s.id);
      else if (s.status === "queued") { s.status = s.versions.length ? "review" : "pending"; s.job = null; }
      checkDone(p);
      break;
    }
    case "sticker.delete": {
      const s = stk();
      abortJob(p, "sticker", s.id);
      p.stickers = p.stickers.filter((x) => x !== s);
      checkDone(p);
      break;
    }
    case "sticker.add": {
      if (a.gif) needApiForDirect();
      const s = newSticker({ emotion: a.emotion, action: a.action, caption: a.caption, gif: !!a.gif, motion: a.motion });
      p.stickers.push(s);
      p.stage = "generate";
      checkDone(p);
      break;
    }
    case "sticker.animate": {
      const s = stk();
      if (s.status === "generating") throw new Error("这张正在生成中");
      queueAnimate(p, s, a);
      p.stage = "generate";
      checkDone(p);
      break;
    }
    case "animateMany": {
      const ids = new Set(a.ids ?? []);
      let n = 0;
      for (const s of p.stickers) {
        if (!ids.has(s.id) || s.status === "generating" || s.status === "queued") continue;
        queueAnimate(p, s, { motion: "", frames: a.frames, ms: a.ms });
        n++;
      }
      p.stage = "generate";
      checkDone(p);
      log(p, `批量做动图：${n} 张`);
      break;
    }
    case "sticker.selectAnim": {
      const s = stk();
      if (a.animId === null) s.currentAnim = null;
      else if (s.anims?.some((x) => x.id === a.animId)) {
        s.currentAnim = a.animId;
        await recomposeAnim(p, s);
      }
      break;
    }
    case "estimate":
      return estimate(p, { count: Number(a.count) || 1, edit: !!a.edit, gif: a.gif ? { frames: Number(a.gif.frames) || 8 } : null, gifCount: Number(a.gifCount) || 0 });
    case "approveAll":
      for (const s of p.stickers) if (s.status === "review") s.status = "approved";
      break;
    case "export": {
      const r = await exportPack(p);
      save(p);
      return r;
    }
    default:
      throw new Error("未知操作 " + a.type);
  }
  save(p);
  pumpAll();
  return { ok: true };
}

// ---------- 启动恢复 ----------
export function recover(projects) {
  for (const p of projects) {
    let touched = false;
    // 旧项目迁移：没有主体类型的按角色处理，旧画风 id 映射到新风格
    const an = p.analysis;
    if (an && !an.subjectType) {
      an.subjectType = (an.characters ?? []).length > 1 ? "duo" : "character";
      an.styleId = styleById(an.styleId).id;
      an.recommendedStyleId ??= an.styleId;
      an.toneIds ??= [];
      for (const d of an.directions ?? []) d.sceneId ??= "daily";
      for (const k of p.character?.candidates ?? []) if (k.file && !k.styleId) k.styleId = an.styleId;
      touched = true;
    }
    for (const s of p.stickers ?? []) {
      if (s.status === "generating") { s.status = "queued"; s.progress = null; touched = true; }
    }
    for (const k of p.character?.candidates ?? []) {
      if (k.status === "generating") { k.status = "error"; k.error = "服务重启中断"; touched = true; }
    }
    if (p.stageStatus === "running" && (p.stage === "analyze" || p.stage === "plan" || p.stage === "character")) {
      p.stageStatus = "error";
      p.error = "服务重启，任务被中断，点「重试」继续";
      touched = true;
    }
    if (p.stickers?.some((s) => s.status === "queued")) {
      p.paused = true;
      p.notice = "服务重启后队列已暂停，点「继续」接着画";
      touched = true;
    }
    if (touched) save(p);
  }
}
