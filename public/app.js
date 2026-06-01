const startButton = document.querySelector("#startButton");
const clearButton = document.querySelector("#clearButton");
const historyButton = document.querySelector("#historyButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const historySheet = document.querySelector("#historySheet");
const selfLanguage = document.querySelector("#selfLanguage");
const peerLanguage = document.querySelector("#peerLanguage");
const selfSourceText = document.querySelector("#selfSourceText");
const selfTranslationText = document.querySelector("#selfTranslationText");
const peerSourceText = document.querySelector("#peerSourceText");
const peerTranslationText = document.querySelector("#peerTranslationText");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");
const historyItemTemplate = document.querySelector("#historyItemTemplate");

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

startButton.addEventListener("click", () => {
  if (state.listening) {
    pauseListening();
  } else {
    startListening();
  }
});

clearButton.addEventListener("click", () => {
  state.history = [];
  localStorage.removeItem("translatorHistory");
  renderHistory();
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
    setListeningUi(true);
    updateDisplay({
      selfSource: "正在请求麦克风...",
      selfTranslation: "请允许麦克风",
      peerSource: "Requesting microphone...",
      peerTranslation: "Please allow"
    });

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
    updateDisplay({
      selfSource: "请说话...",
      selfTranslation: "正在听",
      peerSource: "Listening...",
      peerTranslation: "Listening..."
    });
    monitorAudio();
  } catch (error) {
    console.error(error);
    setListeningUi(false);
    updateDisplay({
      selfSource: "麦克风不可用",
      selfTranslation: "请在浏览器允许麦克风",
      peerSource: "Microphone blocked",
      peerTranslation: "Allow microphone"
    });
    selfTranslationText.classList.add("error");
    peerTranslationText.classList.add("error");
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
  setListeningUi(false);
  updateDisplay({
    selfSource: "已暂停",
    selfTranslation: "请说话...",
    peerSource: "Paused",
    peerTranslation: "Listening..."
  });
}

function monitorAudio() {
  if (!state.listening || !state.analyser) return;
  const data = new Uint8Array(state.analyser.fftSize);
  state.analyser.getByteTimeDomainData(data);
  const level = rms(data);

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
  updateDisplay({
    selfSource: "正在听...",
    selfTranslation: "请继续说",
    peerSource: "Listening...",
    peerTranslation: "Keep speaking"
  });

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
  updateDisplay({
    selfSource: "正在识别...",
    selfTranslation: "正在翻译",
    peerSource: "Transcribing...",
    peerTranslation: "Translating"
  });

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
      updateDisplay({
        selfSource: "",
        selfTranslation: "请说话...",
        peerSource: "Listening...",
        peerTranslation: "Listening..."
      });
      return;
    }
    renderResult(result);
    addHistory(result);
  } catch (error) {
    console.error(error);
    updateDisplay({
      selfSource: "翻译失败",
      selfTranslation: "请再说一次",
      peerSource: "Translation failed",
      peerTranslation: "Try again"
    });
    selfTranslationText.classList.add("error");
    peerTranslationText.classList.add("error");
  } finally {
    state.busy = false;
  }
}

function renderResult(result) {
  const sourceIsChinese = result.sourceLanguage === "zh";
  selfLanguage.textContent = sourceIsChinese ? "中文（简体）" : "English";
  peerLanguage.textContent = sourceIsChinese ? "English" : "中文（简体）";
  updateDisplay({
    selfSource: result.originalText,
    selfTranslation: result.translatedText,
    peerSource: result.originalText,
    peerTranslation: result.translatedText
  });
}

function updateDisplay({ selfSource, selfTranslation, peerSource, peerTranslation }) {
  selfSourceText.textContent = selfSource;
  selfTranslationText.textContent = selfTranslation;
  peerSourceText.textContent = peerSource;
  peerTranslationText.textContent = peerTranslation;
  selfTranslationText.classList.remove("error");
  peerTranslationText.classList.remove("error");
}

function setListeningUi(isListening) {
  startButton.classList.toggle("listening", isListening);
  startButton.setAttribute("aria-label", isListening ? "暂停翻译" : "开始翻译");
}

function addHistory(result) {
  state.history.unshift({
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
    originalText: result.originalText,
    translatedText: result.translatedText
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

function closeHistory() {
  historySheet.classList.remove("open");
  historySheet.setAttribute("aria-hidden", "true");
}

function rms(data) {
  let sum = 0;
  for (const value of data) {
    const normalized = (value - 128) / 128;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / data.length);
}
