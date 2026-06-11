import { createServer } from "http";
import express from "express";
import multer from "multer";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;
const geminiApiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "";
const geminiLiveModel = process.env.GEMINI_LIVE_MODEL || "gemini-3.5-live-translate-preview";
const geminiWsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(geminiApiKey)}`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    hasGeminiKey: Boolean(geminiApiKey),
    mode: geminiApiKey ? "gemini-live-translate" : "openai-vad-fallback",
    geminiLiveModel
  });
});

app.post("/api/translate", upload.single("audio"), async (req, res) => {
  try {
    if (!openai) {
      res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not configured." });
      return;
    }

    if (!req.file?.buffer?.length) {
      res.status(400).json({ ok: false, error: "No audio file received." });
      return;
    }

    const audioFile = await OpenAI.toFile(
      req.file.buffer,
      req.file.originalname || "speech.webm",
      { type: req.file.mimetype || "audio/webm" }
    );

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
      response_format: "json"
    });

    const text = String(transcription.text || "").trim();
    if (!text) {
      res.json({
        ok: true,
        empty: true,
        speaker: "unknown",
        sourceLanguage: "unknown",
        targetLanguage: "unknown",
        originalText: "",
        translatedText: ""
      });
      return;
    }

    const translated = await translateText(text);
    res.json({
      ok: true,
      originalText: text,
      ...translated
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      error: "Translation failed. Please try again."
    });
  }
});

async function translateText(text) {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_TRANSLATE_MODEL || "gpt-4.1-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "You are a face-to-face bilingual interpreter for Chinese and English.",
          "Detect whether the user text is mainly Chinese or English.",
          "If Chinese, the speaker is User and you must translate naturally into English for a distant reader.",
          "If English, the speaker is Target and you must translate naturally into Simplified Chinese for private audio playback.",
          "Preserve names, numbers, dates, and business meaning. Do not add explanations.",
          "Return only JSON with keys: speaker, sourceLanguage, targetLanguage, translatedText.",
          "Use speaker values User or Target.",
          "Use sourceLanguage values zh or en. Use targetLanguage values en or zh."
        ].join(" ")
      },
      { role: "user", content: text }
    ]
  });

  const raw = response.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  const sourceLanguage = parsed.sourceLanguage === "zh" ? "zh" : "en";
  const targetLanguage = sourceLanguage === "zh" ? "en" : "zh";
  return {
    speaker: sourceLanguage === "zh" ? "User" : "Target",
    sourceLanguage,
    targetLanguage,
    translatedText: String(parsed.translatedText || "").trim()
  };
}

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = createServer(app);
const liveServer = new WebSocketServer({ server, path: "/api/live-translate" });

liveServer.on("connection", (client) => {
  if (!geminiApiKey) {
    sendClient(client, { type: "error", error: "Railway 还没有设置 GOOGLE_API_KEY 或 GEMINI_API_KEY" });
    client.close(1011, "Missing Gemini API key");
    return;
  }

  const enSession = createGeminiSession(client, {
    id: "en",
    targetLanguageCode: "en",
    sendAudio: false
  });
  const zhSession = createGeminiSession(client, {
    id: "zh",
    targetLanguageCode: "zh-Hans",
    sendAudio: true
  });

  client.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "audio" && message.data) {
      enSession.sendAudio(message.data);
      zhSession.sendAudio(message.data);
    }

    if (message.type === "stop") {
      enSession.endAudio();
      zhSession.endAudio();
    }
  });

  client.on("close", () => {
    enSession.close();
    zhSession.close();
  });
});

function createGeminiSession(client, options) {
  const gemini = new WebSocket(geminiWsUrl);
  let ready = false;
  const queue = [];
  let transcript = "";

  gemini.on("open", () => {
    const setupMessage = {
      setup: {
        model: `models/${geminiLiveModel}`,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: options.targetLanguageCode,
            echoTargetLanguage: false
          }
        }
      }
    };
    gemini.send(JSON.stringify(setupMessage));
  });

  gemini.on("message", (raw) => {
    let response;
    try {
      response = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (response.setupComplete) {
      ready = true;
      flushQueue();
      sendClient(client, { type: "live-ready", channel: options.id });
      return;
    }

    const content = response.serverContent;
    if (!content) return;

    const outputText = content.outputTranscription?.text || "";
    if (outputText) {
      transcript += outputText;
      sendClient(client, {
        type: options.id === "en" ? "english-partial" : "chinese-partial",
        text: transcript
      });
    }

    const inputText = content.inputTranscription?.text || "";
    if (inputText && options.id === "en") {
      sendClient(client, { type: "source-partial", text: inputText });
    }

    for (const part of content.modelTurn?.parts || []) {
      const audio = part.inlineData?.data || part.inline_data?.data;
      if (audio && options.sendAudio) {
        sendClient(client, { type: "audio", data: audio, sampleRate: 24000 });
      }
    }

    if (content.generationComplete || content.turnComplete) {
      if (transcript.trim()) {
        sendClient(client, {
          type: options.id === "en" ? "english-final" : "chinese-final",
          text: transcript.trim()
        });
      }
      transcript = "";
    }
  });

  gemini.on("error", (error) => {
    sendClient(client, { type: "error", channel: options.id, error: error.message });
  });

  gemini.on("close", (_code, reason) => {
    const text = reason?.toString();
    if (text) sendClient(client, { type: "live-closed", channel: options.id, reason: text });
  });

  function sendAudio(data) {
    const payload = {
      realtimeInput: {
        audio: {
          data,
          mimeType: "audio/pcm;rate=16000"
        }
      }
    };
    sendOrQueue(payload);
  }

  function endAudio() {
    sendOrQueue({ realtimeInput: { audioStreamEnd: true } });
  }

  function sendOrQueue(payload) {
    if (gemini.readyState !== WebSocket.OPEN || !ready) {
      queue.push(payload);
      return;
    }
    gemini.send(JSON.stringify(payload));
  }

  function flushQueue() {
    while (queue.length && gemini.readyState === WebSocket.OPEN) {
      gemini.send(JSON.stringify(queue.shift()));
    }
  }

  return {
    sendAudio,
    endAudio,
    close() {
      if (gemini.readyState === WebSocket.OPEN || gemini.readyState === WebSocket.CONNECTING) {
        gemini.close();
      }
    }
  };
}

function sendClient(client, data) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(data));
  }
}

server.listen(port, () => {
  console.log(`Face-to-Face AI Translator is running on port ${port}`);
});
