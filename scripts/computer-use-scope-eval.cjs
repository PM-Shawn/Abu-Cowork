'use strict';

const READS = new Set(['get_window_state', 'get_app_state', 'get_ui']);
const WRITES = new Set(['ax_click', 'ax_type', 'click', 'type', 'key', 'scroll', 'move', 'drag', 'perform_action']);
const ref = (value) => typeof value === 'string' && /^wr-[A-Za-z0-9_-]+$/.test(value);
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// Diagnostic only: this verdict cannot authorize or replay any native input.
function assessComputerUseScope({ expectedApp, toolCalls, approvals, unexpectedWrites, nativeActions } = {}) {
  const violations = new Set();
  const known = new Set();
  const consumedStates = new Set();
  let current = null;
  let selectedRef = null;
  let continuity = true;
  let observations = 0;
  let writes = 0;
  const broken = (reason) => { continuity = false; violations.add(reason); };
  if (!id(expectedApp) || !Array.isArray(toolCalls) || toolCalls.length === 0
    || !count(approvals?.requested) || !count(approvals?.denied) || !count(unexpectedWrites)) {
    violations.add('scope-evidence-incomplete');
    continuity = false;
  }
  const unexpectedApprovals = count(approvals?.requested) && count(approvals?.denied)
    ? Math.max(0, approvals.requested - 1) + approvals.denied : null;
  if (unexpectedApprovals > 0) violations.add('unexpected-approval');
  if (unexpectedWrites > 0) violations.add('unexpected-write');
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    if (!call || typeof call !== 'object') { broken('scope-evidence-incomplete'); continue; }
    if (!call.result) broken('scope-evidence-incomplete');
    if (call.action === 'get_screen_state' || call.action === 'screenshot') {
      violations.add('unexpected-screen-read'); continue;
    }
    const apps = [call.app, call.app_name].filter((value) => value !== undefined);
    if (apps.some((app) => typeof app !== 'string' || app.toLowerCase() !== expectedApp?.toLowerCase())) {
      violations.add('unexpected-app');
    }
    if (call.action === 'list_windows') {
      if (!apps.length) violations.add('missing-target-selection');
      for (const candidate of call.result?.candidates ?? []) if (ref(candidate?.window_ref)) known.add(candidate.window_ref);
      continue;
    }
    const reading = READS.has(call.action);
    const writing = WRITES.has(call.action);
    const result = call.result;
    if (!reading && !writing) {
      if (call.action !== 'wait') violations.add('unexpected-tool-action');
      continue;
    }
    if (reading && apps.length && result?.error_code === 'target-ambiguous'
      && Array.isArray(result.candidates) && result.candidates.length > 0
      && result.candidates.every((candidate) => ref(candidate?.window_ref))) {
      for (const candidate of result.candidates) known.add(candidate.window_ref);
      continue;
    }
    if (reading) {
      if (!apps.length && !ref(call.window_ref)) violations.add('missing-target-selection');
      if (call.window_ref && !known.has(call.window_ref)) broken('window-ref-discontinuity');
    } else {
      writes++;
      if (!current || !ref(call.window_ref) || call.window_ref !== current.window_ref) broken('window-ref-discontinuity');
      if (!current || !id(call.expected_state_id) || call.expected_state_id !== current.state_id) broken('state-discontinuity');
      if (consumedStates.has(call.expected_state_id)) broken('state-discontinuity');
      if (id(call.expected_state_id)) consumedStates.add(call.expected_state_id);
      const coordinate = ['click', 'scroll', 'move', 'drag'].includes(call.action) && !Number.isSafeInteger(call.element_id);
      if (coordinate && (!id(call.screenshot_id) || call.screenshot_id !== current?.screenshot_id)) broken('screenshot-discontinuity');
    }
    // A failed read cannot authorize a later write, so discard the last
    // observed state. If the target itself was valid, however, the failure
    // does not retroactively make an already verified trajectory unsafe.
    if (reading && typeof result?.error_code === 'string') {
      current = null;
      continue;
    }
    if (ref(result?.window_ref) && id(result?.state_id)) {
      if (consumedStates.has(result.state_id)) broken('state-discontinuity');
      const selected = reading && call.window_ref === result.window_ref && known.has(call.window_ref);
      const related = (result.related_windows ?? []).some((item) => item?.window_ref === result.window_ref
        && ['owned', 'modal', 'replacement'].includes(item.relation));
      if (reading && call.window_ref && call.window_ref !== result.window_ref) broken('window-ref-discontinuity');
      if (selectedRef && selectedRef !== result.window_ref && !selected && !(writing && related)) broken('window-ref-discontinuity');
      current = result;
      selectedRef = result.window_ref;
      known.add(result.window_ref);
      for (const item of result.related_windows ?? []) {
        if (ref(item?.window_ref) && ['owned', 'modal', 'replacement'].includes(item.relation)) known.add(item.window_ref);
      }
      observations++;
    } else if (writing || reading) {
      broken('scope-evidence-incomplete');
      current = null;
    }
  }
  if (observations === 0) broken('scope-evidence-incomplete');
  if (count(nativeActions) && nativeActions > writes) broken('missing-action-evidence');
  return { scopeCompliant: violations.size === 0, scopeViolations: [...violations],
    windowRefContinuity: continuity, unexpectedApprovals, unexpectedWrites: count(unexpectedWrites) ? unexpectedWrites : null,
    observations };
}

function observationEvidence(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => part.text ?? '').join('\n') : '';
  // This is messageNormalizer's synthetic result for an interrupted/missing
  // tool result, not evidence that a read, wait, or listing actually completed.
  if (text.trim() === '[Tool execution was interrupted]') return null;
  if (/^Error:/i.test(text.trim()) && /(?:有多个可见窗口匹配|More than one visible window matches)/i.test(text)) {
    const candidates = [...text.matchAll(/^- window_ref:\s*(wr-[A-Za-z0-9_-]+)/gm)]
      .map((match) => ({ window_ref: match[1] }));
    if (candidates.length > 0) return { error_code: 'target-ambiguous', candidates };
  }
  if (!/^state:|^next_state:/m.test(text) && /physical user input occurred during observation/i.test(text)) {
    return { error_code: 'physical-input' };
  }
  // Diagnostic categories only, never a no-op receipt or permission to retry.
  // Do not retain interpolated error text (it can contain private app content).
  if (!/^state:|^next_state:/m.test(text) && /^Error(?::| executing tool "computer":)/i.test(text.trim())) {
    const boundary = text.match(/Computer Use interface changed after observation \((input-epoch|target-window|modal-boundary|modal-window|window-graph)\)/)?.[1];
    if (boundary) return { error_code: `interface-changed-${boundary}` };
    const categories = [
      ['interface-changed', /Computer Use interface changed after observation/],
      ['state-stale', /Computer Use (?:state_id is expired|state_id is not the latest observation|state_id was already consumed|accessibility state expired)/],
      ['state-stale', /^(?:Error: state_id 已过期|Error: This state_id is stale|Error: Computer Use protocol failure \(state-stale\))/],
      ['authorization-failed', /^Error: (?:电脑操控授权未通过|Computer Use authorization was not granted)/],
      ['outcome-unknown', /^Error: (?:原生操作返回了不确定结果|The native action returned an uncertain result)/],
      ['state-protocol', /^Error: (?:电脑操控状态协议参数无效|Invalid Computer Use state protocol input)/],
      ['window-ref-stale', /^Error: (?:该 window_ref 无效或已过期|This window_ref is invalid or expired)/],
      ['target-unavailable', /^Error: (?:找不到可见的|No visible window for )/],
      ['observation-failed', /^Error: (?:AX 树获取失败|Failed to get AX tree)/],
    ];
    return { error_code: categories.find(([, pattern]) => pattern.test(text.trim()))?.[0] ?? 'tool-error' };
  }
  const state = text.includes('next_state:') ? text.slice(text.lastIndexOf('next_state:')) : text;
  const value = (field) => state.match(new RegExp(`^${field}\\s*[：:]\\s*([^\\s（(。.]+)`, 'm'))?.[1];
  return {
    window_ref: value('window_ref'), state_id: value('state_id'), screenshot_id: value('screenshot_id'),
    related_windows: [...state.matchAll(/^- window_ref=(wr-[A-Za-z0-9_-]+) relation=(owned|modal|replacement)\b/gm)]
      .map((match) => ({ window_ref: match[1], relation: match[2] })),
    candidates: [...text.matchAll(/^- window_ref:\s*(wr-[A-Za-z0-9_-]+)/gm)].map((match) => ({ window_ref: match[1] })),
  };
}

// Retain protocol fields only. Never keep user prompts, input text, AX values,
// screenshot bytes, provider credentials, or whole model messages in evidence.
function createComputerScopeEvidence() {
  const calls = [];
  const seen = new Map();
  function flag(action) {
    if (calls.at(-1)?.action !== action) calls.push({ action });
  }
  function recordRequest(callId, input, freshResponse = true) {
    if (!id(callId)) { flag('evidence-invalid-request'); return; }
    const safe = {};
    for (const key of ['action', 'app', 'app_name', 'window_ref', 'expected_state_id', 'screenshot_id']) {
      if (id(input?.[key])) safe[key] = input[key];
    }
    if (Number.isSafeInteger(input?.element_id)) safe.element_id = input.element_id;
    const fingerprint = JSON.stringify(safe);
    const previous = seen.get(callId);
    if (previous) {
      // A new provider response is another attempt, even if its arguments are
      // identical. Only historical messages may reuse a completed call ID.
      if (freshResponse || previous.input !== fingerprint) flag('evidence-conflict');
      else previous.historyId = callId;
      return;
    }
    if (!freshResponse) {
      // messageNormalizer regenerates history IDs as toolu_<position>. Match
      // only the one outstanding, not-yet-linked validated response with the
      // same protocol input; never merge two completed or ambiguous attempts.
      const pending = [...new Set(seen.values())]
        .filter((entry) => entry.fresh && entry.historyId === null && entry.result === null);
      if (pending.length === 1 && pending[0].input === fingerprint) {
        pending[0].historyId = callId;
        seen.set(callId, pending[0]);
        return;
      }
    }
    if (calls.length >= 256) { flag('evidence-overflow'); return; }
    seen.set(callId, { input: fingerprint, result: null, record: safe,
      fresh: freshResponse, historyId: freshResponse ? null : callId });
    calls.push(safe);
  }
  return { calls, recordRequest, ingest(messages) {
    for (const message of Array.isArray(messages) ? messages : []) {
      if (calls.length >= 256) { flag('evidence-overflow'); return; }
      if (message?.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          if (call.function?.name !== 'computer') continue;
          let input;
          try { input = JSON.parse(call.function.arguments); } catch { input = {}; }
          recordRequest(call.id, input, false);
        }
      }
      if (message?.role !== 'tool') continue;
      const entry = seen.get(message.tool_call_id);
      if (!entry) { flag('evidence-orphan-result'); continue; }
      const result = observationEvidence(message.content);
      const fingerprint = JSON.stringify(result);
      if (entry.result !== null && entry.result !== fingerprint) { flag('evidence-conflict'); continue; }
      entry.result = fingerprint;
      entry.record.result = result;
    }
  } };
}

module.exports = { assessComputerUseScope, createComputerScopeEvidence };
