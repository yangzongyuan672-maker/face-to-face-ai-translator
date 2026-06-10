import express from "express";
import multer from "multer";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = process.env.PORT || 3000;
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
    mode: "asymmetric-openai-vad"
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

app.listen(port, () => {
  console.log(`Face-to-Face AI Translator is running on port ${port}`);
});
