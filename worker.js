// Speech engine. Whisper runs inside this worker so the page stays responsive.
// Audio arrives as 16 kHz mono samples and is transcribed on this computer.
// The only network use is the one-time download of the model files.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2';

env.allowLocalModels = false;

let asr = null;
let loaded = { model: '', device: '' };

const post = (message) => self.postMessage(message);

async function load(model, device) {
  if (asr && loaded.model === model && loaded.device === device) return { device, note: '' };
  if (asr) {
    try {
      await asr.dispose();
    } catch {
      /* the old model is dropped either way */
    }
    asr = null;
  }
  const progress_callback = (progress) => post({ type: 'progress', progress });
  let note = '';

  if (device === 'webgpu') {
    try {
      if (!('gpu' in self.navigator)) throw new Error('WebGPU is not available in this browser');
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'webgpu',
        dtype: 'fp32',
        progress_callback,
      });
      loaded = { model, device: 'webgpu' };
      return { device: 'webgpu', note };
    } catch (err) {
      note = `GPU mode could not start (${err.message}). Using the CPU instead.`;
    }
  }

  asr = await pipeline('automatic-speech-recognition', model, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback,
  });
  loaded = { model, device: 'wasm' };
  return { device: 'wasm', note };
}

async function transcribe(audio, language) {
  if (!asr) throw new Error('The speech model is not loaded.');
  const options = {
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  };
  if (language && language !== 'auto') options.language = language;
  const out = await asr(audio, options);
  return {
    text: out.text ?? '',
    chunks: Array.isArray(out.chunks) ? out.chunks : [],
  };
}

self.onmessage = async (event) => {
  const m = event.data;
  try {
    if (m.type === 'load') {
      const info = await load(m.model, m.device);
      post({ type: 'loaded', id: m.id, ...info });
    } else if (m.type === 'transcribe') {
      const result = await transcribe(m.audio, m.language);
      post({ type: 'result', id: m.id, ...result });
    }
  } catch (err) {
    post({ type: 'error', id: m.id, message: String(err?.message ?? err) });
  }
};
