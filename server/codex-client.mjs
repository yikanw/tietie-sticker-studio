// 极简 codex app-server 客户端（stdio JSON-RPC），零依赖。
// 一个进程承载多个 thread；通知按 threadId 分发。

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
    this.alive = false;
  }

  async start() {
    this.proc = spawn(this.bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.alive = true;
    this.proc.on("exit", (code) => {
      this.alive = false;
      this.log(`codex app-server 退出 code=${code}`);
      for (const p of this.pending.values()) p.rej(new Error("codex app-server 已退出"));
      this.pending.clear();
      for (const set of this.threadListeners.values())
        for (const fn of set) fn({ method: "client/exited", params: {} });
    });
    this.proc.on("error", (e) => this.log("codex 启动失败: " + e.message));
    this.proc.stderr.on("data", () => {}); // app-server 的日志不打扰用户
    createInterface({ input: this.proc.stdout }).on("line", (l) => this.#onLine(l));
    const init = await this.request("initialize", {
      clientInfo: { name: "sticker-studio", title: "Sticker Studio", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
    return init;
  }

  stop() { this.proc?.kill(); }

  #send(m) { if (this.alive) this.proc.stdin.write(JSON.stringify(m) + "\n"); }

  request(method, params, timeoutMs = 120000) {
    return new Promise((res, rej) => {
      if (!this.alive) return rej(new Error("codex app-server 未运行"));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
        method,
      });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  #onLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && !m.method && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      return m.error ? p.rej(new Error(`${p.method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : p.res(m.result);
    }
    if (m.id !== undefined && m.method) {
      // 工作台不允许 agent 执行命令/改文件：一律拒绝
      this.log(`拒绝了 agent 的请求 ${m.method}`);
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
    return () => {
      const s = this.threadListeners.get(threadId);
      s?.delete(fn);
      if (s && !s.size) this.threadListeners.delete(threadId);
    };
  }

  async newThread({ model, cwd, developerInstructions }) {
    const r = await this.request("thread/start", {
      model,
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions,
    });
    return r.thread.id;
  }

  // 跑一个 turn。onStarted 拿到 turnId（用于中断）。
  // 返回 { status, error, images:[item], messages:[text], turnId }
  runTurn(threadId, input, { outputSchema, effort, onStarted, onEvent } = {}) {
    return new Promise((resolve, reject) => {
      const images = [];
      const messages = [];
      let turnId = null;
      let usage = null;
      const off = this.onThread(threadId, (m) => {
        const p = m.params ?? {};
        onEvent?.(m);
        if (m.method === "client/exited") { off(); return reject(new Error("codex app-server 已退出")); }
        if (m.method === "thread/tokenUsage/updated") usage = p.tokenUsage?.total ?? usage;
        if (m.method === "item/completed") {
          if (p.item?.type === "imageGeneration") images.push(p.item);
          if (p.item?.type === "agentMessage") messages.push(p.item.text ?? "");
        }
        if (m.method === "turn/completed") {
          // tokenUsage 通知可能晚于 turn/completed 一点点到达，稍等再结算
          setTimeout(() => {
            off();
            resolve({ status: p.turn?.status, error: p.turn?.error, images, messages, usage, turnId: p.turn?.id ?? turnId });
          }, 300);
          return;
        }
      });
      const params = { threadId, input };
      if (outputSchema) params.outputSchema = outputSchema;
      if (effort) params.effort = effort;
      this.request("turn/start", params)
        .then((r) => { turnId = r.turn.id; onStarted?.(turnId); })
        .catch((e) => { off(); reject(e); });
    });
  }

  interrupt(threadId, turnId) {
    return this.request("turn/interrupt", { threadId, turnId });
  }
}

export const text = (s) => ({ type: "text", text: s, text_elements: [] });
export const localImage = (path) => ({ type: "localImage", path });
