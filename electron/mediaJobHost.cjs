'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const {
  imageEditRequestSchema, mediaArtifactSchema, mediaJobSchema,
  detachMediaJob, recoverMediaJob, transitionMediaJob,
} = require('./generated/mediaRuntime.cjs');

/** One host owns requests, persistence and paid execution for its data root. */
function createMediaJobHost({ root, scope, assertConversation, onChange, hasSavedResponse }) {
  const records = new Map();
  const running = new Map();
  const deleted = new Set();

  function assertOwner(conversationId) {
    if (deleted.has(conversationId)) throw new Error('Media conversation is unavailable');
    assertConversation(conversationId);
  }

  function recordPath(conversationId, requestId) {
    const conversationKey = createHash('sha256').update(conversationId).digest('hex');
    const requestKey = createHash('sha256').update(requestId).digest('hex');
    return path.join(root, conversationKey, `${requestKey}.json`);
  }

  function parseRecord(saved, conversationId, requestId) {
    const request = imageEditRequestSchema.parse(saved.request);
    const job = mediaJobSchema.parse(saved.job);
    const artifacts = saved.artifacts.map((artifact) => mediaArtifactSchema.parse(artifact));
    if (request.id !== requestId || request.conversationId !== conversationId || request.scope !== scope
      || job.requestId !== requestId || job.conversationId !== conversationId || job.scope !== scope) {
      throw new Error('Media request ownership does not match');
    }
    return { request, job, artifacts };
  }

  function read(conversationId, requestId) {
    assertOwner(conversationId);
    const target = recordPath(conversationId, requestId);
    const cached = records.get(target);
    if (cached) return cached;
    if (!fs.existsSync(target)) throw new Error('Media request is unavailable');
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally {
      fs.closeSync(descriptor);
    }
    const { request, job, artifacts } = parseRecord(saved, conversationId, requestId);
    const received = job.generationState === 'running' && hasSavedResponse?.(request);
    const record = { request, job: recoverMediaJob(received ? transitionMediaJob(job, 'saving') : job), artifacts };
    if (record.job !== job) save(record);
    else records.set(target, record);
    return record;
  }

  function save(record) {
    assertOwner(record.request.conversationId);
    const target = recordPath(record.request.conversationId, record.request.id);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const staging = `${target}.${randomUUID()}.part`;
    try {
      const descriptor = fs.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify(record));
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { force: true });
    }
    records.set(target, record);
    onChange?.(structuredClone(record));
  }

  function move(record, state, details) {
    const next = { ...record, job: transitionMediaJob(record.job, state, details) };
    save(next);
    return next;
  }

  return {
    list() {
      if (!fs.existsSync(root)) return [];
      if (fs.realpathSync(root) !== path.resolve(root)) throw new Error('Media job directory changed');
      const result = [];
      for (const folder of fs.readdirSync(root, { withFileTypes: true })) {
        if (!folder.isDirectory() || !/^[a-f0-9]{64}$/.test(folder.name)) throw new Error('Media job directory is invalid');
        for (const name of fs.readdirSync(path.join(root, folder.name))) {
          if (name.endsWith('.part')) continue;
          if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Media job record is invalid');
          const target = path.join(root, folder.name, name);
          const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          let saved;
          try {
            if (fs.fstatSync(descriptor).size > 8 * 1024 * 1024) throw new Error('Media job record exceeds the supported size');
            saved = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
          } finally { fs.closeSync(descriptor); }
          const request = imageEditRequestSchema.parse(saved.request);
          if (recordPath(request.conversationId, request.id) !== target) throw new Error('Media job record ownership does not match');
          result.push(parseRecord(saved, request.conversationId, request.id));
        }
      }
      return result;
    },

    discardPrepared(conversationId, requestId) {
      const record = read(conversationId, requestId);
      if (record.job.generationState !== 'prepared') throw new Error('Submitted image requests must be retained');
      const target = recordPath(conversationId, requestId);
      fs.rmSync(target);
      records.delete(target);
    },

    prepare(input) {
      const request = imageEditRequestSchema.parse(input);
      if (request.scope !== scope) throw new Error('Media scope is unavailable');
      assertOwner(request.conversationId);
      const target = recordPath(request.conversationId, request.id);
      if (records.has(target) || fs.existsSync(target)) {
        const existing = read(request.conversationId, request.id);
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
          throw new Error('Media request id already names different instructions');
        }
        return structuredClone(existing);
      }
      const record = {
        request,
        job: {
          schemaVersion: 1, id: request.id, requestId: request.id, scope,
          conversationId: request.conversationId, attempt: 1, generationState: 'prepared',
          waitState: 'waiting', sequence: 0, outputArtifactIds: [],
        },
        artifacts: [],
      };
      save(record);
      return structuredClone(record);
    },

    get(conversationId, requestId) {
      return structuredClone(read(conversationId, requestId));
    },

    find(conversationId, requestId) {
      assertOwner(conversationId);
      const target = recordPath(conversationId, requestId);
      return records.has(target) || fs.existsSync(target) ? structuredClone(read(conversationId, requestId)) : undefined;
    },

    detach(conversationId, requestId) {
      const record = read(conversationId, requestId);
      const next = { ...record, job: detachMediaJob(record.job) };
      if (next.job !== record.job) save(next);
      return structuredClone(next);
    },

    start(conversationId, requestId, execute) {
      const target = recordPath(conversationId, requestId);
      const record = read(conversationId, requestId);
      if (running.has(target)) return running.get(target);
      if (record.job.generationState !== 'prepared') return Promise.resolve(structuredClone(record));
      move(record, 'submitting');
      const controller = new AbortController();
      const execution = Promise.resolve().then(async () => {
        move(read(conversationId, requestId), 'running');
        const artifacts = await execute(structuredClone(record.request), {
          signal: controller.signal,
          saving() { move(read(conversationId, requestId), 'saving'); },
        });
        const parsed = artifacts.map((artifact) => mediaArtifactSchema.parse(artifact));
        if (parsed.some((artifact) => artifact.conversationId !== conversationId || artifact.editRequestId !== requestId)) {
          throw new Error('Media result belongs to another request');
        }
        const saved = read(conversationId, requestId);
        return move({ ...saved, artifacts: parsed }, 'completed', { outputArtifactIds: parsed.map((artifact) => artifact.id) });
      }).then(
        (result) => structuredClone(result),
        (error) => {
          if (deleted.has(conversationId)) throw error;
          let current = read(conversationId, requestId);
          if (current.job.generationState === 'running' && hasSavedResponse?.(current.request)) current = move(current, 'saving');
          const state = current.job.generationState === 'saving' ? 'save_failed'
            : error?.submissionUnknown === true ? 'unknown' : 'failed';
          move(current, state, { error: error instanceof Error ? error.message : String(error) });
          throw error;
        },
      ).finally(() => running.delete(target));
      running.set(target, execution);
      execution.controller = controller;
      execution.conversationId = conversationId;
      return execution;
    },

    retrySave(conversationId, requestId, saveResult) {
      const target = recordPath(conversationId, requestId);
      const record = read(conversationId, requestId);
      if (running.has(target)) return running.get(target);
      if (record.job.generationState !== 'save_failed') throw new Error('This image does not need saving again');
      move(record, 'saving');
      const controller = new AbortController();
      const execution = Promise.resolve().then(async () => {
        const artifacts = (await saveResult(structuredClone(record.request))).map(artifact => mediaArtifactSchema.parse(artifact));
        if (artifacts.some(artifact => artifact.conversationId !== conversationId || artifact.editRequestId !== requestId)) {
          throw new Error('Media result belongs to another request');
        }
        return move({ ...read(conversationId, requestId), artifacts }, 'completed', { outputArtifactIds: artifacts.map(artifact => artifact.id) });
      }).then(result => structuredClone(result), error => {
        if (!deleted.has(conversationId)) move(read(conversationId, requestId), 'save_failed', { error: error instanceof Error ? error.message : String(error) });
        throw error;
      }).finally(() => running.delete(target));
      execution.controller = controller;
      execution.conversationId = conversationId;
      running.set(target, execution);
      return execution;
    },

    forget(conversationId) {
      deleted.add(conversationId);
      for (const [target, execution] of running) {
        if (execution.conversationId !== conversationId) continue;
        execution.controller.abort();
        running.delete(target);
      }
      for (const [target, record] of records) {
        if (record.request.conversationId === conversationId) records.delete(target);
      }
      const directory = path.dirname(recordPath(conversationId, 'unused'));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

module.exports = { createMediaJobHost };
