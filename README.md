# Face-to-Face AI Translator

手机浏览器使用的面对面中英双向实时翻译器。

## 功能

- 自动监听麦克风
- VAD 停顿断句
- OpenAI 语音识别
- 中英文自动识别和双向翻译
- 上下双屏显示，下半屏 180 度旋转
- 最近 20 条历史记录
- 开始、暂停、清空

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
