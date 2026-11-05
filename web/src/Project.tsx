import { useEffect, useMemo, useState } from "react";
import { act, api, fileUrl, useProject } from "./api";
import { Quota } from "./App";
import { AnalysisPanel, StylePanel, type Run } from "./Style";
import { CostModal, CostPill, EstimateModal, fmtUsd, RATE_FALLBACK } from "./Cost";
import type { Analysis, Env, PlanItem, Project, Stage, Sticker } from "./types";

const STEPS: { key: Stage | "export"; label: string }[] = [
  { key: "analyze", label: "识别" },
  { key: "character", label: "风格设定" },
  { key: "plan", label: "表情计划" },
  { key: "generate", label: "生成与质检" },
];
const order = (s: string) => STEPS.findIndex((x) => x.key === s);

function useAct(p: Project | null) {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (a: Record<string, unknown>, label = String(a.type)) => {
    if (!p) return;
    setBusy(label);
    try {
      return await act(p.id, a);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

export function ProjectView({ id, env, onSettings }: { id: string; env: Env | null; onSettings: () => void }) {
  const { project: p, codex, connected } = useProject(id);
  const [view, setView] = useState<Stage | null>(null);
  const { run, busy } = useAct(p);
  const [showLog, setShowLog] = useState(false);
  const [showCost, setShowCost] = useState(false);
  const rate = env?.pricing?.usdToCny ?? RATE_FALLBACK;

  // 阶段推进时自动跟随
  useEffect(() => { setView(null); }, [p?.stage]);
  if (!p) return <div className="page center muted">加载中…</div>;
  const cur = view ?? p.stage;
  const generating = p.stickers.filter((s) => s.status === "generating").length;
  const queued = p.stickers.filter((s) => s.status === "queued").length;
  const backend = env?.settings.imageBackend === "api" ? "API" : "Codex 订阅";

  return (
    <div className="page">
      <header className="topbar">
        <a href="#/" className="home-link" title="返回首页">
          <span className="logo">贴</span>
          <span className="muted">←</span>
        </a>
        <div className="brand">{p.name}</div>
        <span className="pill">{backend}</span>
        {!connected && <span className="pill danger">连接断开</span>}
        <div className="grow" />
        <CostPill p={p} rate={rate} onClick={() => setShowCost(true)} />
        <Quota codex={codex} />
        <label className="toggle" title="开启后识别、风格、计划会自动通过">
          <input type="checkbox" checked={p.input.autoRun} onChange={(e) => run({ type: "setAutoRun", value: e.target.checked })} />
          全自动
        </label>
        {p.paused ? (
          <button className="primary" onClick={() => run({ type: "resume" })}>▶ 继续</button>
        ) : (
          <>
            <button className="ghost" onClick={() => run({ type: "pause" })} title="进行中的会画完，不再开新的">⏸ 暂停</button>
            {generating > 0 && (
              <button className="ghost danger" onClick={() => run({ type: "pause", interrupt: true })}>⏹ 全部中断</button>
            )}
          </>
        )}
        <button className="ghost" title={`项目目录：${env?.paths ? `${env.paths.runs}/${p.id}` : ""}（点击在文件夹中打开）`} onClick={() => api.post("/api/open", { target: "project", id: p.id }).catch((e) => alert(e.message))}>📁</button>
        <button className="ghost" onClick={onSettings}>⚙</button>
      </header>

      <nav className="stepper">
        {STEPS.map((s, i) => {
          const reached = i <= order(p.stage);
          const state = s.key === p.stage ? p.stageStatus : reached ? "done" : "todo";
          return (
            <button
              key={s.key}
              disabled={!reached}
              className={`step ${state} ${cur === s.key ? "active" : ""}`}
              onClick={() => setView(s.key as Stage)}
            >
              <span className="dot">{state === "done" ? "✓" : i + 1}</span>
              {s.label}
              {s.key === p.stage && p.stageStatus === "running" && <span className="spinner sm" />}
              {s.key === p.stage && p.stageStatus === "waiting" && <span className="pill warn">待确认</span>}
              {s.key === "generate" && (generating || queued) ? <small>　{generating} 画中 · {queued} 排队</small> : null}
            </button>
          );
        })}
      </nav>

      {p.notice && <div className="banner warn">{p.notice}</div>}
      {p.error && p.stageStatus === "error" && (
        <div className="banner danger">
          {p.error}
          <button className="small" onClick={() => run({ type: "retryStage" })}>重试</button>
        </div>
      )}
      {p.paused && !p.notice && <div className="banner">已暂停，点右上角「继续」接着画。</div>}

      <main className="stage-body">
        {cur === "analyze" && <AnalysisPanel p={p} env={env} run={run} busy={busy} past={order(p.stage) > 0} />}
        {cur === "character" && <StylePanel p={p} env={env} run={run} />}
        {cur === "plan" && <PlanPanel p={p} run={run} hasKey={!!env?.settings.api.hasKey} />}
        {cur === "generate" && <GeneratePanel p={p} run={run} busy={busy} rate={rate} hasKey={!!env?.settings.api.hasKey} modelText={env?.styles.find((x) => x.id === p.analysis?.styleId)?.caption.mode === "model"} />}
      </main>

      {showCost && <CostModal p={p} rate={rate} onClose={() => setShowCost(false)} />}
      <footer className={`logbar ${showLog ? "open" : ""}`}>
        <button className="ghost small" onClick={() => setShowLog(!showLog)}>
          {showLog ? "收起日志" : `日志：${p.log.at(-1)?.msg ?? ""}`}
        </button>
        {showLog && (
          <div className="log">
            {[...p.log].reverse().map((l, i) => (
              <div key={i}><time>{new Date(l.t).toLocaleTimeString("zh-CN")}</time> {l.msg}</div>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}

// ---------- 表情计划 ----------
function PlanPanel({ p, run, hasKey }: { p: Project; run: Run; hasKey: boolean }) {
  const [items, setItems] = useState<PlanItem[]>(p.plan?.items ?? []);
  const [note, setNote] = useState("");
  const [ask, setAsk] = useState(false);
  useEffect(() => {
    if (p.costConfirm?.kind === "plan" && p.stageStatus === "waiting") setAsk(true);
  }, [p.costConfirm, p.stageStatus]);
  useEffect(() => setItems(p.plan?.items ?? []), [p.plan]);
  const running = p.stage === "plan" && p.stageStatus === "running";
  const set = (i: number, patch: Partial<PlanItem>) => setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const gifCount = items.filter((it) => it.gif).length;
  const allGif = items.length > 0 && gifCount === items.length;
  const noKey = "直出动图需要 API 通道：先在设置里填 API Key（Codex 订阅暂未开放原生 GIF）";
  if (running && !items.length)
    return <div className="card center"><span className="spinner" /><p>正在写表情计划…</p><button className="ghost small" onClick={() => run({ type: "cancelStage" })}>中断</button></div>;
  return (
    <div className="card">
      <div className="row">
        <h3 className="grow">表情计划 <small className="muted">{items.length} 条 · 可以直接改，配字留空就不加字</small></h3>
        {running && <span className="spinner sm" />}
        <label className="toggle" title={hasKey ? "勾选的条目不出静图，直接生成 GIF（静图从动图中间一帧取）" : noKey}>
          <input type="checkbox" disabled={!hasKey} checked={allGif} onChange={(e) => setItems(items.map((it) => ({ ...it, gif: e.target.checked })))} />
          全部直出动图
        </label>
      </div>
      <div className="plan-table">
        <div className="plan-row head"><span>#</span><span>情绪</span><span>画面描述</span><span>配字</span><span title="不出静图，直接生成 GIF">动图</span><span /></div>
        {items.map((it, i) => (
          <div key={it.id ?? i} className="plan-row">
            <span className="muted">{i + 1}</span>
            <input value={it.emotion} onChange={(e) => set(i, { emotion: e.target.value })} />
            <div className="plan-action">
              <textarea rows={2} value={it.action} onChange={(e) => set(i, { action: e.target.value })} />
              {it.gif && <input value={it.motion ?? ""} onChange={(e) => set(i, { motion: e.target.value })} placeholder="循环动作（只写怎么动），例如：双手举过头顶左右摇摆；留空按情绪自动设计" />}
            </div>
            <input value={it.caption} onChange={(e) => set(i, { caption: e.target.value })} />
            <label className="plan-gif" title={hasKey ? "直出动图" : noKey}>
              <input type="checkbox" disabled={!hasKey} checked={!!it.gif} onChange={(e) => set(i, { gif: e.target.checked })} />
              <span className="mobile-only">直出动图</span>
            </label>
            <button className="ghost small" onClick={() => setItems(items.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}
      </div>
      <button className="ghost small" onClick={() => setItems([...items, { emotion: "", action: "", caption: "" }])}>+ 加一条</button>
      <div className="row">
        <input className="grow" placeholder="整体调整要求（可选），例如：多一些和老板斗智斗勇的、配字更毒舌、加一张「喝大水」的梗、加点近期热梗" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="ghost" disabled={running} onClick={() => run({ type: "regeneratePlan", note })}>重新策划</button>
        <button className="primary" disabled={running || !items.length} onClick={() => setAsk(true)}>
          开始生成 {items.length} 张{gifCount ? `（${gifCount} 张动图）` : ""} →
        </button>
      </div>
      {ask && (
        <EstimateModal
          p={p}
          count={items.length}
          gifCount={gifCount}
          title={`开始生成 ${items.length} 张表情${gifCount ? `（其中 ${gifCount} 张直出动图）` : ""}`}
          confirmLabel="确认费用，开始生成"
          onConfirm={() => run({ type: "confirmPlan", items })}
          onClose={() => setAsk(false)}
        />
      )}
      {gifCount > 0 && <small className="muted">直出动图：不先出静图，以风格设定图为参考直接生成 GIF，每张约省一次静图费用；静图（封面、静态导出用）从动图中间一帧取，画质略低于单独出的静图。</small>}
      {p.stickers.length > 0 && <small className="muted">已通过或锁定的表情会保留，其余按新计划替换。</small>}
    </div>
  );
}

// ---------- 生成与质检 ----------
const STATUS: Record<string, string> = {
  pending: "未开始", queued: "排队中", generating: "生成中", review: "待质检", approved: "已通过", rejected: "已打回", error: "失败",
};
const FILTERS = [
  { k: "all", label: "全部" },
  { k: "review", label: "待质检" },
  { k: "warn", label: "有提醒" },
  { k: "approved", label: "已通过" },
  { k: "rejected", label: "已打回" },
  { k: "busy", label: "进行中" },
] as const;

function GeneratePanel({ p, run, busy, rate, hasKey, modelText }: { p: Project; run: Run; busy: string | null; rate: number; hasKey: boolean; modelText: boolean }) {
  const [bulkGif, setBulkGif] = useState(false);
  const [bulkFrames, setBulkFrames] = useState(8);
  const [bulkMs, setBulkMs] = useState(120);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["k"]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [exported, setExported] = useState<{ zip: string; count: number; gifCount?: number } | null>(null);
  const cur = (s: Sticker) => s.versions.find((v) => v.id === s.current);
  const list = useMemo(
    () =>
      p.stickers.filter((s) => {
        if (filter === "all") return true;
        if (filter === "warn") return (cur(s)?.qa.length ?? 0) > 0 || s.status === "error";
        if (filter === "busy") return s.status === "queued" || s.status === "generating";
        return s.status === filter;
      }),
    [p.stickers, filter],
  );
  const counts = (k: string) =>
    p.stickers.filter((s) =>
      k === "all" ? true : k === "warn" ? (cur(s)?.qa.length ?? 0) > 0 || s.status === "error" : k === "busy" ? s.status === "queued" || s.status === "generating" : s.status === k,
    ).length;
  const openS = p.stickers.find((s) => s.id === open) ?? null;
  const approved = p.stickers.filter((s) => s.status === "approved").length;
  const gifPool = p.stickers.filter((s) => s.current && !s.currentAnim && s.status !== "rejected" && s.status !== "generating" && s.status !== "queued");
  const gifTargets = gifPool.some((s) => s.status === "approved") ? gifPool.filter((s) => s.status === "approved") : gifPool;

  return (
    <div className="gen">
      <div className="toolbar">
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f.k} className={filter === f.k ? "on" : ""} onClick={() => setFilter(f.k)}>
              {f.label} {counts(f.k)}
            </button>
          ))}
        </div>
        <div className="grow" />
        <button className="ghost" onClick={() => run({ type: "approveAll" })}>待质检的全部通过</button>
        <AddSticker run={run} />
        <button
          className="ghost"
          disabled={!hasKey || !gifTargets.length}
          title={hasKey ? "给还没有动图的表情批量做 GIF（已通过的优先）" : "动图需要 API 通道，先在设置里填 API Key"}
          onClick={() => setBulkGif(true)}
        >
          批量做动图 {gifTargets.length || ""}
        </button>
        <button
          className="primary"
          disabled={busy === "export"}
          onClick={async () => {
            const r = (await run({ type: "export" }, "export")) as { zip: string; count: number; gifCount?: number } | undefined;
            if (r?.zip) setExported(r);
          }}
        >
          {busy === "export" ? "打包中…" : `导出${approved ? ` ${approved} 张已通过` : "全部"}`}
        </button>
      </div>
      {bulkGif && (
        <EstimateModal
          p={p}
          count={gifTargets.length}
          gif={{ frames: bulkFrames }}
          title={`给 ${gifTargets.length} 张表情做动图`}
          confirmLabel="确认费用，开始做动图"
          onConfirm={() => run({ type: "animateMany", ids: gifTargets.map((s) => s.id), frames: bulkFrames, ms: bulkMs })}
          onClose={() => setBulkGif(false)}
        >
          <div className="row">
            <label className="field"><span>帧数</span>
              <select value={bulkFrames} onChange={(e) => setBulkFrames(Number(e.target.value))}>{[4, 6, 8, 12, 16].map((n) => <option key={n} value={n}>{n} 帧</option>)}</select>
            </label>
            <label className="field"><span>每帧</span>
              <select value={bulkMs} onChange={(e) => setBulkMs(Number(e.target.value))}>{[80, 100, 120, 160, 200].map((n) => <option key={n} value={n}>{n} ms</option>)}</select>
            </label>
            <small className="muted grow">每张按计划里写好的循环动作来动（没有的按情绪自动设计），做完可在单张里改动作重做。</small>
          </div>
        </EstimateModal>
      )}
      {exported && (
        <div className="banner ok">
          已打包 {exported.count} 张{exported.gifCount ? `，其中 ${exported.gifCount} 张带动图` : ""}（240×240 与 512×512 各一份，含封面和图标）。
          <a className="button small" href={exported.zip} download>下载 zip</a>
        </div>
      )}
      <div className="sticker-grid">
        {list.map((s) => <StickerCard key={s.id} p={p} s={s} run={run} onOpen={() => setOpen(s.id)} />)}
      </div>
      {openS && <StickerDrawer p={p} s={openS} run={run} rate={rate} hasKey={hasKey} modelText={modelText} onClose={() => setOpen(null)} />}
    </div>
  );
}

function AddSticker({ run }: { run: Run }) {
  const [show, setShow] = useState(false);
  const [it, setIt] = useState<PlanItem>({ emotion: "", action: "", caption: "" });
  if (!show) return <button className="ghost" onClick={() => setShow(true)}>+ 加一张</button>;
  return (
    <div className="modal-mask" onClick={() => setShow(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>加一张表情</h3>
        <label className="field"><span>情绪</span><input value={it.emotion} onChange={(e) => setIt({ ...it, emotion: e.target.value })} /></label>
        <label className="field"><span>画面描述</span><textarea rows={3} value={it.action} onChange={(e) => setIt({ ...it, action: e.target.value })} /></label>
        <label className="field"><span>配字</span><input value={it.caption} onChange={(e) => setIt({ ...it, caption: e.target.value })} /></label>
        <div className="row end">
          <button className="ghost" onClick={() => setShow(false)}>取消</button>
          <button className="primary" disabled={!it.action && !it.emotion} onClick={() => { run({ type: "sticker.add", ...it }); setShow(false); setIt({ emotion: "", action: "", caption: "" }); }}>生成</button>
        </div>
      </div>
    </div>
  );
}

function StickerCard({ p, s, run, onOpen }: { p: Project; s: Sticker; run: Run; onOpen: () => void }) {
  const v = s.versions.find((x) => x.id === s.current);
  const an = s.anims?.find((x) => x.id === s.currentAnim);
  return (
    <div className={`sticker ${s.status}`}>
      <button className="sticker-img checker" onClick={onOpen}>
        {an ? (
          <img src={fileUrl(p.id, an.final, an.rev)} alt={s.emotion} className={s.status === "generating" ? "fade" : ""} />
        ) : (
          v && <img src={fileUrl(p.id, v.final, v.rev)} alt={s.emotion} className={s.status === "generating" ? "fade" : ""} />
        )}
        {(s.status === "generating" || s.status === "queued") && (
          <div className="overlay">
            {s.status === "generating"
              ? <><span className="spinner" />{s.job?.mode === "animate" || s.job?.mode === "direct" ? "动图生成中" : s.progress === "drawing" ? "绘制中" : "构思中"}</>
              : s.job?.mode === "animate" || s.job?.mode === "direct" ? "动图排队中" : "排队中"}
            {s.job?.mode === "edit" && <small>修改：{s.job.instruction}</small>}
          </div>
        )}
        {s.status === "error" && <div className="overlay error">失败<small>{s.error}</small></div>}
        {s.status === "pending" && !v && <div className="overlay">未开始</div>}
      </button>
      <div className="sticker-meta">
        <b title={s.action}>{s.emotion || "（无标题）"}</b>
        {s.locked && <span title="已锁定，换风格时不会重画">🔒</span>}
        {an && <span className="gif-badge" title={`${an.frames} 帧动图`}>GIF</span>}
        <span className={`pill s-${s.status}`}>{STATUS[s.status]}</span>
      </div>
      {v && v.qa.length > 0 && <div className="qa-line" title={v.qa.map((q) => q.msg).join("\n")}>⚠ {v.qa[0].msg}{v.qa.length > 1 ? ` 等 ${v.qa.length} 项` : ""}</div>}
      <div className="sticker-actions">
        <button className="ok" title="通过" disabled={!v} onClick={() => run({ type: "sticker.status", id: s.id, status: s.status === "approved" ? "review" : "approved" })}>✓</button>
        <button className="no" title="打回" disabled={!v} onClick={() => run({ type: "sticker.status", id: s.id, status: s.status === "rejected" ? "review" : "rejected" })}>✕</button>
        <button title="重画" onClick={() => run({ type: "sticker.regenerate", id: s.id })}>↻</button>
        {(s.status === "generating" || s.status === "queued") && <button title="中断" onClick={() => run({ type: "sticker.cancel", id: s.id })}>⏹</button>}
        <button title="详情 / 修改" onClick={onOpen}>✎</button>
      </div>
    </div>
  );
}

function StickerDrawer({ p, s, run, rate, hasKey, modelText, onClose }: { p: Project; s: Sticker; run: Run; rate: number; hasKey: boolean; modelText: boolean; onClose: () => void }) {
  const [motion, setMotion] = useState(s.motion || s.anims?.find((x) => x.id === s.currentAnim)?.motion || "");
  const [frames, setFrames] = useState(8);
  const [ms, setMs] = useState(120);
  const [gifCost, setGifCost] = useState<number | null>(null);
  const [showStatic, setShowStatic] = useState(false);
  useEffect(() => {
    act(p.id, { type: "estimate", count: 1, gif: { frames } }).then((r) => setGifCost((r as unknown as { total: number }).total)).catch(() => {});
  }, [p.id, frames]);
  const an = s.anims?.find((x) => x.id === s.currentAnim);
  useEffect(() => { setMotion(s.motion || an?.motion || ""); setShowStatic(false); }, [s.id]);
  const [one, setOne] = useState<{ gen: number; edit: number; gif: number } | null>(null);
  const [direct, setDirect] = useState(!!s.direct);
  useEffect(() => { setDirect(!!s.direct); }, [s.id, s.direct]);
  useEffect(() => {
    const tot = (r: unknown) => (r as { total: number }).total;
    Promise.all([act(p.id, { type: "estimate", count: 1 }), act(p.id, { type: "estimate", count: 1, edit: true }), act(p.id, { type: "estimate", count: 1, gifCount: 1 })])
      .then(([a, b, g]) => setOne({ gen: tot(a), edit: tot(b), gif: tot(g) }))
      .catch(() => {});
  }, [p.id]);
  const spent = (p.costs ?? []).filter((c) => c.stickerId === s.id).reduce((x, c) => x + c.usd, 0);
  const [emotion, setEmotion] = useState(s.emotion);
  const [action, setAction] = useState(s.action);
  const [caption, setCaption] = useState(s.caption);
  const [pos, setPos] = useState(s.captionPos);
  const [instr, setInstr] = useState("");
  useEffect(() => { setEmotion(s.emotion); setAction(s.action); setCaption(s.caption); setPos(s.captionPos); }, [s.id]);
  const v = s.versions.find((x) => x.id === s.current);
  const busy = s.status === "generating" || s.status === "queued";
  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3 className="grow">{s.emotion}</h3>
          <span className={`pill s-${s.status}`}>{STATUS[s.status]}</span>
          <button className="ghost small" onClick={onClose}>✕</button>
        </div>
        {an && (
          <div className="seg">
            <button className={!showStatic ? "on" : ""} onClick={() => setShowStatic(false)}>动图</button>
            <button className={showStatic ? "on" : ""} onClick={() => setShowStatic(true)}>静图</button>
          </div>
        )}
        <div className="big-preview checker">
          {an && !showStatic ? (
            <img src={fileUrl(p.id, an.final, an.rev)} alt="" />
          ) : v ? (
            <img src={fileUrl(p.id, v.final, v.rev)} alt="" />
          ) : (
            <div className="placeholder">{busy ? "生成中…" : "还没有图"}</div>
          )}
          {busy && <div className="overlay"><span className="spinner" />{s.status === "queued" ? "排队中" : s.progress === "drawing" ? "绘制中" : "构思中"}</div>}
        </div>
        {s.versions.length > 1 && (
          <div className="versions">
            {s.versions.map((x, i) => (
              <button key={x.id} className={x.id === s.current ? "on" : ""} onClick={() => run({ type: "sticker.selectVersion", id: s.id, versionId: x.id })} title={x.mode === "edit" ? `修改：${x.instruction}` : x.mode === "direct" ? "直出动图取的静图" : "重画"}>
                <img src={fileUrl(p.id, x.raw)} alt="" />
                <small>v{i + 1}{x.mode === "edit" ? "改" : x.mode === "direct" ? "动" : ""}</small>
              </button>
            ))}
          </div>
        )}
        {v && v.qa.length > 0 && (
          <ul className="qa">{v.qa.map((q) => <li key={q.code}>⚠ {q.msg}</li>)}</ul>
        )}
        {s.error && <p className="error">{s.error}</p>}

        <div className="row">
          <button className={s.status === "approved" ? "primary" : "ghost"} disabled={!v} onClick={() => run({ type: "sticker.status", id: s.id, status: s.status === "approved" ? "review" : "approved" })}>✓ 通过</button>
          <button className="ghost" disabled={!v} onClick={() => run({ type: "sticker.status", id: s.id, status: s.status === "rejected" ? "review" : "rejected" })}>✕ 打回</button>
          <button className="ghost" onClick={() => run({ type: "sticker.lock", id: s.id, locked: !s.locked })}>{s.locked ? "🔓 解锁" : "🔒 锁定"}</button>
          {busy && <button className="ghost" onClick={() => run({ type: "sticker.cancel", id: s.id })}>⏹ 中断</button>}
          <div className="grow" />
          <button className="ghost danger small" onClick={() => confirm("删除这张表情？") && (run({ type: "sticker.delete", id: s.id }), onClose())}>删除</button>
        </div>

        <section>
          <h4>配字 <small className="muted">{modelText ? "当前是文字类风格，字由画面绘制：改字会重画这一张" : "只改字不重画，马上生效"}</small></h4>
          <div className="row">
            <input className="grow" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="留空则不加字" />
            {!modelText && <select value={pos} onChange={(e) => setPos(e.target.value as Sticker["captionPos"])}>
              <option value="bottom">底部</option>
              <option value="top">顶部</option>
              <option value="none">不加字</option>
            </select>}
            <button className="ghost" disabled={!v} onClick={() => run({ type: "sticker.caption", id: s.id, caption, captionPos: caption ? pos : "none" })}>{modelText ? "改字重画" : "更新"}</button>
          </div>
        </section>

        <section>
          <h4>局部修改 <small className="muted">以当前这张为底稿</small></h4>
          <textarea rows={2} value={instr} onChange={(e) => setInstr(e.target.value)} placeholder="例如：眼泪再夸张一点、把手里的咖啡换成奶茶、去掉头顶的符号" />
          <button className="primary" disabled={!v || !instr.trim()} onClick={() => { run({ type: "sticker.edit", id: s.id, instruction: instr }); setInstr(""); }}>
            按要求修改{one ? `（约 ${fmtUsd(one.edit, rate, false)}）` : ""}
          </button>
        </section>

        <section>
          <h4>重新画 <small className="muted">改描述后以风格设定图为参考重新生成</small></h4>
          <input value={emotion} onChange={(e) => setEmotion(e.target.value)} placeholder="情绪" />
          <textarea rows={3} value={action} onChange={(e) => setAction(e.target.value)} placeholder="画面描述" />
          <label className="toggle" title={hasKey ? "不出静图，直接生成 GIF；静图从动图中间一帧取" : "需要 API 通道"}>
            <input type="checkbox" disabled={!hasKey} checked={direct} onChange={(e) => setDirect(e.target.checked)} />
            直出动图（画面用上面的描述，动作用下面「动图」里的循环动作）
          </label>
          <button className="ghost" onClick={() => run({ type: "sticker.regenerate", id: s.id, emotion, action, caption, captionPos: caption ? pos : "none", direct, motion })}>
            {direct ? "按新描述直出动图" : "按新描述重画"}{one ? `（约 ${fmtUsd(direct ? one.gif : one.gen, rate, false)}）` : ""}
          </button>
        </section>

        <section>
          <h4>动图 <small className="muted">API 原生 GIF，以当前静图 + 风格设定图为参考</small></h4>
          {!hasKey && <p className="muted small">需要 API 通道：先在设置里填 API Key（Codex 订阅暂未开放原生 GIF）。</p>}
          <textarea rows={2} value={motion} onChange={(e) => setMotion(e.target.value)} placeholder="循环动作（只写怎么动），例如：双手捂脸左右摇头，眼泪一抽一抽地往外飙。留空则按情绪自动设计" />
          <div className="row">
            <select value={frames} onChange={(e) => setFrames(Number(e.target.value))}>{[4, 6, 8, 12, 16].map((n) => <option key={n} value={n}>{n} 帧</option>)}</select>
            <select value={ms} onChange={(e) => setMs(Number(e.target.value))}>{[80, 100, 120, 160, 200].map((n) => <option key={n} value={n}>{n} ms/帧</option>)}</select>
            <button className="primary" disabled={!hasKey || !v || busy} onClick={() => run({ type: "sticker.animate", id: s.id, motion, frames, ms })}>
              {an ? "重做动图" : "做成 GIF"}{gifCost != null ? `（约 ${fmtUsd(gifCost, rate, false)}）` : ""}
            </button>
          </div>
          {s.anims && s.anims.length > 0 && (
            <div className="versions">
              <button className={!s.currentAnim ? "on" : ""} onClick={() => run({ type: "sticker.selectAnim", id: s.id, animId: null })} title="导出时不带动图">
                <div className="no-anim">不用</div>
                <small>静图</small>
              </button>
              {s.anims.map((x, i) => (
                <button key={x.id} className={x.id === s.currentAnim ? "on" : ""} onClick={() => run({ type: "sticker.selectAnim", id: s.id, animId: x.id })} title={x.motion}>
                  <img src={fileUrl(p.id, x.final240, x.rev)} alt="" />
                  <small>G{i + 1} · {x.frames}帧</small>
                </button>
              ))}
            </div>
          )}
          {an && (
            <p className="muted small">
              {an.frames} 帧 × {an.ms}ms · 240 尺寸 {an.bytes240 ? `${Math.round(an.bytes240 / 1024)}KB` : "—"} · {fmtUsd(an.costUsd, rate)}{an.costEstimated ? "（估算）" : ""}
              {an.qa?.map((q) => <span key={q.code} className="error"><br />⚠ {q.msg}</span>)}
            </p>
          )}
        </section>

        {v && (
          <details>
            <summary>生成信息</summary>
            <p className="muted small">
              通道：{v.backend === "api" ? "API" : "Codex 订阅"} · 参考图：{v.usedRef ? "已使用" : "未使用"} · {new Date(v.createdAt).toLocaleString("zh-CN")}
              <br />
              本版本 {fmtUsd(v.costUsd, rate)}{v.costEstimated ? "（估算）" : ""} · 这张累计 {fmtUsd(spent, rate)}
            </p>
            <pre>{v.revisedPrompt ?? v.prompt}</pre>
          </details>
        )}
      </aside>
    </div>
  );
}
