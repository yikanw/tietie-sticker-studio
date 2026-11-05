import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { Intro } from "./scenes/Intro";
import { Outro } from "./scenes/Outro";
import { Showcase } from "./scenes/Showcase";
import { Step, stepFrames, type StepProps } from "./scenes/Step";

export const FPS = 30;
const T = 12; // 每个转场的帧数

// 录屏（第一套「像素肥鱼娘」的完整制作过程）里挑出的关键节点，单位：录屏秒数
export const STEPS: StepProps[] = [
  { n: 1, title: "上传参考图，写一句想法", sub: "最多 4 张图，可拖拽或粘贴；不传图也能做", from: 56, to: 98, rate: 6 },
  { n: 2, title: "AI 识别主体和内容方向", sub: "角色外貌、语气、3 个内容方向，都可以改", from: 126, to: 144, rate: 3 },
  { n: 3, title: "风格设定：预览、对比、定调", sub: "补一句「更明显的像素点阵」再出一张，挑满意的", from: 268, to: 395, rate: 12 },
  { n: 4, title: "表情计划：改配字、勾动图", sub: "每条有画面描述和循环动作；配字改成梗原句", from: 418, to: 482, rate: 6 },
  { n: 5, title: "16 张直出动图并发生成", sub: "透明 GIF，边生成边质检，约 3 分钟出齐", from: 482, to: 650, rate: 16 },
  { n: 6, title: "单张不满意？改描述重画", sub: "「摸会儿鱼」去掉桌子背景，只重画这一张", from: 700, to: 800, rate: 10 },
  { n: 7, title: "一键通过，导出微信规格", sub: "240 / 512 成品 + 封面 + 图标，打成一个 zip", from: 816, to: 840, rate: 2 },
];

const INTRO = 3.2 * FPS;
const SHOW = 5 * FPS;
const OUTRO = 4 * FPS;

const SHOWCASES = [
  { dir: "set1", ext: "gif" as const, title: "像素肥鱼娘\nAI 梗动图", tags: ["直出 GIF", "像素风", "深色模式无白边"], dark: true },
  { dir: "set2", ext: "gif" as const, title: "布偶猫 × 柯基\n日常语录", tags: ["静图 → 动图", "真实萌宠头像", "糖果色底 + 字体跳动"] },
  { dir: "set3", ext: "png" as const, title: "国风粤语\n文字表情", tags: ["静态", "水墨书法", "对唔嗨住 · 食花生"] },
];

const sceneCount = 1 + STEPS.length + SHOWCASES.length + 1;
export const TOTAL_FRAMES =
  INTRO + STEPS.reduce((a, s) => a + stepFrames(s, FPS), 0) + SHOWCASES.length * SHOW + OUTRO - T * (sceneCount - 1);

export const DemoVideo: React.FC = () => (
  <TransitionSeries>
    <TransitionSeries.Sequence name="开场" durationInFrames={INTRO}>
      <Intro />
    </TransitionSeries.Sequence>
    {STEPS.map((s) => [
      <TransitionSeries.Transition key={`t${s.n}`} presentation={s.n === 1 ? slide({ direction: "from-right" }) : fade()} timing={linearTiming({ durationInFrames: T })} />,
      <TransitionSeries.Sequence key={`s${s.n}`} name={`步骤 ${s.n}`} durationInFrames={stepFrames(s, FPS)}>
        <Step {...s} />
      </TransitionSeries.Sequence>,
    ])}
    {SHOWCASES.map((c, i) => [
      <TransitionSeries.Transition key={`tc${i}`} presentation={slide({ direction: "from-bottom" })} timing={linearTiming({ durationInFrames: T })} />,
      <TransitionSeries.Sequence key={`c${i}`} name={`展示 ${i + 1}`} durationInFrames={SHOW}>
        <Showcase {...c} title={c.title} />
      </TransitionSeries.Sequence>,
    ])}
    <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
    <TransitionSeries.Sequence name="结尾" durationInFrames={OUTRO}>
      <Outro />
    </TransitionSeries.Sequence>
  </TransitionSeries>
);
