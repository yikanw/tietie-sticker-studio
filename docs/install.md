# 安装与配置

> 最省事的办法：把仓库链接发给 Codex / Claude Code 之类的编程 Agent，说「帮我安装并启动」。仓库里的 [AGENTS.md](../AGENTS.md) 写好了步骤，Agent 会照着做。下面是手动安装和各项配置的细节。

## 环境要求

- macOS 或 Linux
- Node.js ≥ 20
- 用 Codex 订阅出图 / 出字时：Codex CLI ≥ 0.166，并已用 ChatGPT 账号登录
- 只用 API 时可以不装 Codex，但需要一个兼容 OpenAI 的 API Key

## 手动安装

```bash
git clone https://github.com/yikanw/tietie-sticker-studio.git
cd tietie-sticker-studio

npm i -g @openai/codex@latest   # 版本太旧会看不到新模型（报 model_not_found）
codex login                      # 选 ChatGPT 账号登录

npm install
npm start                        # 构建前端并启动
```

打开 <http://localhost:5177>。端口被占用时：`PORT=5178 npm start`。

开发模式（前端热更新）：`npm run dev`。改代码后可以用 `npm run typecheck` 和 `npm run build` 自检。

## 生图和生文的通道

设置里「生图」和「生文（识别 / 策划）」分开配置，各自选通道：

| | Codex 订阅（默认） | API |
|---|---|---|
| 生图 | 本机 `codex app-server`，走 ChatGPT 订阅额度 | Base URL + Key + 模型，需兼容 OpenAI Images API（默认 `gpt-image-2.6-sunburst`） |
| 生文 | 同上，模型默认 `gpt-6.1-terra` | Base URL + Key + 模型 + 接口格式：`Responses`（OpenAI）或 `Chat Completions`（多数第三方 / 本地模型服务，模型要能看图） |

- **动图只走 API**：Codex 订阅的原生 GIF 还没开放，做动图需要在「生图」里填好 API Key（生图通道本身可以仍是 Codex）
- 生文的 Key 留空时：Base URL 和生图相同就沿用生图的 Key；环境变量 `OPENAI_API_KEY` 只用于官方地址，不会发给第三方
- Chat Completions 先按 JSON Schema 结构化输出请求，服务不支持时自动退回 JSON 模式
- 本机 / 局域网地址（如 `http://localhost:11434/v1`）自动直连，可以不填 Key
- 思考强度（默认 medium）只对 Codex 和 Responses 生效
- 「同时生成」控制并发张数（1–8），Codex 每张约 40–80 秒，靠并发提速
- Key 只保存在本机 `data/settings.json`，已加入 `.gitignore`

## 网络代理

API 请求按这个顺序找代理：设置里填的代理 → `HTTPS_PROXY` 等环境变量 → macOS 系统代理。设置里填 `direct` 表示直连；本机 / 局域网地址总是直连。

## 数据目录

- 默认在仓库下的 `data/`，可用环境变量 `STICKER_DATA_DIR` 改到别处
- 配字字体默认用系统黑体；放 `.ttf/.otf` 到 `fonts/` 目录会优先使用
- 服务只监听 `127.0.0.1`

## 费用

全部按 **OpenAI 官方标准价**折算，价格表在 `server/pricing.json`，可以改：

| 项 | 价格（每百万 token） |
|---|---|
| gpt-image-2.6-sunburst / flare | 文字输入 $5、图片输入 $8、图片输出 $30 |
| 文字 gpt-6.1-terra | 输入 $1、缓存 $0.05、输出 $5 |
| 文字 gpt-6.1-sol | 输入 $2、缓存 $0.1、输出 $10 |

- **API**：出图和识别 / 策划都按响应里的 `usage` 实算，并据此自动校准估算（`data/pricing-calibration.json`）
- **Codex 订阅**：文字按 app-server 上报的 token 实算；生图不报 token，按同等 API 请求（sunburst · medium）折算，标「估算」
- 第三方模型不在价格表里时按默认模型的价格估算
- 首页「API 累计」是所有项目在 API 上的真实花费合计（`data/api-spend.json`），设置里可以清零

实测（API · sunburst · medium）：新生成 1 张（1024²）≈ $0.059，局部修改 ≈ $0.065，8 帧 512² 动图 ≈ $0.045–0.055。
