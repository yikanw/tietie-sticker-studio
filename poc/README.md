# 最小验证：用 Codex 订阅生图（app-server）

脚本：`codex-imagegen-poc.mjs`（零依赖，Node 18+，需已 `codex login` 用 ChatGPT 账号）

```bash
# 纯文字出图
node poc/codex-imagegen-poc.mjs --prompt "生成一张图片：..." --out poc/out/step1
# 带参考图
node poc/codex-imagegen-poc.mjs --image poc/out/step1/xxx.png --prompt "以附图角色为参考..." --out poc/out/step2
# 测试中断
node poc/codex-imagegen-poc.mjs --image ... --prompt ... --interrupt-after 22
# 指定模型
node poc/codex-imagegen-poc.mjs --model gpt-5.6-terra --prompt ...
```

## 结果（2026-11-05，codex-cli 0.151.0）

| 项 | 结果 |
|---|---|
| 订阅生图 | ✅ `modelProvider/capabilities/read` → `imageGeneration: true`；`item/completed` 收到 `imageGeneration`，带 `savedPath` |
| 文字出图 | ✅ 共 47s（其中 agent 准备约 14s，生图约 28s） |
| 参考图出图（`localImage`） | ✅ 共 66s（生图约 40s），角色外形/配色/围巾一致性很好 |
| 透明背景 | ✅ prompt 要求透明 → `transparentBackground: true`，PNG 带 alpha |
| 输出尺寸 | 1219×1290 PNG |
| 中断（`turn/interrupt`） | ✅ 即时返回，turn 状态 `interrupted`，不产出图片 |
| 审批请求 | 未触发（read-only 沙箱 + approvalPolicy=never） |
| 额度 | 一张图 5 小时窗口约 +1%（仅一个数据点）；通过 `account/rateLimits/updated` 可实时拿到 |

## 坑

- **可用模型跟 codex 客户端版本挂钩。** 全局 CLI 是 0.151.0，`model/list` 只返回 `gpt-5.6-*`；
  桌面端（ChatGPT.app）自带 0.166.0-alpha.6，能看到 `gpt-6.1-sol` 等。两者共用 `~/.codex/config.toml`，
  桌面端把默认模型写成了 `gpt-6.1-sol`，旧 CLI 用它就报 `model_not_found`（错误文案误导，实际是版本太旧）。
  修复：`npm i -g @openai/codex@latest`，或用 `--codex` / `CODEX_BIN` 指向桌面端自带的二进制。
  工作台启动时应检查 codex 版本，并始终以 `model/list` 的结果选模型。
- 用桌面端二进制 + `gpt-6.1-sol` 复测参考图出图：✅ 总共 82s（生图约 63s）。
- 底层用的是哪个图像模型（是否 2.6）协议里不暴露。
- 每张图都是一次完整 agent 轮次，约 15–20s 是 agent 开销；24 张串行约 25 分钟，需要测并发。

## 第二轮：并发 / 单轮多图 / GIF（CLI 升级到 0.166.0，模型 gpt-6.1-sol）

脚本：`bench.mjs`（基于 `lib/codex-client.mjs`），日志和 report 在 `poc/out/<mode>/`，总览图 `poc/out/contact.png`。

| 测试 | 结果 |
|---|---|
| 4 路并发（1 个 app-server，4 个 thread） | ✅ 全部成功，70–82s 内全部完成 ≈ 单张耗时，吞吐约 4 倍，未触发限流 |
| 单 prompt 要 4 张 | ✅ 出 4 张，但**串行**：263s；**出图顺序与列表不一致**（开心/震惊/生气/困） |
| 要求 GIF | ❌ 工具只返回静态 PNG，agent 自己也说明"只返回了静态 PNG" |
| 角色一致性 | 10 张全部一致（含 `inputImages` 为空的几张） |
| 额度 | 当天约 10 张图，周额度 72% → 78%；5 小时窗口波动较大（可能混有其他 Codex 使用） |

结论：
- **工作台用"一张表情 = 一个 thread 的一个 turn"，并发跑**；不要一轮要多张（慢且顺序不可靠）。
- `imageGeneration` 条目新版多了 `inputImages`、`generationId`、`startedAtMs/completedAtMs`。
  `inputImages` 是否带参考图由 agent 决定、并不稳定（并发 4 张里有 2 张为空），工作台应记录并作为质检项。
- 订阅生图拿不到 GIF：要么底层不是 2.6，要么内置工具没暴露 GIF 参数——**无法据此断定模型版本**。
  动图走"多帧静态图 + 代码合成 GIF"，或另接 API（`gpt-image-2.6-*` generations 接口）。

## 第三轮：GIF（codex-cli 0.168.0-alpha.3）

- 新版内置工具 `image_gen.imagegen` 参数：`prompt`、`gif {frame_count 2–16, frame_duration_ms 20–2000}`（`{}` 为默认 9 帧/200ms）、
  `transparent_background`、`referenced_image_paths`、`num_last_images_to_include`。
  工具说明写明 GIF 同时支持生成和编辑；改已有 GIF 要先拆成等大网格 spritesheet 作为参考图传入。
- 功能开关 `image_generation_animation`（under development），本机 `config.toml` 已设为 true，agent 也确实带上了 gif 参数。
- 结果：带参考图、不带参考图都在 1–3s 内失败，工具返回"此请求未启用 GIF 输出"（二进制里对应 `GIF output is unavailable in this session.`）。
  **判断：客户端已就绪，服务端尚未对本账号开放。** 等灰度放开后，用 `node poc/bench.mjs gif [--image ref.png] --frames 8 --ms 120` 复测即可。
- 工作台里要把"GIF 是否可用"作为启动探测项，不可用时回退为"多帧静态图 + 代码合成 GIF"。
- 复核（15:13 Codex Desktop 会话里的 `output/bouncing-yellow-duck.gif`）：imagegen 调用参数只有 `prompt` + `transparent_background`，
  **没有 `gif`**；先出一张透明 PNG 小黄鸭，再用 Python/PIL 脚本做 24 帧弹跳合成。即原生 GIF 仍未开放，
  但"单张透明图 + 代码动效"是零额度、立即可用的动图方案。同时间点 app-server 复测 gif 参数仍报"此请求未启用 GIF 输出"。

## 第四轮：API 原生 GIF（gpt-image-2.6-sunburst · medium，2026-11-05）

脚本：`api-gif.mjs`（复用工作台的 Key/代理设置），产物在 `poc/out/api-gif/`。

请求：`output_format: "gif"` + `frame_count` + `frame_duration_ms` + `size`（每帧尺寸，16 的倍数）。

| 测试 | 结果 |
|---|---|
| generations，8 帧 × 1024² | ❌ 400：所有帧拼在一张精灵表上，表的长边 ≤ 3840（8×1024 → 4096×2048 超限） |
| generations，8 帧 × 512²，120ms | ✅ 23.6s，405KB，GIF89a，无限循环；usage 文字 150 + 输出 974 → **$0.030** |
| edits + 角色设定图，8 帧 × 512² | ✅ 29.3s，440KB；角色与设定图高度一致；usage 文字 120 + 图片 1536 + 输出 974 → **$0.042** |

- 官方指南说 edits 不支持 GIF，但实测支持（API 参考里 edits 也列了 gif），**带参考图做动图可行**
- 动作是真正的逐帧动画（挥手、眨眼、弹跳、首尾衔接），不是整体位移
- 背景为白色（GIF 无 alpha 透明；文档要求透明背景只用 png/webp），如需透明需逐帧去背景
- 尺寸限制：帧数 × 帧尺寸要放进 ≤3840 长边的精灵表；512² 下 8 帧可行，16 帧需更小尺寸
- 输出 token 与帧数关系待测（8 帧 512² 为 974，和单张 1024² 的 1449 不同）

## 还没验证

- `turn/steer` 中途改方向
- 触发 `usageLimitExceeded` 后的行为、更高并发（8 路以上）
- 局部修改（圈选区域）能否通过订阅工具实现
