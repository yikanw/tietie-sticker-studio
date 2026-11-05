import { useEffect, useState } from "react";
import { api, readAsDataUrl, useEnv } from "./api";
import type { ApiSpend, ArchivedSummary, CodexEnv, Env, ProjectSummary, Settings } from "./types";
import { fmtUsd, RATE_FALLBACK } from "./Cost";
import { ProjectView } from "./Project";

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHashRoute();
  const { env, reload, setEnv } = useEnv();
  const [showSettings, setShowSettings] = useState(false);
  const m = /^#\/p\/([\w-]+)/.exec(hash);
  // 全局推送：Codex 额度和 API 累计开销实时更新
  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("env", (e) => setEnv((cur) => (cur ? { ...cur, codex: JSON.parse((e as MessageEvent).data) } : cur)));
    es.addEventListener("spend", (e) => setEnv((cur) => (cur ? { ...cur, apiSpend: JSON.parse((e as MessageEvent).data) } : cur)));
    return () => es.close();
  }, [setEnv]);
  return (
    <>
      {m ? (
        <ProjectView id={m[1]} env={env} onSettings={() => setShowSettings(true)} />
      ) : (
        <Home env={env} onSettings={() => setShowSettings(true)} reloadEnv={reload} />
      )}
      {showSettings && env && (
        <SettingsModal
          env={env}
          onClose={() => setShowSettings(false)}
          onSaved={(settings) => setEnv({ ...env, settings })}
          onSpendReset={(apiSpend) => setEnv({ ...env, apiSpend })}
        />
      )}
    </>
  );
}

// ---------- API 累计开销 ----------
export function SpendPill({ spend, rate, onClick }: { spend?: ApiSpend; rate: number; onClick: () => void }) {
  if (!spend) return null;
  return (
    <button
      className="pill cost-pill"
      onClick={onClick}
      title={`自 ${new Date(spend.since).toLocaleString("zh-CN")} 起，API 通道共 ${spend.count} 次调用，按官方价计算。可在设置里清零`}
    >
      API 累计 {fmtUsd(spend.usd, rate, false)}
    </button>
  );
}

// ---------- 额度 ----------
export function Quota({ codex }: { codex: CodexEnv | null | undefined }) {
  const rl = codex?.rateLimits;
  if (!codex) return null;
  if (!codex.ok) return <span className={`pill ${codex.error ? "danger" : ""}`} title={codex.error ?? ""}>{codex.error ? "Codex 未连接" : "Codex 启动中"}</span>;
  // 显示剩余可用的比例
  const bar = (label: string, w?: { usedPercent: number; resetsAt: number }) => {
    if (!w) return null;
    const left = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
    return (
      <span className="quota" title={`Codex ${label}额度剩余 ${left}%（已用 ${w.usedPercent}%），${new Date(w.resetsAt * 1000).toLocaleString("zh-CN")} 重置`}>
        <span className="quota-label">{label}剩</span>
        <span className="quota-bar">
          <span style={{ width: `${left}%` }} className={left < 15 ? "hot" : left < 35 ? "warm" : ""} />
        </span>
        <span className="quota-num">{left}%</span>
      </span>
    );
  };
  return (
    <span className="quota-wrap">
      {bar("5小时", rl?.primary)}
      {bar("本周", rl?.secondary)}
    </span>
  );
}

// ---------- 首页 ----------
const MAX_IMAGES = 4;
function Home({ env, onSettings, reloadEnv }: { env: Env | null; onSettings: () => void; reloadEnv: () => void }) {
  const [list, setList] = useState<ProjectSummary[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(16);
  const [styleId, setStyleId] = useState("auto");
  const [autoRun, setAutoRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);

  const [archived, setArchived] = useState<ArchivedSummary[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const refresh = () => {
    api.get<ProjectSummary[]>("/api/projects").then(setList).catch(() => {});
    api.get<ArchivedSummary[]>("/api/archive").then(setArchived).catch(() => {});
  };
  useEffect(refresh, []);
  const openDir = (target: string, id?: string) => api.post("/api/open", { target, id }).catch((e) => alert(e.message));
  const archive = async (p: ProjectSummary) => {
    if (!confirm(`归档「${p.name}」？\n项目会从列表移除，整个目录移到归档文件夹，随时可以恢复。进行中的任务会被中断。`)) return;
    try { await api.post(`/api/projects/${p.id}/archive`); refresh(); } catch (e) { alert((e as Error).message); }
  };
  const restore = async (a: ArchivedSummary) => {
    try { await api.post(`/api/archive/${encodeURIComponent(a.folder)}/restore`); refresh(); } catch (e) { alert((e as Error).message); }
  };

  const pick = async (files?: FileList | File[] | null) => {
    const list = [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const urls = await Promise.all(list.map(readAsDataUrl));
    setImages((cur) => [...cur, ...urls].slice(0, MAX_IMAGES));
  };

  // 在首页任意位置粘贴图片（⌘V / Ctrl+V）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.items ?? [])]
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => !!f);
      if (!files.length) return;
      // 只有图片时阻止默认粘贴，免得把文件名粘进输入框；同时带文字的保留文字
      if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
      pick(files);
    };
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  }, []);

  const canStart = images.length > 0 || prompt.trim().length > 0;
  const start = async () => {
    if (!canStart) return setErr("上传图片，或者写一句想法");
    setBusy(true);
    setErr("");
    try {
      const p = await api.post<{ id: string }>("/api/projects", { imageDataUrls: images, prompt, count, styleId, autoRun });
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const backend = env?.settings.imageBackend === "api" ? `API · ${env.settings.api.model}` : `Codex 订阅 · ${env?.codex.model ?? "…"}`;

  return (
    <div className="page">
      <header className="topbar">
        <a href="#/" className="home-link brand" title="贴贴机 TIETIE">
          <span className="logo">贴</span>
          <span className="wordmark">贴贴机<small>TIETIE</small></span>
        </a>
        <div className="grow" />
        <Quota codex={env?.codex} />
        <SpendPill spend={env?.apiSpend} rate={env?.pricing?.usdToCny ?? RATE_FALLBACK} onClick={onSettings} />
        <button className="ghost" onClick={onSettings}>
          ⚙ 设置
        </button>
      </header>

      {env && !env.codex.ok && !env.codex.error && <div className="banner">Codex 启动中…</div>}
      {env && !env.codex.ok && env.codex.error && (
        <div className="banner danger">
          Codex 没有连上：{env.codex.error}
          <button
            className="small"
            onClick={() => api.post("/api/env/reconnect").then(reloadEnv, (e) => alert(e.message))}
          >
            重新连接
          </button>
        </div>
      )}

      <main className="home">
        <section className="card new-project">
          <h2>新建一套表情包</h2>
          <div
            className={`drop ${drag ? "drag" : ""} ${images.length ? "has" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files); }}
          >
            {images.length ? (
              <div className="thumbs">
                {images.map((u, i) => (
                  <div key={i} className="thumb-in checker">
                    <img src={u} alt="" />
                    <span className="tag">图{i + 1}</span>
                    <button className="x" title="移除" onClick={() => setImages(images.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                {images.length < MAX_IMAGES && (
                  <label className="thumb-in add">
                    <input type="file" accept="image/*" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
                    + 再加一张
                  </label>
                )}
              </div>
            ) : (
              <label className="drop-empty">
                <input type="file" accept="image/*" multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
                <span>
                  把图片拖到这里、点击上传，或直接粘贴（{navigator.platform.includes("Mac") ? "⌘" : "Ctrl+"}V），最多 {MAX_IMAGES} 张
                  <br />
                  <small>人物、宠物、手绘角色都可以；也可以加一张风格参考图。<b>不传图也行</b>，在下面描述你想要的形象，AI 来原创设计</small>
                </span>
              </label>
            )}
          </div>
          {images.length > 1 && (
            <p className="hint">
              建议在下面写清每张图的用途，例如：<button className="link" onClick={() => setPrompt((t) => `图1 是我的小猫，按图2 的风格做一套表情包${t ? "。" + t : ""}`)}>「图1 是我的小猫，按图2 的风格做一套表情包」</button>。没写清楚的交给 AI 判断。
            </p>
          )}
          <textarea
            rows={3}
            placeholder={images.length > 1
              ? "例如：图1 是我的小猫，图2 是它的好朋友，按图3 的风格做一套情侣表情包"
              : images.length
                ? "想要什么样的表情包？例如：打工人日常、和对象斗嘴、给爸妈发的问候；想要热梗可以直接点名（如「喝大水」「是你」）。不写也行，交给 AI 判断"
                : "不传图时写清楚想要的形象和用途，例如：一只戴蓝围巾的胖橘猫，打工人日常；或者：纯文字表情，工作群里回复收到、稍等"}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="row">
            <label className="field">
              <span>数量</span>
              <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[4, 8, 16, 24].map((n) => <option key={n} value={n}>{n} 张{n === 4 ? "（试做）" : n === 24 ? "（微信整套常见）" : ""}</option>)}
              </select>
            </label>
            <label className="field grow">
              <span>风格</span>
              <select value={styleId} onChange={(e) => setStyleId(e.target.value)}>
                <option value="auto">让 AI 根据图片推荐（风格设定里还能换、能对比预览）</option>
                {[...new Set(env?.styles.map((s) => s.group))].map((g) => (
                  <optgroup key={g} label={g}>
                    {env?.styles.filter((s) => s.group === g).map((s) => (
                      <option key={s.id} value={s.id}>{s.name}{s.trend ? " · 近期流行" : ""}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          </div>
          <div className="seg">
            <button className={!autoRun ? "on" : ""} onClick={() => setAutoRun(false)}>每一步确认</button>
            <button className={autoRun ? "on" : ""} onClick={() => setAutoRun(true)}>全自动跑完</button>
          </div>
          <p className="hint">
            {autoRun ? "识别、定风格、出计划、生成会一路跑完，你随时可以暂停和修改。" : "识别、风格设定、表情计划三个环节会停下来等你确认。"}
            <br />
            出图通道：{backend}
          </p>
          {err && <p className="error">{err}</p>}
          {!images.length && prompt.trim() && <p className="hint">没有上传图片：将按你的描述原创设计形象（或做纯文字包）。</p>}
          <button className="primary big" disabled={busy || !canStart} onClick={start}>
            {busy ? "上传中…" : "开始"}
          </button>
        </section>

        <section className="projects">
          <div className="row projects-head">
            <h3 className="grow">{showArchived ? `已归档（${archived.length}）` : "最近的项目"}</h3>
            <button className="ghost small" title={showArchived ? env?.paths.archive : env?.paths.runs} onClick={() => openDir(showArchived ? "archive" : "runs")}>
              📁 打开{showArchived ? "归档" : "项目"}文件夹
            </button>
            <button className="small" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? "← 返回项目" : `🗄 已归档 ${archived.length}`}
            </button>
          </div>
          <p className="hint path-hint">
            {showArchived
              ? <>归档的项目整个目录放在 <code>{env?.paths.archive}</code>，恢复后回到项目列表。</>
              : <>每个项目是 <code>{env?.paths.runs}</code> 下的一个文件夹（project.json + 所有图片和导出包）。</>}
          </p>
          {!showArchived && !list.length && <p className="muted">还没有项目</p>}
          {showArchived && !archived.length && <p className="muted">还没有归档的项目</p>}
          <div className="project-grid">
            {!showArchived && list.map((p) => (
              <div key={p.id} className="project-card">
                <a href={`#/p/${p.id}`}>
                  <div className="thumb checker">{p.cover ? <img src={p.cover} alt="" /> : <span className="muted">无图</span>}</div>
                  <div className="meta">
                    <b>{p.name}</b>
                    <small>{new Date(p.createdAt).toLocaleString("zh-CN")}</small>
                    <small>{p.total ? `${p.done}/${p.total} 张` : stageName(p.stage)}{p.cost ? ` · $${p.cost.toFixed(2)}` : ""}</small>
                  </div>
                </a>
                <div className="card-actions">
                  <button className="ghost small" title={p.path} onClick={() => openDir("project", p.id)}>📁 目录</button>
                  <button className="ghost small" onClick={() => archive(p)}>归档</button>
                </div>
              </div>
            ))}
            {showArchived && archived.map((a) => (
              <div key={a.folder} className="project-card archived">
                <div className="thumb checker">{a.cover ? <img src={a.cover} alt="" /> : <span className="muted">无图</span>}</div>
                <div className="meta">
                  <b>{a.name}</b>
                  <small>归档于 {a.archivedAt ? new Date(a.archivedAt).toLocaleString("zh-CN") : "—"}</small>
                  <small>{a.total ? `${a.total} 张` : "未生成"}{a.cost ? ` · $${a.cost.toFixed(2)}` : ""}</small>
                </div>
                <div className="card-actions">
                  <button className="ghost small" title={a.path} onClick={() => openDir("archive")}>📁 文件夹</button>
                  <button className="small primary" onClick={() => restore(a)}>恢复</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

export const stageName = (s: string) =>
  ({ analyze: "识别中", character: "风格设定", plan: "表情计划", generate: "生成" })[s] ?? s;

// ---------- 设置 ----------
function SettingsModal({ env, onClose, onSaved, onSpendReset }: { env: Env; onClose: () => void; onSaved: (s: Settings) => void; onSpendReset: (s: ApiSpend) => void }) {
  const rate = env.pricing?.usdToCny ?? RATE_FALLBACK;
  const resetSpend = async () => {
    if (!confirm("把 API 累计开销清零？只清这个计数，各项目自己的费用明细不受影响。")) return;
    try {
      onSpendReset(await api.post<ApiSpend>("/api/spend/reset"));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const [s, setS] = useState<Settings>(env.settings);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const save = async () => {
    try {
      const r = await api.put<Settings>("/api/settings", {
        imageBackend: s.imageBackend,
        concurrency: s.concurrency,
        codex: { model: s.codex.model },
        text: { apiModel: s.text.apiModel, effort: s.text.effort },
        api: { baseUrl: s.api.baseUrl, proxy: s.api.proxy, model: s.api.model, quality: s.api.quality, size: s.api.size, ...(key ? { apiKey: key } : {}) },
      });
      onSaved(r);
      onClose();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const setApi = (patch: Partial<Settings["api"]>) => setS({ ...s, api: { ...s.api, ...patch } });
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>
        <div className="field">
          <span>出图通道</span>
          <div className="seg">
            <button className={s.imageBackend === "codex" ? "on" : ""} onClick={() => set({ imageBackend: "codex" })}>Codex 订阅</button>
            <button className={s.imageBackend === "api" ? "on" : ""} onClick={() => set({ imageBackend: "api" })}>OpenAI API</button>
          </div>
          <small className="muted">识别、策划这类文字步骤也走同一个通道。</small>
        </div>

        <div className="row">
          <label className="field grow">
            <span>文字模型（识别 / 策划）</span>
            {s.imageBackend === "api" ? (
              <input list="text-models" value={s.text.apiModel} onChange={(e) => set({ text: { ...s.text, apiModel: e.target.value } })} />
            ) : (
              <input value={`Codex 模型：${env.codex.model ?? "—"}（在下方切换）`} disabled />
            )}
            <datalist id="text-models">
              <option value="gpt-6.1-terra" />
              <option value="gpt-6.1-sol" />
              <option value="gpt-6-luna" />
            </datalist>
          </label>
          <label className="field">
            <span>思考强度</span>
            <select value={s.text.effort} onChange={(e) => set({ text: { ...s.text, effort: e.target.value } })}>
              <option value="low">low</option>
              <option value="medium">medium（推荐）</option>
              <option value="high">high</option>
            </select>
          </label>
        </div>

        <fieldset>
          <legend>Codex（{env.codex.version ?? "未连接"}）</legend>
          <label className="field">
            <span>模型</span>
            <select value={s.codex.model} onChange={(e) => set({ codex: { model: e.target.value } })}>
              <option value="">自动（优先 gpt-6.1-terra）</option>
              {env.codex.models.map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
        </fieldset>

        <fieldset disabled={s.imageBackend !== "api"} className={s.imageBackend !== "api" ? "dim" : ""}>
          <legend>OpenAI API</legend>
          <label className="field">
            <span>Base URL</span>
            <input value={s.api.baseUrl} onChange={(e) => setApi({ baseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>代理</span>
            <input
              value={s.api.proxy}
              onChange={(e) => setApi({ proxy: e.target.value })}
              placeholder={`留空自动检测${s.api.effectiveProxy ? `（当前 ${s.api.effectiveProxy}）` : "（未检测到）"}；填 direct 表示直连`}
            />
          </label>
          <label className="field">
            <span>API Key</span>
            <input
              type="password"
              placeholder={s.api.hasKey ? `已保存 ${s.api.keyHint}${s.api.keyFromEnv ? "（来自环境变量）" : ""}，留空不修改` : "sk-…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
          </label>
          <div className="row">
            <label className="field grow">
              <span>模型</span>
              <input list="img-models" value={s.api.model} onChange={(e) => setApi({ model: e.target.value })} />
              <datalist id="img-models">
                <option value="gpt-image-2.6-sunburst" />
                <option value="gpt-image-2.6-flare" />
              </datalist>
            </label>
            <label className="field">
              <span>质量</span>
              <select value={s.api.quality} onChange={(e) => setApi({ quality: e.target.value })}>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
            <label className="field">
              <span>尺寸</span>
              <select value={s.api.size} onChange={(e) => setApi({ size: e.target.value })}>
                {["1024x1024", "1024x1536", "1536x1024", "auto"].map((x) => <option key={x}>{x}</option>)}
              </select>
            </label>
          </div>
          <small className="muted">Key 只保存在本机 data/settings.json。</small>
        </fieldset>

        <div className="row spend-row">
          <div className="grow">
            <span className="muted">API 累计开销</span>
            <div><b>{fmtUsd(env.apiSpend?.usd, rate)}</b></div>
            <small className="muted">
              自 {env.apiSpend ? new Date(env.apiSpend.since).toLocaleString("zh-CN") : "—"} 起 · {env.apiSpend?.count ?? 0} 次调用 · 按官方价计算
            </small>
          </div>
          <button className="ghost danger small" type="button" onClick={resetSpend}>清零</button>
        </div>


        <label className="field">
          <span>同时生成几张</span>
          <select value={s.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })}>
            {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {msg && <p className="error">{msg}</p>}
        <div className="row end">
          <button className="ghost" onClick={onClose}>取消</button>
          <button className="primary" onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}
