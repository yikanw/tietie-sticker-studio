export type Stage = "analyze" | "character" | "plan" | "generate";
export type StageStatus = "running" | "waiting" | "done" | "error";

export interface Character {
  id: string;
  role: "主角" | "配角";
  name: string;
  appearance: string;
  personality: string;
}

export interface Direction {
  title: string;
  description: string;
  sceneId: string;
}

export interface ImageRole {
  index: number;
  role: "subject" | "style" | "both" | "scene" | "other";
  note: string;
}

export interface Analysis {
  summary: string;
  imageRoles?: ImageRole[];
  subjectType: string;
  characters: Character[];
  styleId: string;
  altStyleIds?: string[];
  recommendedStyleId?: string;
  toneIds?: string[];
  memeIds?: string[];
  styleReason: string;
  styleNote: string;
  directions: Direction[];
  directionIndex: number;
}

export interface Candidate {
  id: string;
  status: "generating" | "done" | "error";
  note: string;
  styleId?: string;
  styleNote?: string;
  file: string | null;
  error: string | null;
}

export interface PlanItem {
  id?: string;
  emotion: string;
  action: string;
  caption: string;
  motion?: string;
  gif?: boolean;
}

export interface QA {
  code: string;
  msg: string;
}

export interface Version {
  id: string;
  raw: string;
  final: string;
  rev: number;
  mode: "new" | "edit" | "direct";
  animId?: string;
  instruction: string | null;
  prompt: string;
  revisedPrompt: string | null;
  backend: "codex" | "api";
  usedRef: boolean;
  qa: QA[];
  createdAt: number;
  costUsd?: number;
  costEstimated?: boolean;
}

export type StickerStatus = "pending" | "queued" | "generating" | "review" | "approved" | "rejected" | "error";

export interface Sticker {
  id: string;
  emotion: string;
  action: string;
  caption: string;
  captionPos: "bottom" | "top" | "none";
  status: StickerStatus;
  progress: "thinking" | "drawing" | null;
  locked: boolean;
  error: string | null;
  versions: Version[];
  current: string | null;
  direct?: boolean;
  motion?: string;
  job: { mode: "new" | "edit" | "animate" | "direct"; instruction?: string; motion?: string; frames?: number; ms?: number } | null;
  anims?: Anim[];
  currentAnim?: string | null;
}

export interface Anim {
  id: string;
  raw: string;
  final: string;
  final240: string;
  rev: number;
  motion: string;
  frames: number;
  ms: number;
  createdAt: number;
  costUsd: number;
  costEstimated: boolean;
  bytes240?: number;
  qa?: QA[];
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  input: { image: string | null; images?: string[]; prompt: string; count: number; autoRun: boolean; styleId: string };
  stage: Stage;
  stageStatus: StageStatus;
  paused: boolean;
  error: string | null;
  notice: string | null;
  analysis: Analysis | null;
  character: { candidates: Candidate[]; chosenId: string | null };
  plan: { note?: string; items: PlanItem[] } | null;
  stickers: Sticker[];
  log: { t: number; msg: string }[];
  exportedAt?: number;
  costs?: CostEntry[];
  costTotal?: number;
  costConfirm?: { kind: "plan" | "character"; count: number; candidateId?: string } | null;
}

export interface CostEntry {
  t: number;
  kind: "analyze" | "plan" | "character" | "sticker" | "edit" | "gif" | "failed";
  label: string;
  backend: "codex" | "api";
  model: string;
  usd: number;
  estimated: boolean;
  stickerId?: string;
  split?: { image: number; agent: number };
}

export interface Estimate {
  count: number;
  perSticker: number;
  total: number;
  totalCny: number;
  usdToCny: number;
  basis: string;
  parts: { image: number; agent: number };
  calibrated: boolean;
  spent: number;
  gif?: { count: number; per: number; basis: string };
}

export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  stage: Stage;
  stageStatus: StageStatus;
  total: number;
  done: number;
  cover: string;
  cost: number;
  path: string;
}

export interface ArchivedSummary {
  folder: string;
  id: string;
  name: string;
  createdAt: number;
  archivedAt: number | null;
  total: number;
  cost: number;
  path: string;
  cover: string;
}

export interface Style {
  id: string;
  name: string;
  group: string;
  desc: string;
  refs: string;
  prompt: string;
  fits: string[];
  caption: { mode: "overlay" | "model"; fill?: string; stroke?: string };
  trend?: boolean;
  needsStyleRef?: boolean;
  sample?: string;
}

export interface Guide {
  subjects: { id: string; name: string; hint: string }[];
  tones: { id: string; name: string; prompt: string }[];
  scenes: { id: string; name: string; structure: string; skeleton: string[]; samples: string[] }[];
  memes: { id: string; name: string; since: string; how: string; caption: string; needs: string }[];
  rules: string[];
}

export interface RateWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexEnv {
  ok: boolean;
  error: string | null;
  version: string | null;
  models: string[];
  model: string | null;
  imageGeneration: boolean;
  rateLimits: { primary?: RateWindow; secondary?: RateWindow } | null;
}

export interface ApiConn {
  backend: "codex" | "api";
  baseUrl: string;
  apiKey: string;
  model: string;
  hasKey: boolean;
  keyHint: string;
  keyFrom: "" | "self" | "image" | "env";
}

export interface Settings {
  concurrency: number;
  proxy: string;
  effectiveProxy: string;
  codex: { model: string };
  image: ApiConn & { quality: string; size: string };
  text: ApiConn & { format: "responses" | "chat"; effort: string };
}

export interface Env {
  codex: CodexEnv;
  settings: Settings;
  styles: Style[];
  guide: Guide;
  apiSpend: ApiSpend;
  paths: { data: string; runs: string; archive: string };
  pricing: { usdToCny: number; note: string };
}

export interface ApiSpend {
  usd: number;
  count: number;
  since: number;
}
