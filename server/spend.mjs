// API 通道累计开销（跨项目，真金白银的部分）。存 data/api-spend.json，可在设置里清零。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { DATA_DIR } from "./paths.mjs";

const FILE = join(DATA_DIR, "api-spend.json");
export const spendEvents = new EventEmitter();
let state = null;

const round = (x) => Math.round(x * 1e6) / 1e6;
function persist() {
  writeFileSync(FILE, JSON.stringify(state, null, 2));
  spendEvents.emit("spend", state);
}

// 首次启动时把已有项目里的 API 花费汇总进来
export function initSpend(projects) {
  if (existsSync(FILE)) {
    try { state = JSON.parse(readFileSync(FILE, "utf8")); return; } catch {}
  }
  const api = projects.flatMap((p) => p.costs ?? []).filter((c) => c.backend === "api");
  state = {
    usd: round(api.reduce((a, c) => a + c.usd, 0)),
    count: api.length,
    since: api.length ? Math.min(...api.map((c) => c.t)) : Date.now(),
  };
  persist();
}

export function recordSpend(entry) {
  if (!state || entry.backend !== "api" || !entry.usd) return;
  state.usd = round(state.usd + entry.usd);
  state.count += 1;
  persist();
}

export function resetSpend() {
  state = { usd: 0, count: 0, since: Date.now() };
  persist();
  return state;
}

export const getSpend = () => state ?? { usd: 0, count: 0, since: Date.now() };
