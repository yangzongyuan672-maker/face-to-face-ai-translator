const startButton = document.querySelector("#startButton");
const endButton = document.querySelector("#endButton");
const clearButton = document.querySelector("#clearButton");
const exportButton = document.querySelector("#exportButton");
const historyButton = document.querySelector("#historyButton");
const closeHistoryButton = document.querySelector("#closeHistoryButton");
const historySheet = document.querySelector("#historySheet");
const statusText = document.querySelector("#statusText");
const captionBoard = document.querySelector("#captionBoard");
const emptyCaption = document.querySelector("#emptyCaption");
const confirmLine = document.querySelector("#confirmLine");
const listeningIndicator = document.querySelector("#listeningIndicator");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");
const historyItemTemplate = document.querySelector("#historyItemTemplate");

const targetRate = 16000;
const chunkMs = 100;
const chunkSamples = Math.floor(targetRate * chunkMs / 1000);
const maxCaptions = 18;
const maxChineseCaptions = 6;
const idleEndMs = 20 * 60 * 1000;

const state = {
  listening: false,
  ended: false,
  ws: null,
  reconnecting: false,
  manualDisconnect: false,
  stream: null,
  audioContext: null,
  source: null,
  processor: null,
  playbackContext: null,
  playbackCursor: 0,
  playbackSourceLanguage: null,
  queuedAudio: [],
  pendingSamples: [],
  idleTimer: null,
  sessionId: crypto.randomUUID?.() || String(Date.now()),
  sessionStartedAt: new Date().toISOString(),
  sessionEndedAt: null,
  currentEnglish: "",
  currentChinese: "",
  captions: JSON.parse(localStorage.getItem("nancyCaptions") || "[]"),
  chineseCaptions: JSON.parse(localStorage.getItem("nancyChineseCaptions") || "[]"),
  captionAutoScroll: true,
  chineseAutoScroll: true,
  records: JSON.parse(localStorage.getItem("translatorSessionRecords") || "[]")
};

renderCaptions();
renderHistory();

startButton.addEventListener("click", () => {
  if (state.listening) {
    pauseListening();
  } else {
    startListening();
  }
});

endButton.addEventListener("click", () => endConversation("manual"));

clearButton.addEventListener("click", () => {
  state.records = [];
  state.captions = [];
  state.chineseCaptions = [];
  state.currentEnglish = "";
  state.currentChinese = "";
  state.sessionStartedAt = new Date().toISOString();
  state.sessionEndedAt = null;
  localStorage.removeItem("translatorSessionRecords");
  localStorage.removeItem("nancyCaptions");
  localStorage.removeItem("nancyChineseCaptions");
  renderCaptions();
  renderHistory();
});

exportButton.addEventListener("click", () => copySessionText());

historyButton.addEventListener("click", () => {
  openHistory();
});

closeHistoryButton.addEventListener("click", closeHistory);
historySheet.addEventListener("click", (event) => {
  if (event.target === historySheet) closeHistory();
});
captionBoard.addEventListener("scroll", () => {
  state.captionAutoScroll = isNearBottom(captionBoard);
});
confirmLine.addEventListener("scroll", () => {
  state.chineseAutoScroll = isNearBottom(confirmLine);
});

async function startListening() {
  try {
    state.ended = false;
    state.manualDisconnect = false;
    setListeningUi(true);
    setStatus("连接 Gemini Live");
    await openLiveSocket();
    setStatus("请求麦克风");

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    state.audioContext = new AudioContext();
    state.playbackContext = state.playbackContext || new AudioContext({ sampleRate: 24000 });
    state.source = state.audioContext.createMediaStreamSource(state.stream);
    state.processor = state.audioContext.createScriptProcessor(4096, 1, 1);
    state.processor.onaudioprocess = handleAudioProcess;
    state.source.connect(state.processor);
    state.processor.connect(state.audioContext.destination);

    state.listening = true;
    resetIdleTimer();
    setStatus("实时翻译中");
  } catch (error) {
    console.error(error);
    setListeningUi(false);
    setStatus(error.message || "启动失败");
    cleanupAudio();
  }
}

function openLiveSocket() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/api/live-translate`);
    state.ws = socket;

    const timeout = window.setTimeout(() => {
      reject(new Error("Gemini Live 连接超时"));
    }, 18000);

    let readyChannels = new Set();
    socket.addEventListener("open", () => {
      setStatus("等待 Live 模型");
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "error") {
        window.clearTimeout(timeout);
        reject(new Error(message.error || "Gemini Live 连接失败"));
        return;
      }
      if (message.type === "live-ready") {
        readyChannels.add(message.channel);
        if (readyChannels.has("en") && readyChannels.has("zh")) {
          window.clearTimeout(timeout);
          resolve();
        }
        return;
      }
      handleLiveMessage(message);
    });

    socket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Gemini Live 连接失败"));
    });

    socket.addEventListener("close", () => {
      if (state.listening && !state.manualDisconnect) {
        reconnectLiveSocket();
      }
    });
  });
}

async function reconnectLiveSocket() {
  if (state.reconnecting || state.ended || !state.stream) return;
  state.reconnecting = true;
  setStatus("Gemini 断开，正在重连");
  for (let attempt = 1; attempt <= 4 && state.listening && !state.manualDisconnect; attempt += 1) {
    try {
      await delay(600 * attempt);
      await openLiveSocket();
      setStatus("实时翻译中");
      state.reconnecting = false;
      return;
    } catch (error) {
      console.warn(error);
      setStatus(`重连中 ${attempt}/4`);
    }
  }
  state.reconnecting = false;
  if (state.listening) setStatus("Gemini 连接失败，点开始重试");
}

function handleAudioProcess(event) {
  if (!state.listening || state.ws?.readyState !== WebSocket.OPEN) return;
  const input = event.inputBuffer.getChannelData(0);
  const pcm = downsampleTo16BitPcm(input, state.audioContext.sampleRate, targetRate);
  for (const sample of pcm) state.pendingSamples.push(sample);

  while (state.pendingSamples.length >= chunkSamples) {
    const chunk = state.pendingSamples.splice(0, chunkSamples);
    sendAudioChunk(Int16Array.from(chunk));
  }
}

function sendAudioChunk(samples) {
  resetIdleTimer();
  state.ws.send(JSON.stringify({
    type: "audio",
    data: int16ToBase64(samples)
  }));
}

function handleLiveMessage(message) {
  if (message.type === "error") {
    setStatus(message.error || "Gemini Live 错误");
    return;
  }

  if (message.type === "english-partial") {
    state.currentEnglish = normalizeCaption(message.text);
    renderCaptions();
    return;
  }

  if (message.type === "english-final") {
    const text = normalizeCaption(message.text);
    if (text) {
      addCaption(text);
      addRecord({
        speaker: "User",
        originalText: state.currentChinese || "",
        translatedText: text,
        sourceLanguage: "zh",
        targetLanguage: "en"
      });
    }
    state.currentEnglish = "";
    state.currentChinese = "";
    state.playbackSourceLanguage = null;
    state.queuedAudio = [];
    renderChineseCaptions();
    renderCaptions();
    return;
  }

  if (message.type === "chinese-partial") {
    state.currentChinese = normalizeCaption(message.text);
    renderChineseCaptions();
    renderCaptions();
    return;
  }

  if (message.type === "chinese-final") {
    const text = normalizeCaption(message.text);
    if (state.currentEnglish) addCaption(state.currentEnglish);
    if (text) addChineseCaption(text);
    state.currentChinese = "";
    state.currentEnglish = "";
    state.playbackSourceLanguage = null;
    state.queuedAudio = [];
    addRecord({
      speaker: "Target",
      originalText: "",
      translatedText: text,
      sourceLanguage: "en",
      targetLanguage: "zh"
    });
    renderChineseCaptions();
    renderCaptions();
    return;
  }

  if (message.type === "source-partial") {
    const text = normalizeCaption(message.text);
    if (looksEnglish(text)) {
      state.playbackSourceLanguage = "en";
      state.currentEnglish = text;
      flushQueuedAudio();
      renderCaptions();
    } else if (text) {
      state.playbackSourceLanguage = "zh";
      state.queuedAudio = [];
      state.currentChinese = text;
      renderChineseCaptions();
    }
    return;
  }

  if (message.type === "audio" && message.data) {
    playTranslatedAudio(message.data, message.sampleRate || 24000);
  }
}

function addCaption(text) {
  if (isSameCaption(state.captions.at(-1)?.text, text)) return;
  state.captions.push({ id: crypto.randomUUID?.() || String(Date.now()), text });
  state.captions = state.captions.slice(-maxCaptions);
  localStorage.setItem("nancyCaptions", JSON.stringify(state.captions));
}

function addChineseCaption(text) {
  if (isSameCaption(state.chineseCaptions.at(-1)?.text, text)) return;
  state.chineseCaptions.push({ id: crypto.randomUUID?.() || String(Date.now()), text });
  state.chineseCaptions = state.chineseCaptions.slice(-maxChineseCaptions);
  localStorage.setItem("nancyChineseCaptions", JSON.stringify(state.chineseCaptions));
}

function renderCaptions(options = {}) {
  captionBoard.innerHTML = "";
  if (!state.captions.length && !state.currentEnglish) {
    captionBoard.appendChild(emptyCaption);
    emptyCaption.hidden = false;
  } else {
    emptyCaption.hidden = true;
  }

  for (const caption of state.captions) {
    const line = document.createElement("p");
    line.className = "caption-line complete";
    line.textContent = formatCaptionLines(caption.text);
    captionBoard.appendChild(line);
  }

  if (state.currentEnglish) {
    const line = document.createElement("p");
    line.className = "caption-line partial";
    line.textContent = formatCaptionLines(state.currentEnglish);
    captionBoard.appendChild(line);
  }

  if (options.forceScroll || state.captionAutoScroll) {
    captionBoard.scrollTop = captionBoard.scrollHeight;
  }
}

function renderChineseCaptions(options = {}) {
  const lines = state.chineseCaptions.map((caption) => formatCaptionLines(caption.text));
  if (state.currentChinese) lines.push(formatCaptionLines(state.currentChinese));
  confirmLine.textContent = lines.filter(Boolean).join("\n");
  if (options.forceScroll || state.chineseAutoScroll) {
    confirmLine.scrollTop = confirmLine.scrollHeight;
  }
}

function pauseListening() {
  state.listening = false;
  state.manualDisconnect = true;
  clearTimeout(state.idleTimer);
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "stop" }));
    state.ws.close();
  }
  cleanupAudio();
  setListeningUi(false);
  setStatus("已暂停");
}

function cleanupAudio() {
  state.processor?.disconnect();
  state.source?.disconnect();
  state.stream?.getTracks().forEach((track) => track.stop());
  state.audioContext?.close();
  state.stream = null;
  state.audioContext = null;
  state.source = null;
  state.processor = null;
  state.pendingSamples = [];
  state.queuedAudio = [];
  state.playbackSourceLanguage = null;
}

function addRecord(result) {
  const record = {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    time: new Date().toISOString(),
    speaker: result.speaker,
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
    const article = node.querySelector(".history-item");
    article.tabIndex = 0;
    article.addEventListener("click", () => showRecordOnScreen(item));
    article.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") showRecordOnScreen(item);
    });
    node.querySelector("time").textContent = formatTime(item.time);
    node.querySelector(".history-speaker").textContent = item.speaker === "User" ? "中文 -> 英文" : "English -> 中文";
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
  if (state.records.length) openHistory();
}

async function copySessionText() {
  const text = buildSessionText();
  try {
    await navigator.clipboard.writeText(text);
    setStatus("记录已复制");
  } catch {
    setStatus("复制失败，记录仍在页面里");
  }
}

function buildSessionText() {
  const lines = ["Nancy Translation Session", ""];
  state.records.forEach((item, index) => {
    const speaker = item.speaker === "User" ? "中文 -> 英文" : "English -> 中文";
    lines.push(`${index + 1}. ${formatTime(item.time)} ${speaker}`);
    if (item.originalText) lines.push(`原文：${item.originalText}`);
    lines.push(`翻译：${item.translatedText || ""}`, "");
  });
  return lines.join("\n");
}

function showRecordOnScreen(item) {
  if (item.targetLanguage === "en") {
    addCaption(item.translatedText);
    renderCaptions({ forceScroll: true });
  } else {
    addChineseCaption(item.translatedText);
    renderChineseCaptions({ forceScroll: true });
  }
  closeHistory();
}

function downsampleTo16BitPcm(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return floatTo16Bit(input);
  }
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const result = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < input.length; j += 1) {
      sum += input[j];
      count += 1;
    }
    result[i] = clampSample(sum / Math.max(1, count));
  }
  return result;
}

function floatTo16Bit(input) {
  const result = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    result[i] = clampSample(input[i]);
  }
  return result;
}

function clampSample(value) {
  const sample = Math.max(-1, Math.min(1, value || 0));
  return sample < 0 ? sample * 0x8000 : sample * 0x7fff;
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function playPcm24(base64, sampleRate) {
  if (!state.playbackContext) return;
  const bytes = base64ToBytes(base64);
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const buffer = state.playbackContext.createBuffer(1, samples.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) {
    channel[i] = samples[i] / 32768;
  }

  const source = state.playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(state.playbackContext.destination);
  const startAt = Math.max(state.playbackContext.currentTime + 0.02, state.playbackCursor);
  source.start(startAt);
  state.playbackCursor = startAt + buffer.duration;
}

function playTranslatedAudio(data, sampleRate) {
  if (state.playbackSourceLanguage === "zh") return;
  if (state.playbackSourceLanguage !== "en") {
    state.queuedAudio.push({ data, sampleRate });
    state.queuedAudio = state.queuedAudio.slice(-20);
    return;
  }
  playPcm24(data, sampleRate);
}

function flushQueuedAudio() {
  if (state.playbackSourceLanguage !== "en") return;
  const queued = state.queuedAudio.splice(0);
  for (const item of queued) playPcm24(item.data, item.sampleRate);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalizeCaption(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatCaptionLines(text) {
  const normalized = normalizeCaption(text);
  if (!normalized) return "";
  return normalized
    .replace(/([.!?。！？])\s+/g, "$1\n")
    .replace(/([.!?。！？])(?=[A-Z\u4e00-\u9fff])/g, "$1\n");
}

function looksEnglish(text) {
  const normalized = normalizeCaption(text);
  if (!normalized) return false;
  const latin = normalized.match(/[A-Za-z]/g)?.length || 0;
  const cjk = normalized.match(/[\u3400-\u9fff]/g)?.length || 0;
  return latin > 0 && latin >= cjk;
}

function isSameCaption(a, b) {
  return normalizeCaption(a).toLowerCase() === normalizeCaption(b).toLowerCase();
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = window.setTimeout(() => {
    if (state.listening) endConversation("idle");
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

function openHistory() {
  historySheet.classList.add("open");
  historySheet.setAttribute("aria-hidden", "false");
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatFileDate(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
