// 图像处理：输入规范化、去背景、质检、合成带字表情、导出尺寸。
import sharp from "sharp";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";

// ---------- 字体 ----------
const FONT_FAMILY = "StickerFont";
let fontReady = false;
function ensureFont() {
  if (fontReady) return;
  const candidates = [];
  const userFonts = join(ROOT, "fonts");
  if (existsSync(userFonts))
    for (const f of readdirSync(userFonts)) if (/\.(ttf|otf|ttc)$/i.test(f)) candidates.push(join(userFonts, f));
  candidates.push(
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
  );
  for (const p of candidates) {
    if (existsSync(p) && GlobalFonts.registerFromPath(p, FONT_FAMILY)) {
      fontReady = true;
      return;
    }
  }
  fontReady = true; // 没找到也继续，用系统默认字体
}

// ---------- 输入 ----------
export async function normalizeInput(buffer, dst) {
  await sharp(buffer).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).png().toFile(dst);
}

// ---------- 去背景 + 质检 ----------
// 读入生成结果；若几乎没有透明区域，则从边缘做洪泛去掉纯色背景。
export async function prepareRaw(src, dst) {
  const img = sharp(src).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let stats = alphaStats(data, w, h);
  let bgRemoved = false;
  if (stats.transparentRatio < 0.03) {
    removeBorderBackground(data, w, h);
    stats = alphaStats(data, w, h);
    bgRemoved = true;
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(dst);
  return { ...stats, width: w, height: h, bgRemoved };
}

function alphaStats(d, w, h) {
  let transparent = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3];
      if (a < 16) transparent++;
      else {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  const bbox = maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  const m = 2;
  const touchesEdge = !!bbox && (minX <= m || minY <= m || maxX >= w - 1 - m || maxY >= h - 1 - m);
  return {
    transparentRatio: transparent / (w * h),
    bbox,
    touchesEdge,
    subjectRatio: bbox ? (bbox.w * bbox.h) / (w * h) : 0,
  };
}

function removeBorderBackground(d, w, h) {
  // 背景色取四角平均
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  const bg = [0, 0, 0];
  for (const [x, y] of corners) for (let c = 0; c < 3; c++) bg[c] += d[(y * w + x) * 4 + c] / 4;
  const tol2 = 42 * 42;
  const near = (i) => {
    const dr = d[i] - bg[0], dg = d[i + 1] - bg[1], db = d[i + 2] - bg[2];
    return dr * dr + dg * dg + db * db < tol2;
  };
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    const p = y * w + x;
    if (!seen[p] && near(p * 4)) { seen[p] = 1; stack.push(p); }
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop();
    d[p * 4 + 3] = 0;
    const x = p % w, y = (p / w) | 0;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  // 边缘柔化：与透明区相邻的不透明像素半透明处理
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      if (seen[p]) continue;
      if (seen[p - 1] || seen[p + 1] || seen[p - w] || seen[p + w]) d[p * 4 + 3] = Math.min(d[p * 4 + 3], 170);
    }
}

export function qaFromStats(stats, { usedRef }) {
  const qa = [];
  if (!usedRef) qa.push({ code: "no_ref", msg: "生成时没有带上角色参考图，注意核对是否像本人" });
  if (stats.transparentRatio < 0.05) qa.push({ code: "bg", msg: "背景没有去干净" });
  if (stats.touchesEdge) qa.push({ code: "edge", msg: "主体贴边，可能被裁切" });
  if (stats.subjectRatio && stats.subjectRatio < 0.12) qa.push({ code: "small", msg: "主体偏小" });
  if (!stats.bbox) qa.push({ code: "empty", msg: "画面是空的" });
  return qa;
}

// ---------- 合成 ----------
// raw → 512×512 透明底，按需加字
export async function composeSticker(rawPath, dst, { caption = "", captionPos = "bottom", size = 512, fill, stroke } = {}) {
  const meta = await sharp(rawPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const st = alphaStats(meta.data, meta.info.width, meta.info.height);
  const bb = st.bbox ?? { x: 0, y: 0, w: meta.info.width, h: meta.info.height };
  const cropped = await sharp(rawPath).extract({ left: bb.x, top: bb.y, width: bb.w, height: bb.h }).png().toBuffer();
  await writeFile(dst, await composeCanvas(cropped, { caption, captionPos, size, fill, stroke }));
}

// 把裁好的主体放进方形画布并加字，返回 PNG buffer
async function composeCanvas(croppedPng, { caption = "", captionPos = "bottom", size = 512, fill = "#ffffff", stroke = "#1d1d1f" }) {
  ensureFont();
  const img = await loadImage(croppedPng);
  const hasCap = caption.trim() && captionPos !== "none";
  const pad = Math.round(size * 0.04);
  const capH = hasCap ? Math.round(size * 0.2) : 0;
  const box = { x: pad, y: pad + (hasCap && captionPos === "top" ? capH : 0), w: size - pad * 2, h: size - pad * 2 - capH };
  const scale = Math.min(box.w / img.width, box.h / img.height);
  const dw = img.width * scale, dh = img.height * scale;

  const cv = createCanvas(size, size);
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);

  if (hasCap) {
    const t = caption.trim();
    let fs = Math.round(size * 0.14);
    ctx.font = `bold ${fs}px ${FONT_FAMILY}, "PingFang SC", sans-serif`;
    while (ctx.measureText(t).width > size * 0.92 && fs > 10) {
      fs -= 1;
      ctx.font = `bold ${fs}px ${FONT_FAMILY}, "PingFang SC", sans-serif`;
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const cy = captionPos === "top" ? pad + capH / 2 : size - pad - capH / 2;
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, fs * 0.22);
    ctx.strokeStyle = stroke;
    ctx.strokeText(t, size / 2, cy);
    ctx.fillStyle = fill;
    ctx.fillText(t, size / 2, cy);
  }
  return cv.encode("png");
}

// ---------- 动图 ----------
// API 返回的 GIF（白底）→ 逐帧去背景 → 所有帧用同一个裁切框（防止主体抖动）→ 加字 → 输出多个尺寸
export async function processGif(src, outs, { caption = "", captionPos = "bottom", fill, stroke, maxBytes = 500 * 1024 } = {}) {
  const meta = await sharp(src, { animated: true }).metadata();
  const n = meta.pages ?? 1;
  const fh = meta.pageHeight ?? meta.height;
  const { data, info } = await sharp(src, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const frameBytes = w * fh * 4;
  const frames = [];
  let union = null;
  let transparentSum = 0;
  for (let i = 0; i < n; i++) {
    const fr = Buffer.from(data.subarray(i * frameBytes, (i + 1) * frameBytes));
    let st = alphaStats(fr, w, fh);
    if (st.transparentRatio < 0.03) {
      removeBorderBackground(fr, w, fh);
      st = alphaStats(fr, w, fh);
    }
    transparentSum += st.transparentRatio;
    if (st.bbox) {
      const b = st.bbox;
      union = union
        ? { x0: Math.min(union.x0, b.x), y0: Math.min(union.y0, b.y), x1: Math.max(union.x1, b.x + b.w), y1: Math.max(union.y1, b.y + b.h) }
        : { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
    }
    frames.push(fr);
  }
  const bb = union ? { left: union.x0, top: union.y0, width: union.x1 - union.x0, height: union.y1 - union.y0 } : { left: 0, top: 0, width: w, height: fh };
  const delay = meta.delay ?? Array(n).fill(120);
  const crops = [];
  for (const fr of frames) crops.push(await sharp(fr, { raw: { width: w, height: fh, channels: 4 } }).extract(bb).png().toBuffer());

  const results = [];
  for (const { path, size } of outs) {
    const composed = [];
    for (const c of crops) composed.push(await composeCanvas(c, { caption, captionPos, size, fill, stroke }));
    // 超过体积上限时逐步减少颜色数
    let bytes = 0;
    for (const colours of [256, 128, 64, 32]) {
      const buf = await sharp(composed, { join: { animated: true } }).gif({ delay, loop: 0, colours, effort: 8 }).toBuffer();
      bytes = buf.length;
      await writeFile(path, buf);
      if (bytes <= maxBytes) break;
    }
    results.push({ path, size, bytes });
  }
  const m = 2;
  const touchesEdge = !!union && (union.x0 <= m || union.y0 <= m || union.x1 >= w - m || union.y1 >= fh - m);
  return { frames: n, delay, results, stats: { transparentRatio: transparentSum / n, touchesEdge, bbox: union, subjectRatio: union ? (bb.width * bb.height) / (w * fh) : 0 } };
}

export async function resizeTo(src, dst, size) {
  await sharp(src).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toFile(dst);
}
