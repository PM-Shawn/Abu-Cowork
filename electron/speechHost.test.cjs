'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createSpeechHost, loadAssets, MAX_AUDIO_BYTES } = require('./speechHost.cjs');

const sha = (text) => createHash('sha256').update(text).digest('hex');
const CONTENT = { a: 'model-bytes', b: 'tokens', c: 'vad' };
const ASSETS = {
  origins: { 'hf-mirror': 'https://mirror.test', huggingface: 'https://hf.test' },
  files: Object.entries(CONTENT).map(([name, body]) => ({
    name,
    path: `repo/resolve/rev/${name}`,
    bytes: Buffer.byteLength(body),
    sha256: sha(body),
  })),
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abu-speech-host-'));
}

function runtimeDir({ installed = true } = {}) {
  const dir = tempDir();
  if (installed) {
    fs.mkdirSync(path.join(dir, 'node_modules', 'sherpa-onnx-node'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'sherpa-onnx-node', 'package.json'), '{}');
  }
  return dir;
}

function body(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

/** Fake fetch: `routes[origin]` = 'ok' | 'down' | 'corrupt' | 'hang'. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET' });
    const origin = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const mode = routes[origin];
    if (mode === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'hang') {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    if (init.method === 'HEAD') return { ok: true, status: 200 };
    const name = url.split('/').at(-1);
    const text = mode === 'corrupt' ? CONTENT[name].replace(/./, 'X') : CONTENT[name];
    return { ok: true, status: 200, body: body(text) };
  };
  return { fetch, calls };
}

/** Fake utilityProcess: answers load/transcribe like speechWorker.cjs. */
function fakeFork({ transcript = '你好', hang = false } = {}) {
  const forks = [];
  const fork = () => {
    const child = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 0); return true; };
    child.messages = [];
    child.postMessage = (message) => {
      child.messages.push(message);
      if (hang && message.type === 'transcribe') return;
      setImmediate(() => child.emit('message', {
        id: message.id,
        ok: true,
        result: message.type === 'load' ? { loaded: true } : { text: transcript, audioSeconds: 1, inferenceSeconds: 0.1 },
      }));
    };
    forks.push(child);
    return child;
  };
  return { fork, forks };
}

function wave(seconds = 1) {
  const samples = Math.round(seconds * 16000);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8, 'ascii');
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36, 'ascii');
  bytes.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(bytes);
}

function host({ routes = { 'https://mirror.test': 'ok', 'https://hf.test': 'ok' }, forkOptions, options, runtime } = {}) {
  const events = [];
  const net = fakeFetch(routes);
  const proc = fakeFork(forkOptions);
  const dataDir = path.join(tempDir(), 'sensevoice');
  const speech = createSpeechHost({
    dataDir,
    runtimeDir: runtime || runtimeDir(),
    workerPath: '/app/electron/speechWorker.cjs',
    fetch: net.fetch,
    fork: proc.fork,
    emit: (event) => events.push(event),
    assets: ASSETS,
    options: { probeTimeoutMs: 50, progressIntervalMs: 0, idleTimeoutMs: 0, ...options },
  });
  return { speech, events, net, proc, dataDir };
}

async function waitForState(speech, state) {
  for (let i = 0; i < 200; i++) {
    if (speech.snapshot().model.state === state) return speech.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`state never became ${state}: ${JSON.stringify(speech.snapshot().model)}`);
}

test('shipped asset lock pins size and SHA-256 for every model file', () => {
  const assets = loadAssets();
  assert.deepEqual(assets.files.map((file) => file.name), ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']);
  for (const file of assets.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
    assert.match(file.path, /\/resolve\/[0-9a-f]{40}\//, 'pinned to a commit, not a branch');
  }
  assert.deepEqual(Object.keys(assets.origins), ['hf-mirror', 'huggingface']);
});

test('a fresh install reports the model as missing', async () => {
  const { speech } = host();
  const status = await speech.dispatch('status');
  assert.equal(status.model.state, 'missing');
  assert.equal(status.runtimeAvailable, true);
  assert.equal(status.model.totalBytes, 11 + 6 + 3);
});

test('prepare downloads, verifies and then reports ready; the cache survives a restart', async () => {
  const { speech, dataDir, net } = host();
  await speech.dispatch('prepare', { source: 'auto' });
  await waitForState(speech, 'ready');
  for (const [name, text] of Object.entries(CONTENT)) {
    assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), text);
    assert.equal(fs.existsSync(path.join(dataDir, `${name}.part`)), false);
  }
  assert.ok(net.calls.some((call) => call.method === 'HEAD'), 'auto source probes origins');

  const restarted = createSpeechHost({
    dataDir, runtimeDir: runtimeDir(), workerPath: 'w', fetch: net.fetch, fork: fakeFork().fork, emit: () => {}, assets: ASSETS,
  });
  assert.equal((await restarted.dispatch('status')).model.state, 'ready');
});

test('a down mirror falls back to the next origin', async () => {
  const { speech, net } = host({ routes: { 'https://mirror.test': 'down', 'https://hf.test': 'ok' } });
  await speech.dispatch('prepare', { source: 'auto' });
  await waitForState(speech, 'ready');
  assert.ok(net.calls.some((call) => call.method === 'GET' && call.url.startsWith('https://hf.test')));
});

test('an explicit source never falls back', async () => {
  const { speech, net } = host({ routes: { 'https://mirror.test': 'down', 'https://hf.test': 'ok' } });
  await speech.dispatch('prepare', { source: 'hf-mirror' });
  const status = await waitForState(speech, 'error');
  assert.equal(status.model.error.code, 'network');
  assert.equal(status.model.error.source, 'hf-mirror');
  assert.ok(net.calls.every((call) => !call.url.startsWith('https://hf.test')));
});

test('a corrupted download is rejected and never lands on disk', async () => {
  const { speech, dataDir } = host({ routes: { 'https://mirror.test': 'corrupt', 'https://hf.test': 'corrupt' } });
  await speech.dispatch('prepare', { source: 'auto' });
  const status = await waitForState(speech, 'error');
  assert.equal(status.model.error.code, 'integrity');
  assert.equal(status.model.error.file, 'a');
  assert.equal(fs.existsSync(path.join(dataDir, 'a')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'a.part')), false);
});

test('cancel stops a download and returns to missing', async () => {
  const { speech } = host({ routes: { 'https://mirror.test': 'hang', 'https://hf.test': 'hang' } });
  await speech.dispatch('prepare', { source: 'huggingface' });
  assert.equal(speech.snapshot().model.state, 'downloading');
  const status = await speech.dispatch('cancel');
  assert.equal(status.model.state, 'missing');
});

test('verified files are reused on retry', async () => {
  const { speech, dataDir, net } = host();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'a'), CONTENT.a);
  await speech.dispatch('prepare', { source: 'hf-mirror' });
  await waitForState(speech, 'ready');
  assert.ok(!net.calls.some((call) => call.url.endsWith('/a')), 'the verified file was not downloaded again');
});

test('unknown download sources and actions are rejected', async () => {
  const { speech } = host();
  await speech.dispatch('status');
  await assert.rejects(speech.dispatch('prepare', { source: 'https://evil.test' }), /Unknown download source/);
  await assert.rejects(speech.dispatch('rm -rf'), /unsupported action/);
});

test('transcribe requires the model, then runs in one reused worker', async () => {
  const { speech, proc } = host();
  await assert.rejects(speech.dispatch('transcribe', { audio: wave(), language: 'auto' }), { code: 'not-ready' });
  await speech.dispatch('prepare');
  await waitForState(speech, 'ready');
  const first = await speech.dispatch('transcribe', { audio: wave(), language: 'zh' });
  const second = await speech.dispatch('transcribe', { audio: wave(), language: 'auto' });
  assert.equal(first.text, '你好');
  assert.equal(second.text, '你好');
  assert.equal(proc.forks.length, 1);
  const types = proc.forks[0].messages.map((message) => message.type);
  assert.deepEqual(types, ['load', 'transcribe', 'transcribe']);
  assert.equal(proc.forks[0].messages[1].language, 'zh');
});

test('transcribe validates audio and language before touching the worker', async () => {
  const { speech, proc } = host();
  await assert.rejects(speech.dispatch('transcribe', { audio: 'RIFF', language: 'auto' }), { code: 'invalid' });
  await assert.rejects(speech.dispatch('transcribe', { audio: new Uint8Array(MAX_AUDIO_BYTES + 2) }), { code: 'invalid' });
  await assert.rejects(speech.dispatch('transcribe', { audio: new Uint8Array(100) }), { code: 'invalid' });
  await assert.rejects(speech.dispatch('transcribe', { audio: wave(), language: 'fr' }), { code: 'invalid' });
  assert.equal(proc.forks.length, 0);
});

test('a missing native runtime is reported instead of starting a worker', async () => {
  const { speech, proc } = host({ runtime: runtimeDir({ installed: false }) });
  assert.equal((await speech.dispatch('status')).runtimeAvailable, false);
  await speech.dispatch('prepare');
  await waitForState(speech, 'ready');
  await assert.rejects(speech.dispatch('transcribe', { audio: wave() }), { code: 'runtime-missing' });
  assert.equal(proc.forks.length, 0);
});

test('a hung inference times out, kills the worker and the next call starts a fresh one', async () => {
  const { speech, proc } = host({ forkOptions: { hang: true }, options: { inferenceTimeoutMs: 30 } });
  await speech.dispatch('prepare');
  await waitForState(speech, 'ready');
  await assert.rejects(speech.dispatch('transcribe', { audio: wave() }), { code: 'timeout' });
  assert.equal(proc.forks[0].killed, true);
  await assert.rejects(speech.dispatch('transcribe', { audio: wave() }), { code: 'timeout' });
  assert.equal(proc.forks.length, 2);
});

test('the queue is bounded', async () => {
  const { speech } = host({ forkOptions: { hang: true }, options: { maxPending: 2, inferenceTimeoutMs: 1000 } });
  await speech.dispatch('prepare');
  await waitForState(speech, 'ready');
  const running = [speech.dispatch('transcribe', { audio: wave() }), speech.dispatch('transcribe', { audio: wave() })];
  await assert.rejects(speech.dispatch('transcribe', { audio: wave() }), { code: 'busy' });
  speech.dispose();
  await Promise.allSettled(running);
});

test('delete removes the model, stops the worker and reports missing', async () => {
  const { speech, proc, dataDir } = host();
  await speech.dispatch('prepare');
  await waitForState(speech, 'ready');
  await speech.dispatch('transcribe', { audio: wave() });
  const status = await speech.dispatch('delete');
  assert.equal(status.model.state, 'missing');
  assert.equal(fs.existsSync(dataDir), false);
  assert.equal(proc.forks[0].killed, true);
});

test('status changes are published to the renderer', async () => {
  const { speech, events } = host();
  await speech.dispatch('prepare');
  await waitForState(speech, 'ready');
  const states = events.map((event) => event.status.model.state);
  assert.ok(states.includes('downloading'));
  assert.equal(states.at(-1), 'ready');
  assert.ok(events.some((event) => event.status.model.download && event.status.model.download.received > 0));
});
