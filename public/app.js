const startButton = document.querySelector("#startButton");
const clearButton = document.querySelector("#clearButton");
const historyButton = document.querySelector("#historyButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const historySheet = document.querySelector("#historySheet");
const statusText = document.querySelector("#statusText");
const selfCaptions = document.querySelector("#selfCaptions");
const peerCaptions = document.querySelector("#peerCaptions");
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
  history: JSON.parse(localStorage.getItem("translatorHistory") || "[]"),
  captions: []
};

renderHistory();
restoreCaptions();

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
    setStatus("正在听");
    monitorAudio();
  } catch (error) {
    console.error(error);
    setListeningUi(false);
    setStatus("麦克风不可用");
    if (!state.captions.length) {
      renderCaptions([{ originalText: "麦克风不可用", translatedText: "请允许浏览器使用麦克风" }]);
    }
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
    renderResult(result);
    addHistory(result);
    setStatus("正在听");
  } catch (error) {
    console.error(error);
    setStatus("翻译失败");
  } finally {
    state.busy = false;
  }
}

function renderResult(result) {
  state.captions = [{
    originalText: result.originalText,
    translatedText: result.translatedText
  }];
  renderCaptions(state.captions);
}

function setListeningUi(isListening) {
  startButton.classList.toggle("listening", isListening);
  startButton.setAttribute("aria-label", isListening ? "暂停翻译" : "开始翻译");
}

function setStatus(text) {
  statusText.textContent = text;
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

function restoreCaptions() {
  state.captions = state.history
    .slice(0, 1)
    .reverse()
    .map((item) => ({
      originalText: item.originalText,
      translatedText: item.translatedText
    }));
  if (state.captions.length) renderCaptions(state.captions);
}

function renderCaptions(items) {
  selfCaptions.innerHTML = "";
  peerCaptions.innerHTML = "";
  items.forEach((item, index) => {
    const active = index === items.length - 1;
    selfCaptions.appendChild(createCaption(item.originalText, item.translatedText, active));
    peerCaptions.appendChild(createCaption(item.originalText, item.translatedText, active));
  });
}

function createCaption(source, translation, active) {
  const article = document.createElement("article");
  article.className = `caption${active ? " active" : ""}`;

  const sourceNode = document.createElement("p");
  sourceNode.className = "caption-source";
  sourceNode.textContent = source;

  const translationNode = document.createElement("p");
  translationNode.className = "caption-translation";
  translationNode.textContent = translation;

  article.append(sourceNode, translationNode);
  return article;
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
