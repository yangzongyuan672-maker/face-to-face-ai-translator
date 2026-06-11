# Nancy

Nancy 是手机浏览器使用的非对称面对面中英实时翻译器。

## 功能

- 使用 Gemini Live Translate WebSocket 流式翻译
- 麦克风音频转为 16k PCM，并按约 100ms 分片持续发送
- 中文发言时，主屏实时显示英文字幕
- 英文发言时，通过 Gemini 输出的中文音频流实时播放
- 英文字幕下方显示小号中文翻译，方便确认反馈是否正确
- 已完成字幕显示绿色，正在生成/调整的字幕显示白色
- 主屏边角显示轻量收音呼吸反馈
- 记录完整会话，并可在结束对话时导出 Markdown 文档
- 开始、暂停、结束、记录、清空

## 交互逻辑

- User 说中文：实时翻译成英文字幕，方便对方阅读。
- Target 说英文：实时翻译成中文音频播放，同时在底部用小字显示中文确认。
- 主屏英文字幕按句保留，最新生成中的一句为白色，完成后变绿色。
- 点击“结束”会停止监听，并把当前会话导出为结构化 Markdown 文档。

当前实时链路使用 Google Gemini Live Translate：

```txt
GEMINI_LIVE_MODEL=gemini-3.5-live-translate-preview
```

后端保留 OpenAI HTTP 识别/翻译接口作为旧兜底代码，但主界面会优先连接 Gemini Live WebSocket。

## 本地运行

```bash
npm install
GOOGLE_API_KEY=你的_google_ai_studio_key npm start
```

打开 `http://localhost:3000`。

## Railway 部署

在 Railway 项目的 Variables 里设置环境变量：

```txt
GOOGLE_API_KEY=你的 Google AI Studio API Key
GEMINI_LIVE_MODEL=gemini-3.5-live-translate-preview
OPENAI_API_KEY=你的 OpenAI API Key
```

`OPENAI_API_KEY` 只用于旧 HTTP 兜底接口；实时同传必须设置 `GOOGLE_API_KEY` 或 `GEMINI_API_KEY`。

Railway 会读取 `railway.json`，启动命令为：

```bash
npm start
```

可选覆盖旧兜底模型：

```txt
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSLATE_MODEL=gpt-4.1-mini
```
