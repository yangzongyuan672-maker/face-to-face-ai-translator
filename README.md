# Face-to-Face AI Translator

手机浏览器使用的非对称面对面中英翻译器。

## 功能

- 自动监听麦克风
- VAD 停顿断句
- OpenAI 语音识别
- 中英文自动识别和双向翻译
- 中文发言时仅在主屏显示英文大字
- 英文发言时主屏保持不变，并通过浏览器中文语音播报译文
- 主屏边角显示轻量收音呼吸反馈
- 记录完整会话，并可在结束对话时导出 Markdown 文档
- 开始、暂停、结束、记录、清空

## 交互逻辑

- User 说中文：识别后翻译成英文，替换主屏大字，方便对方阅读。
- Target 说英文：识别后翻译成中文，使用浏览器 `speechSynthesis` 播放，不在主屏显示文本。
- 主屏英文会一直保留，直到下一条中文发言翻译完成后替换。
- 点击“结束”会停止监听，并把当前会话导出为结构化 Markdown 文档。

当前版本仍使用 OpenAI HTTP 识别/翻译链路。PRD 中的 Google Gemini Live API WebSocket 真同传需要新增 `GOOGLE_API_KEY`、WebSocket 代理和 PCM 音频流处理后再切换。

## 本地运行

```bash
npm install
OPENAI_API_KEY=你的_key npm start
```

打开 `http://localhost:3000`。

## Railway 部署

在 Railway 项目的 Variables 里设置环境变量：

```txt
OPENAI_API_KEY=你的 OpenAI API Key
```

Railway 会读取 `railway.json`，启动命令为：

```bash
npm start
```

可选覆盖模型：

```txt
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
OPENAI_TRANSLATE_MODEL=gpt-4.1-mini
```
