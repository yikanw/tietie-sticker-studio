// 极简 codex app-server 客户端（stdio JSON-RPC），零依赖。
// 一个进程可承载多个 thread；通知按 threadId 分发。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class CodexClient {
  constructor({ bin = process.env.CODEX_BIN ?? "codex", log = () => {} } = {}) {
    this.bin = bin;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.threadListeners = new Map(); // threadId -> Set<fn>
    this.globalListeners = new Set();
  }

  async start() {
    this.proc = spawn(this.bin, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.proc.stdout }).on("line", (l) => this.#onLine(l));
    const init = await this.request("initialize", {
      clientInfo: { name: "sticker-studio-poc", title: "Sticker Studio PoC", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return init;
  }

  stop() { this.proc?.kill(); }

  #send(m) { this.proc.stdin.write(JSON.stringify(m) + "\n"); }

  request(method, params) {
    return new Promise((res, rej) => {
      const id = this.nextId++;
      this.pending.set(id, { res, rej, method });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? p.rej(new Error(`${p.method}: ${JSON.stringify(m.error)}`)) : p.res(m.result);
    }
    if (m.id !== undefined && m.method) {
      // 工作台不允许 agent 执行命令/改文件：一律拒绝
      this.log("⚠️ server request", m.method, "→ decline");
      return this.#send({ jsonrpc: "2.0", id: m.id, result: { decision: "decline" } });
    }
    if (!m.method) return;
    for (const fn of this.globalListeners) fn(m);
    const tid = m.params?.threadId ?? m.params?.thread?.id;
    if (tid && this.threadListeners.has(tid)) for (const fn of this.threadListeners.get(tid)) fn(m);
  }

  onThread(threadId, fn) {
    if (!this.threadListeners.has(threadId)) this.threadListeners.set(threadId, new Set());
    this.threadListeners.get(threadId).add(fn);
    return () => this.threadListeners.get(threadId)?.delete(fn);
  }

  async pickModel(preferred) {
    const r = await this.request("model/list", {});
    const models = r?.data ?? [];
    if (preferred && models.some((m) => m.id === preferred)) return preferred;
    return (models.find((m) => m.isDefault) ?? models[0])?.id;
  }

  async newThread({ model, cwd, developerInstructions } = {}) {
    const r = await this.request("thread/start", {
      model,
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions:
        developerInstructions ??
        "你是表情包画师。收到需求后直接调用内置图像生成工具出图，不要执行 shell 命令、不要读写文件。出图后用一句话说明。",
    });
    return r.thread.id;
  }

  // 跑一个 turn，返回 { status, images: [item...], messages: [...], t: {...} }
  runTurn(threadId, input, { onEvent } = {}) {
    return new Promise(async (resolve, reject) => {
      const t = { start: Date.now(), genStarts: [], genEnds: [] };
      const images = [];
      const messages = [];
      const off = this.onThread(threadId, (m) => {
        const p = m.params ?? {};
        onEvent?.(m);
        if (m.method === "item/started" && p.item?.type === "imageGeneration") t.genStarts.push(Date.now());
        if (m.method === "item/completed") {
          if (p.item?.type === "imageGeneration") { t.genEnds.push(Date.now()); images.push(p.item); }
          if (p.item?.type === "agentMessage") messages.push(p.item.text);
        }
        if (m.method === "turn/completed") {
          off();
          t.end = Date.now();
          resolve({ status: p.turn?.status, error: p.turn?.error, images, messages, t, turnId: p.turn?.id });
        }
      });
      try {
        const r = await this.request("turn/start", { threadId, input });
        t.turnId = r.turn.id;
      } catch (e) { off(); reject(e); }
    });
  }
}

export const text = (s) => ({ type: "text", text: s, text_elements: [] });
export const localImage = (path) => ({ type: "localImage", path });
