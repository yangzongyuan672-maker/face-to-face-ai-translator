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
const maxCaptions = 9;
const idleEndMs = 20 * 60 * 1000;

const state = {
  listening: false,
  ended: false,
  ws: null,
  stream: null,
  audioContext: null,
  source: null,
  processor: null,
  playbackContext: null,
  playbackCursor: 0,
  pendingSamples: [],
  idleTimer: null,
  sessionId: crypto.randomUUID?.() || String(Date.now()),
  sessionStartedAt: new Date().toISOString(),
  sessionEndedAt: null,
  currentEnglish: "",
  currentChinese: "",
  captions: JSON.parse(localStorage.getItem("nancyCaptions") || "[]"),
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
  state.currentEnglish = "";
  state.currentChinese = "";
  state.sessionStartedAt = new Date().toISOString();
  state.sessionEndedAt = null;
  localStorage.removeItem("translatorSessionRecords");
  localStorage.removeItem("nancyCaptions");
  renderCaptions();
  renderHistory();
});

exportButton.addEventListener("click", () => exportSessionDocument());

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
    }, 12000);

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
      if (state.listening) {
        setStatus("实时连接已断开");
        pauseListening();
      }
    });
  });
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
    renderCaptions();
    return;
  }

  if (message.type === "chinese-partial") {
    state.currentChinese = normalizeCaption(message.text);
    confirmLine.textContent = state.currentChinese;
    renderCaptions();
    return;
  }

  if (message.type === "chinese-final") {
    state.currentChinese = normalizeCaption(message.text);
    confirmLine.textContent = state.currentChinese;
    addRecord({
      speaker: "Target",
      originalText: "",
      translatedText: state.currentChinese,
      sourceLanguage: "en",
      targetLanguage: "zh"
    });
    return;
  }

  if (message.type === "source-partial" && !state.currentChinese) {
    confirmLine.textContent = normalizeCaption(message.text);
    return;
  }

  if (message.type === "audio" && message.data) {
    playPcm24(message.data, message.sampleRate || 24000);
  }
}

function addCaption(text) {
  state.captions.push({ id: crypto.randomUUID?.() || String(Date.now()), text });
  state.captions = state.captions.slice(-maxCaptions);
  localStorage.setItem("nancyCaptions", JSON.stringify(state.captions));
}

function renderCaptions() {
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
    line.textContent = caption.text;
    captionBoard.appendChild(line);
  }

  if (state.currentEnglish) {
    const line = document.createElement("p");
    line.className = "caption-line partial";
    line.textContent = state.currentEnglish;
    captionBoard.appendChild(line);
  }

  captionBoard.scrollTop = captionBoard.scrollHeight;
}

function pauseListening() {
  state.listening = false;
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
  if (state.records.length) exportSessionDocument();
}

function exportSessionDocument() {
  const endedAt = state.sessionEndedAt || new Date().toISOString();
  const documentText = buildSessionDocument(endedAt);
  const blob = new Blob([documentText], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `nancy-conversation-${formatFileDate(state.sessionStartedAt)}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildSessionDocument(endedAt) {
  const start = new Date(state.sessionStartedAt);
  const end = new Date(endedAt);
  const lines = [
    "# Nancy Translation Session",
    "",
    `- Session ID: ${state.sessionId}`,
    `- Date: ${start.toLocaleDateString("zh-CN")}`,
    `- Time Range: ${start.toLocaleTimeString("zh-CN", { hour12: false })} - ${end.toLocaleTimeString("zh-CN", { hour12: false })}`,
    "",
    "## Dialogue",
    ""
  ];

  state.records.forEach((item, index) => {
    const speaker = item.speaker === "User" ? "中文 -> 英文" : "English -> 中文";
    lines.push(`### ${index + 1}. ${formatTime(item.time)} ${speaker}`);
    if (item.originalText) lines.push(`- Original: ${item.originalText}`);
    lines.push(`- Translation: ${item.translatedText}`);
    lines.push("");
  });

  return lines.join("\n");
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

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function normalizeCaption(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
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

function formatTime(value) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatFileDate(value) {
  return new Date(value).toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
