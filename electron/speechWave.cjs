'use strict';

/**
 * Canonical recording format for voice input: 16 kHz mono PCM16 little-endian
 * WAV with the 44-byte header written by src/core/speech/recording.ts
 * (encodeWave). Both the IPC boundary (speechHost.cjs) and the recognizer
 * process (speechWorker.cjs) validate with this before touching samples.
 */

const SPEECH_SAMPLE_RATE = 16000;
const WAVE_HEADER_BYTES = 44;
const SPEECH_LANGUAGES = Object.freeze(['auto', 'zh', 'en', 'yue', 'ja', 'ko']);

/**
 * @param {Uint8Array} audio
 * @param {number} maxDurationSeconds
 * @returns {number} recording duration in seconds
 */
function validateWave(audio, maxDurationSeconds) {
  if (!(audio instanceof Uint8Array)) throw new Error('Speech audio must be bytes');
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  const ascii = (at) => data.toString('ascii', at, at + 4);
  if (
    data.length < WAVE_HEADER_BYTES + 2
    || ascii(0) !== 'RIFF'
    || ascii(8) !== 'WAVE'
    || ascii(12) !== 'fmt '
    || data.readUInt32LE(16) !== 16
    || data.readUInt16LE(20) !== 1
    || data.readUInt16LE(22) !== 1
    || data.readUInt32LE(24) !== SPEECH_SAMPLE_RATE
    || data.readUInt32LE(28) !== SPEECH_SAMPLE_RATE * 2
    || data.readUInt16LE(32) !== 2
    || data.readUInt16LE(34) !== 16
    || ascii(36) !== 'data'
    || data.readUInt32LE(4) !== data.length - 8
    || data.readUInt32LE(40) !== data.length - WAVE_HEADER_BYTES
    || (data.length - WAVE_HEADER_BYTES) % 2 !== 0
  ) {
    throw new Error('Speech audio must be a canonical 16 kHz mono PCM16 WAV recording');
  }
  const seconds = (data.length - WAVE_HEADER_BYTES) / (SPEECH_SAMPLE_RATE * 2);
  if (seconds > maxDurationSeconds) throw new Error(`Speech audio exceeds ${maxDurationSeconds} seconds`);
  return seconds;
}

/**
 * PCM16 payload → float samples in [-1, 1). Copies into a fresh buffer so the
 * native recognizer never holds a view onto IPC-owned memory.
 * @param {Uint8Array} audio validated WAV
 */
function waveSamples(audio) {
  const view = new DataView(audio.buffer, audio.byteOffset + WAVE_HEADER_BYTES, audio.byteLength - WAVE_HEADER_BYTES);
  const samples = new Float32Array(view.byteLength / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

module.exports = {
  SPEECH_LANGUAGES,
  SPEECH_SAMPLE_RATE,
  WAVE_HEADER_BYTES,
  validateWave,
  waveSamples,
};
