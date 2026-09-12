'use strict';

// This module has no executor. A replay is diagnostic data, never permission
// to repeat an input or evidence that the user's task succeeded.
const { createHash, randomUUID } = require('node:crypto');
const { COMPUTER_USE_PRIVILEGED_COMMANDS } = require('./computerUseCommands.cjs');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STAGES = new Set(['approval', 'observation', 'action-attempted', 'action-outcome', 'turn-stopped', 'turn-ended']);
const ENUMS = {
  approvalKind: new Set(['task', 'app', 'action', 'browser-origin']),
  approvalDecision: new Set(['requested', 'allowed', 'denied', 'error']),
  outcome: new Set(['success', 'stopped', 'verified-change', 'no-change', 'outcome-unknown', 'not-executed']),
  verificationStatus: new Set(['verified-change', 'no-change']),
  reason: new Set(['continue', 'recover', 'observe-required', 'stop-no-progress', 'stop-ambiguous-side-effect',
    'outcome-unknown', 'physical-input', 'emergency-stop', 'user-stopped', 'user-stop', 'aborted',
    'stopped', 'task-ended', 'renderer-gone', 'disabled', 'helper-failed',
    'user-interrupted', 'user-input-detected', 'window-invalidated']),
};
const MAX_RECORDS = 10_000;

function sanitizeTrajectoryAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.trajectoryVersion !== 1 || !UUID.test(raw.trajectoryId ?? '')
    || !/^cu-[a-f0-9]{24}$/.test(raw.computerRunId ?? '')
    || !Number.isSafeInteger(raw.trajectorySequence) || raw.trajectorySequence < 1
    || !STAGES.has(raw.stage)) return null;
  const result = {
    trajectoryVersion: 1, trajectoryId: raw.trajectoryId.toLowerCase(),
    computerRunId: raw.computerRunId, trajectorySequence: raw.trajectorySequence, stage: raw.stage,
  };
  for (const [key, values] of Object.entries(ENUMS)) {
    if (values.has(raw[key])) result[key] = raw[key];
  }
  if (COMPUTER_USE_PRIVILEGED_COMMANDS.has(raw.command)) result.command = raw.command;
  for (const key of ['attemptCount', 'durationMs', 'helperGeneration']) {
    if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) result[key] = raw[key];
  }
  for (const key of ['outcomeUnknown', 'consequential']) {
    if (typeof raw[key] === 'boolean') result[key] = raw[key];
  }
  if (typeof raw.windowGraphRevision === 'string' && /^[a-f0-9]{64}$/.test(raw.windowGraphRevision)) {
    result.windowGraphRevision = raw.windowGraphRevision;
  }
  return result;
}

function normalizeTrajectoryEvent(raw) {
  const attributes = sanitizeTrajectoryAttributes(raw);
  if (!attributes || raw.schemaVersion !== 1 || raw.event !== 'main.computer_use_trajectory' || raw.process !== 'main'
    || !UUID.test(raw.appSessionId ?? '') || !Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0) return null;
  return { appSessionId: raw.appSessionId.toLowerCase(), timestamp: raw.timestamp, ...attributes };
}

function createTrajectoryRecorder({ emit, idFactory = randomUUID, maxRuns = 512 } = {}) {
  const streams = new Map();
  const capacity = Math.max(1, Math.min(512, Number.isSafeInteger(maxRuns) ? maxRuns : 512));
  return {
    record(key, stage, attributes = {}) {
      if (typeof key !== 'string' || !key || !STAGES.has(stage)) return;
      let stream = streams.get(key);
      if (!stream) {
        if (streams.size >= capacity) streams.delete(streams.keys().next().value);
        stream = { id: idFactory(), sequence: 0 };
        streams.set(key, stream);
      }
      const safe = sanitizeTrajectoryAttributes({
        ...attributes, trajectoryVersion: 1, trajectoryId: stream.id,
        computerRunId: `cu-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
        trajectorySequence: ++stream.sequence, stage,
      });
      // Telemetry failure must never fail or retry a native input.
      try { if (safe) emit?.(safe); } catch { /* diagnostic only */ }
    },
    clear() { streams.clear(); },
  };
}

function projectRun(events, inputIncomplete) {
  const first = events[0];
  const issues = new Set();
  if (inputIncomplete) issues.add('input-incomplete');
  const metrics = { actionAttempts: 0, observations: 0, verifiedChanges: 0, noChanges: 0,
    unknownOutcomes: 0, approvalsRequested: 0, approvalsDenied: 0, approvalErrors: 0,
    approvalWaitMs: 0, elapsedMs: 0, activeMs: 0, interventions: 0 };
  const seen = new Map();
  const attempts = new Map();
  const approvals = new Map();
  let phase = 'unknown';
  let stopped = false;
  let ended = false;
  let stopReason = null;
  let pendingAttempt = null;
  let approvalStart = null;
  let approvalDepth = 0;
  let lastSequence = 0;
  let lastObservationSequence = 0;
  let lastTimestamp = first.timestamp;
  for (const e of events) {
    const previous = seen.get(e.trajectorySequence);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(e)) issues.add('sequence-conflict');
      continue;
    }
    seen.set(e.trajectorySequence, e);
    if (e.trajectorySequence !== lastSequence + 1) issues.add('sequence-gap');
    if (e.timestamp < lastTimestamp) issues.add('clock-regression');
    lastSequence = e.trajectorySequence;
    lastTimestamp = Math.max(lastTimestamp, e.timestamp);
    if (e.stage === 'approval') {
      if (!e.approvalKind || !e.approvalDecision) { issues.add('invalid-approval'); continue; }
      if (e.approvalDecision === 'requested') {
        metrics.approvalsRequested++;
        approvals.set(e.approvalKind, (approvals.get(e.approvalKind) ?? 0) + 1);
        if (approvalDepth++ === 0) approvalStart = e.timestamp;
        phase = 'awaiting-approval';
      } else {
        const depth = approvals.get(e.approvalKind) ?? 0;
        if (!depth) issues.add('orphan-approval');
        else {
          approvals.set(e.approvalKind, depth - 1);
          if (--approvalDepth === 0) {
            metrics.approvalWaitMs += Math.max(0, e.timestamp - approvalStart);
            approvalStart = null;
          }
        }
        if (e.approvalDecision === 'denied') metrics.approvalsDenied++;
        if (e.approvalDecision === 'error') metrics.approvalErrors++;
        phase = approvalDepth ? 'awaiting-approval'
          : e.approvalDecision === 'allowed' ? 'awaiting-observation' : 'blocked';
      }
    } else if (e.stage === 'observation') {
      metrics.observations++;
      lastObservationSequence = e.trajectorySequence;
      phase = pendingAttempt === null ? 'ready' : 'awaiting-observation';
    } else if (e.stage === 'action-attempted') {
      if (!e.attemptCount || !e.command || attempts.has(e.attemptCount) || pendingAttempt !== null) {
        issues.add('invalid-attempt');
      } else {
        attempts.set(e.attemptCount, { unknown: false, verified: false, sequence: e.trajectorySequence });
        metrics.actionAttempts++;
        pendingAttempt = e.attemptCount;
        phase = 'acting';
      }
    } else if (e.stage === 'action-outcome') {
      if (['stop-no-progress', 'stop-ambiguous-side-effect'].includes(e.reason)) {
        stopped = true;
        stopReason ??= e.reason;
      }
      const attempt = attempts.get(e.attemptCount);
      if (!attempt) issues.add('orphan-outcome');
      else if (e.outcome === 'outcome-unknown') {
        if (!attempt.unknown) metrics.unknownOutcomes++;
        attempt.unknown = true;
        phase = 'awaiting-observation';
        if (e.consequential) { stopped = true; stopReason ??= 'outcome-unknown'; }
      } else if (e.outcome === 'verified-change' || e.outcome === 'no-change') {
        if (attempt.verified || pendingAttempt !== e.attemptCount
          || lastObservationSequence <= attempt.sequence) issues.add('invalid-outcome');
        else {
          attempt.verified = true;
          metrics[e.outcome === 'verified-change' ? 'verifiedChanges' : 'noChanges']++;
          pendingAttempt = null;
          phase = 'ready';
        }
      } else if (e.outcome === 'not-executed') {
        // Refused before dispatch: the attempt closes with no verdict on the
        // target — neither progress nor an unknown outcome.
        attempt.released = true;
        pendingAttempt = null;
        phase = 'ready';
      } else issues.add('invalid-outcome');
    } else if (e.stage === 'turn-stopped') {
      if (!stopped && ['physical-input', 'emergency-stop', 'user-stop', 'user-stopped',
        'user-interrupted', 'user-input-detected'].includes(e.reason)) metrics.interventions++;
      stopped = true;
      stopReason ??= e.reason ?? 'stopped';
    } else if (e.stage === 'turn-ended') ended = true;
  }
  if (approvalStart !== null) metrics.approvalWaitMs += Math.max(0, lastTimestamp - approvalStart);
  if (ended && pendingAttempt !== null) issues.add('unresolved-attempt-at-end');
  if (ended && approvalDepth > 0) issues.add('unresolved-approval-at-end');
  metrics.elapsedMs = Math.max(0, lastTimestamp - first.timestamp);
  metrics.activeMs = Math.max(0, metrics.elapsedMs - metrics.approvalWaitMs);
  // Missing/conflicting records cannot establish the present state. A known
  // stop remains fail-closed even with a truncated prefix or late callbacks.
  phase = stopped ? 'stopped' : issues.size ? 'unknown' : ended ? 'ended' : phase;
  return {
    appSessionId: first.appSessionId, trajectoryId: first.trajectoryId, computerRunId: first.computerRunId,
    eventCount: seen.size, lastSequence, phase, stopReason,
    taskOutcome: 'not-evaluated', historyComplete: issues.size === 0,
    issues: [...issues].sort(), metrics,
  };
}

function replayComputerUseTrajectory(records, { maxRecords = MAX_RECORDS, inputTruncated = false, droppedInvalidRecordCount = 0 } = {}) {
  const limit = Math.max(1, Math.min(MAX_RECORDS, Number.isSafeInteger(maxRecords) ? maxRecords : MAX_RECORDS));
  const groups = new Map();
  let invalidRecordCount = Number.isSafeInteger(droppedInvalidRecordCount) ? Math.max(0, droppedInvalidRecordCount) : 0;
  let count = 0;
  let truncated = inputTruncated === true;
  for (const record of records) {
    if (++count > limit) { truncated = true; break; }
    let raw = record;
    if (typeof raw === 'string') {
      if (!raw.trim()) continue;
      try { raw = JSON.parse(raw); } catch { invalidRecordCount++; continue; }
    }
    if (raw?.event !== 'main.computer_use_trajectory') continue;
    const normalized = normalizeTrajectoryEvent(raw);
    if (!normalized) { invalidRecordCount++; continue; }
    const key = `${normalized.appSessionId}:${normalized.trajectoryId}:${normalized.computerRunId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(normalized);
  }
  const runs = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, events]) =>
    projectRun(events.sort((a, b) => a.trajectorySequence - b.trajectorySequence
      || JSON.stringify(a).localeCompare(JSON.stringify(b))), truncated || invalidRecordCount > 0));
  return { schemaVersion: 1, evaluationKind: 'diagnostic-replay',
    complete: !truncated && invalidRecordCount === 0 && runs.every((r) => r.historyComplete),
    truncated, invalidRecordCount, runs };
}

module.exports = { sanitizeTrajectoryAttributes, normalizeTrajectoryEvent, createTrajectoryRecorder, replayComputerUseTrajectory };
