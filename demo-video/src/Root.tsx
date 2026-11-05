import { Composition } from "remotion";
import { DemoVideo, FPS, TOTAL_FRAMES } from "./DemoVideo";

export const RemotionRoot: React.FC = () => (
  <Composition id="TietieDemo" component={DemoVideo} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
);
