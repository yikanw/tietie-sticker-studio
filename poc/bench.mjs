#!/usr/bin/env node
// 并发 / 单 prompt 多图 / GIF 测试
//   node poc/bench.mjs concurrent --n 4 --image ref.png
//   node poc/bench.mjs multi --count 4 --image ref.png
//   node poc/bench.mjs gif --image ref.png

import { copyFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, statSync, appendFileSync, writeFileSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { CodexClient, text, localImage } from "./lib/codex-client.mjs";

const [mode = "concurrent", ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) args[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") ? true : rest[++i] ?? true;

const T0 = Date.now();
const s = (ms) => ((ms - T0) / 1000).toFixed(1) + "s";

const ref = args.image ? resolve(args.image) : null;
const outDir = resolve(args.out ?? `poc/out/${mode}`);
mkdirSync(outDir, { recursive: true });
const logFile = join(outDir, "bench.log");
const log = (...m) => {
  const line = `[${s(Date.now())}] ${m.join(" ")}`;
  console.log(line);
  appendFileSync(logFile, line + "\n");
};

const EMOTIONS = ["开心到转圈", "生气跺脚冒烟", "震惊瞳孔地震", "困到睁不开眼", "疑惑歪头冒问号", "得意叉腰"];
const charRule = ref
  ? "以附图中的角色为唯一参考，严格保持外形、配色、围巾一致。"
  : "角色：Q版橘色虎斑猫，圆脸大眼，奶白色口鼻和肚子，粗深棕描边，戴蓝色围巾（右侧打结、带流苏），扁平插画表情包风格。";

function sniff(path) {
  const fd = openSync(path, "r"); const b = Buffer.alloc(12); readSync(fd, b, 0, 12, 0); closeSync(fd);
  const h = b.toString("latin1");
  if (h.startsWith("GIF8")) return "GIF";
  if (b[0] === 0x89 && h.slice(1, 4) === "PNG") return "PNG";
  if (h.startsWith("RIFF") && h.slice(8, 12) === "WEBP") return "WEBP";
  if (b[0] === 0xff && b[1] === 0xd8) return "JPEG";
  if (h.trimStart().startsWith("<svg") || h.startsWith("<?xml")) return "SVG";
  return "unknown:" + b.toString("hex");
}

function collect(images, tag) {
  return images.map((it, i) => {
    const info = {
      tag, status: it.status, transparent: it.transparentBackground, generationId: it.generationId,
      inputImages: it.inputImages, genSec: it.completedAtMs && it.startedAtMs ? (it.completedAtMs - it.startedAtMs) / 1000 : undefined,
      failure: it.failure, savedPath: it.savedPath,
    };
    if (it.savedPath && existsSync(it.savedPath)) {
      info.format = sniff(it.savedPath);
      info.kb = Math.round(statSync(it.savedPath).size / 1024);
      const dst = join(outDir, `${tag}-${i}${extname(it.savedPath) || ".bin"}`);
      copyFileSync(it.savedPath, dst);
      info.copied = dst;
    } else {
      info.resultHead = String(it.result ?? "").slice(0, 80);
    }
    return info;
  });
}

const c = new CodexClient({ log });
await c.start();
const model = await c.pickModel(args.model);
log("model", model, "mode", mode);

const ev = (tag) => (m) => {
  const p = m.params ?? {};
  if (m.method === "item/started" && p.item?.type === "imageGeneration") log(`  [${tag}] 🎨 gen start`);
  if (m.method === "item/completed" && p.item?.type === "imageGeneration") log(`  [${tag}] 🖼  gen done ${p.item.status}`, p.item.failure ? JSON.stringify(p.item.failure) : "");
  if (m.method === "item/started" && p.item?.type === "commandExecution") log(`  [${tag}] ⚙️ command`, JSON.stringify(p.item).slice(0, 160));
  if (m.method === "error") log(`  [${tag}] ❌`, JSON.stringify(p).slice(0, 300));
};
c.globalListeners.add((m) => {
  if (m.method === "account/rateLimits/updated") {
    const r = m.params.rateLimits;
    log(`  📊 5h=${r.primary?.usedPercent}% week=${r.secondary?.usedPercent}%`);
  }
});

const report = [];

if (mode === "concurrent") {
  const n = Number(args.n ?? 4);
  const tids = await Promise.all(Array.from({ length: n }, () => c.newThread({ model, cwd: outDir })));
  log(`started ${n} threads`);
  const runs = await Promise.all(tids.map((tid, i) => {
    const input = [...(ref ? [localImage(ref)] : []), text(`${charRule}生成一张表情包：橘猫${EMOTIONS[i % EMOTIONS.length]}，透明背景，不要文字。`)];
    return c.runTurn(tid, input, { onEvent: ev(`#${i}`) }).then((r) => ({ i, ...r }));
  }));
  for (const r of runs) {
    log(`#${r.i} ${r.status} images=${r.images.length} turn=${((r.t.end - r.t.start) / 1000).toFixed(1)}s` +
      (r.t.genStarts[0] ? ` gen=${s(r.t.genStarts[0])}→${s(r.t.genEnds[0])} (${((r.t.genEnds[0] - r.t.genStarts[0]) / 1000).toFixed(1)}s)` : ""));
    report.push(...collect(r.images, `c${r.i}`));
  }
}

if (mode === "multi") {
  const count = Number(args.count ?? 4);
  const list = EMOTIONS.slice(0, count).map((e, i) => `${i + 1}. 橘猫${e}`).join("\n");
  const tid = await c.newThread({ model, cwd: outDir });
  const input = [...(ref ? [localImage(ref)] : []),
    text(`${charRule}请生成 ${count} 张相互独立的表情包图片（每张单独出一张图，不要拼在一张里），透明背景，不要文字：\n${list}`)];
  const r = await c.runTurn(tid, input, { onEvent: ev("multi") });
  log(`multi ${r.status} images=${r.images.length} turn=${((r.t.end - r.t.start) / 1000).toFixed(1)}s`);
  r.t.genStarts.forEach((st, i) => log(`  gen#${i} ${s(st)}→${s(r.t.genEnds[i])}`));
  report.push(...collect(r.images, "m"));
}

if (mode === "gif") {
  const tid = await c.newThread({ model, cwd: outDir });
  const input = [...(ref ? [localImage(ref)] : []),
    text(`${charRule}请调用图像生成工具并设置 gif 参数（frame_count=${args.frames ?? 8}，frame_duration_ms=${args.ms ?? 120}），` +
      `输出一张循环 GIF 动图：橘猫举起右爪左右挥手打招呼，身体轻微上下弹动，白色背景，不要文字。不要用脚本拼帧。`)];
  const r = await c.runTurn(tid, input, { onEvent: ev("gif") });
  log(`gif ${r.status} images=${r.images.length}`);
  r.messages.forEach((m) => log("  💬", m.slice(0, 300)));
  report.push(...collect(r.images, "g"));
}

writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
log(`total ${s(Date.now())}  report → ${join(outDir, "report.json")}`);
for (const r of report) log(`  ${r.tag} ${r.status} ${r.format ?? "-"} ${r.kb ?? "-"}KB gen=${r.genSec ?? "-"}s inputImages=${r.inputImages ? "yes" : "no"}`);
c.stop();
process.exit(0);
