// OpenAI Images API 通道：有参考图走 /images/edits，没有走 /images/generations。
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fetch, FormData } from "undici";
import { getSettings, imageKey, OPENAI_BASE } from "./settings.mjs";
import { dispatcherForUrl } from "./proxy.mjs";

// gif: { frames, ms } 时输出透明 GIF（所有帧拼成一张精灵表，长边 ≤ 3840，所以帧尺寸用 512）
export async function runApiImage({ prompt, refImages = [], signal, transparent = true, gif = null }) {
  const st = getSettings();
  const s = st.image;
  const key = imageKey();
  if (!key) throw new Error("还没有配置生图 API Key（设置 → 生图）");
  const base = (s.baseUrl || OPENAI_BASE).replace(/\/+$/, "");
  const { dispatcher, proxy } = dispatcherForUrl(base, st.proxy);
  const common = gif
    ? {
        model: s.model,
        prompt,
        size: gif.size ?? "512x512",
        quality: s.quality || "medium",
        output_format: "gif",
        background: "transparent", // GIF 原生支持透明，避免白底抠不干净（缝隙里的白沫）
        frame_count: gif.frames,
        frame_duration_ms: gif.ms,
      }
    : {
        model: s.model,
        prompt,
        size: s.size || "1024x1024",
        quality: s.quality || "medium",
        background: transparent ? "transparent" : "opaque",
        output_format: "png",
      };

  let res;
  try {
  if (refImages.length) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(common)) fd.append(k, String(v));
    for (const p of refImages) {
      const buf = await readFile(p);
      fd.append("image[]", new Blob([buf], { type: "image/png" }), basename(p));
    }
    res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
      signal,
      dispatcher,
    });
  } else {
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...common, n: 1 }),
      signal,
      dispatcher,
    });
  }
  } catch (e) {
    if (e.name === "AbortError" || signal?.aborted) { const a = new Error("已中断"); a.code = "aborted"; throw a; }
    const cause = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`连不上 ${new URL(base).host}（${cause}）。${proxy ? `当前代理 ${proxy}` : "没有使用代理"}，可在设置里填代理地址`);
  }

  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = null; }
  if (!res.ok) {
    const msg = json?.error?.message ?? body.slice(0, 300);
    const e = new Error(`API ${res.status}：${msg}`);
    if (res.status === 429) e.code = "usage_limit";
    throw e;
  }
  const item = json?.data?.[0];
  const usage = json?.usage ?? null;
  if (item?.b64_json) return { buffer: Buffer.from(item.b64_json, "base64"), usedRef: true, revisedPrompt: item.revised_prompt ?? null, usage };
  if (item?.url) {
    const r = await fetch(item.url, { signal, dispatcher });
    return { buffer: Buffer.from(await r.arrayBuffer()), usedRef: true, revisedPrompt: item.revised_prompt ?? null, usage };
  }
  throw new Error("API 没有返回图片数据");
}
