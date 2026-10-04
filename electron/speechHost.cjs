'use strict';

/**
 * Voice input host (main process): owns the local recognition model on disk
 * and the recognizer process.
 *
 *  - Model: three pinned files (speechAssets.json) downloaded on demand into
 *    <app data>/speech/sensevoice. Each file streams into `<name>.part` while
 *    its SHA-256 is computed, and is renamed into place only when size and
 *    hash match. Origins are compared with concurrent HEAD probes (first 2xx
 *    wins, hf-mirror first on a tie/failure); a network, HTTP or integrity
 *    failure moves on to the next origin. Verified files are reused on retry.
 *  - Recognizer: speechWorker.cjs in a utilityProcess, started on the first
 *    recording, fed one recording at a time (bounded queue), stopped after an
 *    idle period, and killed on timeout, delete or quit.
 *
 * Audio is only ever held in memory. The renderer talks to this module through
 * `abu:speech` (request/response) and receives status on `abu:speech-event`.
 */

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SPEECH_LANGUAGES, validateWave } = require('./speechWave.cjs');

const SPEECH_CHANNEL = 'abu:speech';
const SPEECH_EVENT_CHANNEL = 'abu:speech-event';
const MAX_AUDIO_SECONDS = 150;
const MAX_AUDIO_BYTES = 44 + MAX_AUDIO_SECONDS * 16000 * 2;
const MARKER_NAME = '.verified.json';
const DOWNLOAD_SOURCES = ['auto', 'hf-mirror', 'huggingface'];

const DEFAULTS = {
  probeTimeoutMs: 3000,
  progressIntervalMs: 150,
  loadTimeoutMs: 60_000,
  inferenceTimeoutMs: 120_000,
  idleTimeoutMs: 5 * 60_000,
  maxPending: 4,
  threads: 2,
};

class SpeechError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
    Object.assign(this, details);
  }
}

function loadAssets() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'speechAssets.json'), 'utf8'));
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function fileSize(filePath) {
  try {
    const info = await fs.promises.stat(filePath);
    return info.isFile() ? info.size : -1;
  } catch (error) {
    if (error && error.code === 'ENOENT') return -1;
    throw error;
  }
}

function classifyDownloadError(error) {
  if (error instanceof SpeechError) return error.code;
  if (error && error.name === 'AbortError') return 'cancelled';
  const code = error && (error.code || (error.cause && error.cause.code));
  if (typeof code === 'string' && /^(ENOSPC|EACCES|EPERM|EROFS|EIO)$/.test(code)) return 'storage';
  return 'network';
}

/**
 * @param {{
 *   dataDir: string,
 *   runtimeDir: string,
 *   workerPath: string,
 *   fetch: typeof fetch,
 *   fork: (modulePath: string) => {
 *     postMessage: (message: unknown) => void,
 *     on: (event: 'message' | 'exit', listener: Function) => unknown,
 *     kill: () => boolean,
 *   },
 *   emit: (event: object) => void,
 *   assets?: ReturnType<typeof loadAssets>,
 *   options?: Partial<typeof DEFAULTS>,
 * }} deps
 */
function createSpeechHost(deps) {
  const assets = deps.assets || loadAssets();
  const options = { ...DEFAULTS, ...(deps.options || {}) };
  const modelDir = deps.dataDir;
  const totalBytes = assets.files.reduce((sum, file) => sum + file.bytes, 0);

  /** @type {'checking' | 'missing' | 'downloading' | 'ready' | 'error'} */
  let modelState = 'checking';
  let download = null;
  let lastError = null;
  let preparation = null;
  let downloadAbort = null;
  let checked = null;
  let lastProgressAt = 0;

  let worker = null;
  let workerReady = null;
  let nextRequestId = 1;
  const pendingReplies = new Map();
  let queue = Promise.resolve();
  let queued = 0;
  let idleTimer = null;

  const pathFor = (file) => path.join(modelDir, file.name);

  function runtimeAvailable() {
    return fs.existsSync(path.join(deps.runtimeDir, 'node_modules', 'sherpa-onnx-node', 'package.json'));
  }

  function snapshot() {
    return {
      runtimeAvailable: runtimeAvailable(),
      model: {
        state: modelState,
        totalBytes,
        download: download ? { ...download } : null,
        error: lastError ? { ...lastError } : null,
      },
      downloadSources: DOWNLOAD_SOURCES,
      languages: SPEECH_LANGUAGES,
      maxAudioSeconds: MAX_AUDIO_SECONDS,
    };
  }

  function publish() {
    try { deps.emit({ type: 'status', status: snapshot() }); } catch { /* window gone */ }
  }

  function setState(state) {
    modelState = state;
    publish();
  }

  async function readMarker() {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(modelDir, MARKER_NAME), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Fast cache check: the marker written after a full verify + matching sizes. */
  async function checkCache() {
    const marker = await readMarker();
    const markerMatches = marker && assets.files.every((file) => marker[file.name] === file.sha256);
    if (!markerMatches) return false;
    for (const file of assets.files) {
      if (await fileSize(pathFor(file)) !== file.bytes) return false;
    }
    return true;
  }

  function ensureChecked() {
    if (!checked) {
      checked = checkCache().then((ready) => {
        if (modelState === 'checking') setState(ready ? 'ready' : 'missing');
      }, () => {
        if (modelState === 'checking') setState('missing');
      });
    }
    return checked;
  }

  async function probeOrigins(names, signal) {
    const sample = assets.files[assets.files.length - 1];
    const probes = names.map((name, index) => {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), options.probeTimeoutMs);
      const started = Date.now();
      return deps.fetch(`${assets.origins[name]}/${sample.path}`, { method: 'HEAD', redirect: 'follow', signal: controller.signal })
        .then((response) => ({ name, index, ok: response.ok, ms: Date.now() - started }))
        .catch(() => ({ name, index, ok: false, ms: Infinity }))
        .finally(() => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); });
    });
    const results = await Promise.all(probes);
    return results
      .sort((a, b) => (a.ok === b.ok ? a.ms - b.ms || a.index - b.index : a.ok ? -1 : 1))
      .map((result) => result.name);
  }

  async function downloadFile(file, origin, fileIndex, signal) {
    const url = `${assets.origins[origin]}/${file.path}`;
    const partPath = `${pathFor(file)}.part`;
    const response = await deps.fetch(url, { redirect: 'follow', signal });
    if (!response.ok || !response.body) {
      throw new SpeechError('http', `HTTP ${response.status}`, { status: response.status });
    }
    const hash = createHash('sha256');
    const handle = await fs.promises.open(partPath, 'w');
    let received = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted();
        received += value.byteLength;
        if (received > file.bytes) throw new SpeechError('integrity', 'Downloaded file is larger than expected');
        hash.update(value);
        await handle.write(value);
        const now = Date.now();
        if (now - lastProgressAt >= options.progressIntervalMs) {
          lastProgressAt = now;
          download = { file: file.name, fileIndex, fileCount: assets.files.length, received, total: file.bytes, source: origin };
          publish();
        }
      }
    } finally {
      await handle.close();
    }
    if (received !== file.bytes || hash.digest('hex') !== file.sha256) {
      await fs.promises.rm(partPath, { force: true });
      throw new SpeechError('integrity', 'Downloaded file failed verification');
    }
    await fs.promises.rename(partPath, pathFor(file));
  }

  async function prepareModel(source, signal) {
    await fs.promises.mkdir(modelDir, { recursive: true });
    await fs.promises.rm(path.join(modelDir, MARKER_NAME), { force: true });
    let origins = null;
    for (const [fileIndex, file] of assets.files.entries()) {
      signal.throwIfAborted();
      download = { file: file.name, fileIndex, fileCount: assets.files.length, received: 0, total: file.bytes, source: null };
      publish();
      if (await fileSize(pathFor(file)) === file.bytes && await sha256File(pathFor(file)) === file.sha256) continue;
      if (!origins) {
        origins = source === 'auto'
          ? await probeOrigins(Object.keys(assets.origins), signal)
          : [source];
      }
      let failure = null;
      for (const origin of origins) {
        try {
          await downloadFile(file, origin, fileIndex, signal);
          failure = null;
          break;
        } catch (error) {
          const code = signal.aborted ? 'cancelled' : classifyDownloadError(error);
          failure = { code, file: file.name, source: origin, status: error && error.status };
          if (code === 'cancelled' || code === 'storage') break;
        }
      }
      if (failure) {
        await fs.promises.rm(`${pathFor(file)}.part`, { force: true });
        throw new SpeechError(failure.code, `Could not download ${file.name}`, failure);
      }
    }
    const marker = Object.fromEntries(assets.files.map((file) => [file.name, file.sha256]));
    await fs.promises.writeFile(path.join(modelDir, MARKER_NAME), JSON.stringify(marker));
  }

  function prepare(source = 'auto') {
    if (!DOWNLOAD_SOURCES.includes(source)) throw new SpeechError('invalid', 'Unknown download source');
    if (preparation) return preparation;
    const controller = new AbortController();
    downloadAbort = controller;
    lastError = null;
    modelState = 'downloading';
    publish();
    preparation = prepareModel(source, controller.signal).then(() => {
      download = null;
      setState('ready');
    }, (error) => {
      download = null;
      lastError = {
        // An abort can surface from any await (a DOMException with a numeric code).
        code: controller.signal.aborted ? 'cancelled' : error instanceof SpeechError ? error.code : classifyDownloadError(error),
        file: error && error.file,
        source: error && error.source,
        status: error && error.status,
      };
      setState(lastError.code === 'cancelled' ? 'missing' : 'error');
    }).finally(() => {
      preparation = null;
      downloadAbort = null;
    });
    return preparation;
  }

  async function cancelPreparation() {
    if (downloadAbort) downloadAbort.abort();
    if (preparation) await preparation;
  }

  // ── Recognizer process ────────────────────────────────────────────────────

  function stopWorker(reason) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    const current = worker;
    worker = null;
    workerReady = null;
    for (const [id, pending] of pendingReplies) {
      pendingReplies.delete(id);
      pending.reject(new SpeechError('worker', reason));
    }
    if (current) {
      try { current.kill(); } catch { /* already exited */ }
    }
  }

  function request(message, timeoutMs) {
    const current = worker;
    const id = nextRequestId++;
    if (!current) return Promise.reject(new SpeechError('worker', 'Speech recognizer is not running'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplies.delete(id);
        stopWorker('Speech recognizer timed out');
        reject(new SpeechError('timeout', 'Speech recognizer timed out'));
      }, timeoutMs);
      pendingReplies.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      current.postMessage({ ...message, id });
    });
  }

  function ensureWorker() {
    if (workerReady) return workerReady;
    const child = deps.fork(deps.workerPath);
    worker = child;
    child.on('message', (message) => {
      const pending = message && pendingReplies.get(message.id);
      if (!pending) return;
      pendingReplies.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new SpeechError('recognizer', String(message.error || 'Recognition failed')));
    });
    child.on('exit', () => {
      if (worker === child) stopWorker('Speech recognizer exited');
    });
    workerReady = request({
      type: 'load',
      runtimeDir: deps.runtimeDir,
      model: pathFor(assets.files[0]),
      tokens: pathFor(assets.files[1]),
      vad: pathFor(assets.files[2]),
      threads: options.threads,
    }, options.loadTimeoutMs).catch((error) => {
      if (worker === child) stopWorker('Speech recognizer failed to load');
      throw error;
    });
    return workerReady;
  }

  function scheduleIdleStop() {
    if (idleTimer) clearTimeout(idleTimer);
    if (options.idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => stopWorker('idle'), options.idleTimeoutMs);
  }

  async function transcribe(input) {
    const audio = input && input.audio;
    if (!(audio instanceof Uint8Array) || audio.byteLength > MAX_AUDIO_BYTES) {
      throw new SpeechError('invalid', 'Speech audio must be bytes within the recording limit');
    }
    const language = input.language ?? 'auto';
    if (!SPEECH_LANGUAGES.includes(language)) throw new SpeechError('invalid', 'Unsupported speech language');
    try {
      validateWave(audio, MAX_AUDIO_SECONDS);
    } catch (error) {
      throw new SpeechError('invalid', error.message);
    }
    await ensureChecked();
    if (modelState !== 'ready') throw new SpeechError('not-ready', 'Speech model is not installed');
    if (!runtimeAvailable()) throw new SpeechError('runtime-missing', 'Speech runtime is not installed');
    if (queued >= options.maxPending) throw new SpeechError('busy', 'Too many recordings are waiting');
    queued++;
    const run = queue.then(async () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      await ensureWorker();
      return request({ type: 'transcribe', audio, language }, options.inferenceTimeoutMs);
    });
    queue = run.catch(() => undefined).finally(() => {
      queued--;
      if (queued === 0 && worker) scheduleIdleStop();
    });
    return run;
  }

  async function deleteModel() {
    await cancelPreparation();
    stopWorker('Speech model deleted');
    await fs.promises.rm(modelDir, { recursive: true, force: true });
    lastError = null;
    download = null;
    setState('missing');
  }

  async function dispatch(action, input = {}) {
    switch (action) {
      case 'status':
        await ensureChecked();
        return snapshot();
      case 'prepare':
        await ensureChecked();
        if (modelState === 'ready') return snapshot();
        void prepare(input && input.source !== undefined ? input.source : 'auto');
        return snapshot();
      case 'cancel':
        await cancelPreparation();
        return snapshot();
      case 'delete':
        await deleteModel();
        return snapshot();
      case 'transcribe':
        return transcribe(input);
      default:
        throw new SpeechError('invalid', 'Speech: unsupported action');
    }
  }

  function dispose() {
    if (downloadAbort) downloadAbort.abort();
    stopWorker('Speech host disposed');
  }

  return { dispatch, dispose, snapshot };
}

module.exports = {
  DOWNLOAD_SOURCES,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  SPEECH_CHANNEL,
  SPEECH_EVENT_CHANNEL,
  SpeechError,
  createSpeechHost,
  loadAssets,
};
