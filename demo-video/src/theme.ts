// 与工作台一致的粗硬阴影（neo-brutalism）配色
export const C = {
  bg: "#fff4e0",
  ink: "#141210",
  brand: "#ff4f8b",
  primary: "#ffd23f",
  panel: "#ffffff",
  dark: "#1b1a19",
  muted: "#6b6258",
};

export const FONT = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

export const card = (shadow = 10): React.CSSProperties => ({
  background: C.panel,
  border: `4px solid ${C.ink}`,
  borderRadius: 22,
  boxShadow: `${shadow}px ${shadow}px 0 ${C.ink}`,
});
