import { AnimatedImage, Img, staticFile } from "remotion";

// GIF 用 AnimatedImage（与时间轴同步），静图用 Img
export const Sticker: React.FC<{ src: string; size: number; style?: React.CSSProperties }> = ({ src, size, style }) =>
  src.endsWith(".gif") ? (
    <AnimatedImage src={staticFile(src)} width={size} height={size} fit="contain" style={style} />
  ) : (
    <Img src={staticFile(src)} style={{ width: size, height: size, objectFit: "contain", ...style }} />
  );
