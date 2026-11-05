// API 通道的文字步骤（识别 / 策划）：结构化 JSON 输出
// - format "responses"：OpenAI Responses API（json_schema strict + reasoning.effort）
// - format "chat"：兼容 OpenAI 的 /chat/completions（多数第三方 / 本地模型服务）。
//   先试 json_schema，服务不支持时退回 json_object + 在提示词里附上 schema
import { readFile } from "node:fs/promises";
import { fetch } from "undici";
import { getSettings, textKey, OPENAI_BASE } from "./settings.mjs";
import { dispatcherForUrl } from "./proxy.mjs";

const INSTRUCTIONS =
  "你是表情包策划。只根据用户提供的图片和文字进行分析与策划，严格按要求的 JSON 结构输出。";

const mimeOf = (buf) => (buf[0] === 0xff && buf[1] === 0xd8 ? "image/jpeg" : buf[0] === 0x52 && buf[8] === 0x57 ? "image/webp" : "image/png");
async function dataUrls(images) {
  return Promise.all(images.map(async (p) => {
    const buf = await readFile(p);
    return `data:${mimeOf(buf)};base64,${buf.toString("base64")}`;
  }));
}

async function post(url, key, body, signal, dispatcher, proxy) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      dispatcher,
    });
  } catch (e) {
    if (e.name === "AbortError" || signal?.aborted) { const a = new Error("已中断"); a.code = "aborted"; throw a; }
    const cause = e.cause?.code || e.cause?.message || e.message;
    throw new Error(`连不上 ${new URL(url).host}（${cause}）。${proxy ? `当前代理 ${proxy}` : "没有使用代理"}，可在设置里填代理地址`);
  }
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  if (!res.ok) {
    const e = new Error(`API ${res.status}：${json?.error?.message ?? raw.slice(0, 300)}`);
    e.status = res.status;
    if (res.status === 429) e.code = "usage_limit";
    throw e;
  }
  if (!json) throw new Error(`API 返回的不是 JSON：${raw.slice(0, 200)}`);
  return json;
}

function parseOut(text, schema) {
  if (!schema) return text;
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  try { if (m) return JSON.parse(m[0]); } catch {}
  throw new Error(`模型没有返回合法 JSON：${text.slice(0, 200)}`);
}

const cleanModel = (m, fallback) => m?.replace(/-\d{4}-\d{2}-\d{2}$/, "") || fallback;

async function viaResponses({ base, key, model, effort, prompt, urls, schema, signal, dispatcher, proxy }) {
  const content = [...urls.map((u) => ({ type: "input_image", image_url: u })), { type: "input_text", text: prompt }];
  const json = await post(`${base}/responses`, key, {
    model,
    instructions: INSTRUCTIONS,
    input: [{ role: "user", content }],
    reasoning: { effort },
    store: false,
    ...(schema ? { text: { format: { type: "json_schema", name: "result", schema, strict: true } } } : {}),
  }, signal, dispatcher, proxy);
  if (json.status === "incomplete") throw new Error(`模型输出不完整：${json.incomplete_details?.reason ?? "unknown"}`);
  const msg = (json.output ?? []).find((o) => o.type === "message");
  const refusal = msg?.content?.find((c) => c.type === "refusal");
  if (refusal) throw new Error(`模型拒绝：${refusal.refusal}`);
  const text = msg?.content?.filter((c) => c.type === "output_text").map((c) => c.text).join("") ?? "";
  const u = json.usage ?? {};
  return {
    data: parseOut(text, schema),
    model: cleanModel(json.model, model),
    usage: { inputTokens: u.input_tokens ?? 0, cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0, outputTokens: u.output_tokens ?? 0 },
  };
}

async function viaChat({ base, key, model, prompt, urls, schema, signal, dispatcher, proxy }) {
  const call = (userText, response_format) => post(`${base}/chat/completions`, key, {
    model,
    messages: [
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: [...urls.map((u) => ({ type: "image_url", image_url: { url: u } })), { type: "text", text: userText }] },
    ],
    ...(response_format ? { response_format } : {}),
  }, signal, dispatcher, proxy);
  let json;
  if (!schema) json = await call(prompt);
  else {
    try {
      json = await call(prompt, { type: "json_schema", json_schema: { name: "result", schema, strict: true } });
    } catch (e) {
      if (e.status !== 400 && e.status !== 422) throw e;
      json = await call(`${prompt}\n\n只输出一个 JSON 对象，不要任何其他文字。JSON 必须符合这个 JSON Schema：\n${JSON.stringify(schema)}`, { type: "json_object" });
    }
  }
  const msg = json.choices?.[0]?.message;
  if (msg?.refusal) throw new Error(`模型拒绝：${msg.refusal}`);
  const text = typeof msg?.content === "string" ? msg.content : (msg?.content ?? []).map((c) => c.text ?? "").join("");
  const u = json.usage ?? {};
  return {
    data: parseOut(text, schema),
    model: cleanModel(json.model, model),
    usage: { inputTokens: u.prompt_tokens ?? 0, cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
  };
}

export async function runApiText({ prompt, images = [], schema, signal }) {
  const st = getSettings();
  const t = st.text;
  const base = (t.baseUrl || OPENAI_BASE).replace(/\/+$/, "");
  const key = textKey();
  const { dispatcher, proxy } = dispatcherForUrl(base, st.proxy);
  // 本机服务（如 Ollama）可以不要 Key；其他地址没有 Key 直接提示
  if (!key && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(base)) throw new Error("还没有配置生文 API Key（设置 → 生文）");
  if (!t.model) throw new Error("还没有填生文模型（设置 → 生文）");
  const opts = { base, key, model: t.model, effort: t.effort || "medium", prompt, urls: await dataUrls(images), schema, signal, dispatcher, proxy };
  return t.format === "chat" ? viaChat(opts) : viaResponses(opts);
}
