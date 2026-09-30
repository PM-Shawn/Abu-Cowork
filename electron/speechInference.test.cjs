'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTranscriber, joinSegments } = require('./speechInference.cjs');
const { validateWave, waveSamples, SPEECH_LANGUAGES } = require('./speechWave.cjs');
const { handle } = require('./speechWorker.cjs');

function wave(samples, { sampleRate = 16000, channels = 1 } = {}) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8, 'ascii');
  bytes.write('fmt ', 12, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2 * channels, 28);
  bytes.writeUInt16LE(2 * channels, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, i) => bytes.writeInt16LE(value, 44 + i * 2));
  return new Uint8Array(bytes);
}

test('validateWave accepts the canonical recording and reports its duration', () => {
  assert.equal(validateWave(wave(new Array(16000).fill(0)), 120), 1);
});

test('validateWave rejects other formats, truncated data and overlong audio', () => {
  assert.throws(() => validateWave(wave([0, 0], { sampleRate: 44100 }), 120), /canonical/);
  assert.throws(() => validateWave(wave([0, 0], { channels: 2 }), 120), /canonical/);
  const truncated = wave([0, 0, 0]).subarray(0, 48);
  assert.throws(() => validateWave(truncated, 120), /canonical/);
  assert.throws(() => validateWave(new Uint8Array(10), 120), /canonical/);
  assert.throws(() => validateWave('RIFF', 120), /bytes/);
  assert.throws(() => validateWave(wave(new Array(32000).fill(0)), 1), /exceeds 1 seconds/);
});

test('waveSamples decodes PCM16 into floats', () => {
  assert.deepEqual(Array.from(waveSamples(wave([0, 16384, -32768]))), [0, 0.5, -1]);
});

test('joinSegments spaces Latin segments and glues CJK ones', () => {
  assert.equal(joinSegments(['hello', 'world']), 'hello world');
  assert.equal(joinSegments(['你好。', '今天']), '你好。今天');
  assert.equal(joinSegments(['OK', '好的']), 'OK好的');
  assert.equal(joinSegments([]), '');
});

function fakeSherpa(segmentTexts) {
  const calls = { configs: [], accepted: 0 };
  class OfflineRecognizer {
    constructor(config) { calls.configs.push(JSON.parse(JSON.stringify(config))); }
    setConfig(config) { calls.configs.push(JSON.parse(JSON.stringify(config))); }
    createStream() { return { acceptWaveform() {} }; }
    decode() {}
    getResult() { return { text: segmentTexts.shift() ?? '' }; }
  }
  class Vad {
    constructor() { this.queue = []; }
    acceptWaveform(samples) { calls.accepted += samples.length; }
    flush() { this.queue.push({ samples: new Float32Array(4) }, { samples: new Float32Array(4) }); }
    isEmpty() { return this.queue.length === 0; }
    front() { return this.queue[0]; }
    pop() { this.queue.shift(); }
    reset() { this.queue = []; }
  }
  return { sherpa: { OfflineRecognizer, Vad }, calls };
}

test('transcriber feeds every sample through VAD and joins segment texts', () => {
  const { sherpa, calls } = fakeSherpa(['第一句。', ' 第二句 ']);
  const transcribe = createTranscriber(sherpa, { model: 'm', tokens: 't', vad: 'v' });
  const result = transcribe(wave(new Array(1600).fill(0)), 'zh');
  assert.equal(result.text, '第一句。第二句');
  assert.equal(calls.accepted, 1600);
  assert.equal(calls.configs.at(-1).modelConfig.senseVoice.language, 'zh');
  assert.equal(calls.configs[0].modelConfig.provider, 'cpu');
});

test('transcriber rejects languages SenseVoice does not support', () => {
  const { sherpa } = fakeSherpa([]);
  const transcribe = createTranscriber(sherpa, { model: 'm', tokens: 't', vad: 'v' });
  assert.deepEqual(SPEECH_LANGUAGES, ['auto', 'zh', 'en', 'yue', 'ja', 'ko']);
  assert.throws(() => transcribe(wave([0]), 'fr'), /Unsupported speech language/);
});

test('worker refuses to transcribe before a model is loaded and rejects unknown requests', () => {
  assert.throws(() => handle({ id: 1, type: 'transcribe', audio: wave([0]), language: 'auto' }), /not loaded/);
  assert.throws(() => handle({ id: 2, type: 'reboot' }), /Unknown speech worker request/);
  assert.throws(() => handle(null), /Invalid/);
});

// Real-model acceptance: ABU_SPEECH_MODEL_DIR = a directory holding
// model.int8.onnx, tokens.txt, silero_vad.onnx and test_wavs/zh.wav (the
// sherpa-onnx SenseVoice int8 release). Skipped when absent (CI has no model).
const modelDir = process.env.ABU_SPEECH_MODEL_DIR;
test('real SenseVoice model transcribes the Chinese sample', { skip: !modelDir && 'ABU_SPEECH_MODEL_DIR not set' }, () => {
  const runtimeDir = path.join(__dirname, 'speech-runtime');
  assert.deepEqual(handle({
    id: 1,
    type: 'load',
    runtimeDir,
    model: path.join(modelDir, 'model.int8.onnx'),
    tokens: path.join(modelDir, 'tokens.txt'),
    vad: path.join(modelDir, 'silero_vad.onnx'),
    threads: 2,
  }), { loaded: true });
  const audio = new Uint8Array(fs.readFileSync(path.join(modelDir, 'test_wavs', 'zh.wav')));
  const result = handle({ id: 2, type: 'transcribe', audio, language: 'auto' });
  assert.match(result.text, /开饭时间/);
  assert.ok(result.audioSeconds > 5 && result.audioSeconds < 6);
});
