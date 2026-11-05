import { useEffect, useState } from "react";
import { act } from "./api";
import type { CostEntry, Estimate, Project } from "./types";

export const RATE_FALLBACK = 7.1;

export function fmtUsd(usd: number | undefined, rate = RATE_FALLBACK, withCny = true) {
  const v = usd ?? 0;
  const s = v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
  return withCny ? `${s}（≈¥${(v * rate).toFixed(v * rate < 1 ? 2 : 1)}）` : s;
}

const KIND: Record<CostEntry["kind"], string> = {
  analyze: "识别",
  plan: "策划",
  character: "风格设定图",
  sticker: "生成表情",
  edit: "局部修改",
  gif: "动图",
  failed: "失败/中断（只计 agent 文字）",
};

export function CostPill({ p, rate, onClick }: { p: Project; rate: number; onClick: () => void }) {
  const est = (p.costs ?? []).some((c) => c.estimated);
  return (
    <button className="pill cost-pill" onClick={onClick} title="按 OpenAI 官方标准价折算，点开看明细">
      已花费 {fmtUsd(p.costTotal, rate, false)}
      {est ? " 起" : ""}
    </button>
  );
}

export function CostModal({ p, rate, onClose }: { p: Project; rate: number; onClose: () => void }) {
  const costs = p.costs ?? [];
  const groups = new Map<string, { n: number; usd: number; est: boolean }>();
  for (const c of costs) {
    const g = groups.get(c.kind) ?? { n: 0, usd: 0, est: false };
    g.n++;
    g.usd += c.usd;
    g.est ||= c.estimated;
    groups.set(c.kind, g);
  }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>费用明细</h2>
        <div className="cost-total">
          {fmtUsd(p.costTotal, rate)}
        </div>
        <table className="cost-table">
          <thead>
            <tr><th>环节</th><th>次数</th><th>费用</th></tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([k, g]) => (
              <tr key={k}>
                <td>{KIND[k as CostEntry["kind"]] ?? k}</td>
                <td>{g.n}</td>
                <td>{fmtUsd(g.usd, rate, false)}{g.est ? " *" : ""}</td>
              </tr>
            ))}
            {!groups.size && <tr><td colSpan={3} className="muted">还没有产生费用</td></tr>}
          </tbody>
        </table>
        <p className="muted small">
          全部按 OpenAI 官方标准价折算：gpt-image-2.6（sunburst/flare）文字输入 $5、图片输入 $8、图片输出 $30 / 每百万 token；
          agent 文字按 {costs.find((c) => c.backend === "codex")?.model ?? "gpt-6.1-sol"} 的 token 价。
          带 * 的含估算：Codex 订阅不返回生图 token，按同等 API 请求折算（sunburst · medium）；API 通道按返回的 usage 实算。
          汇率 1 USD ≈ ¥{rate}。价格表在 server/pricing.json，可自行调整。
        </p>
        <details>
          <summary>最近 {Math.min(costs.length, 30)} 条记录</summary>
          <table className="cost-table">
            <tbody>
              {[...costs].reverse().slice(0, 30).map((c, i) => (
                <tr key={i}>
                  <td>{new Date(c.t).toLocaleTimeString("zh-CN")}</td>
                  <td>{c.label}</td>
                  <td>{c.backend === "api" ? "API" : "Codex"}</td>
                  <td>{fmtUsd(c.usd, rate, false)}{c.estimated ? " *" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
        <div className="row end">
          <button className="primary" onClick={onClose}>好</button>
        </div>
      </div>
    </div>
  );
}

// 批量生成前的费用确认
export function EstimateModal({
  p, count, title, confirmLabel, onConfirm, onClose, gif, gifCount = 0, children,
}: {
  p: Project; count: number; title: string; confirmLabel: string; onConfirm: () => void; onClose: () => void;
  gif?: { frames: number }; gifCount?: number; children?: React.ReactNode;
}) {
  const [e, setE] = useState<Estimate | null>(null);
  const [err, setErr] = useState("");
  const gifFrames = gif?.frames;
  useEffect(() => {
    act(p.id, { type: "estimate", count, gifCount, ...(gifFrames ? { gif: { frames: gifFrames } } : {}) }).then(
      (r) => setE(r as unknown as Estimate),
      (x) => setErr(x.message),
    );
  }, [p.id, count, gifFrames, gifCount]);
  const rate = e?.usdToCny ?? RATE_FALLBACK;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(ev) => ev.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        {err && <p className="error">{err}</p>}
        {!e && !err && <p className="muted"><span className="spinner sm" /> 估算中…</p>}
        {e && (
          <>
            <div className="cost-total">约 {fmtUsd(e.total, rate)}</div>
            <table className="cost-table">
              <tbody>
                <tr><td>数量</td><td>{e.count} 张{e.gif ? `（静图 ${e.count - e.gif.count} · 直出动图 ${e.gif.count}）` : ""}</td></tr>
                {e.gif ? (
                  <>
                    {e.count > e.gif.count && <tr><td>静图单张</td><td>{fmtUsd(e.perSticker, rate)}</td></tr>}
                    <tr><td>直出动图单张</td><td>{fmtUsd(e.gif.per, rate)}<br /><small className="muted">{e.gif.basis}</small></td></tr>
                  </>
                ) : (
                  <tr><td>单张</td><td>{fmtUsd(e.perSticker, rate)}</td></tr>
                )}
                {e.parts.agent > 0 && (
                  <tr><td className="muted">　其中出图</td><td className="muted">{fmtUsd(e.parts.image, rate, false)}；agent 文字 {fmtUsd(e.parts.agent, rate, false)}</td></tr>
                )}
                <tr><td>计价依据</td><td>{e.basis}</td></tr>
                <tr><td>本项目已花费</td><td>{fmtUsd(e.spent, rate)}</td></tr>
              </tbody>
            </table>
            <p className="muted small">
              按 OpenAI 官方标准价估算{e.calibrated ? "，已用历史真实用量校准" : "，还没有真实用量可校准，可能偏差较大"}。
              重画、局部修改、失败重试会另外计费。
            </p>
          </>
        )}
        <div className="row end">
          <button className="ghost" onClick={onClose}>再想想</button>
          <button className="primary" disabled={!e} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
