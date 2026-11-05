import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { Sticker } from "../Sticker";
import { C, FONT } from "../theme";

export type ShowcaseProps = {
  dir: string;
  ext: "gif" | "png";
  title: string;
  tags: string[];
  dark?: boolean;
};

const TILE = 196;
const GAP = 22;

// 一套 16 张的展示墙：左侧标题，右侧 4×4 网格依次弹出
export const Showcase: React.FC<ShowcaseProps> = ({ dir, ext, title, tags, dark }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fg = dark ? "#ffffff" : C.ink;
  const enter = (d: number) =>
    interpolate(frame, [d, d + 0.45 * fps], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    });
  return (
    <AbsoluteFill style={{ background: dark ? C.dark : C.bg, fontFamily: FONT }}>
      <div style={{ position: "absolute", left: 100, top: 0, bottom: 0, width: 640, display: "flex", flexDirection: "column", justifyContent: "center", gap: 30 }}>
        <div style={{ fontSize: 34, fontWeight: 800, color: C.brand }}>DEMO · 16 张一套</div>
        <div style={{ fontSize: 84, fontWeight: 900, color: fg, lineHeight: 1.15, whiteSpace: "pre-line" }}>{title}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          {tags.map((t, i) => (
            <div
              key={t}
              style={{
                padding: "8px 20px",
                borderRadius: 14,
                border: `4px solid ${fg}`,
                background: i === 0 ? C.primary : "transparent",
                color: i === 0 ? C.ink : fg,
                fontSize: 32,
                fontWeight: 800,
                opacity: enter(6 + i * 4),
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          right: 110,
          top: (1080 - (TILE * 4 + GAP * 3)) / 2,
          display: "grid",
          gridTemplateColumns: `repeat(4, ${TILE}px)`,
          gap: GAP,
        }}
      >
        {Array.from({ length: 16 }, (_, i) => (
          <div key={i} style={{ width: TILE, height: TILE, scale: String(enter(8 + i * 2)) }}>
            <Sticker src={`${dir}/${String(i + 1).padStart(2, "0")}.${ext}`} size={TILE} />
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
