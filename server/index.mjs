// 贴贴机 TIETIE（表情包工作台）本地服务
import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec, execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { ROOT, RUNS_DIR, ARCHIVE_DIR, DATA_DIR } from "./paths.mjs";
import { bus, loadAll, getProject, listProjects, projectDir, archiveProject, listArchived, restoreArchived } from "./store.mjs";
import { createProject, act, recover, pumpAll, stopProject } from "./pipeline.mjs";
import { ensureCodex, codexEnv, codexEvents } from "./codex-service.mjs";
import { publicSettings, updateSettings } from "./settings.mjs";
import { STYLES, GUIDE } from "./prompts.mjs";
import { pricingInfo } from "./billing.mjs";
import { initSpend, getSpend, resetSpend, spendEvents } from "./spend.mjs";

const DEV = process.argv.includes("--dev");
const PORT = Number(process.env.PORT ?? 5177);
const HOST = "127.0.0.1"; // 只监听本机

const app = express();
app.use(express.json({ limit: "40mb" }));

// 风格样张：server/style-samples/<id>.jpg（原创形象，由 poc/gen-style-samples.mjs 生成）
const SAMPLE_DIR = join(ROOT, "server/style-samples");
const stylesWithSamples = () =>
  STYLES.map((s) => (existsSync(join(SAMPLE_DIR, `${s.id}.jpg`)) ? { ...s, sample: `/style-samples/${s.id}.jpg` } : s));
app.use("/style-samples", express.static(SAMPLE_DIR, { maxAge: "1d" }));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

app.get("/api/env", wrap(async () => ({ codex: codexEnv(), settings: publicSettings(), styles: stylesWithSamples(), guide: GUIDE, pricing: pricingInfo(), apiSpend: getSpend(),
  paths: { data: DATA_DIR, runs: RUNS_DIR, archive: ARCHIVE_DIR },
})));
app.post("/api/spend/reset", wrap(async () => resetSpend()));

// 全局实时推送：额度 + API 累计开销（首页用）
app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("env", codexEnv());
  send("spend", getSpend());
  const onEnv = () => send("env", codexEnv());
  const onSpend = (s) => send("spend", s);
  codexEvents.on("env", onEnv);
  spendEvents.on("spend", onSpend);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    codexEvents.off("env", onEnv);
    spendEvents.off("spend", onSpend);
  });
});
app.post("/api/env/reconnect", wrap(async () => { await ensureCodex(); return codexEnv(); }));
app.put("/api/settings", wrap(async (req) => updateSettings(req.body ?? {})));

// 封面：当前版本成品 → 选中的风格设定图 → 原图
function coverOf(p, base) {
  const s = p.stickers.find((x) => x.current);
  const v = s?.versions.find((x) => x.id === s.current);
  if (v) return `${base}/${v.final}?r=${v.rev}`;
  const k = p.character?.candidates?.find((x) => x.id === p.character.chosenId) ?? p.character?.candidates?.find((x) => x.file);
  const img = k?.file ?? (p.input.images ?? [p.input.image])[0];
  return img ? `${base}/${img}` : "";
}

// 用系统文件管理器打开目录（只允许项目数据下的固定目录）
function openFolder(path) {
  mkdirSync(path, { recursive: true });
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(cmd, [path], () => {});
  return { path };
}

app.post("/api/open", wrap(async (req) => {
  const { target, id } = req.body ?? {};
  if (target === "runs") return openFolder(RUNS_DIR);
  if (target === "archive") return openFolder(ARCHIVE_DIR);
  if (target === "project") {
    if (!getProject(id)) throw new Error("项目不存在");
    return openFolder(projectDir(id));
  }
  throw new Error("未知目录");
}));

app.post("/api/projects/:id/archive", wrap(async (req) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error("项目不存在");
  stopProject(p);
  return archiveProject(p.id);
}));

app.get("/api/archive", wrap(async () =>
  listArchived().map(({ folder, project: p }) => ({
    folder, id: p.id, name: p.name, createdAt: p.createdAt, archivedAt: p.archivedAt ?? null,
    total: p.stickers?.length ?? 0, cost: p.costTotal ?? 0,
    path: join(ARCHIVE_DIR, folder), cover: coverOf(p, `/archive-files/${encodeURIComponent(folder)}`),
  })),
));
app.post("/api/archive/:folder/restore", wrap(async (req) => {
  const p = restoreArchived(req.params.folder);
  return { id: p.id };
}));
app.use("/archive-files", express.static(ARCHIVE_DIR, { maxAge: "1h" }));

app.get("/api/projects", wrap(async () =>
  listProjects().map((p) => ({
    id: p.id, name: p.name, createdAt: p.createdAt, stage: p.stage, stageStatus: p.stageStatus,
    total: p.stickers.length, done: p.stickers.filter((x) => x.current).length, cost: p.costTotal ?? 0,
    path: projectDir(p.id), cover: coverOf(p, `/files/${p.id}`),
  })),
));
app.post("/api/projects", wrap(async (req) => createProject(req.body ?? {})));
app.get("/api/projects/:id", wrap(async (req) => {
  const p = getProject(req.params.id);
  if (!p) throw new Error("项目不存在");
  return p;
}));
app.post("/api/projects/:id/act", wrap(async (req) => act(req.params.id, req.body ?? {})));

// 实时推送：项目状态 + 环境（额度）
app.get("/api/projects/:id/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const p = getProject(req.params.id);
  if (p) send("project", p);
  send("env", codexEnv());
  const onProject = (q) => { if (q.id === req.params.id) send("project", q); };
  const onEnv = () => send("env", codexEnv());
  bus.on("project", onProject);
  codexEvents.on("env", onEnv);
  const ping = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("project", onProject);
    codexEvents.off("env", onEnv);
  });
});

app.use("/files", express.static(RUNS_DIR, { maxAge: "1h" }));

// 前端
if (DEV) {
  const { createServer } = await import("vite");
  const vite = await createServer({ configFile: join(ROOT, "vite.config.mjs"), server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
} else {
  const dist = join(ROOT, "web/dist");
  if (!existsSync(dist)) {
    console.error("还没有构建前端，请先运行 npm run build（或直接 npm start）");
    process.exit(1);
  }
  app.use(express.static(dist));
  app.get(/^(?!\/api|\/files).*/, (_req, res) => res.sendFile(join(dist, "index.html")));
}

{
  const all = loadAll();
  initSpend(all);
  recover(all);
}
ensureCodex()
  .then(() => pumpAll())
  .catch((e) => console.error("[codex] 启动失败：", e.message));

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  贴贴机 TIETIE 已启动：${url}\n`);
  if (process.argv.includes("--open")) exec(`open ${url}`);
});
