// 项目持久化：每个项目一个目录 data/runs/<id>/（project.json + 所有图片）；归档后整目录移到 data/archive/
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RUNS_DIR, ARCHIVE_DIR } from "./paths.mjs";

export const bus = new EventEmitter();
bus.setMaxListeners(100);

const projects = new Map();
const archived = new Set(); // 已归档的 id：残留的异步任务再 save 也不会把目录写回 runs/

export function projectDir(id) {
  return join(RUNS_DIR, id);
}

export function loadAll() {
  mkdirSync(RUNS_DIR, { recursive: true });
  for (const id of readdirSync(RUNS_DIR)) {
    const f = join(RUNS_DIR, id, "project.json");
    if (!existsSync(f)) continue;
    try {
      projects.set(id, JSON.parse(readFileSync(f, "utf8")));
    } catch (e) {
      console.warn("跳过损坏的项目", id, e.message);
    }
  }
  return [...projects.values()];
}

export function getProject(id) {
  return projects.get(id) ?? null;
}

export function listProjects() {
  return [...projects.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function save(p) {
  if (archived.has(p.id)) return;
  p.updatedAt = Date.now();
  projects.set(p.id, p);
  const dir = projectDir(p.id);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "project.json");
  writeFileSync(f + ".tmp", JSON.stringify(p, null, 2));
  renameSync(f + ".tmp", f);
  bus.emit("project", p);
}

export function addLog(p, msg) {
  p.log = p.log ?? [];
  p.log.push({ t: Date.now(), msg });
  if (p.log.length > 100) p.log.splice(0, p.log.length - 100);
}

export const uid = (prefix = "") => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- 归档 ----------
const safe = (s) => String(s ?? "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "未命名";
const day = (t) => new Date(t).toLocaleDateString("sv-SE"); // YYYY-MM-DD

// 把项目目录整个移到 data/archive/<日期>_<名字>_<id>/，并从列表里移除
export function archiveProject(id) {
  const p = projects.get(id);
  if (!p) throw new Error("项目不存在");
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const folder = `${day(p.createdAt)}_${safe(p.name)}_${id}`;
  const dst = join(ARCHIVE_DIR, folder);
  if (existsSync(dst)) throw new Error("归档目录已存在：" + dst);
  p.archivedAt = Date.now();
  writeFileSync(join(projectDir(id), "project.json"), JSON.stringify(p, null, 2));
  renameSync(projectDir(id), dst);
  archived.add(id);
  projects.delete(id);
  bus.emit("archived", id);
  return { folder, path: dst };
}

export function listArchived() {
  if (!existsSync(ARCHIVE_DIR)) return [];
  const out = [];
  for (const folder of readdirSync(ARCHIVE_DIR)) {
    const f = join(ARCHIVE_DIR, folder, "project.json");
    if (!existsSync(f)) continue;
    try {
      out.push({ folder, project: JSON.parse(readFileSync(f, "utf8")) });
    } catch {}
  }
  return out.sort((a, b) => (b.project.archivedAt ?? 0) - (a.project.archivedAt ?? 0));
}

// 从归档恢复：目录移回 data/runs/<id>/
export function restoreArchived(folder) {
  if (!/^[^/\\]+$/.test(folder) || folder.startsWith(".")) throw new Error("目录名不合法");
  const src = join(ARCHIVE_DIR, folder);
  const f = join(src, "project.json");
  if (!existsSync(f)) throw new Error("归档不存在");
  const p = JSON.parse(readFileSync(f, "utf8"));
  if (existsSync(projectDir(p.id))) throw new Error("项目目录已存在，无法恢复：" + projectDir(p.id));
  renameSync(src, projectDir(p.id));
  delete p.archivedAt;
  archived.delete(p.id);
  save(p);
  return p;
}
