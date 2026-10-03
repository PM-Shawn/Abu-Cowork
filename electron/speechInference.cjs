'use strict';

/**
 * CPU speech recognition: Silero VAD splits a recording into speech segments,
 * SenseVoice (via sherpa-onnx) transcribes each one, and the texts are joined.
 * Runs only inside the recognizer process (speechWorker.cjs).
 *
 * Adapted from DeepSeek Harness speech-to-text-sensevoice/src/inference.ts.
 */

const { SPEECH_LANGUAGES, SPEECH_SAMPLE_RATE, waveSamples } = require('./speechWave.cjs');

const VAD_WINDOW = 512;

/**
 * @param {{ OfflineRecognizer: Function, Vad: Function }} sherpa sherpa-onnx-node exports
 * @param {{
 *   model: string, tokens: string, vad: string,
 *   threads?: number, segmentSeconds?: number, vadThreshold?: number,
 *   minSpeechSeconds?: number, minSilenceSeconds?: number,
 * }} config verified file paths + tuning
 * @returns {(audio: Uint8Array, language: string) => { text: string, inferenceSeconds: number }}
 */
function createTranscriber(sherpa, config) {
  const threads = config.threads ?? 2;
  const segmentSeconds = config.segmentSeconds ?? 30;
  const minSilenceSeconds = config.minSilenceSeconds ?? 0.5;
  const recognizerConfig = {
    featConfig: { sampleRate: SPEECH_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: { model: config.model, language: 'auto', useInverseTextNormalization: 1 },
      tokens: config.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  };
  const recognizer = new sherpa.OfflineRecognizer(recognizerConfig);
  const detector = new sherpa.Vad({
    sileroVad: {
      model: config.vad,
      threshold: config.vadThreshold ?? 0.5,
      minSilenceDuration: minSilenceSeconds,
      minSpeechDuration: config.minSpeechSeconds ?? 0.25,
      maxSpeechDuration: segmentSeconds,
      windowSize: VAD_WINDOW,
    },
    sampleRate: SPEECH_SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, segmentSeconds + minSilenceSeconds + 1);

  return function transcribe(audio, language) {
    if (!SPEECH_LANGUAGES.includes(language)) throw new Error(`Unsupported speech language: ${language}`);
    const samples = waveSamples(audio);
    recognizerConfig.modelConfig.senseVoice.language = language;
    recognizer.setConfig(recognizerConfig);
    detector.reset();
    const started = performance.now();
    const texts = [];
    const drain = () => {
      while (!detector.isEmpty()) {
        // Electron's V8 memory cage rejects external buffers: ask for a copy.
        const segment = detector.front(false);
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SPEECH_SAMPLE_RATE, samples: segment.samples });
        recognizer.decode(stream);
        const text = String(recognizer.getResult(stream).text || '').trim();
        if (text) texts.push(text);
        detector.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += VAD_WINDOW) {
      detector.acceptWaveform(samples.subarray(offset, offset + VAD_WINDOW));
      drain();
    }
    detector.flush();
    drain();
    return {
      text: joinSegments(texts),
      inferenceSeconds: (performance.now() - started) / 1000,
    };
  };
}

/** Join segment texts; CJK segments need no space between them. */
function joinSegments(texts) {
  let out = '';
  for (const text of texts) {
    if (!out) { out = text; continue; }
    const cjkBoundary = /[　-鿿＀-￯]$/.test(out) || /^[　-鿿＀-￯]/.test(text);
    out += cjkBoundary ? text : ` ${text}`;
  }
  return out;
}

module.exports = { createTranscriber, joinSegments };
