// Codex 服务：管理一个常驻 app-server 进程，提供"出文字(JSON)"和"出图"两种能力。
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { CodexClient, text, localImage } from "./codex-client.mjs";
import { getSettings } from "./settings.mjs";

export const codexEvents = new EventEmitter();

const state = {
  client: null,
  starting: null,
  version: null,
  models: [],
  defaultModel: null,
  imageGeneration: false,
  rateLimits: null,
  error: null,
};

const log = (...m) => console.log("[codex]", ...m);

function cliVersion(bin) {
  return new Promise((res) => {
    execFile(bin, ["--version"], { timeout: 10000 }, (err, out) => res(err ? null : String(out).trim()));
  });
}

export async function ensureCodex() {
  if (state.client?.alive) return state.client;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const bin = process.env.CODEX_BIN ?? "codex";
    state.version = await cliVersion(bin);
    if (!state.version) throw new Error(`找不到 codex 命令（${bin}）。请先安装：npm i -g @openai/codex`);
    const c = new CodexClient({ bin, log });
    await c.start();
    c.globalListeners.add((m) => {
      if (m.method === "account/rateLimits/updated") {
        state.rateLimits = m.params?.rateLimits ?? state.rateLimits;
        codexEvents.emit("env");
      }
    });
    const caps = await c.request("modelProvider/capabilities/read", {}).catch(() => ({}));
    state.imageGeneration = !!caps?.imageGeneration;
    const ml = await c.request("model/list", {}).catch(() => ({ data: [] }));
    state.models = (ml?.data ?? []).filter((m) => !m.hidden).map((m) => m.id);
    state.defaultModel = (ml?.data ?? []).find((m) => m.isDefault)?.id ?? state.models[0] ?? null;
    const rl = await c.request("account/rateLimits/read", {}).catch(() => null);
    state.rateLimits = rl?.rateLimits ?? state.rateLimits;
    state.client = c;
    state.error = null;
    codexEvents.emit("env");
    log(`ready ${state.version} model=${state.defaultModel} imageGeneration=${state.imageGeneration}`);
    return c;
  })();
  try {
    return await state.starting;
  } catch (e) {
    state.error = e.message;
    codexEvents.emit("env");
    throw e;
  } finally {
    state.starting = null;
  }
}

export function codexEnv() {
  return {
    ok: !!state.client?.alive,
    error: state.error,
    version: state.version,
    models: state.models,
    model: pickModel(),
    imageGeneration: state.imageGeneration,
    rateLimits: state.rateLimits,
  };
}

function pickModel() {
  const want = getSettings().codex.model;
  if (want && state.models.includes(want)) return want;
  if (state.models.includes("gpt-6.1-terra")) return "gpt-6.1-terra";
  return state.defaultModel;
}

// 把 AbortSignal 接到 turn/interrupt 上
function wireAbort(c, threadId, signal) {
  let turnId = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    if (turnId) c.interrupt(threadId, turnId).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return {
    onStarted: (id) => { turnId = id; if (aborted) onAbort(); },
    dispose: () => signal?.removeEventListener("abort", onAbort),
  };
}

const TEXT_INSTRUCTIONS =
  "你是表情包策划。只根据用户提供的图片和文字进行分析与策划，按要求的 JSON 结构输出。" +
  "不要调用任何工具，不要生成图片，不要执行命令或读写文件。";

export async function runCodexText({ cwd, prompt, images = [], schema, signal }) {
  const c = await ensureCodex();
  const threadId = await c.newThread({ model: pickModel(), cwd, developerInstructions: TEXT_INSTRUCTIONS });
  const ab = wireAbort(c, threadId, signal);
  try {
    const r = await c.runTurn(threadId, [...images.map(localImage), text(prompt)], {
      outputSchema: schema,
      effort: getSettings().text?.effort || "medium",
      onStarted: ab.onStarted,
    });
    if (r.status === "interrupted") throw abortError();
    if (r.status !== "completed") throw new Error(turnErr(r));
    const last = r.messages.at(-1) ?? "";
    return { data: parseJson(last), usage: r.usage, model: pickModel() };
  } finally {
    ab.dispose();
  }
}

const IMAGE_INSTRUCTIONS =
  "你是表情包画师。每次收到需求，必须且只调用一次内置图像生成工具，只生成一张图。" +
  "用户附带的图片都要作为参考图传给图像生成工具（referenced_image_paths）。" +
  "不要执行 shell 命令，不要读写文件，不要反问用户；信息不足时按最合理的理解直接出图。出图后用一句话说明。";

export async function runCodexImage({ cwd, prompt, refImages = [], signal, onProgress }) {
  const c = await ensureCodex();
  if (!state.imageGeneration) throw new Error("当前 Codex 账号不支持图像生成");
  const threadId = await c.newThread({ model: pickModel(), cwd, developerInstructions: IMAGE_INSTRUCTIONS });
  const ab = wireAbort(c, threadId, signal);
  try {
    const r = await c.runTurn(threadId, [...refImages.map(localImage), text(prompt)], {
      effort: "low",
      onStarted: ab.onStarted,
      onEvent: (m) => {
        if (m.method === "item/started" && m.params?.item?.type === "imageGeneration") onProgress?.("drawing");
      },
    });
    if (r.status === "interrupted") { const e = abortError(); e.usage = r.usage; e.model = pickModel(); throw e; }
    const img = r.images.find((i) => i.status === "completed" && i.savedPath) ?? null;
    const failed = r.images.find((i) => i.failure);
    if (failed?.failure?.type === "usageLimitExceeded") {
      const e = new Error("Codex 生图额度已用完");
      e.code = "usage_limit";
      e.resetsAt = failed.failure.resetsAt;
      e.usage = r.usage;
      e.model = pickModel();
      throw e;
    }
    if (!img) {
      const msg = r.messages.at(-1) || turnErr(r) || "未返回图片";
      const e = new Error("没有出图：" + msg.slice(0, 200));
      e.usage = r.usage;
      e.model = pickModel();
      throw e;
    }
    return {
      path: img.savedPath,
      usedRef: refImages.length === 0 ? true : Array.isArray(img.inputImages) && img.inputImages.length > 0,
      revisedPrompt: img.revisedPrompt ?? null,
      transparent: img.transparentBackground ?? null,
      usage: r.usage,
      model: pickModel(),
    };
  } finally {
    ab.dispose();
  }
}

function turnErr(r) {
  const e = r.error;
  if (!e) return r.status;
  try {
    const inner = JSON.parse(e.message);
    return inner?.error?.message ?? e.message;
  } catch {
    return e.message ?? JSON.stringify(e);
  }
}

function parseJson(s) {
  const t = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("模型没有返回有效 JSON：" + s.slice(0, 200));
  }
}

export function abortError() {
  const e = new Error("已中断");
  e.code = "aborted";
  return e;
}
