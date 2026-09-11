'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTrajectoryEvent, replayComputerUseTrajectory, createTrajectoryRecorder } = require('./computerUseTrajectory.cjs');

const SESSION = 'a1111111-1111-4111-8111-111111111111';
const STREAM = 'b1111111-1111-4111-8111-111111111111';
const RUN = 'cu-0123456789abcdef01234567';
const event = (sequence, stage, fields = {}) => ({
  schemaVersion: 1, event: 'main.computer_use_trajectory', process: 'main', trajectoryVersion: 1,
  appSessionId: SESSION, trajectoryId: STREAM, computerRunId: RUN,
  timestamp: sequence * 100, trajectorySequence: sequence, stage, ...fields,
});
const replay = (events) => replayComputerUseTrajectory(events).runs[0];

test('reconstructs approval waiting without an artificial response deadline', () => {
  const requested = event(1, 'approval', { approvalKind: 'task', approvalDecision: 'requested' });
  const pending = replay([requested]);
  assert.equal(pending.phase, 'awaiting-approval');
  assert.equal(pending.metrics.approvalsRequested, 1);
  const result = replay([
    requested,
    event(2, 'approval', { timestamp: 3600100, approvalKind: 'task', approvalDecision: 'allowed', durationMs: 3600000 }),
    event(3, 'observation', { timestamp: 3600200 }),
  ]);
  assert.equal(result.phase, 'ready');
  assert.equal(result.metrics.approvalWaitMs, 3600000);
  assert.equal(result.metrics.activeMs, 100);
  assert.equal(result.taskOutcome, 'not-evaluated');
});

test('unknown input requires observation; a change is never proof of task completion', () => {
  const events = [event(1, 'observation'), event(2, 'action-attempted', { attemptCount: 1, command: 'keyboard_type' }),
    event(3, 'action-outcome', { attemptCount: 1, outcome: 'outcome-unknown', outcomeUnknown: true })];
  assert.equal(replay(events).phase, 'awaiting-observation');
  const result = replay([...events, event(4, 'observation'), event(5, 'action-outcome', { attemptCount: 1, outcome: 'verified-change' })]);
  assert.equal(result.phase, 'ready');
  assert.equal(result.metrics.actionAttempts, 1);
  assert.equal(result.metrics.unknownOutcomes, 1);
  assert.equal(result.metrics.verifiedChanges, 1);
  assert.equal(result.taskOutcome, 'not-evaluated');
});

test('stop is terminal even when late approval or outcome events arrive', () => {
  const result = replay([event(1, 'turn-stopped', { reason: 'outcome-unknown' }),
    event(2, 'approval', { approvalKind: 'action', approvalDecision: 'allowed' }),
    event(3, 'action-outcome', { attemptCount: 1, outcome: 'verified-change' })]);
  assert.equal(result.phase, 'stopped');
  assert.equal(result.stopReason, 'outcome-unknown');
  assert.equal(result.taskOutcome, 'not-evaluated');
});

test('duplicates are idempotent; gaps, conflicts and orphan outcomes are incomplete', () => {
  const first = event(1, 'observation');
  assert.equal(replay([first, first]).eventCount, 1);
  assert.equal(replay([first, first]).historyComplete, true);
  const gap = replay([first, event(3, 'observation')]);
  assert.equal(gap.historyComplete, false);
  assert.ok(gap.issues.includes('sequence-gap'));
  const conflict = replay([first, event(1, 'turn-stopped')]);
  assert.equal(conflict.historyComplete, false);
  assert.equal(conflict.phase, 'unknown');
  assert.ok(conflict.issues.includes('sequence-conflict'));
  assert.equal(replay([event(1, 'action-outcome', { attemptCount: 1, outcome: 'verified-change' })]).historyComplete, false);
});

test('replay ordering is deterministic, isolates process restarts, and detects clock regression', () => {
  const first = event(1, 'observation');
  const second = event(2, 'action-attempted', { attemptCount: 1, command: 'keyboard_type' });
  assert.deepEqual(replayComputerUseTrajectory([second, first]), replayComputerUseTrajectory([first, second]));
  assert.equal(replayComputerUseTrajectory([first, { ...first, appSessionId: STREAM }]).runs.length, 2);
  assert.ok(replay([first, { ...second, timestamp: 0 }]).issues.includes('clock-regression'));
});

test('strict structural metadata excludes private content even in known string fields', () => {
  const safe = normalizeTrajectoryEvent(event(1, 'observation', {
    title: 'private', text: 'private', prompt: 'private', base64: 'private', stateId: 'private',
    command: 'private', reason: 'private', approvalKind: 'private', outcome: 'private',
    windowGraphRevision: 'private', targetBundleId: 'private',
  }));
  assert.equal(JSON.stringify(safe).includes('private'), false);
  assert.equal(normalizeTrajectoryEvent(event(1, 'private')), null);
  assert.equal(normalizeTrajectoryEvent(event(1, 'observation', { computerRunId: 'private' })), null);
  assert.equal(normalizeTrajectoryEvent(event(1, 'observation', { trajectoryVersion: 99 })), null);
});

test('malformed JSON and invalid trajectory versions cannot silently yield complete reports', () => {
  const report = replayComputerUseTrajectory([JSON.stringify(event(1, 'observation')), '{', event(2, 'observation', { trajectoryVersion: 99 })]);
  assert.equal(report.invalidRecordCount, 2);
  assert.equal(report.complete, false);
  assert.equal(report.runs[0].historyComplete, false);
});

test('recorder keeps bounded memory and uses a fresh stream when an evicted task returns', () => {
  const recorded = [];
  let id = 0;
  const recorder = createTrajectoryRecorder({ emit: (e) => recorded.push(e), maxRuns: 2,
    idFactory: () => `b1111111-1111-4111-8111-${String(++id).padStart(12, '0')}` });
  recorder.record('secret-task-a', 'observation');
  recorder.record('secret-task-a', 'observation');
  recorder.record('secret-task-b', 'observation');
  recorder.record('secret-task-c', 'observation');
  recorder.record('secret-task-a', 'observation');
  assert.equal(recorded[1].trajectorySequence, 2);
  assert.equal(recorded[4].trajectorySequence, 1);
  assert.notEqual(recorded[0].trajectoryId, recorded[4].trajectoryId);
  assert.equal(JSON.stringify(recorded).includes('secret-task'), false);
  recorder.clear();
});

test('replay bounds the input and exposes truncation rather than guessing a state', () => {
  const report = replayComputerUseTrajectory([event(1, 'observation'), event(2, 'turn-stopped')], { maxRecords: 1 });
  assert.equal(report.truncated, true);
  assert.equal(report.complete, false);
  assert.equal(report.runs[0].phase, 'unknown');
});

test('an outcome without a post-action observation cannot count as verified', () => {
  const run = replay([event(1, 'observation'), event(2, 'action-attempted', { attemptCount: 1, command: 'keyboard_type' }),
    event(3, 'action-outcome', { attemptCount: 1, outcome: 'verified-change' })]);
  assert.equal(run.historyComplete, false);
  assert.equal(run.metrics.verifiedChanges, 0);
});

test('ending the agent turn does not hide an unresolved native attempt', () => {
  const run = replay([event(1, 'observation'), event(2, 'action-attempted', { attemptCount: 1, command: 'keyboard_type' }), event(3, 'turn-ended')]);
  assert.equal(run.phase, 'unknown');
  assert.ok(run.issues.includes('unresolved-attempt-at-end'));
});

test('nested confirmation waits count wall time once, not once per dialog', () => {
  const run = replay([
    event(1, 'approval', { approvalKind: 'task', approvalDecision: 'requested' }),
    event(2, 'approval', { approvalKind: 'action', approvalDecision: 'requested' }),
    event(3, 'approval', { approvalKind: 'action', approvalDecision: 'allowed', durationMs: 100 }),
    event(4, 'approval', { approvalKind: 'task', approvalDecision: 'allowed', durationMs: 300 }),
  ]);
  assert.equal(run.metrics.approvalWaitMs, 300);
  assert.equal(run.metrics.activeMs, 0);
});

test('native takeover events retain their reason and count one human intervention', () => {
  for (const reason of ['user-interrupted', 'user-input-detected']) {
    const run = replay([event(1, 'observation'), event(2, 'turn-stopped', { reason }), event(3, 'turn-stopped', { reason })]);
    assert.equal(run.stopReason, reason);
    assert.equal(run.metrics.interventions, 1);
  }
  const invalidated = replay([event(1, 'turn-stopped', { reason: 'window-invalidated' })]);
  assert.equal(invalidated.stopReason, 'window-invalidated');
  assert.equal(invalidated.metrics.interventions, 0);
});

test('terminal action receipt reasons cannot be relabeled as clean task endings', () => {
  const run = replay([event(1, 'observation'), event(2, 'action-attempted', { attemptCount: 1, command: 'keyboard_type' }),
    event(3, 'observation'), event(4, 'action-outcome', { attemptCount: 1, outcome: 'no-change', reason: 'stop-no-progress' }), event(5, 'turn-ended')]);
  assert.equal(run.phase, 'stopped');
  assert.equal(run.stopReason, 'stop-no-progress');
});

test('ending with a pending approval is incomplete, never cleanly ended', () => {
  const run = replay([event(1, 'approval', { approvalKind: 'task', approvalDecision: 'requested' }), event(2, 'turn-ended')]);
  assert.equal(run.phase, 'unknown');
  assert.ok(run.issues.includes('unresolved-approval-at-end'));
});

test('rejects future or missing log envelope versions', () => {
  assert.equal(normalizeTrajectoryEvent(event(1, 'observation', { schemaVersion: 99 })), null);
  assert.equal(normalizeTrajectoryEvent(event(1, 'observation', { schemaVersion: undefined })), null);
});
