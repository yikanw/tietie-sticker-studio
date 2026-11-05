# AGENTS.md

本仓库是本机运行的表情包工作台「贴贴机 TIETIE」。用户让你"安装 / 启动 / 打开贴贴机（或表情包工作台）"时，按下面做。

## 安装与启动

1. 检查 Node.js ≥ 20：`node --version`
2. 检查 Codex CLI 版本与登录：`codex --version`、`codex login status`
   - 版本低于 0.166 时提醒用户升级：`npm i -g @openai/codex@latest`（旧版看不到新模型，会报 model_not_found）
   - 没有用 ChatGPT 账号登录时，让用户自己运行 `codex login`（不要替用户输入任何凭据）
3. 安装依赖：`npm install`
4. 启动：`npm start`（会先构建前端），然后告诉用户打开 http://localhost:5177
   - 端口被占用时可用 `PORT=5178 npm start`

## 约束

- 不要读取、打印或提交 `data/settings.json`（含用户的 API Key）
- `data/` 是用户的项目数据，不要删除
- 修改代码后用 `npm run typecheck` 和 `npm run build` 自检

## 结构速览

- `server/pipeline.mjs`：流程与队列（识别 → 风格设定图 → 计划 → 生成 → 导出）
- `server/codex-service.mjs`：通过 `codex app-server` 调用订阅出文字/出图
- `server/settings.mjs`：生图 / 生文两套独立配置（各自通道、Base URL、Key、模型）
- `server/api-backend.mjs`：生图 API（兼容 OpenAI Images API）；`server/api-text.mjs`：生文 API（Responses 或 Chat Completions）
- `server/prompts.mjs`、`server/styles.json`：提示词与风格预设；`server/style-guide.json`：主体/语气/场景/热梗
- `web/src/`：前端
