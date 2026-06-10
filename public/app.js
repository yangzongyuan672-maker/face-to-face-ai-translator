const startButton = document.querySelector("#startButton");
const endButton = document.querySelector("#endButton");
const clearButton = document.querySelector("#clearButton");
const exportButton = document.querySelector("#exportButton");
const historyButton = document.querySelector("#historyButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const historySheet = document.querySelector("#historySheet");
const statusText = document.querySelector("#statusText");
const displayText = document.querySelector("#displayText");
const stageLabel = document.querySelector("#stageLabel");
const listeningIndicator = document.querySelector("#listeningIndicator");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");
const historyItemTemplate = document.querySelector("#historyItemTemplate");

const idleEndMs = 12 * 60 * 1000;

const state = {
  listening: false,
  recording: false,
  busy: false,
  ended: false,
  stream: null,
  audioContext: null,
  analyser: null,
  recorder: null,
  chunks: [],
  rafId: null,
  idleTimer: null,
  lastVoiceAt: 0,
  speechStartedAt: 0,
  silenceMs: 950,
  minSpeechMs: 480,
  threshold: 0.035,
  sessionId: crypto.randomUUID?.() || String(Date.now()),
  sessionStartedAt: new Date().toISOString(),
  sessionEndedAt: null,
  records: JSON.parse(localStorage.getItem("translatorSessionRecords") || "[]"),
  lastDisplayText: localStorage.getItem("translatorLastDisplay") || ""
};

renderHistory();
restoreDisplay();

startButton.addEventListener("click", () => {
  if (state.listening) {
    pauseListening();
  } else {
    startListening();
  }
});

endButton.addEventListener("click", () => {
  endConversation("manual");
});

clearButton.addEventListener("click", () => {
  state.records = [];
  state.sessionStartedAt = new Date().toISOString();
  state.sessionEndedAt = null;
  localStorage.removeItem("translatorSessionRecords");
  renderHistory();
});

exportButton.addEventListener("click", () => {
  exportSessionDocument();
});

historyButton.addEventListener("click", () => {
  historySheet.classList.add("open");
  historySheet.setAttribute("aria-hidden", "false");
});

closeHistoryButton.addEventListener("click", closeHistory);
historySheet.addEventListener("click", (event) => {
  if (event.target === historySheet) closeHistory();
});

async function startListening() {
  try {
    state.ended = false;
    setListeningUi(true);
    setStatus("请求麦克风");

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    state.audioContext = new AudioContext();
    const source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    state.analyser.fftSize = 1024;
    source.connect(state.analyser);

    state.listening = true;
    state.lastVoiceAt = performance.now();
    resetIdleTimer();
    setStatus("正在听");
    monitorAudio();
  } catch (error) {
    console.error(error);
    setListeningUi(false);
    setStatus("麦克风不可用");
    showPlaceholder("请允许浏览器使用麦克风");
  }
}

function pauseListening() {
  state.listening = false;
  stopRecording();
  cancelAnimationFrame(state.rafId);
  clearTimeout(state.idleTimer);
  state.stream?.getTracks().forEach((track) => track.stop());
  state.audioContext?.close();
  state.stream = null;
  state.audioContext = null;
  state.analyser = null;
  setListeningUi(false);
  setStatus("已暂停");
}

function monitorAudio() {
  if (!state.listening || !state.analyser) return;
  const data = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(data);
  const level = rms(data);
  const now = performance.now();

  if (level > state.threshold) {
    state.lastVoiceAt = now;
    resetIdleTimer();
    if (!state.recording && !state.busy) {
      startRecording();
    }
  }

  if (
    state.recording &&
    now - state.lastVoiceAt > state.silenceMs &&
    now - state.speechStartedAt > state.minSpeechMs
  ) {
    stopRecording(true);
  }

  state.rafId = requestAnimationFrame(monitorAudio);
}

function startRecording() {
  state.chunks = [];
  state.recording = true;
  state.speechStartedAt = performance.now();
  state.lastVoiceAt = performance.now();
  setStatus("收音中");

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";

  state.recorder = new MediaRecorder(state.stream, { mimeType });
  state.recorder.ondataavailable = (event) => {
    if (event.data.size) state.chunks.push(event.data);
  };
  state.recorder.onstop = () => submitAudio();
  state.recorder.start();
}

function stopRecording(shouldSubmit = false) {
  if (!state.recording) return;
  state.recording = false;
  if (state.recorder?.state !== "inactive") {
    state.recorder.stop();
  }
  if (!shouldSubmit) state.chunks = [];
}

async function submitAudio() {
  if (!state.chunks.length || !state.listening) return;
  state.busy = true;
  setStatus("翻译中");

  const blob = new Blob(state.chunks, { type: state.chunks[0]?.type || "audio/webm" });
  state.chunks = [];

  try {
    const formData = new FormData();
    formData.append("audio", blob, "speech.webm");
    const response = await fetch("/api/translate", {
      method: "POST",
      body: formData
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || "Translation failed");
    if (result.empty) {
      setStatus("正在听");
      return;
    }
    handleTranslation(result);
    addRecord(result);
    setStatus("正在听");
  } catch (error) {
    console.error(error);
    setStatus("翻译失败");
  } finally {
    state.busy = false;
  }
}

function handleTranslation(result) {
  if (result.sourceLanguage === "zh") {
    showDisplayText(result.translatedText);
    stageLabel.textContent = "Showing your English";
    return;
  }

  stageLabel.textContent = "Listening to English";
  speakChinese(result.translatedText);
}

function showDisplayText(text) {
  const value = String(text || "").trim();
  if (!value) return;
  displayText.textContent = value;
  displayText.classList.remove("is-placeholder");
  state.lastDisplayText = value;
  localStorage.setItem("translatorLastDisplay", value);
}

function showPlaceholder(text) {
  displayText.textContent = text;
  displayText.classList.add("is-placeholder");
}

function restoreDisplay() {
  if (state.lastDisplayText) {
    showDisplayText(state.lastDisplayText);
  }
}

function speakChinese(text) {
  const value = String(text || "").trim();
  if (!value || !("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(value);
  utterance.lang = "zh-CN";
  utterance.rate = 1.02;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

function addRecord(result) {
  const record = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    time: new Date().toISOString(),
    speaker: result.speaker || (result.sourceLanguage === "zh" ? "User" : "Target"),
    sourceLanguage: result.sourceLanguage,
    targetLanguage: result.targetLanguage,
    originalText: result.originalText,
    translatedText: result.translatedText
  };
  state.records.push(record);
  localStorage.setItem("translatorSessionRecords", JSON.stringify(state.records));
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = "";
  historyCount.textContent = `${state.records.length} 条`;

  if (!state.records.length) {
    const empty = document.createElement("p");
    empty.className = "empty-history";
    empty.textContent = "还没有会话记录";
    historyList.appendChild(empty);
    return;
  }

  [...state.records].reverse().forEach((item) => {
    const node = historyItemTemplate.content.cloneNode(true);
    node.querySelector("time").textContent = formatTime(item.time);
    node.querySelector(".history-speaker").textContent = item.speaker === "User" ? "User / 中文" : "Target / English";
    node.querySelector(".history-original").textContent = item.originalText;
    node.querySelector(".history-translation").textContent = item.translatedText;
    historyList.appendChild(node);
  });
}

function endConversation(reason) {
  if (state.ended) return;
  state.ended = true;
  state.sessionEndedAt = new Date().toISOString();
  pauseListening();
  setStatus(reason === "idle" ? "已因长时间无输入结束" : "对话已结束");
  if (state.records.length) exportSessionDocument();
}

function exportSessionDocument() {
  const endedAt = state.sessionEndedAt || new Date().toISOString();
  const documentText = buildSessionDocument(endedAt);
  const blob = new Blob([documentText], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `conversation-${formatFileDate(state.sessionStartedAt)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildSessionDocument(endedAt) {
  const start = new Date(state.sessionStartedAt);
  const end = new Date(endedAt);
  const lines = [
    "# Face-to-Face Translation Session",
    "",
    `- Session ID: ${state.sessionId}`,
    `- Date: ${start.toLocaleDateString("zh-CN")}`,
    `- Time Range: ${start.toLocaleTimeString("zh-CN", { hour12: false })} - ${end.toLocaleTimeString("zh-CN", { hour12: false })}`,
    "",
    "## Dialogue",
    ""
  ];

  state.records.forEach((item, index) => {
    const speaker = item.speaker === "User" ? "User (中文)" : "Target (English)";
    lines.push(`### ${index + 1}. ${formatTime(item.time)} ${speaker}`);
    lines.push(`- Original: ${item.originalText}`);
    lines.push(`- Translation: ${item.translatedText}`);
    lines.push("");
  });

  return lines.join("\n");
}

function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = window.setTimeout(() => {
    if (state.listening && !state.recording && !state.busy) {
      endConversation("idle");
    }
  }, idleEndMs);
}

function setListeningUi(isListening) {
  startButton.classList.toggle("listening", isListening);
  listeningIndicator.classList.toggle("active", isListening);
  startButton.setAttribute("aria-label", isListening ? "暂停翻译" : "开始翻译");
}

function setStatus(text) {
  statusText.textContent = text;
}

function closeHistory() {
  historySheet.classList.remove("open");
  historySheet.setAttribute("aria-hidden", "true");
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatFileDate(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function rms(data) {
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}
