import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Sticker } from "../Sticker";
import { C, FONT, card } from "../theme";

const FLOAT = ["set1/02.gif", "set2/01.gif", "set3/07.png", "set1/12.gif", "set2/10.gif", "set3/12.png"];

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = (delay: number) =>
    interpolate(frame, [delay, delay + 0.6 * fps], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    });
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT, alignItems: "center", justifyContent: "center" }}>
      {FLOAT.map((f, i) => {
        const left = i % 2 === 0;
        const x = left ? 110 + (i % 3) * 60 : 1520 - (i % 3) * 60;
        const y = 80 + Math.floor(i / 2) * 250;
        return (
          <div
            key={f}
            style={{
              position: "absolute",
              left: x,
              top: y + Math.sin((frame + i * 17) / 18) * 10,
              width: 230,
              height: 230,
              ...card(8),
              overflow: "hidden",
              rotate: `${(i % 2 ? 1 : -1) * (5 + i)}deg`,
              scale: String(pop(6 + i * 4)),
            }}
          >
            <Sticker src={f} size={222} />
          </div>
        );
      })}
      <div style={{ display: "flex", alignItems: "center", gap: 36, scale: String(pop(0)) }}>
        <Img
          src={staticFile("icon.png")}
          style={{ width: 230, height: 230, objectFit: "contain", rotate: `${Math.sin(frame / 14) * 4}deg` }}
        />
        <div>
          <div style={{ fontSize: 150, fontWeight: 900, color: C.ink, lineHeight: 1 }}>贴贴机</div>
          <div
            style={{
              display: "inline-block",
              marginTop: 18,
              padding: "6px 22px",
              background: C.primary,
              border: `5px solid ${C.ink}`,
              borderRadius: 14,
              fontSize: 52,
              fontWeight: 900,
              letterSpacing: 10,
              color: C.ink,
            }}
          >
            TIETIE
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 150,
          fontSize: 54,
          fontWeight: 700,
          color: C.ink,
          opacity: pop(0.8 * fps),
          translate: `0px ${interpolate(pop(0.8 * fps), [0, 1], [30, 0])}px`,
        }}
      >
        一张图 + 一句话，做出一整套微信表情包
      </div>
    </AbsoluteFill>
  );
};
