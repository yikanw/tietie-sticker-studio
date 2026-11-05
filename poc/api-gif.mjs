#!/usr/bin/env node
// 用 OpenAI Images API 测 GIF 输出。复用工作台的 Key / 代理设置（不打印 Key）。
//   node poc/api-gif.mjs gen  [--frames 8] [--ms 120] [--size 1024x1024] [--quality medium] [--model gpt-image-2.6-sunburst]
//   node poc/api-gif.mjs edit --image ref.png   （测 edits 端点是否接受 gif）
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fetch, FormData } from "undici";
import { getSettings, apiKey } from "../server/settings.mjs";
import { dispatcherFor } from "../server/proxy.mjs";

const [mode = "gen", ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) args[rest[i].slice(2)] = rest[++i];

const s = getSettings().api;
const key = apiKey();
if (!key) throw new Error("没有 API Key");
const base = (s.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
const { dispatcher, proxy } = dispatcherFor(s.proxy);
const outDir = resolve("poc/out/api-gif");
await mkdir(outDir, { recursive: true });

const character =
  "角色：Q版橘色虎斑猫，圆脸大眼，奶白色口鼻和肚子，粗深棕描边，戴蓝色围巾（右侧打结、带流苏），扁平插画表情包风格。";
const prompt =
  args.prompt ??
  `${character}循环动图表情包：橘猫举起右爪左右挥手打招呼，身体轻轻上下弹动，眨一次眼，最后一帧回到第一帧的姿势，无缝循环。白色背景，画面中不要文字。`;

const params = {
  model: args.model ?? s.model,
  prompt,
  output_format: "gif",
  frame_count: Number(args.frames ?? 8),
  frame_duration_ms: Number(args.ms ?? 120),
  size: args.size ?? "1024x1024",
  quality: args.quality ?? s.quality ?? "medium",
};

console.log(`mode=${mode} proxy=${proxy ?? "直连"} params=`, { ...params, prompt: prompt.slice(0, 40) + "…" });
const t0 = Date.now();
let res;
if (mode === "edit") {
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
  const img = resolve(args.image);
  fd.append("image[]", new Blob([await readFile(img)], { type: "image/png" }), basename(img));
  res = await fetch(`${base}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd, dispatcher });
} else {
  res = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...params, n: 1 }),
    dispatcher,
  });
}
const sec = ((Date.now() - t0) / 1000).toFixed(1);
const body = await res.text();
let json = null;
try { json = JSON.parse(body); } catch {}
if (!res.ok) {
  console.log(`❌ HTTP ${res.status} (${sec}s)`, json?.error ?? body.slice(0, 500));
  process.exit(1);
}
const item = json?.data?.[0];
const buf = Buffer.from(item?.b64_json ?? "", "base64");
const head = buf.subarray(0, 6).toString("latin1");
const file = join(outDir, `${mode}-${Date.now()}.${head.startsWith("GIF") ? "gif" : "bin"}`);
await writeFile(file, buf);
console.log(`✅ HTTP 200 (${sec}s) format=${json.output_format ?? "?"} size=${json.size ?? "?"} quality=${json.quality ?? "?"} bytes=${buf.length} magic=${head}`);
console.log("usage:", JSON.stringify(json.usage ?? null));
console.log("saved:", file);
