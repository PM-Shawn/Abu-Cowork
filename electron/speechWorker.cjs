'use strict';

/**
 * Recognizer process for voice input, started by speechHost.cjs with
 * `utilityProcess.fork()`. It owns the native sherpa-onnx runtime so a crash,
 * a hung inference or a cancel only costs this process, never main.
 *
 * Protocol over `process.parentPort` (one request at a time, serial):
 *   → { id, type: 'load', runtimeDir, model, tokens, vad, threads }
 *   → { id, type: 'transcribe', audio: Uint8Array, language }
 *   ← { id, ok: true, result } | { id, ok: false, error }
 *
 * `runtimeDir` is the speech-runtime directory (extraResource when packaged,
 * electron/speech-runtime in development) whose node_modules holds
 * sherpa-onnx-node and its platform package.
 */

const path = require('node:path');
const { createTranscriber } = require('./speechInference.cjs');
const { validateWave } = require('./speechWave.cjs');

const MAX_AUDIO_SECONDS = 150;

let transcribe = null;

function loadSherpa(runtimeDir) {
  // Resolve from the runtime directory, not from this file (which may sit in app.asar).
  return require(path.join(runtimeDir, 'node_modules', 'sherpa-onnx-node'));
}

function handle(message) {
  if (!message || typeof message !== 'object') throw new Error('Invalid speech worker request');
  if (message.type === 'load') {
    if (transcribe) return { loaded: true };
    const sherpa = loadSherpa(String(message.runtimeDir));
    transcribe = createTranscriber(sherpa, {
      model: String(message.model),
      tokens: String(message.tokens),
      vad: String(message.vad),
      threads: Number(message.threads) || 2,
    });
    return { loaded: true };
  }
  if (message.type === 'transcribe') {
    if (!transcribe) throw new Error('Speech model is not loaded');
    const audio = message.audio instanceof Uint8Array ? message.audio : new Uint8Array(message.audio || []);
    const audioSeconds = validateWave(audio, MAX_AUDIO_SECONDS);
    return { ...transcribe(audio, String(message.language)), audioSeconds };
  }
  throw new Error(`Unknown speech worker request: ${message.type}`);
}

const port = process.parentPort;
if (port) {
  port.on('message', (event) => {
    const message = event && event.data;
    const id = message && message.id;
    try {
      port.postMessage({ id, ok: true, result: handle(message) });
    } catch (error) {
      port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

module.exports = { handle };
