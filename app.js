// Dictation prototype, Phase 1 (browser).
// Hold to talk -> record in memory -> decode to 16 kHz -> Whisper in a worker -> rule-based
// cleanup -> insert at the cursor. Audio is never uploaded and never written to disk.
import { cleanup, parseCustomWords, spacedInsertion, MAX_CUSTOM_WORDS } from './cleanup.js';

/* ---------- constants. [PROPOSED] values come from the requirements document ---------- */
const MIN_HOLD_MS = 150; // [PROPOSED] shorter holds are treated as accidental taps (TC-DICT-003/004)
const MAX_RECORD_MS = 60_000; // [PROPOSED] recording stops here (TC-DICT-007)
const SILENCE_PEAK = 0.01; // a recording that never rises above this is treated as silent
const TARGET_CAPTURE_MS = 200; // SRS-001
const TARGET_TEXT_MS = 1000; // SRS-101
const MAX_TRIALS = 200;
const MODELS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
};
const STORE_KEY = 'dictation.phase1.v1';
const DEFAULTS = {
  model: 'small',
  language: 'auto',
  speed: 'cpu',
  fillers: true,
  capitalize: true,
  punctuate: true,
  warmMic: false,
  customWords: '',
  loadedKey: '',
};

/* ---------- page elements ---------- */
const IDS = [
  'talk', 'talkLabel', 'talkHint', 'recTimer', 'jobStatus', 'banner', 'target', 'copyBtn', 'clearBtn',
  'rawText', 'cleanText', 'statCapture', 'statText', 'statAudio', 'statReset',
  'modelPill', 'enginePill', 'netPill', 'loadBox', 'loadBtn', 'progressBar', 'progressText',
  'modelSelect', 'langSelect', 'speedSelect', 'optFillers', 'optCapitalize', 'optPunctuate', 'optWarmMic',
  'customWords', 'customWordsMsg',
];
const els = {};
for (const id of IDS) {
  els[id] = document.getElementById(id);
  if (!els[id]) console.error(`Missing element #${id}`);
}

/* ---------- settings (settings and custom words only; never audio or text) ---------- */
const settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(STORE_KEY) || '{}'));
} catch {
  /* storage unavailable: defaults apply for this visit */
}
function saveSettings() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}
let customEntries = parseCustomWords(settings.customWords).entries;

/* ---------- small helpers ---------- */
function showBanner(kind, text) {
  els.banner.dataset.kind = kind;
  els.banner.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  els.banner.textContent = text;
  els.banner.hidden = false;
}
function clearBanner() {
  els.banner.hidden = true;
  els.banner.textContent = '';
}
const fmtMs = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

/* ---------- speech engine (worker) ---------- */
const engine = (() => {
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let onProgress = () => {};

  function rejectAll(error) {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  }
  function ensure() {
    if (worker) return worker;
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const m = event.data;
      if (m.type === 'progress') return onProgress(m.progress);
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    worker.onerror = (event) => {
      const reason = event.message || 'its code could not be loaded. Check your internet connection for the first load';
      worker = null;
      rejectAll(new Error(`The speech engine stopped: ${reason}.`));
    };
    return worker;
  }
  function call(message, transfer = []) {
    const w = ensure();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ ...message, id }, transfer);
    });
  }
  return {
    setProgressHandler: (fn) => { onProgress = fn; },
    load: (model, device) => call({ type: 'load', model, device }),
    transcribe: (audio, language) => call({ type: 'transcribe', audio, language }, [audio.buffer]),
  };
})();

/* ---------- model loading ---------- */
const model = { state: 'idle', device: '' }; // idle | loading | ready | error
const downloadedFiles = new Map();

function renderModel() {
  const names = { idle: 'Model not loaded', loading: 'Loading model…', ready: `Model ready · ${settings.model}`, error: 'Model failed to load' };
  els.modelPill.textContent = names[model.state];
  els.modelPill.dataset.state = model.state;
  els.enginePill.textContent = model.state === 'ready' ? (model.device === 'webgpu' ? 'GPU (WebGPU)' : 'CPU (WASM)') : 'Engine idle';
  els.loadBox.hidden = model.state === 'ready';
  els.loadBtn.disabled = model.state === 'loading';
  els.loadBtn.textContent = model.state === 'error' ? 'Try again' : 'Load speech model';
  const loading = model.state === 'loading';
  els.progressBar.hidden = !loading;
  els.progressText.hidden = !loading;
}

engine.setProgressHandler((p) => {
  if (!p || !p.file) return;
  if (p.status === 'progress' && Number.isFinite(p.total) && p.total > 0) {
    downloadedFiles.set(p.file, { loaded: p.loaded, total: p.total });
  } else if (p.status === 'done') {
    const f = downloadedFiles.get(p.file);
    if (f) f.loaded = f.total;
  }
  let loaded = 0;
  let total = 0;
  for (const f of downloadedFiles.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  if (total > 0) {
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    els.progressBar.value = pct;
    els.progressText.textContent = `Downloading the model: ${pct}% (${(loaded / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`;
  }
});

async function loadModel() {
  if (model.state === 'loading') return;
  const key = `${settings.model}:${settings.speed}`;
  model.state = 'loading';
  downloadedFiles.clear();
  els.progressBar.value = 0;
  els.progressText.textContent = 'Preparing the model…';
  clearBanner();
  renderModel();
  try {
    const info = await engine.load(MODELS[settings.model], settings.speed === 'gpu' ? 'webgpu' : 'wasm');
    model.state = 'ready';
    model.device = info.device;
    settings.loadedKey = key;
    saveSettings();
    if (info.note) showBanner('info', info.note);
  } catch (err) {
    model.state = 'error';
    const advice = navigator.onLine
      ? 'Reload the page and try again.'
      : 'You are offline. The first load needs a connection to download the model.';
    showBanner('error', `The speech model could not be loaded. ${advice} Details: ${err.message}`);
  }
  renderModel();
}

function modelSelectionChanged() {
  model.state = 'idle';
  renderModel();
  if (settings.loadedKey === `${settings.model}:${settings.speed}`) loadModel();
}

/* ---------- microphone ---------- */
let warmStream = null;

function describeMicError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Click the lock icon in the address bar, allow the microphone for this site, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect one, or choose an input in your system sound settings, then try again.';
    case 'NotReadableError':
      return 'The microphone is in use by another app or could not be opened. Close other apps that use it and try again.';
    default:
      return `The microphone could not be started (${err?.name || 'unknown error'}).`;
  }
}

async function getStream() {
  if (warmStream && warmStream.getAudioTracks().some((t) => t.readyState === 'live')) return warmStream;
  if (!navigator.mediaDevices?.getUserMedia) {
    const e = new Error('insecure');
    e.name = 'SecurityError';
    throw e;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (settings.warmMic) warmStream = stream;
  return stream;
}
function releaseStream(stream) {
  if (!stream || (settings.warmMic && stream === warmStream)) return;
  stream.getTracks().forEach((t) => t.stop());
}
function dropWarmStream() {
  if (warmStream) warmStream.getTracks().forEach((t) => t.stop());
  warmStream = null;
}
function pickMimeType() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  return options.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

/* ---------- talk button state ---------- */
let session = null; // the recording currently being made or opened
let jobCount = 0; // transcriptions waiting or running

function setTalkState(state) {
  els.talk.dataset.state = state;
  els.talkLabel.textContent = {
    idle: 'Hold to talk',
    starting: 'Opening microphone…',
    recording: 'Listening… release to insert',
  }[state];
}
function renderJobs() {
  els.jobStatus.textContent = jobCount > 0 ? 'Transcribing…' : '';
}

/* ---------- capture ---------- */
function captureSupported() {
  return typeof window.MediaRecorder !== 'undefined' && typeof window.OfflineAudioContext !== 'undefined';
}

async function startCapture(via, code) {
  if (session) return;
  if (!captureSupported()) {
    showBanner('error', 'This browser cannot record audio. Use a current version of Chrome, Edge or Safari.');
    return;
  }
  if (model.state !== 'ready') {
    showBanner(
      'error',
      model.state === 'loading'
        ? 'The speech model is still loading. Wait for it to finish, then try again.'
        : 'Load the speech model first, using the button above.',
    );
    return;
  }
  const s = { via, code, t0: performance.now(), released: false, done: false, chunks: [], recorder: null, stream: null, tStart: 0, tRelease: 0, timerId: 0, stopId: 0 };
  session = s;
  clearBanner();
  setTalkState('starting');

  try {
    s.stream = await getStream();
  } catch (err) {
    session = null;
    setTalkState('idle');
    showBanner('error', describeMicError(err));
    return;
  }
  if (s.released) {
    // let go before the microphone opened: treat as a tap
    releaseStream(s.stream);
    if (session === s) session = null;
    setTalkState('idle');
    return;
  }

  const mimeType = pickMimeType();
  try {
    s.recorder = new MediaRecorder(s.stream, mimeType ? { mimeType } : undefined);
  } catch (err) {
    releaseStream(s.stream);
    session = null;
    setTalkState('idle');
    showBanner('error', `Recording could not start (${err.name || 'unknown error'}).`);
    return;
  }
  s.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) s.chunks.push(e.data);
  };
  s.recorder.onstart = () => {
    s.tStart = performance.now();
    recordTrial('capture', s.tStart - s.t0);
    setTalkState('recording');
    els.recTimer.hidden = false;
    els.recTimer.textContent = '0:00';
    s.timerId = setInterval(() => {
      els.recTimer.textContent = `${clock(performance.now() - s.tStart)} / ${clock(MAX_RECORD_MS)}`;
    }, 200);
    s.stopId = setTimeout(() => {
      showBanner('info', `Recording stopped at ${MAX_RECORD_MS / 1000} seconds. Release and press again to keep going.`);
      stopCapture();
    }, MAX_RECORD_MS);
  };
  s.recorder.onstop = () => finishCapture(s);
  s.recorder.onerror = () => {
    showBanner('error', 'Recording failed. Nothing was inserted.');
    s.chunks = [];
    finishCapture(s);
  };
  s.recorder.start();
}

function stopCapture(code) {
  const s = session;
  if (!s || (code && s.code !== code)) return;
  s.released = true;
  s.tRelease = performance.now();
  if (!s.recorder) return; // microphone still opening; startCapture handles it
  session = null; // the next press can begin straight away
  if (s.recorder.state === 'recording') s.recorder.stop();
  else finishCapture(s);
}

function finishCapture(s) {
  if (s.done) return;
  s.done = true;
  clearInterval(s.timerId);
  clearTimeout(s.stopId);
  releaseStream(s.stream);
  if (session === s) session = null;
  if (!session) {
    setTalkState('idle');
    els.recTimer.hidden = true;
  }
  if (!s.tRelease) s.tRelease = performance.now();
  if (s.tRelease - s.t0 < MIN_HOLD_MS || !s.chunks.length) return; // accidental tap: ignore quietly
  const blob = new Blob(s.chunks, { type: s.recorder?.mimeType || 'audio/webm' });
  s.chunks = [];
  enqueue({ blob, tRelease: s.tRelease });
}

/* ---------- transcription queue ---------- */
let queue = Promise.resolve();
function enqueue(job) {
  jobCount += 1;
  renderJobs();
  queue = queue
    .then(() => runJob(job))
    .catch((err) => showBanner('error', `Nothing was inserted. ${err.message}`))
    .finally(() => {
      jobCount -= 1;
      renderJobs();
    });
}

function resampleLinear(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.round(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0] * (1 - (p - i0)) + input[i1] * (p - i0);
  }
  return out;
}

async function decodeTo16kMono(blob) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const decoded = await new Offline(1, 1, 16000).decodeAudioData(await blob.arrayBuffer());
  const mixed = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < mixed.length; i++) mixed[i] += data[i] / decoded.numberOfChannels;
  }
  return resampleLinear(mixed, decoded.sampleRate, 16000);
}

async function runJob({ blob, tRelease }) {
  const audio = await decodeTo16kMono(blob);
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  const seconds = audio.length / 16000;
  if (seconds < 0.15 || peak < SILENCE_PEAK) {
    showBanner('info', 'No speech was detected. Nothing was inserted.');
    return;
  }

  const t1 = performance.now();
  const result = await engine.transcribe(audio, settings.language);
  const transcribeMs = performance.now() - t1;

  const cleaned = cleanup(result.chunks.length ? result.chunks : result.text, {
    removeFillers: settings.fillers,
    capitalize: settings.capitalize,
    punctuate: settings.punctuate,
    customWords: customEntries,
  });
  els.rawText.textContent = result.text.trim();
  els.cleanText.textContent = cleaned;
  els.statAudio.textContent = `${seconds.toFixed(1)} s of audio · model took ${fmtMs(transcribeMs)} · ${settings.model} · ${model.device === 'webgpu' ? 'GPU' : 'CPU'}`;

  if (!cleaned) {
    showBanner('info', 'No words were left after cleanup. Nothing was inserted.');
    return;
  }
  insertAtCursor(cleaned);
  recordTrial('text', performance.now() - tRelease);
}

function insertAtCursor(text) {
  const ta = els.target;
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? start;
  ta.setRangeText(spacedInsertion(ta.value, start, end, text), start, end, 'end');
}

/* ---------- timing trials ---------- */
const trials = { capture: [], text: [] };
function recordTrial(kind, ms) {
  trials[kind].push(ms);
  if (trials[kind].length > MAX_TRIALS) trials[kind].shift();
  renderTrials();
}
function renderTrials() {
  const c = trials.capture;
  const t = trials.text;
  els.statCapture.textContent = c.length
    ? `${fmtMs(c.at(-1))} last · median ${fmtMs(median(c))} · ${Math.round((100 * c.filter((x) => x <= TARGET_CAPTURE_MS).length) / c.length)}% within ${TARGET_CAPTURE_MS} ms · n=${c.length}`
    : 'No trials yet';
  els.statText.textContent = t.length
    ? `${fmtMs(t.at(-1))} last · median ${fmtMs(median(t))} · ${Math.round((100 * t.filter((x) => x <= TARGET_TEXT_MS).length) / t.length)}% within ${fmtMs(TARGET_TEXT_MS)} · n=${t.length}`
    : 'No trials yet';
}

/* ---------- talk controls: button, keyboard, safety stops ---------- */
const isTyping = (el) => el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

els.talk.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  try { els.talk.setPointerCapture(e.pointerId); } catch { /* not essential */ }
  startCapture('pointer', 'pointer');
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  els.talk.addEventListener(type, () => stopCapture('pointer'));
}
els.talk.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.code === 'AltRight') {
    e.preventDefault();
    if (!e.repeat) startCapture('key', 'AltRight');
  } else if (e.code === 'Space' && !isTyping(e.target)) {
    e.preventDefault();
    if (!e.repeat) startCapture('key', 'Space');
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'AltRight' || e.code === 'Space') {
    if (session && session.code === e.code) e.preventDefault();
    stopCapture(e.code);
  }
});
window.addEventListener('blur', () => stopCapture());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCapture();
});
window.addEventListener('pagehide', () => {
  stopCapture();
  dropWarmStream();
});

/* ---------- target text buttons ---------- */
function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1200);
}
els.copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.target.value);
  } catch {
    els.target.focus();
    els.target.select();
  }
  flash(els.copyBtn, 'Copied');
});
els.clearBtn.addEventListener('click', () => {
  els.target.value = '';
  els.rawText.textContent = '';
  els.cleanText.textContent = '';
});
els.statReset.addEventListener('click', () => {
  trials.capture = [];
  trials.text = [];
  renderTrials();
});
els.loadBtn.addEventListener('click', loadModel);

/* ---------- settings controls ---------- */
els.modelSelect.value = settings.model;
els.langSelect.value = settings.language;
els.speedSelect.value = settings.speed;
els.optFillers.checked = settings.fillers;
els.optCapitalize.checked = settings.capitalize;
els.optPunctuate.checked = settings.punctuate;
els.optWarmMic.checked = settings.warmMic;
els.customWords.value = settings.customWords;

els.modelSelect.addEventListener('change', () => { settings.model = els.modelSelect.value; saveSettings(); modelSelectionChanged(); });
els.speedSelect.addEventListener('change', () => { settings.speed = els.speedSelect.value; saveSettings(); modelSelectionChanged(); });
els.langSelect.addEventListener('change', () => { settings.language = els.langSelect.value; saveSettings(); });
els.optFillers.addEventListener('change', () => { settings.fillers = els.optFillers.checked; saveSettings(); });
els.optCapitalize.addEventListener('change', () => { settings.capitalize = els.optCapitalize.checked; saveSettings(); });
els.optPunctuate.addEventListener('change', () => { settings.punctuate = els.optPunctuate.checked; saveSettings(); });
els.optWarmMic.addEventListener('change', async () => {
  settings.warmMic = els.optWarmMic.checked;
  saveSettings();
  if (!settings.warmMic) return dropWarmStream();
  try {
    await getStream();
  } catch (err) {
    settings.warmMic = false;
    els.optWarmMic.checked = false;
    saveSettings();
    showBanner('error', describeMicError(err));
  }
});

function applyCustomWordsInput() {
  const parsed = parseCustomWords(els.customWords.value);
  if (parsed.tooMany) {
    els.customWordsMsg.dataset.kind = 'error';
    els.customWordsMsg.textContent = `That list has ${parsed.count} entries. The limit is ${MAX_CUSTOM_WORDS}. The list is unchanged: remove some lines to save it.`;
    return;
  }
  customEntries = parsed.entries;
  settings.customWords = els.customWords.value;
  saveSettings();
  els.customWordsMsg.dataset.kind = 'ok';
  els.customWordsMsg.textContent = parsed.count ? `${parsed.count} custom ${parsed.count === 1 ? 'word' : 'words'} saved.` : '';
}
els.customWords.addEventListener('input', applyCustomWordsInput);

/* ---------- network indicator ---------- */
function renderNet() {
  els.netPill.textContent = navigator.onLine ? 'Online' : 'Offline';
  els.netPill.dataset.state = navigator.onLine ? 'online' : 'offline';
}
window.addEventListener('online', renderNet);
window.addEventListener('offline', renderNet);

/* ---------- start ---------- */
renderNet();
renderModel();
renderTrials();
renderJobs();
setTalkState('idle');
applyCustomWordsInput();

if (!captureSupported()) {
  els.talk.disabled = true;
  showBanner('error', 'This browser cannot record audio. Use a current version of Chrome, Edge or Safari.');
} else if (!window.isSecureContext) {
  els.talk.disabled = true;
  showBanner('error', 'The microphone only works on a secure page. Open this app at http://localhost:8765, not from a file.');
} else if (settings.loadedKey === `${settings.model}:${settings.speed}`) {
  loadModel(); // downloaded before: loads from the browser cache
}
