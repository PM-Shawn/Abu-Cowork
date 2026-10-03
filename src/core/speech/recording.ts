/**
 * Microphone capture for voice input.
 *
 * The browser owns capture and resampling: MediaRecorder records the device's
 * native format, then Web Audio decodes and resamples it to the canonical
 * 16 kHz mono PCM16 WAV the local recognizer accepts. No audio converter
 * binary is needed, and the audio never leaves memory.
 *
 * Adapted from DeepSeek Harness `client-ui-voice-input/src/client/audio.ts`.
 */

/** Sample rate the recognizer (SenseVoice via sherpa-onnx) expects. */
export const SPEECH_SAMPLE_RATE = 16000;

/** Size of the canonical 44-byte PCM WAV header. */
export const WAVE_HEADER_BYTES = 44;

export type RecordingErrorKind =
  /** No mediaDevices / MediaRecorder in this renderer. */
  | 'unavailable'
  /** Chromium or the OS denied microphone access. */
  | 'permission'
  /** No audio input device is connected. */
  | 'no-device'
  /** Stopped before any audio was captured. */
  | 'empty'
  /** Cancelled by the user or released by the owner. */
  | 'cancelled'
  /** The device failed mid-capture (unplugged, taken by another app). */
  | 'interrupted';

/** Capture failure; the UI localizes it by `kind`. */
export class RecordingError extends Error {
  readonly kind: RecordingErrorKind;

  constructor(kind: RecordingErrorKind) {
    super(kind);
    this.name = 'RecordingError';
    this.kind = kind;
  }
}

/**
 * Encode mono float samples as a canonical 16 kHz PCM16 little-endian WAV.
 * Samples outside [-1, 1] are clipped.
 */
export function encodeWave(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(WAVE_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SPEECH_SAMPLE_RATE, true);
  view.setUint32(28, SPEECH_SAMPLE_RATE * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(WAVE_HEADER_BYTES + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

/** Recording duration of a canonical WAV produced by {@link encodeWave}. */
export function waveDurationSeconds(wave: Uint8Array): number {
  return Math.max(0, wave.byteLength - WAVE_HEADER_BYTES) / (SPEECH_SAMPLE_RATE * 2);
}

function mapGetUserMediaError(error: unknown): unknown {
  if (!(error instanceof DOMException)) return error;
  if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return new RecordingError('permission');
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return new RecordingError('no-device');
  if (error.name === 'NotReadableError' || error.name === 'AbortError') return new RecordingError('interrupted');
  return error;
}

/**
 * One microphone acquisition. `start()` may wait on a permission prompt that
 * settles after `dispose()`; a late grant releases its tracks immediately.
 */
export class Recording {
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private context: AudioContext | undefined;
  private analyser: AnalyserNode | undefined;
  private readonly levelSamples = new Float32Array(256);
  private chunks: Blob[] = [];
  private disposed = false;
  private disposal: Promise<void> | undefined;

  /**
   * Acquire the microphone and start recording.
   * @param onError - capture failures after start (device lost), reported once.
   */
  async start(onError?: (error: RecordingError) => void): Promise<void> {
    const devices = (navigator as Partial<Navigator>).mediaDevices;
    if (!devices || typeof devices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
      throw new RecordingError('unavailable');
    }
    let stream: MediaStream;
    try {
      stream = await devices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch (error) {
      throw mapGetUserMediaError(error);
    }
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new RecordingError('cancelled');
    }
    this.stream = stream;
    try {
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = this.levelSamples.length;
      this.context.createMediaStreamSource(stream).connect(this.analyser);
      const recorder = new MediaRecorder(stream);
      this.recorder = recorder;
      recorder.ondataavailable = (event) => {
        if (!this.disposed && event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (this.disposed) return;
        void this.dispose().catch(() => undefined);
        onError?.(new RecordingError('interrupted'));
      };
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (this.disposed || recorder.state !== 'recording') return;
          void this.dispose().catch(() => undefined);
          onError?.(new RecordingError('interrupted'));
        };
      });
      recorder.start();
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  /** Live RMS level in [0, 1]; zero outside capture. */
  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelSamples);
    let sum = 0;
    for (const sample of this.levelSamples) sum += sample * sample;
    return Math.min(1, Math.sqrt(sum / this.levelSamples.length));
  }

  /**
   * Stop capture and return the recording as a canonical WAV.
   * @param maxDurationSeconds - truncate to the recognizer's limit.
   */
  async stop(maxDurationSeconds: number): Promise<Uint8Array> {
    const recorder = this.recorder;
    const context = this.context;
    if (this.disposed || !recorder || !context || recorder.state !== 'recording') {
      await this.dispose();
      throw new RecordingError(this.disposed ? 'cancelled' : 'empty');
    }
    try {
      await new Promise<void>((resolve, reject) => {
        recorder.onstop = () => resolve();
        recorder.onerror = () => reject(new RecordingError('interrupted'));
        recorder.stop();
      });
      this.stream?.getTracks().forEach((track) => track.stop());
      this.throwIfDisposed();
      const blob = new Blob(this.chunks, { type: recorder.mimeType });
      if (blob.size === 0) throw new RecordingError('empty');
      const decoded = await context.decodeAudioData(await blob.arrayBuffer());
      this.throwIfDisposed();
      const seconds = Math.min(decoded.duration, maxDurationSeconds);
      const frames = Math.max(1, Math.floor(seconds * SPEECH_SAMPLE_RATE));
      const offline = new OfflineAudioContext(1, frames, SPEECH_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const resampled = await offline.startRendering();
      this.throwIfDisposed();
      return encodeWave(resampled.getChannelData(0));
    } catch (error) {
      // A cancel closes the AudioContext mid-decode; report the cancel, not
      // whatever the closed context threw.
      if (this.disposed && !(error instanceof RecordingError)) throw new RecordingError('cancelled');
      throw error;
    } finally {
      await this.dispose();
    }
  }

  /** Release the device and invalidate pending work; idempotent. */
  dispose(): Promise<void> {
    if (!this.disposal) this.disposal = this.release();
    return this.disposal;
  }

  private throwIfDisposed(): void {
    // stop() disposes only in its finally; an earlier dispose() is a cancel.
    if (this.disposed) throw new RecordingError('cancelled');
  }

  private async release(): Promise<void> {
    this.disposed = true;
    if (this.recorder?.state === 'recording') this.recorder.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.recorder = undefined;
    this.analyser = undefined;
    this.chunks = [];
    const context = this.context;
    this.context = undefined;
    if (context && context.state !== 'closed') await context.close();
  }
}
