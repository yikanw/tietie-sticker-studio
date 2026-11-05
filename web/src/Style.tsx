// 识别 & 风格设定两个环节的界面
import { useEffect, useMemo, useState } from "react";
import { act, fileUrl } from "./api";
import { EstimateModal, fmtUsd, RATE_FALLBACK } from "./Cost";
import type { Analysis, Env, ImageRole, Project, Style } from "./types";

const ROLE_NAMES: Record<ImageRole["role"], string> = {
  subject: "主体",
  style: "风格参考",
  both: "主体 + 风格",
  scene: "元素/场景参考",
  other: "其他参考",
};
export const inputImages = (p: Project) => (p.input.images ?? [p.input.image]).filter(Boolean) as string[];
const isStyleRole = (r?: string) => r === "style" || r === "both";

// 用户上传的图；传入 roles/onChange 时可以改每张图的用途
function InputImages({ p, roles, onChange }: { p: Project; roles?: ImageRole[]; onChange?: (r: ImageRole[]) => void }) {
  const imgs = inputImages(p).filter(Boolean);
  if (!imgs.length) return <div className="no-input muted">没有上传图片，形象由 AI 按描述原创设计</div>;
  if (imgs.length === 1 && !roles) return <img className="input-img checker" src={fileUrl(p.id, imgs[0])} alt="" />;
  const roleOf = (i: number) => roles?.find((r) => r.index === i + 1);
  return (
    <div className="inputs">
      {imgs.map((f, i) => {
        const r = roleOf(i);
        return (
          <div key={f} className="input-cell">
            <div className="thumb-in checker">
              <img src={fileUrl(p.id, f)} alt="" />
              <span className="tag">图{i + 1}</span>
            </div>
            {roles && onChange ? (
              <>
                <select
                  value={r?.role ?? (i === 0 ? "subject" : "other")}
                  onChange={(e) => {
                    const next = imgs.map((_, j) => roleOf(j) ?? { index: j + 1, role: (j === 0 ? "subject" : "other") as ImageRole["role"], note: "" });
                    next[i] = { ...next[i], role: e.target.value as ImageRole["role"] };
                    onChange(next);
                  }}
                >
                  {Object.entries(ROLE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                {r?.note && <small className="muted">{r.note}</small>}
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export type Run = (a: Record<string, unknown>, label?: string) => Promise<unknown>;

const toggle = (arr: string[], id: string, max: number) =>
  arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id].slice(-max);

// ---------- 识别 ----------
export function AnalysisPanel({ p, env, run, busy, past }: { p: Project; env: Env | null; run: Run; busy: string | null; past: boolean }) {
  const [a, setA] = useState<Analysis | null>(p.analysis);
  useEffect(() => setA(p.analysis), [p.analysis]);
  const running = p.stage === "analyze" && p.stageStatus === "running";
  const waiting = p.stage === "analyze" && p.stageStatus === "waiting";
  const guide = env?.guide;

  if (!a)
    return (
      <div className="split">
        <div className="card"><InputImages p={p} /></div>
        <div className="card center">
          {running ? (
            <>
              <span className="spinner" />
              <p>正在识别主体、判断风格、语气和内容方向…（约 30–60 秒）</p>
              <button className="ghost small" onClick={() => run({ type: "cancelStage" })}>中断</button>
            </>
          ) : (
            <button className="primary" onClick={() => run({ type: "retryStage" })}>开始识别</button>
          )}
        </div>
      </div>
    );

  const isText = a.subjectType === "text";
  const setChar = (i: number, patch: Partial<Analysis["characters"][0]>) =>
    setA({ ...a, characters: a.characters.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const setDir = (i: number, patch: Partial<Analysis["directions"][0]>) =>
    setA({ ...a, directions: a.directions.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  const subjectHint = guide?.subjects.find((s) => s.id === a.subjectType)?.hint;

  return (
    <div className="split">
      <div className="card">
        <InputImages p={p} roles={inputImages(p).length > 1 || (a.imageRoles && a.imageRoles[0]?.role !== "subject") ? a.imageRoles ?? [] : undefined} onChange={(imageRoles) => setA({ ...a, imageRoles })} />
        {inputImages(p).length > 1 && <small className="muted">每张图的用途由 AI 根据你的描述判断，可以在这里改；风格参考图只学画法，不会被当成主体。</small>}
        <p className="muted">{a.summary}</p>
        {p.input.prompt && <p><b>你的想法：</b>{p.input.prompt}</p>}
      </div>
      <div className="card form">
        <h3>主体 <small className="muted">表情包里"谁"在说话，不一定是角色</small></h3>
        <div className="chip-row">
          {guide?.subjects.map((s) => (
            <button key={s.id} className={`style-chip ${a.subjectType === s.id ? "on" : ""}`} title={s.hint} onClick={() => setA({ ...a, subjectType: s.id })}>
              {s.name}
            </button>
          ))}
        </div>
        {subjectHint && <small className="muted">{subjectHint}</small>}

        {!isText && (
          <>
            <h3>角色</h3>
            {a.characters.map((c, i) => (
              <div key={c.id || i} className="char-edit">
                <div className="row">
                  <select value={c.role} onChange={(e) => setChar(i, { role: e.target.value as "主角" | "配角" })}>
                    <option>主角</option>
                    <option>配角</option>
                  </select>
                  <input className="grow" value={c.name} onChange={(e) => setChar(i, { name: e.target.value })} />
                  <button className="ghost small" onClick={() => setA({ ...a, characters: a.characters.filter((_, j) => j !== i) })}>删除</button>
                </div>
                <textarea rows={4} value={c.appearance} onChange={(e) => setChar(i, { appearance: e.target.value })} placeholder="外貌：识别点、配色、服装配饰…" />
                <input value={c.personality} onChange={(e) => setChar(i, { personality: e.target.value })} placeholder="有反差的性格，例如：懒但在乎你" />
              </div>
            ))}
            <button
              className="ghost small"
              onClick={() => setA({ ...a, characters: [...a.characters, { id: "", role: a.characters.length ? "配角" : "主角", name: "新角色", appearance: "", personality: "" }] })}
            >
              + 添加{a.characters.length ? "配角" : "主角"}
            </button>
          </>
        )}

        <h3>语气 <small className="muted">最多选 2 个</small></h3>
        <div className="chip-row">
          {guide?.tones.map((t) => (
            <button key={t.id} className={`style-chip ${a.toneIds?.includes(t.id) ? "on" : ""}`} title={t.prompt} onClick={() => setA({ ...a, toneIds: toggle(a.toneIds ?? [], t.id, 2) })}>
              {t.name}
            </button>
          ))}
        </div>

        <h3>内容方向</h3>
        {a.directions.map((d, i) => (
          <label key={i} className={`direction ${a.directionIndex === i ? "on" : ""}`}>
            <input type="radio" checked={a.directionIndex === i} onChange={() => setA({ ...a, directionIndex: i })} />
            <div className="grow">
              <div className="row">
                <input className="grow" value={d.title} onChange={(e) => setDir(i, { title: e.target.value })} />
                <select value={d.sceneId} onChange={(e) => setDir(i, { sceneId: e.target.value })} title="场景模板：决定整套的内容结构">
                  {guide?.scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <textarea rows={2} value={d.description} onChange={(e) => setDir(i, { description: e.target.value })} />
              {a.directionIndex === i && (
                <small className="muted">结构：{guide?.scenes.find((s) => s.id === d.sceneId)?.structure}</small>
              )}
            </div>
          </label>
        ))}

        <div className="row end">
          {waiting && (
            <button className="primary" disabled={!!busy} onClick={() => run({ type: "confirmAnalysis", edits: a })}>
              确认，去风格设定 →
            </button>
          )}
          {past && (
            <>
              <button
                className="ghost"
                onClick={() => run({ type: "editAnalysis", edits: a })}
              >
                保存主体/语气，去风格设定
              </button>
              <button
                className="ghost"
                onClick={() => confirm("按新的内容方向重新出计划？已通过和锁定的表情会保留。") && run({ type: "changeDirection", directionIndex: a.directionIndex, direction: a.directions[a.directionIndex] })}
              >
                换内容方向，重出计划
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 风格设定 ----------
export function StylePanel({ p, env, run }: { p: Project; env: Env | null; run: Run }) {
  const a = p.analysis;
  const styles = env?.styles ?? [];
  const rate = env?.pricing?.usdToCny ?? RATE_FALLBACK;
  const cands = p.character.candidates;
  const [styleId, setStyleId] = useState(a?.styleId ?? styles[0]?.id);
  const [styleNote, setStyleNote] = useState(a?.styleNote ?? "");
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<string | null>(p.character.chosenId);
  const [ask, setAsk] = useState(false);
  const [askMulti, setAskMulti] = useState(false);
  const [one, setOne] = useState<number | null>(null);
  const redrawCount = p.stickers.filter((s) => !s.locked).length;

  useEffect(() => {
    if (!sel) setSel(p.character.chosenId ?? [...cands].reverse().find((k) => k.status === "done")?.id ?? null);
  }, [cands, p.character.chosenId, sel]);
  useEffect(() => {
    if (p.costConfirm?.kind === "character") setAsk(true);
  }, [p.costConfirm]);
  useEffect(() => {
    act(p.id, { type: "estimate", count: 1 }).then((r) => setOne((r as unknown as { total: number }).total)).catch(() => {});
  }, [p.id]);

  const recommended = a?.recommendedStyleId ?? a?.styleId;
  const alts = a?.altStyleIds ?? [];
  const hasStyleRef = !!a?.imageRoles?.some((r) => isStyleRole(r.role));
  const groups = useMemo(() => {
    const m = new Map<string, Style[]>();
    for (const s of styles) if (!s.needsStyleRef || hasStyleRef) m.set(s.group, [...(m.get(s.group) ?? []), s]);
    // 有风格参考图时，「参考图」组放最前
    return [...m.entries()].sort((x, y) => Number(y[1].some((s) => s.needsStyleRef)) - Number(x[1].some((s) => s.needsStyleRef)));
  }, [styles, hasStyleRef]);
  const toPreview = [...new Set([recommended, ...alts].filter(Boolean) as string[])].filter(
    (id) => !cands.some((k) => k.styleId === id && k.status !== "error"),
  );
  const generating = cands.some((k) => k.status === "generating");
  const styleName = (id?: string) => styles.find((s) => s.id === id)?.name ?? id ?? "";
  const selCand = cands.find((k) => k.id === sel);

  if (!a) return <div className="card center muted">先完成识别</div>;

  return (
    <div className="style-stage">
      <div className="card">
        <div className="row">
          <h3 className="grow">
            选风格 <small className="muted">主体：{env?.guide.subjects.find((s) => s.id === a.subjectType)?.name ?? a.subjectType}{a.styleReason ? ` · AI：${a.styleReason}` : ""}</small>
          </h3>
        </div>
        {groups.map(([g, list]) => (
          <div key={g} className="style-group">
            <div className="style-group-title">{g}</div>
            <div className="style-cards">
              {list.map((s) => {
                const fits = s.fits.includes(a.subjectType);
                return (
                  <button key={s.id} className={`style-card ${styleId === s.id ? "on" : ""} ${fits ? "" : "dim"}`} onClick={() => setStyleId(s.id)}>
                    {s.sample ? (
                      <img className="style-sample" src={s.sample} alt={`${s.name} 样张`} loading="lazy" />
                    ) : s.needsStyleRef ? (
                      <div className="style-sample ref-samples">
                        {(a.imageRoles ?? []).filter((r) => isStyleRole(r.role)).map((r) => {
                          const file = inputImages(p)[r.index - 1];
                          return file ? <img key={r.index} src={fileUrl(p.id, file)} alt="" /> : null;
                        })}
                      </div>
                    ) : null}
                    <div className="row">
                      <b className="grow">{s.name}</b>
                      {s.id === recommended && <span className="pill s-approved">AI 推荐</span>}
                      {alts.includes(s.id) && <span className="pill">备选</span>}
                      {s.trend && <span className="pill warn">近期流行</span>}
                    </div>
                    <small>{s.desc}</small>
                    {!fits && <small className="muted">与当前主体不太搭</small>}
                    {cands.some((k) => k.styleId === s.id && k.status === "done") && <small className="ok-text">✓ 已预览</small>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="row">
          <input className="grow" placeholder="补充风格要求（可选），例如：线条更粗、配色偏粉、字更潦草" value={styleNote} onChange={(e) => setStyleNote(e.target.value)} />
          <input className="grow" placeholder="这次预览的调整要求（可选），例如：主体再胖一点" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="row end">
          {toPreview.length > 1 && (
            <button className="ghost" onClick={() => setAskMulti(true)}>
              一键预览推荐的 {toPreview.length} 种{one != null ? `（约 ${fmtUsd(one * toPreview.length, rate, false)}）` : ""}
            </button>
          )}
          <button className="primary" onClick={() => { run({ type: "previewStyle", styleId, styleNote, note }); setNote(""); }}>
            预览「{styleName(styleId)}」{one != null ? `（约 ${fmtUsd(one, rate, false)}）` : ""}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <h3 className="grow">风格设定图 <small className="muted">左上是主体设定（文字包为字体样张），其余三格是示例；确认后每张表情都以它为参考</small></h3>
          {generating && <button className="ghost small" onClick={() => run({ type: "cancelStage" })}>中断</button>}
        </div>
        <div className="cand-grid">
          {inputImages(p).length > 0 && <div className="cand ref">
            {inputImages(p).length > 1 ? (
              <div className="ref-stack">
                {inputImages(p).map((f) => <img key={f} className="checker" src={fileUrl(p.id, f)} alt="" />)}
              </div>
            ) : (
              <img className="checker" src={fileUrl(p.id, inputImages(p)[0])} alt="" />
            )}
            <small>你的图{inputImages(p).length > 1 ? `（${inputImages(p).length} 张，都会作为参考）` : ""}</small>
          </div>}
          {cands.map((k) => (
            <button key={k.id} className={`cand ${sel === k.id ? "on" : ""} ${p.character.chosenId === k.id ? "chosen" : ""}`} onClick={() => k.status === "done" && setSel(k.id)}>
              {k.status === "done" && k.file ? (
                <img className="checker" src={fileUrl(p.id, k.file)} alt="" />
              ) : k.status === "generating" ? (
                <div className="placeholder"><span className="spinner" />绘制中…</div>
              ) : (
                <div className="placeholder error">{k.error}</div>
              )}
              <small>
                <b>{styleName(k.styleId) || "旧版设定图"}</b>
                {p.character.chosenId === k.id ? " · ✓ 当前使用" : ""}
                {k.note ? ` · ${k.note}` : ""}
              </small>
            </button>
          ))}
          {!cands.length && <div className="placeholder">还没有预览，选一个风格点「预览」</div>}
        </div>
        <div className="row end">
          <button
            className="primary"
            disabled={!selCand || selCand.status !== "done" || (sel === p.character.chosenId && p.stage !== "character")}
            onClick={() => (p.stickers.length && redrawCount ? setAsk(true) : run({ type: "confirmCharacter", candidateId: sel }))}
          >
            {selCand ? `用「${styleName(selCand.styleId) || "这张"}」` : "选一张预览"}
            {p.stickers.length ? `，重画 ${redrawCount} 张未锁定的表情 →` : "，出表情计划 →"}
          </button>
        </div>
      </div>

      {ask && (
        <EstimateModal
          p={p}
          count={redrawCount}
          title={`按新风格重画 ${redrawCount} 张表情`}
          confirmLabel="确认，开始重画"
          onConfirm={() => run({ type: "confirmCharacter", candidateId: sel ?? p.costConfirm?.candidateId })}
          onClose={() => setAsk(false)}
        />
      )}
      {askMulti && (
        <EstimateModal
          p={p}
          count={toPreview.length}
          title={`预览 ${toPreview.length} 种风格：${toPreview.map(styleName).join("、")}`}
          confirmLabel="确认，开始预览"
          onConfirm={() => { for (const id of toPreview) run({ type: "previewStyle", styleId: id, styleNote }); }}
          onClose={() => setAskMulti(false)}
        />
      )}
    </div>
  );
}
