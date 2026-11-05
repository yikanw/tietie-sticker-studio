# 贴贴机演示视频（Remotion）

把第一套 Demo 的制作录屏剪成 7 个关键步骤，再接三套表情的展示墙，输出 1920×1080 / 30fps，约 85 秒。

```bash
cd demo-video
npm i
npm run dev                                   # Remotion Studio 预览
npx remotion render TietieDemo out/tietie-demo.mp4
```

## 素材（`public/`，不入库）

| 路径 | 内容 |
|---|---|
| `public/walkthrough.mp4` | 第一套的完整录屏（1440×900，headless Chrome 录制） |
| `public/set1/01.gif…16.gif` | 第一套：像素肥鱼娘 · AI 梗（直出动图，512） |
| `public/set2/01.gif…16.gif` | 第二套：布偶猫 × 柯基 · 日常语录（静图 → 动图） |
| `public/set3/01.png…16.png` | 第三套：国风粤语文字（静态） |

每个目录里的 `manifest.json` 记录对应的配字和情绪。

## 改剪辑

`src/DemoVideo.tsx` 里的 `STEPS`：每一步是录屏的 `from`–`to`（秒）和加速倍数 `rate`，改数字即可重新剪。
