const state = {
  subject: null,
  session: null,
  stimuli: [],
  queue: [],
  currentIndex: 0,
  promptMode: "text_prompt",
  stream: null,
  audioContext: null,
  analyser: null,
  source: null,
  mediaRecorder: null,
  recordingStartedAt: null,
  chunks: [],
  lastBlob: null,
  lastQc: null,
  noiseRms: null,
  records: [],
  sessions: [],
  selectedSessionKey: "all",
  selectedTrial: null,
  sessionRecordingActive: false,
  selectedErrorTypes: [],
  lastAnnotator: localStorage.getItem("phoneme_last_annotator") || "",
  lastReviewer: localStorage.getItem("phoneme_last_reviewer") || "",
};

const $ = (id) => document.getElementById(id);

function formDataObject(form) {
  const data = new FormData(form);
  const out = {};
  for (const [key, value] of data.entries()) out[key] = value;
  for (const input of form.querySelectorAll('input[type="checkbox"]')) {
    out[input.name || input.id] = input.checked;
  }
  return out;
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const ch of String(seedText)) {
    seed ^= ch.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, seed) {
  const arr = [...items];
  const rand = seededRandom(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function api(path, method = "GET", body = null) {
  const res = await fetch(path, {
    method,
    headers: body ? {"Content-Type": "application/json"} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function setRole(role) {
  document.querySelectorAll(".role").forEach((btn) => btn.classList.toggle("active", btn.dataset.role === role));
  document.querySelectorAll(".role-panel").forEach((panel) => panel.classList.add("hidden"));
  $(`${role}Panel`).classList.remove("hidden");
  if (role === "admin") loadAnnotationData();
}

function updateIdentity() {
  $("currentSubject").textContent = state.subject?.subject_id || "未创建";
  $("currentSession").textContent = state.session?.session_id || "session 未开始";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthDefault() {
  const d = new Date();
  return `${d.getFullYear() - 60}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function saveSubject(event) {
  event.preventDefault();
  const payload = formDataObject(event.currentTarget);
  payload.role_scope = ["patient", "therapist", "admin"];
  await api("/api/subjects", "POST", payload);
  state.subject = payload;
  updateIdentity();
  setRole("therapist");
}

async function ensureMic() {
  if (state.stream) return state.stream;
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false},
  });
  state.audioContext = new AudioContext();
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 2048;
  state.source = state.audioContext.createMediaStreamSource(state.stream);
  state.source.connect(state.analyser);
  drawLiveMeter();
  $("deviceStep").classList.add("done");
  markStepDone("micBtn");
  suggestNextStep();
  return state.stream;
}

function readAnalyserRms(seconds = 1) {
  return new Promise((resolve) => {
    const values = [];
    const buf = new Float32Array(state.analyser.fftSize);
    const until = performance.now() + seconds * 1000;
    function tick() {
      state.analyser.getFloatTimeDomainData(buf);
      values.push(metricsFromSamples(buf));
      if (performance.now() < until) requestAnimationFrame(tick);
      else resolve(summarizeMetrics(values));
    }
    tick();
  });
}

function metricsFromSamples(samples) {
  let sum = 0;
  let peak = 0;
  for (const sample of samples) {
    const abs = Math.abs(sample);
    sum += sample * sample;
    if (abs > peak) peak = abs;
  }
  return {
    rms: Math.sqrt(sum / samples.length),
    peak,
    clipping: peak >= 0.98,
  };
}

function summarizeMetrics(values) {
  const rms = values.reduce((sum, v) => sum + v.rms, 0) / values.length;
  const peak = Math.max(...values.map((v) => v.peak));
  return {rms, peak, clipping: values.some((v) => v.clipping)};
}

function db(value) {
  return 20 * Math.log10(Math.max(value, 0.000001));
}

function snrDb(signalRms, noiseRms) {
  return db(signalRms) - db(noiseRms || 0.000001);
}

async function captureSilence() {
  await ensureMic();
  $("noiseMetric").textContent = "采集中...";
  const m = await readAnalyserRms(5);
  state.noiseRms = m.rms;
  $("noiseMetric").textContent = `${db(m.rms).toFixed(1)} dBFS`;
  markStepDone("silenceBtn");
  suggestNextStep();
}

async function createSession() {
  if (!state.subject) {
    alert("请先保存匿名被试信息。");
    setRole("patient");
    return;
  }
  const date = today().replaceAll("-", "");
  state.session = {
    subject_id: state.subject.subject_id,
    session_id: `${date}-A`,
    assessment_date: $("subjectForm").assessment_date.value || today(),
    device_type: $("deviceType").value,
    noise_floor_dbfs: state.noiseRms === null ? null : Number(db(state.noiseRms).toFixed(2)),
    random_seed: $("randomSeed").value,
  };
  await api("/api/sessions", "POST", state.session);
  updateIdentity();
  resetSessionStepState();
  markStepDone("newSessionBtn");
  suggestNextStep();
}

async function testRecord() {
  await ensureMic();
  $("volumeMetric").textContent = "请说：我准备好了";
  const m = await readAnalyserRms(3);
  const snr = snrDb(m.rms, state.noiseRms);
  $("volumeMetric").textContent = `${db(m.rms).toFixed(1)} dBFS`;
  $("snrMetric").textContent = Number.isFinite(snr) ? `${snr.toFixed(1)} dB` : "缺少静音基线";
  $("clipMetric").textContent = m.clipping ? "有削波" : "无削波";
  markStepDone("testRecordBtn");
  suggestNextStep();
}

function buildTaskQueue() {
  if (!state.session) {
    alert("请先新建 session。");
    return;
  }
  const reps = $("reduceFatigue").checked ? 1 : Number($("repetitions").value);
  const expanded = [];
  for (const item of state.stimuli) {
    for (let rep = 1; rep <= reps; rep++) expanded.push({...item, repetition_index: rep});
  }
  state.queue = shuffle(expanded, $("randomSeed").value);
  state.currentIndex = 0;
  $("taskSummary").textContent = `${state.queue.length} 个试次，随机种子 ${$("randomSeed").value}`;
  $("taskStep").classList.add("done");
  renderCurrentTrial();
  markStepDone("buildTaskBtn");
  suggestButton("startBtn", "任务已生成。请点击“开始录音”，开始第一个字。");
}

function renderCurrentTrial() {
  const item = state.queue[state.currentIndex];
  state.lastBlob = null;
  state.lastQc = null;
  if (!item) {
    $("wordCue").textContent = "完成";
    $("stimulusMeta").textContent = "任务已完成";
    return;
  }
  $("promptModeText").textContent = "汉字提示";
  $("wordCue").textContent = item.word;
  $("stimulusMeta").textContent = `${state.currentIndex + 1}/${state.queue.length} · ${item.contrast_group} · rep${item.repetition_index}`;
  $("liveQc").textContent = "等待录音";
  clearCanvas($("waveCanvas"));
}

function currentTrialId() {
  const item = state.queue[state.currentIndex];
  if (!item || !state.subject || !state.session) return "";
  return `${state.subject.subject_id}_${item.id}_rep${item.repetition_index}_${String(state.currentIndex + 1).padStart(3, "0")}`;
}

function resetSessionStepState() {
  state.sessionRecordingActive = false;
  ["micBtn", "silenceBtn", "testRecordBtn", "newSessionBtn", "buildTaskBtn", "startBtn", "nextBtn", "retryBtn", "saveSessionBtn"].forEach((id) => {
    const el = $(id);
    if (el) el.classList.remove("suggested", "clicked-step");
  });
  $("therapistStepHint").textContent = "新 session 已创建。请完成设备检测，随后生成随机任务。";
}

function markStepDone(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove("suggested");
  el.classList.add("clicked-step");
}

function suggestButton(id, message) {
  document.querySelectorAll(".suggested").forEach((el) => el.classList.remove("suggested"));
  const el = $(id);
  if (el) {
    el.classList.remove("clicked-step");
    el.classList.add("suggested");
  }
  $("therapistStepHint").textContent = message;
}

function suggestNextStep() {
  if (!state.stream) return suggestButton("micBtn", "请先点击“获取麦克风权限”。");
  if (state.noiseRms === null) return suggestButton("silenceBtn", "请点击“采集 5 秒静音”，建立环境噪声基线。");
  if (!$("testRecordBtn").classList.contains("clicked-step")) return suggestButton("testRecordBtn", "请点击试录，确认音量、SNR 和削波情况。");
  if (!state.session) return suggestButton("newSessionBtn", "设备检查完成。请点击“新建 Session”。");
  if (!state.queue.length) return suggestButton("buildTaskBtn", "请点击“生成随机任务”。");
  if (!state.sessionRecordingActive) return suggestButton("startBtn", "请点击“开始录音”，开始本 session 的第一个字。");
}

function goPrevTrial() {
  if (state.currentIndex > 0) {
    state.currentIndex -= 1;
    renderCurrentTrial();
  }
}

function goNextTrialWithoutSave() {
  if (state.currentIndex < state.queue.length - 1) {
    state.currentIndex += 1;
    renderCurrentTrial();
  }
}

function toggleRecording() {
  if (state.mediaRecorder?.state === "recording") stopRecording();
  else startRecording();
}

function isTypingTarget(target) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
}

function handleKeyboard(event) {
  if (isTypingTarget(event.target)) return;
  if ($("therapistPanel").classList.contains("hidden")) return;
  if (event.code === "Space") {
    event.preventDefault();
    toggleRecording();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    goPrevTrial();
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    saveAndNext();
  }
}

function setErrorTypes(values) {
  state.selectedErrorTypes = [...new Set(values.filter(Boolean))];
  $("annErrorType").value = state.selectedErrorTypes.join(",");
  document.querySelectorAll("#errorTypeChips button").forEach((btn) => {
    btn.classList.toggle("active", state.selectedErrorTypes.includes(btn.dataset.value));
  });
}

function toggleErrorType(value) {
  if (!value) return;
  const next = state.selectedErrorTypes.includes(value)
    ? state.selectedErrorTypes.filter((item) => item !== value)
    : [...state.selectedErrorTypes, value];
  setErrorTypes(next);
}

function supportedMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function startRecording() {
  if (!state.queue[state.currentIndex]) return;
  await ensureMic();
  state.chunks = [];
  const mimeType = supportedMime();
  state.mediaRecorder = new MediaRecorder(state.stream, mimeType ? {mimeType} : undefined);
  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size) state.chunks.push(event.data);
  };
  state.mediaRecorder.onstop = async () => {
    state.lastBlob = new Blob(state.chunks, {type: state.mediaRecorder.mimeType || "audio/webm"});
    const durationMs = state.recordingStartedAt ? Math.round(performance.now() - state.recordingStartedAt) : null;
    const m = await readAnalyserRms(0.2);
    const snr = snrDb(m.rms, state.noiseRms);
    state.lastQc = {
      rms_dbfs: Number(db(m.rms).toFixed(2)),
      peak: Number(m.peak.toFixed(4)),
      snr_db: Number.isFinite(snr) ? Number(snr.toFixed(2)) : null,
      clipping: m.clipping,
      duration_ms: durationMs,
      silence: m.rms < 0.01,
    };
    $("liveQc").textContent = qcText(state.lastQc);
    drawBlobWaveform(state.lastBlob, $("waveCanvas"));
  };
  state.mediaRecorder.start();
  state.sessionRecordingActive = true;
  state.recordingStartedAt = performance.now();
  $("startBtn").disabled = true;
  $("stopBtn").disabled = false;
  $("liveQc").textContent = "录音中...";
  markStepDone("startBtn");
  suggestButton("nextBtn", "当前字正在录音。读完后按 → 或点击“保存当前字并下一题”。");
}

function stopRecording() {
  if (state.mediaRecorder?.state === "recording") state.mediaRecorder.stop();
  $("startBtn").disabled = false;
  $("stopBtn").disabled = true;
}

function waitForLastBlob(timeoutMs = 2500) {
  const start = performance.now();
  return new Promise((resolve) => {
    function tick() {
      if (state.lastBlob) resolve(true);
      else if (performance.now() - start > timeoutMs) resolve(false);
      else setTimeout(tick, 40);
    }
    tick();
  });
}

function qcText(qc) {
  const parts = [`音量 ${qc.rms_dbfs} dBFS`];
  if (qc.snr_db !== null) parts.push(`SNR ${qc.snr_db} dB`);
  parts.push(qc.clipping ? "有削波" : "无削波");
  if (qc.silence) parts.push("疑似静音");
  return parts.join(" · ");
}

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  return arrayBufferToBase64(buffer);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function writeString(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function audioBufferToWav(audioBuffer) {
  const channels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.getChannelData(0);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

async function blobToWavBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(buffer.slice(0));
  const wav = audioBufferToWav(audio);
  await ctx.close();
  return arrayBufferToBase64(wav);
}

function retryRecording() {
  if (state.mediaRecorder?.state === "recording") stopRecording();
  state.lastBlob = null;
  state.lastQc = null;
  $("liveQc").textContent = "已清空本题录音，正在重新录当前字。";
  clearCanvas($("waveCanvas"));
  markStepDone("retryBtn");
  startRecording();
}

async function saveAndNext() {
  const item = state.queue[state.currentIndex];
  if (state.mediaRecorder?.state === "recording") {
    stopRecording();
    await waitForLastBlob();
  }
  if (!item || !state.lastBlob) {
    alert("请先完成本试次录音。");
    return;
  }
  const trialId = currentTrialId();
  const instant = document.querySelector('input[name="instantMark"]:checked')?.value || "";
  const wavBase64 = await blobToWavBase64(state.lastBlob);
  const payload = {
    subject_id: state.subject.subject_id,
    session_id: state.session.session_id,
    trial_id: trialId,
    stimulus_id: item.id,
    word: item.word,
    pinyin: item.pinyin,
    target_initial: item.target_initial,
    target_final: item.target_final,
    target_tone: item.target_tone,
    target_attributes: item.target_attributes,
    contrast_group: item.contrast_group,
    prompt_mode: "text_prompt",
    repetition_index: item.repetition_index,
    sample_rate: state.audioContext?.sampleRate || null,
    mime_type: state.lastBlob.type || "audio/webm",
    snr_db: state.lastQc?.snr_db,
    clipping: state.lastQc?.clipping,
    duration_ms: state.lastQc?.duration_ms,
    qc: state.lastQc,
    therapist_mark: instant,
    completed_after_cue: $("completedAfterCue").checked,
    fatigue: $("fatigueMark").checked,
    attention_problem: $("attentionMark").checked,
    therapist_transcription: "",
    error_type: "",
    error_direction: "",
    label_confidence: null,
    audio_base64: await blobToBase64(state.lastBlob),
    wav_base64: wavBase64,
  };
  await api("/api/trials", "POST", payload);
  markStepDone("nextBtn");
  state.currentIndex += 1;
  $("completedAfterCue").checked = false;
  $("fatigueMark").checked = false;
  $("attentionMark").checked = false;
  renderCurrentTrial();
  if (state.currentIndex < state.queue.length) {
    await startRecording();
  } else {
    state.sessionRecordingActive = false;
    suggestButton("saveSessionBtn", "本 session 的试次已完成。请点击“保存此session”。");
  }
}

async function finalizeSession() {
  if (state.mediaRecorder?.state === "recording") stopRecording();
  if (!state.session || !state.subject) {
    alert("当前没有可保存的 session。");
    return;
  }
  await api("/api/finalize_session", "POST", {
    subject_id: state.subject.subject_id,
    session_id: state.session.session_id,
    finalized_by: "therapist",
  });
  markStepDone("saveSessionBtn");
  $("therapistStepHint").textContent = "此 session 已保存。可以切换到标注员端查看 manifest 和音频。";
}

function drawLiveMeter() {
  const buf = new Float32Array(state.analyser.fftSize);
  function tick() {
    if (!state.analyser) return;
    state.analyser.getFloatTimeDomainData(buf);
    const m = metricsFromSamples(buf);
    const pct = Math.min(100, Math.round(m.rms * 420));
    $("meterBar").style.width = `${pct}%`;
    $("meterBar").style.background = m.clipping ? "var(--bad)" : pct > 78 ? "var(--warn)" : "var(--ok)";
    if (state.mediaRecorder?.state === "recording") drawSamples(buf, $("waveCanvas"));
    requestAnimationFrame(tick);
  }
  tick();
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawSamples(samples, canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#2d5fb8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  const mid = canvas.height / 2;
  for (let i = 0; i < samples.length; i++) {
    const x = (i / (samples.length - 1)) * canvas.width;
    const y = mid + samples[i] * mid * 0.86;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

async function drawBlobWaveform(blob, canvas) {
  try {
    const buffer = await blob.arrayBuffer();
    const ctx = new AudioContext();
    const audio = await ctx.decodeAudioData(buffer.slice(0));
    const channel = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(channel.length / canvas.width));
    const reduced = new Float32Array(canvas.width);
    for (let x = 0; x < canvas.width; x++) {
      let peak = 0;
      for (let i = x * step; i < Math.min(channel.length, (x + 1) * step); i++) {
        peak = Math.max(peak, Math.abs(channel[i]));
      }
      reduced[x] = peak;
    }
    drawSamples(reduced, canvas);
    await ctx.close();
  } catch {
    clearCanvas(canvas);
  }
}

async function loadAnnotationData() {
  await Promise.all([loadSessions(), loadRecords()]);
}

async function loadSessions() {
  const payload = await api("/api/sessions_index");
  state.sessions = payload.sessions;
  renderSessions();
}

function renderSessions() {
  const list = $("sessionList");
  list.innerHTML = "";
  const allBtn = document.createElement("button");
  allBtn.className = `session-item ${state.selectedSessionKey === "all" ? "active" : ""}`;
  allBtn.innerHTML = `<strong>全部 session</strong><span>${state.sessions.length} 个 session</span>`;
  allBtn.addEventListener("click", () => {
    state.selectedSessionKey = "all";
    renderSessions();
    renderRecords();
  });
  list.appendChild(allBtn);
  for (const session of state.sessions) {
    const key = `${session.subject_id}::${session.session_id}`;
    const btn = document.createElement("button");
    btn.className = `session-item ${state.selectedSessionKey === key ? "active" : ""}`;
    btn.innerHTML = `<strong>${session.subject_id} / ${session.session_id}</strong><span>${session.trial_count} 条 · 删除 ${session.deleted_count} · ${session.finalized_at ? "已保存" : "未结束"}</span>`;
    btn.addEventListener("click", () => {
      state.selectedSessionKey = key;
      renderSessions();
      renderRecords();
    });
    list.appendChild(btn);
  }
}

async function loadRecords() {
  const payload = await api("/api/records");
  state.records = payload.trials;
  renderRecords();
}

function renderRecords() {
  const list = $("recordList");
  list.innerHTML = "";
  const visible = state.records.filter((trial) => {
    if (trial.deleted) return false;
    if (state.selectedSessionKey === "all") return true;
    return `${trial.subject_id}::${trial.session_id}` === state.selectedSessionKey;
  });
  if (!visible.length) {
    list.innerHTML = '<p class="hint">暂无录音记录。</p>';
    return;
  }
  for (const trial of visible.slice().reverse()) {
    const btn = document.createElement("button");
    btn.className = "record-item";
    btn.innerHTML = `<strong>${trial.word} · ${trial.trial_id}</strong><span>${trial.subject_id}/${trial.session_id} · ${trial.pinyin} · ${trial.annotation?.annotator || "未标注"}</span>`;
    btn.addEventListener("click", () => selectTrial(trial, btn));
    list.appendChild(btn);
  }
}

function selectTrial(trial, button) {
  state.selectedTrial = trial;
  document.querySelectorAll(".record-item").forEach((el) => el.classList.remove("active"));
  button.classList.add("active");
  $("audioPlayer").src = trial.audio_path ? `/file/${trial.audio_path}` : "";
  if (trial.wav_path) {
    $("spectrogramStatus").textContent = "语谱图生成中...";
    $("spectrogramImage").classList.remove("hidden");
    $("spectrogramImage").src = `/api/spectrogram?subject_id=${encodeURIComponent(trial.subject_id)}&session_id=${encodeURIComponent(trial.session_id)}&trial_id=${encodeURIComponent(trial.trial_id)}&t=${Date.now()}`;
    $("spectrogramImage").onload = () => {
      $("spectrogramStatus").textContent = "语谱图：亮色点为 F1/F2/F3 共振峰轨迹。";
    };
    $("spectrogramImage").onerror = () => {
      $("spectrogramImage").classList.add("hidden");
      $("spectrogramStatus").textContent = "语谱图生成失败，请确认 WAV 文件存在且 parselmouth 可用。";
    };
  } else {
    $("spectrogramImage").classList.add("hidden");
    $("spectrogramStatus").textContent = "该记录没有 WAV 文件，无法生成 Praat/parselmouth 语谱图。";
  }
  $("annWord").value = trial.word || "";
  $("annTarget").value = `${trial.target_initial || "零声母"}${trial.target_final || ""}${trial.target_tone || ""}`;
  $("annInitial").value = trial.target_initial || "零声母";
  $("annFinal").value = trial.target_final || "";
  $("annTone").value = trial.target_tone || "";
  const perceived = trial.perceived_reading || {};
  $("annActualInitial").value = perceived.initial || trial.target_initial || "零声母";
  $("annActualFinal").value = perceived.final || trial.target_final || "";
  $("annActualTone").value = perceived.tone || trial.target_tone || "";
  $("annActual").value = trial.therapist_transcription || perceived.pinyin || trial.pinyin || "";
  setErrorTypes(trial.error_types || (trial.error_type ? String(trial.error_type).split(",").filter(Boolean) : []));
  $("annAnnotator").value = trial.annotation?.annotator || state.lastAnnotator;
  $("annReviewer").value = trial.adjudication?.reviewer || state.lastReviewer;
  $("annAdjudication").value = trial.adjudication?.note || "";
}

async function deleteSelectedSample() {
  if (!state.selectedTrial) return;
  await api("/api/delete_trial", "POST", {
    subject_id: state.selectedTrial.subject_id,
    session_id: state.selectedTrial.session_id,
    trial_id: state.selectedTrial.trial_id,
    reason: "建议重录",
  });
  state.selectedTrial = null;
  $("audioPlayer").removeAttribute("src");
  $("spectrogramImage").classList.add("hidden");
  $("spectrogramStatus").textContent = "已删除该音频样本，manifest 中已标记建议重录。";
  await loadAnnotationData();
}

async function saveAnnotation(event) {
  event.preventDefault();
  if (!state.selectedTrial) return;
  state.lastAnnotator = $("annAnnotator").value || state.lastAnnotator;
  state.lastReviewer = $("annReviewer").value || state.lastReviewer;
  localStorage.setItem("phoneme_last_annotator", state.lastAnnotator);
  localStorage.setItem("phoneme_last_reviewer", state.lastReviewer);
  const updated = {
    subject_id: state.selectedTrial.subject_id,
    session_id: state.selectedTrial.session_id,
    trial_id: state.selectedTrial.trial_id,
    perceived_reading: {
      initial: $("annActualInitial").value,
      final: $("annActualFinal").value,
      tone: $("annActualTone").value,
      pinyin: $("annActual").value,
    },
    therapist_transcription: $("annActual").value,
    error_type: state.selectedErrorTypes.join(","),
    error_types: state.selectedErrorTypes,
    annotation: {
      annotator: state.lastAnnotator,
      status: state.selectedErrorTypes.length ? "error" : "correct",
    },
    adjudication: {
      reviewer: state.lastReviewer,
      note: $("annAdjudication").value,
    },
  };
  await api("/api/annotations", "POST", updated);
  $("labelStep").classList.add("done");
  await loadAnnotationData();
}

async function init() {
  $("subjectForm").assessment_date.value = today();
  $("subjectForm").birth_month.value = monthDefault();
  state.stimuli = (await api("/api/stimuli")).stimuli;
  document.querySelectorAll(".role").forEach((btn) => btn.addEventListener("click", () => setRole(btn.dataset.role)));
  $("subjectForm").addEventListener("submit", saveSubject);
  $("micBtn").addEventListener("click", ensureMic);
  $("silenceBtn").addEventListener("click", captureSilence);
  $("testRecordBtn").addEventListener("click", testRecord);
  $("newSessionBtn").addEventListener("click", createSession);
  $("buildTaskBtn").addEventListener("click", buildTaskQueue);
  $("startBtn").addEventListener("click", startRecording);
  $("stopBtn").addEventListener("click", stopRecording);
  $("retryBtn").addEventListener("click", retryRecording);
  $("prevBtn").addEventListener("click", goPrevTrial);
  $("nextBtn").addEventListener("click", saveAndNext);
  $("saveSessionBtn").addEventListener("click", finalizeSession);
  $("exportBtn").addEventListener("click", loadRecords);
  $("reloadRecordsBtn").addEventListener("click", loadAnnotationData);
  document.querySelectorAll("#errorTypeChips button").forEach((btn) => btn.addEventListener("click", () => toggleErrorType(btn.dataset.value)));
  $("deleteSampleBtn").addEventListener("click", deleteSelectedSample);
  $("annotationForm").addEventListener("submit", saveAnnotation);
  window.addEventListener("keydown", handleKeyboard);
  updateIdentity();
  setErrorTypes([]);
  suggestNextStep();
}

init().catch((err) => {
  console.error(err);
  alert(`初始化失败：${err.message}`);
});
