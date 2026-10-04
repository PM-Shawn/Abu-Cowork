import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeWave,
  Recording,
  RecordingError,
  SPEECH_SAMPLE_RATE,
  WAVE_HEADER_BYTES,
  waveDurationSeconds,
} from './recording';

// ── Minimal Web Audio / MediaRecorder fakes (node env) ──────────────────────

class FakeTrack {
  stopped = false;
  onended: (() => void) | null = null;
  stop() { this.stopped = true; }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}

class FakeMediaRecorder {
  static last: FakeMediaRecorder | undefined;
  static chunk: Blob | null = new Blob([new Uint8Array([1, 2, 3])]);
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { FakeMediaRecorder.last = this; }
  start() { this.state = 'recording'; }
  stop() {
    if (this.state !== 'recording') return;
    this.state = 'inactive';
    if (FakeMediaRecorder.chunk) this.ondataavailable?.({ data: FakeMediaRecorder.chunk });
    this.onstop?.();
  }
}

let decodedSeconds = 2;
class FakeAudioContext {
  static last: FakeAudioContext | undefined;
  state: 'running' | 'closed' = 'running';
  constructor() { FakeAudioContext.last = this; }
  createAnalyser() {
    return {
      fftSize: 0,
      getFloatTimeDomainData(target: Float32Array) { target.fill(0.5); },
    };
  }
  createMediaStreamSource() { return { connect() {} }; }
  async decodeAudioData() { return { duration: decodedSeconds }; }
  async close() { this.state = 'closed'; }
}

class FakeOfflineAudioContext {
  static lastFrames = 0;
  constructor(_channels: number, private readonly frames: number, readonly sampleRate: number) {
    FakeOfflineAudioContext.lastFrames = frames;
  }
  destination = {};
  createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
  async startRendering() {
    const data = new Float32Array(this.frames).fill(0.25);
    return { getChannelData: () => data };
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  decodedSeconds = 2;
  FakeMediaRecorder.chunk = new Blob([new Uint8Array([1, 2, 3])]);
  getUserMedia = vi.fn(async () => new FakeStream());
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function expectKind(promise: Promise<unknown>, kind: RecordingError['kind']) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RecordingError);
  expect((error as RecordingError).kind).toBe(kind);
}

describe('recording', () => {
  describe('encodeWave', () => {
    it('writes a canonical 16 kHz mono PCM16 header', () => {
      const wave = encodeWave(new Float32Array(10));
      const view = new DataView(wave.buffer);
      const ascii = (at: number) => String.fromCharCode(...wave.subarray(at, at + 4));
      expect(wave.byteLength).toBe(WAVE_HEADER_BYTES + 20);
      expect(ascii(0)).toBe('RIFF');
      expect(view.getUint32(4, true)).toBe(wave.byteLength - 8);
      expect(ascii(8)).toBe('WAVE');
      expect(ascii(12)).toBe('fmt ');
      expect(view.getUint16(20, true)).toBe(1);
      expect(view.getUint16(22, true)).toBe(1);
      expect(view.getUint32(24, true)).toBe(SPEECH_SAMPLE_RATE);
      expect(view.getUint32(28, true)).toBe(SPEECH_SAMPLE_RATE * 2);
      expect(view.getUint16(32, true)).toBe(2);
      expect(view.getUint16(34, true)).toBe(16);
      expect(ascii(36)).toBe('data');
      expect(view.getUint32(40, true)).toBe(20);
    });

    it('clips samples to the PCM16 range', () => {
      const wave = encodeWave(new Float32Array([2, -2, 0.5, -0.5, 0]));
      const view = new DataView(wave.buffer);
      const at = (i: number) => view.getInt16(WAVE_HEADER_BYTES + i * 2, true);
      expect([at(0), at(1), at(2), at(3), at(4)]).toEqual([32767, -32768, 16384, -16384, 0]);
    });

    it('reports duration from the data length', () => {
      expect(waveDurationSeconds(encodeWave(new Float32Array(SPEECH_SAMPLE_RATE * 3)))).toBe(3);
      expect(waveDurationSeconds(new Uint8Array(10))).toBe(0);
    });
  });

  describe('start', () => {
    it('is unavailable without mediaDevices', async () => {
      vi.stubGlobal('navigator', {});
      await expectKind(new Recording().start(), 'unavailable');
    });

    it('asks for audio only', async () => {
      await new Recording().start();
      expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ video: false, audio: expect.any(Object) }));
    });

    it('maps a denied prompt to permission and a missing device to no-device', async () => {
      getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
      await expectKind(new Recording().start(), 'permission');
      getUserMedia.mockRejectedValueOnce(new DOMException('none', 'NotFoundError'));
      await expectKind(new Recording().start(), 'no-device');
    });

    it('releases a permission grant that arrives after dispose', async () => {
      const stream = new FakeStream();
      let grant: (value: FakeStream) => void = () => {};
      getUserMedia.mockReturnValueOnce(new Promise((resolve) => { grant = resolve; }));
      const recording = new Recording();
      const started = recording.start();
      await recording.dispose();
      grant(stream);
      await expectKind(started, 'cancelled');
      expect(stream.tracks[0].stopped).toBe(true);
    });
  });

  describe('stop', () => {
    it('returns a 16 kHz WAV truncated to the limit and releases the device', async () => {
      decodedSeconds = 5;
      const recording = new Recording();
      await recording.start();
      const context = FakeAudioContext.last;
      const wave = await recording.stop(3);
      expect(FakeOfflineAudioContext.lastFrames).toBe(3 * SPEECH_SAMPLE_RATE);
      expect(waveDurationSeconds(wave)).toBe(3);
      expect(context?.state).toBe('closed');
      expect(recording.level()).toBe(0);
    });

    it('reports empty when nothing was captured', async () => {
      FakeMediaRecorder.chunk = null;
      const recording = new Recording();
      await recording.start();
      await expectKind(recording.stop(60), 'empty');
    });

    it('reports cancelled after dispose', async () => {
      const recording = new Recording();
      await recording.start();
      await recording.dispose();
      await expectKind(recording.stop(60), 'cancelled');
    });
  });

  it('measures a live level while recording', async () => {
    const recording = new Recording();
    await recording.start();
    expect(recording.level()).toBeCloseTo(0.5);
    await recording.dispose();
  });

  it('reports a lost device once and releases capture', async () => {
    const stream = new FakeStream();
    getUserMedia.mockResolvedValueOnce(stream);
    const onError = vi.fn();
    const recording = new Recording();
    await recording.start(onError);
    stream.tracks[0].onended?.();
    stream.tracks[0].onended?.();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ kind: 'interrupted' });
    await expectKind(recording.stop(60), 'cancelled');
  });
});
