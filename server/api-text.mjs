// API 通道的文字步骤（识别 / 策划）：OpenAI Responses API + 结构化输出
import { readFile } from "node:fs/promises";
import { fetch } from "undici";
import { getSettings, apiKey } from "./settings.mjs";
import { dispatcherFor } from "./proxy.mjs";

const INSTRUCTIONS =
  "你是表情包策划。只根据用户提供的图片和文字进行分析与策划，严格按要求的 JSON 结构输出。";

export async function runApiText({ prompt, images = [], schema, signal }) {
  const st = getSettings();
  const s = st.api;
  const key = apiKey();
  if (!key) throw new Error("还没有配置 API Key（设置 → API 通道）");
  const base = (s.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
  const { dispatcher, proxy } = dispatcherFor(s.proxy);
  const model = st.text.apiModel || "gpt-6.1-terra";

  const content = [];
  for (const p of images) {
    const b64 = (await readFile(p)).toString("base64");
    content.push({ type: "input_image", image_url: `data:image/png;base64,${b64}` });
  }
  content.push({ type: "input_text", text: prompt });
  const body = {
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content }],
    reasoning: { effort: st.text.effort || "medium" },
    store: false,
    ...(schema ? { text: { format: { type: "json_schema", name: "result", schema, strict: true } } } : {}),
  };

  let res;
  try {
    res = await fetch(`${base}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      dispatcher,
    });
  } catch (e) {
    if (e.name === "AbortError" || signal?.aborted) { const a = new Error("已中断"); a.code = "aborted"; throw a; }
    const cause = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`连不上 ${new URL(base).host}（${cause}）。${proxy ? `当前代理 ${proxy}` : "没有使用代理"}，可在设置里填代理地址`);
  }
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  if (!res.ok) {
    const e = new Error(`API ${res.status}：${json?.error?.message ?? raw.slice(0, 300)}`);
    if (res.status === 429) e.code = "usage_limit";
    throw e;
  }
  if (json.status === "incomplete") throw new Error(`模型输出不完整：${json.incomplete_details?.reason ?? "unknown"}`);
  const msg = (json.output ?? []).find((o) => o.type === "message");
  const refusal = msg?.content?.find((c) => c.type === "refusal");
  if (refusal) throw new Error(`模型拒绝：${refusal.refusal}`);
  const text = msg?.content?.filter((c) => c.type === "output_text").map((c) => c.text).join("") ?? "";
  let data;
  try { data = schema ? JSON.parse(text) : text; } catch { throw new Error(`模型没有返回合法 JSON：${text.slice(0, 200)}`); }
  const u = json.usage ?? {};
  return {
    data,
    model: json.model?.replace(/-\d{4}-\d{2}-\d{2}$/, "") || model,
    usage: {
      inputTokens: u.input_tokens ?? 0,
      cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
    },
  };
}
