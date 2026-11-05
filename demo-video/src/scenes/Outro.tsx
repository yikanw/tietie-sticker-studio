import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "../theme";

const POINTS = ["本机运行，项目数据只在你电脑上", "Codex 订阅出图，或接入自定义 API", "直出透明 GIF，深色模式也干净", "一键导出微信表情规格"];

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const on = (d: number) =>
    interpolate(frame, [d, d + 0.4 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) });
  return (
    <AbsoluteFill style={{ background: C.primary, fontFamily: FONT, alignItems: "center", justifyContent: "center", gap: 40 }}>
      <div style={{ fontSize: 120, fontWeight: 900, color: C.ink, opacity: on(0) }}>贴贴机 TIETIE</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "22px 40px" }}>
        {POINTS.map((t, i) => (
          <div
            key={t}
            style={{
              padding: "18px 30px",
              background: "#fff",
              border: `5px solid ${C.ink}`,
              borderRadius: 18,
              boxShadow: `8px 8px 0 ${C.ink}`,
              fontSize: 40,
              fontWeight: 800,
              color: C.ink,
              opacity: on(8 + i * 5),
              translate: `0px ${interpolate(on(8 + i * 5), [0, 1], [24, 0])}px`,
            }}
          >
            {t}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
