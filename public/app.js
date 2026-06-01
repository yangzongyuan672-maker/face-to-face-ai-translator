const startButton = document.querySelector("#startButton");
const pauseButton = document.querySelector("#pauseButton");
const clearButton = document.querySelector("#clearButton");
const statusPill = document.querySelector("#statusPill");
const statusText = document.querySelector("#statusText");
const liveText = document.querySelector("#liveText");
const translatedText = document.querySelector("#translatedText");
const sourceLabel = document.querySelector("#sourceLabel");
const targetLabel = document.querySelector("#targetLabel");
const guestLiveText = document.querySelector("#guestLiveText");
const guestTranslatedText = document.querySelector("#guestTranslatedText");
const guestSourceLabel = document.querySelector("#guestSourceLabel");
const guestTargetLabel = document.querySelector("#guestTargetLabel");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");
const historyItemTemplate = document.querySelector("#historyItemTemplate");
const meter = document.querySelector("#meter");

const state = {
  listening: false,
  recording: false,
  busy: false,
  stream: null,
  audioContext: null,
  analyser: null,
  recorder: null,
  chunks: [],
  rafId: null,
  lastVoiceAt: 0,
  speechStartedAt: 0,
  silenceMs: 950,
  minSpeechMs: 480,
  threshold: 0.035,
  history: JSON.parse(localStorage.getItem("translatorHistory") || "[]")
};

renderHistory();

startButton.addEventListener("click", startListening);
pauseButton.addEventListener("click", pauseListening);
clearButton.addEventListener("click", () => {
  state.history = [];
  localStorage.removeItem("translatorHistory");
  renderHistory();
});

async function startListening() {
  try {
    setStatus("正在请求麦克风", "listening");
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
    startButton.disabled = true;
    pauseButton.disabled = false;
    setStatus("正在监听", "listening");
    updateLive("正在监听，说中文或英文都可以。", "Waiting for speech...");
    monitorAudio();
  } catch (error) {
    console.error(error);
    setStatus("麦克风不可用", "error");
    updateLive("请允许浏览器使用麦克风。", "Please allow microphone access.");
  }
}

function pauseListening() {
  state.listening = false;
  stopRecording();
  cancelAnimationFrame(state.rafId);
  state.stream?.getTracks().forEach((track) => track.stop());
  state.audioContext?.close();
  state.stream = null;
  state.audioContext = null;
  state.analyser = null;
  startButton.disabled = false;
  pauseButton.disabled = true;
  meter.classList.remove("active");
  setStatus("已暂停");
}

function monitorAudio() {
  if (!state.listening || !state.analyser) return;
  const data = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(data);
  const level = rms(data);
  updateMeter(level);

  const now = performance.now();
  if (level > state.threshold) {
    state.lastVoiceAt = now;
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
  setStatus("正在收音", "listening");
  updateLive("正在聆听这一句话…", "Listening...");

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
  setStatus("正在翻译", "listening");
  updateLive("正在识别并翻译…", "Translating...");

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
      setStatus("正在监听", "listening");
      return;
    }
    renderResult(result);
    addHistory(result);
    setStatus("正在监听", "listening");
  } catch (error) {
    console.error(error);
    setStatus("翻译失败", "error");
    updateLive("翻译失败，请再说一次。", "Translation failed. Please try again.");
  } finally {
    state.busy = false;
  }
}

function renderResult(result) {
  const sourceName = result.sourceLanguage === "zh" ? "中文" : "English";
  const targetName = result.targetLanguage === "zh" ? "中文" : "English";
  sourceLabel.textContent = `原文 · ${sourceName}`;
  targetLabel.textContent = `译文 · ${targetName}`;
  guestSourceLabel.textContent = `Original · ${sourceName}`;
  guestTargetLabel.textContent = `Translation · ${targetName}`;
  liveText.textContent = result.originalText;
  translatedText.textContent = result.translatedText;
  guestLiveText.textContent = result.originalText;
  guestTranslatedText.textContent = result.translatedText;
}

function addHistory(result) {
  state.history.unshift({
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    originalText: result.originalText,
    translatedText: result.translatedText,
    sourceLanguage: result.sourceLanguage,
    targetLanguage: result.targetLanguage
  });
  state.history = state.history.slice(0, 20);
  localStorage.setItem("translatorHistory", JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  historyList.innerHTML = "";
  historyCount.textContent = `${state.history.length} / 20`;
  state.history.forEach((item) => {
    const node = historyItemTemplate.content.cloneNode(true);
    node.querySelector("time").textContent = item.time;
    node.querySelector(".history-original").textContent = item.originalText;
    node.querySelector(".history-translation").textContent = item.translatedText;
    historyList.appendChild(node);
  });
}

function updateLive(selfText, guestText) {
  liveText.textContent = selfText;
  guestLiveText.textContent = guestText || selfText;
}

function setStatus(text, mode = "") {
  statusText.textContent = text;
  statusPill.className = `status-pill ${mode}`;
}

function updateMeter(level) {
  const bars = meter.querySelectorAll("span");
  const active = level > state.threshold;
  meter.classList.toggle("active", active);
  bars.forEach((bar, index) => {
    const offset = Math.abs(index - 2) * 0.12;
    const value = Math.min(2.8, Math.max(0.35, level * 28 - offset));
    bar.style.setProperty("--level", value.toFixed(2));
  });
}

function rms(data) {
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}
