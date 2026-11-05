import { Video } from "@remotion/media";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, card } from "../theme";

// 录屏里的一段：from/to 是录屏的秒数，rate 是加速倍数
export type StepProps = { n: number; title: string; sub: string; from: number; to: number; rate: number };

export const stepFrames = (s: Pick<StepProps, "from" | "to" | "rate">, fps: number) => Math.round(((s.to - s.from) / s.rate) * fps);

const SCREEN_W = 1360;
const SCREEN_H = Math.round((SCREEN_W * 900) / 1440);

export const Step: React.FC<StepProps> = ({ n, title, sub, from, to, rate }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = interpolate(frame, [0, 0.5 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      {/* 左侧：步骤说明 */}
      <div style={{ position: "absolute", left: 80, top: 0, bottom: 0, width: 380, display: "flex", flexDirection: "column", justifyContent: "center", gap: 26 }}>
        <div
          style={{
            width: 104,
            height: 104,
            borderRadius: 999,
            background: C.primary,
            border: `5px solid ${C.ink}`,
            boxShadow: `6px 6px 0 ${C.ink}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 58,
            fontWeight: 900,
            color: C.ink,
            scale: String(enter),
          }}
        >
          {n}
        </div>
        <div style={{ fontSize: 60, fontWeight: 900, color: C.ink, lineHeight: 1.18, opacity: enter }}>{title}</div>
        <div style={{ fontSize: 34, fontWeight: 500, color: C.muted, lineHeight: 1.5, opacity: enter }}>{sub}</div>
        <div
          style={{
            alignSelf: "flex-start",
            padding: "6px 18px",
            borderRadius: 12,
            background: C.ink,
            color: C.primary,
            fontSize: 28,
            fontWeight: 800,
            opacity: enter,
          }}
        >
          {rate > 1 ? `▶▶ ${rate}× 加速` : "▶ 原速"}
        </div>
      </div>
      {/* 右侧：录屏 */}
      <div
        style={{
          position: "absolute",
          right: 60,
          top: (1080 - SCREEN_H - 44) / 2,
          width: SCREEN_W,
          height: SCREEN_H + 44,
          ...card(14),
          overflow: "hidden",
          translate: `${interpolate(enter, [0, 1], [80, 0])}px 0px`,
          opacity: enter,
        }}
      >
        <div style={{ height: 44, borderBottom: `4px solid ${C.ink}`, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", background: C.bg }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 16, height: 16, borderRadius: 99, background: c, border: `2px solid ${C.ink}` }} />
          ))}
          <div style={{ marginLeft: 14, fontSize: 20, color: C.muted, fontWeight: 600 }}>localhost:5177</div>
        </div>
        <Video
          src={staticFile("walkthrough.mp4")}
          trimBefore={Math.round(from * fps)}
          durationInFrames={Math.round((to - from) * fps)}
          playbackRate={rate}
          muted
          style={{ width: SCREEN_W - 8, height: SCREEN_H }}
        />
      </div>
    </AbsoluteFill>
  );
};
