import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.STICKER_DATA_DIR ?? join(ROOT, "data");
export const RUNS_DIR = join(DATA_DIR, "runs");
export const ARCHIVE_DIR = join(DATA_DIR, "archive"); // 归档的项目整个目录搬到这里，可恢复
