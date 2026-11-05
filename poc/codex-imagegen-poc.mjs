#!/usr/bin/env node
// 最小验证：通过 codex app-server（ChatGPT 订阅）生图
// 用法：
//   node poc/codex-imagegen-poc.mjs --prompt "..." [--image ref.png] [--out poc/out] [--interrupt-after 8]
// 零依赖，Node 18+。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, basename, extname, join } from "node:path";

// ---------- 参数 ----------
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]?.startsWith("--") ? true : arr[i + 1] ?? true]);
    return acc;
  }, [])
);
const prompt = args.prompt ?? "画一个Q版橘猫角色，白色背景，全身，表情开心，表情包风格";
const image = args.image ? resolve(args.image) : null;
const outDir = resolve(args.out ?? "poc/out");
const interruptAfter = args["interrupt-after"] ? Number(args["interrupt-after"]) : null;
mkdirSync(outDir, { recursive: true });

// ---------- JSON-RPC over stdio ----------
const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

// 可用模型列表跟 codex 客户端版本挂钩：旧版 CLI 看不到新模型。
// 可用 --codex 或 CODEX_BIN 指定二进制，例如桌面端自带的
// /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
const codexBin = args.codex ?? process.env.CODEX_BIN ?? "codex";
const proc = spawn(codexBin, ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
const rl = createInterface({ input: proc.stdout });
let nextId = 1;
const pending = new Map();
const listeners = new Set();

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
const request = (method, params) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // 对我们请求的响应
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)) : p.res(msg.result);
    return;
  }
  // 服务端发来的请求（审批等）：一律拒绝，工作台不允许 agent 动文件/跑命令
  if (msg.id !== undefined && msg.method) {
    log("⚠️ server request", msg.method, "→ decline");
    send({ jsonrpc: "2.0", id: msg.id, result: { decision: "decline" } });
    return;
  }
  // 通知
  if (msg.method) for (const fn of listeners) fn(msg);
});

proc.on("exit", (code) => log("app-server exited", code));

// ---------- 主流程 ----------
async function main() {
  const init = await request("initialize", {
    clientInfo: { name: "sticker-studio-poc", title: "Sticker Studio PoC", version: "0.0.1" },
    capabilities: { experimentalApi: true },
  });
  notify("initialized", {});
  log("initialized", JSON.stringify(init).slice(0, 200));

  const caps = await request("modelProvider/capabilities/read", {});
  log("capabilities", JSON.stringify(caps));
  if (!caps?.imageGeneration) throw new Error("当前 provider 不支持 imageGeneration");

  // 列出当前账号可用的模型；~/.codex/config.toml 里的默认模型不一定支持 ChatGPT 账号
  const ml = await request("model/list", {});
  const models = ml?.data ?? ml?.models ?? [];
  log("models", models.map((m) => `${m.id ?? m.model}${m.isDefault ? "(default)" : ""}`).join(", "));
  const pick = args.model ?? (models.find((m) => m.isDefault) ?? models[0])?.id ?? (models[0]?.model);

  const { thread, model } = await request("thread/start", {
    model: pick,
    cwd: outDir,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
    developerInstructions:
      "你是表情包画师。收到需求后直接调用内置图像生成工具出图，不要执行 shell 命令、不要读写文件。出图后用一句话说明。",
  });
  log("thread", thread.id, "model", model);

  const input = [];
  if (image) {
    if (!existsSync(image)) throw new Error("找不到参考图 " + image);
    input.push({ type: "localImage", path: image });
  }
  input.push({ type: "text", text: prompt, text_elements: [] });

  const results = [];
  const done = new Promise((res) => {
    listeners.add((msg) => {
      const p = msg.params ?? {};
      switch (msg.method) {
        case "turn/started":
          log("turn started", p.turn?.id);
          break;
        case "item/started":
          log("item started:", p.item?.type);
          break;
        case "item/completed": {
          const it = p.item;
          if (it?.type === "imageGeneration") {
            log("🖼  imageGeneration", it.status, "savedPath=", it.savedPath, "transparent=", it.transparentBackground);
            if (it.revisedPrompt) log("   revisedPrompt:", it.revisedPrompt.slice(0, 200));
            if (it.failure) log("   failure:", JSON.stringify(it.failure));
            results.push(it);
          } else if (it?.type === "agentMessage") {
            log("💬", (it.text ?? "").slice(0, 200));
          } else {
            log("item completed:", it?.type);
          }
          break;
        }
        case "account/rateLimits/updated":
          log("rateLimits", JSON.stringify(p).slice(0, 300));
          break;
        case "error":
          log("❌ error", JSON.stringify(p).slice(0, 500));
          break;
        case "turn/completed":
          log("turn completed:", p.turn?.status, p.turn?.error ? JSON.stringify(p.turn.error) : "");
          res(p.turn);
          break;
      }
    });
  });

  const { turn } = await request("turn/start", { threadId: thread.id, input });
  log("turn/start ok", turn.id);

  if (interruptAfter) {
    setTimeout(async () => {
      log(`⏹  interrupt after ${interruptAfter}s`);
      try { log("interrupt result", JSON.stringify(await request("turn/interrupt", { threadId: thread.id, turnId: turn.id }))); }
      catch (e) { log("interrupt failed", e.message); }
    }, interruptAfter * 1000);
  }

  const finalTurn = await done;

  // 收集产物
  let n = 0;
  for (const it of results) {
    const stamp = `${Date.now()}-${n++}`;
    if (it.savedPath && existsSync(it.savedPath)) {
      const dst = join(outDir, `${stamp}${extname(it.savedPath) || ".png"}`);
      copyFileSync(it.savedPath, dst);
      log("✅ saved", dst);
    } else if (it.result && /^[A-Za-z0-9+/=]{200,}$/.test(it.result.slice(0, 400))) {
      const dst = join(outDir, `${stamp}.png`);
      writeFileSync(dst, Buffer.from(it.result, "base64"));
      log("✅ saved (from base64)", dst);
    } else {
      log("no file for item", it.id, "result head:", String(it.result).slice(0, 120));
    }
  }
  log(`done: status=${finalTurn?.status} images=${results.length} total=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  proc.kill();
  process.exit(results.length || interruptAfter ? 0 : 1);
}

main().catch((e) => {
  log("FATAL", e.message);
  proc.kill();
  process.exit(1);
});
