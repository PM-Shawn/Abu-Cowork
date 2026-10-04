'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDesktopModelResponse, startDesktopLiveProxy, buildDesktopEvalReport, buildDesktopLifecycleReport, recordDesktopEvaluation, createDesktopModelDriver, desktopTaskFinished } = require('./computer-use-desktop-eval.cjs');
const { validateOfficeModelResponse } = require('./computer-use-live-eval.cjs');
const scope = { appName: 'AbuCuFixture-abc123', marker: 'ABU_CU_TEST' };
const frame = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
const tool = (input, name = 'computer', id = 'one') => frame({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }) + 'data: [DONE]\n\n';
const input = { action: 'ax_type', app: scope.appName, consequence: 'none', window_ref: 'wr-test', element_id: 3, expected_state_id: 'state-test', text: scope.marker };
const trajectory = { complete: true, runs: [{ phase: 'ended', historyComplete: true, metrics: {
  actionAttempts: 3, approvalWaitMs: 20000, interventions: 0, unknownOutcomes: 0,
} }] };
const oracle = { version: 1, scenario: 'edit', markerPresent: true, mainMarkerPresent: true,
  secondaryMarkerPresent: false, dialogDepth: 0, cancelCount: 0, unexpectedWrites: 0 };
const scopeEvidence = { expectedApp: scope.appName, approvals: { requested: 1, denied: 0 }, toolCalls: [{
  action: 'get_window_state', app: scope.appName, result: { window_ref: 'wr-test', state_id: 'state-test' },
}, ...['state-test', 'state-2', 'state-3'].map((state, index) => ({
  action: 'ax_type', window_ref: 'wr-test', expected_state_id: state, element_id: 3,
  result: { window_ref: 'wr-test', state_id: `state-${index + 2}` },
}))] };

test('desktop only permits indexed native actions in its exact owned application', () => {
  assert.equal(validateDesktopModelResponse(tool(input), scope), true);
  assert.equal(validateDesktopModelResponse(tool({ ...input, text: undefined, action: 'ax_click' }), scope), true);
  for (const mutation of [
    { app: 'PowerShell' }, { app_name: 'Explorer' }, { text: 'private text' }, { x: 3 },
    { action: 'click', element_id: undefined, x: 3, y: 5 }, { action: 'key', key: 'Win+r' }, { action: 'screenshot' },
    { expected_state_id: undefined }, { window_ref: undefined }, { element_id: -1 }, { element_id: 1.5 },
    { consequence: 'send' }, { unexpected: 'payload' },
  ]) assert.throws(() => validateDesktopModelResponse(tool({ ...input, ...mutation }), scope), /scope/);
  assert.throws(() => validateDesktopModelResponse(tool(input, 'run_command'), scope), /scope/);
  assert.throws(() => validateOfficeModelResponse(tool({ ...input, action: 'ax_click', app: 'WINWORD' }), { appName: 'WINWORD', marker: scope.marker }), /scope/);
});

test('desktop scope rejection exposes only a fixed reason code, not model input values', () => {
  for (const [change, reason] of [
    [{ window_ref: undefined }, 'missing-window-ref'],
    [{ expected_state_id: undefined }, 'missing-state-id'],
    [{ action: 'key' }, 'unsupported-key'],
    [{ privateField: 'PRIVATE_MODEL_TEXT' }, 'unexpected-field'],
    [{ action: 'get_window_state', app: undefined, window_ref: undefined }, 'missing-app'],
    [{ consequence: undefined }, 'invalid-consequence'],
    [{ show_user: true }, 'unexpected-display'],
  ]) {
    assert.throws(() => validateDesktopModelResponse(tool({ ...input, ...change }), scope),
      (error) => error.code === reason && !error.message.includes('PRIVATE_MODEL_TEXT'));
  }
});

test('standard indexed click/type share AX scope limits without enabling coordinate or keyboard input', () => {
  for (const action of ['click', 'type']) {
    const request = { ...input, action, ...(action === 'click' ? { text: undefined } : {}) };
    assert.equal(validateDesktopModelResponse(tool(request), scope), true);
    for (const change of [{ element_id: undefined }, { window_ref: undefined }, { expected_state_id: undefined },
      { x: 1, y: 2 }, { key: 'Enter' }, { app: 'Other' }, { text: 'unexpected-input' }]) {
      assert.throws(() => validateDesktopModelResponse(tool({ ...request, ...change }), scope), /scope/);
    }
  }
});

test('window-bound requests may omit the redundant app name but cannot switch to another app', () => {
  for (const action of ['type', 'click', 'ax_type', 'ax_click', 'get_window_state']) {
    const request = ['get_window_state'].includes(action)
      ? { action, window_ref: 'wr-test', consequence: 'none' }
      : { ...input, action, app: undefined, ...(['type', 'ax_type'].includes(action) ? {} : { text: undefined }) };
    assert.equal(validateDesktopModelResponse(tool(request), scope), true);
    assert.throws(() => validateDesktopModelResponse(tool({ ...request, app: 'Other' }), scope), /scope/);
    assert.throws(() => validateDesktopModelResponse(tool({ ...request, window_ref: undefined }), scope), /scope/);
  }
  assert.throws(() => validateDesktopModelResponse(tool({ action: 'list_windows', window_ref: 'wr-test', consequence: 'none' }), scope), /scope/);
});

test('bounded wait needs no window target because it cannot read or write the desktop', () => {
  assert.equal(validateDesktopModelResponse(tool({ action: 'wait', duration: 300, consequence: 'none' }), scope), true);
  for (const change of [{ duration: 10001 }, { x: 1 }, { action: 'get_window_state' }, { key: 'Enter' }, { app: 'Other' }]) {
    assert.throws(() => validateDesktopModelResponse(tool({ action: 'wait', duration: 300, consequence: 'none', ...change }), scope), /scope/);
  }
});

test('indexed actions accept bounded verification predicates without opening another input channel', () => {
  for (const effect of [
    { type: 'any-state-change' },
    { type: 'element-value', element_id: 3, equals: scope.marker },
    { type: 'element-state', element_id: 3, attribute: 'enabled', equals: true },
    { type: 'element-appears', role: 'TextField', label: 'Document body' },
    { type: 'element-disappears', element_id: 3 },
    { type: 'frontmost-app', bundle_id: scope.appName },
  ]) assert.equal(validateDesktopModelResponse(tool({ ...input, expected_effect: effect }), scope), true);
  for (const effect of [null, [], 'any-state-change', { type: 'unknown' },
    { type: 'element-value', element_id: -1, equals: scope.marker },
    { type: 'element-state', element_id: 3, attribute: 'x', equals: {} },
    { type: 'element-appears', label: 'x'.repeat(257) },
    { type: 'any-state-change', command: 'run-something' },
  ]) assert.throws(() => validateDesktopModelResponse(tool({ ...input, expected_effect: effect }), scope), /scope/);
  assert.throws(() => validateDesktopModelResponse(tool({ ...input, text: 'Other', expected_effect: { type: 'any-state-change' } }), scope), /scope/);
});

test('desktop observation and bounded waits cannot smuggle an alternate write channel', () => {
  const observe = { action: 'get_window_state', app: scope.appName, consequence: 'none' };
  assert.equal(validateDesktopModelResponse(tool(observe), scope), true);
  assert.equal(validateDesktopModelResponse(tool({ ...observe, action: 'list_windows' }), scope), true);
  assert.equal(validateDesktopModelResponse(tool({ ...observe, window_ref: 'wr-observed' }), scope), true);
  assert.equal(validateDesktopModelResponse(tool({ ...observe, action: 'wait', duration: 100 }), scope), true);
  for (const mutation of [{ app: undefined }, { show_user: true }, { text: scope.marker }, { window_ref: 'raw-hwnd' }, { action: 'wait', duration: 10001 }]) {
    assert.throws(() => validateDesktopModelResponse(tool({ ...observe, ...mutation }), scope), /scope/);
  }
});

test('fragmented streams validate the complete single call and reject alternate executable envelopes', () => {
  const json = JSON.stringify(input);
  const body = frame({ tool_calls: [{ index: 0, id: 'one', type: 'function', function: { name: 'computer', arguments: json.slice(0, 30) } }] })
    + frame({ tool_calls: [{ index: 0, function: { arguments: json.slice(30) } }] }) + 'data: [DONE]\n\n';
  assert.equal(validateDesktopModelResponse(body, scope), true);
  for (const bad of [body.replace('data: [DONE]', ''), body + frame({ content: 'late' }),
    frame({ function_call: { name: 'run_command', arguments: '{}' } }) + 'data: [DONE]\n\n',
    body.replace('"index":0,"id":"one"', '"index":1,"id":"one"'),
    'data: {"choices":[{"message":{"tool_calls":[]}}]}\n\ndata: [DONE]\n\n',
    frame({ tool_calls: [{ index: 0, type: 'function', function: { name: 'computer', arguments: json } }] }) + 'data: [DONE]\n\n',
    body.replace('data: [DONE]', 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]'),
  ]) assert.throws(() => validateDesktopModelResponse(bad, scope), /scope|incomplete|invalid/);
});

test('task success requires the independent final document, not just trajectory or a done message', () => {
  const args = { ...scopeEvidence, scenario: 'edit', evaluationKind: 'deterministic-model', oracle, trajectory, taskFinished: true, elapsedMs: 25000 };
  const result = buildDesktopEvalReport(args);
  assert.equal(result.outcome, 'passed');
  assert.equal(result.evaluationKind, 'deterministic-model');
  assert.equal(result.machineElapsedMs, 5000);
  assert.equal(result.actionAttempts, 3);
  for (const mutation of [{ markerPresent: false }, { mainMarkerPresent: false }, { secondaryMarkerPresent: true }, { dialogDepth: 1 }, { unexpectedWrites: 1 }, { scenario: 'nested-modal' }]) {
    assert.equal(buildDesktopEvalReport({ ...args, oracle: { ...oracle, ...mutation } }).outcome, 'failed');
  }
  assert.equal(buildDesktopEvalReport({ ...args, taskFinished: false }).outcome, 'failed');
  assert.equal(buildDesktopEvalReport({ ...args, trajectory: { complete: false, runs: [] } }).outcome, 'incomplete');
  assert.equal(buildDesktopEvalReport({ ...args, trajectory: { complete: true, runs: [{ ...trajectory.runs[0], phase: 'stopped' }] } }).outcome, 'failed');
});

test('natural final prose may finish only after the independent oracle and Host both complete', () => {
  const args = { scenario: 'edit', oracle, trajectory };
  assert.equal(desktopTaskFinished({ ...args, terminalText: 'ABU_DESKTOP_TASK_DONE' }), true);
  assert.equal(desktopTaskFinished({ ...args, terminalText: null }), true);
  assert.equal(desktopTaskFinished({ ...args, terminalText: 'Task completed.' }), true);
  assert.equal(desktopTaskFinished({ ...args, terminalText: 'ABU_DESKTOP_TASK_FAILED' }), false);
  assert.equal(desktopTaskFinished({ ...args, oracle: { ...oracle, markerPresent: false } }), false);
  assert.equal(desktopTaskFinished({ ...args, trajectory: { complete: false, runs: [] } }), false);
  assert.equal(desktopTaskFinished({ ...args, trajectory: { complete: true,
    runs: [{ ...trajectory.runs[0], phase: 'stopped' }] } }), false);
});

test('modal cancellation and window switching each require their own observable result', () => {
  const args = { ...scopeEvidence, evaluationKind: 'live-model', trajectory, taskFinished: true };
  for (const [scenario, cancelCount] of [['modal-cancel', 1], ['nested-modal', 2]]) {
    assert.equal(buildDesktopEvalReport({ ...args, scenario, oracle: { ...oracle, scenario, cancelCount } }).outcome, 'passed');
    assert.equal(buildDesktopEvalReport({ ...args, scenario, oracle: { ...oracle, scenario, cancelCount: 0 } }).outcome, 'failed');
  }
  assert.equal(buildDesktopEvalReport({ ...args, scenario: 'window-switch', oracle: { ...oracle, scenario: 'window-switch', mainMarkerPresent: false, secondaryMarkerPresent: true } }).outcome, 'passed');
  assert.equal(buildDesktopEvalReport({ ...args, scenario: 'window-switch', oracle: { ...oracle, scenario: 'window-switch' } }).outcome, 'failed');
});

test('successful editing cannot hide an out-of-scope observation or missing scope evidence', () => {
  const args = { ...scopeEvidence, scenario: 'edit', evaluationKind: 'deterministic-model', oracle, trajectory, taskFinished: true };
  const valid = buildDesktopEvalReport(args);
  assert.equal(valid.taskSucceeded, true);
  assert.equal(valid.scopeCompliant, true);
  const outside = buildDesktopEvalReport({ ...args, toolCalls: [{ action: 'get_screen_state', result: {} }, ...args.toolCalls] });
  assert.equal(outside.taskSucceeded, true);
  assert.equal(outside.scopeCompliant, false);
  assert.deepEqual(outside.scopeViolations, ['unexpected-screen-read']);
  assert.equal(outside.outcome, 'failed');
  assert.equal(buildDesktopEvalReport({ ...args, toolCalls: undefined }).outcome, 'failed');
  assert.equal(JSON.stringify(outside).includes('get_screen_state'), false);
  const recovered = buildDesktopEvalReport({ ...args, proxyMetrics: { rejectedResponses: 1, providerErrors: 1 } });
  assert.equal(recovered.taskSucceeded, true);
  assert.equal(recovered.outcome, 'failed');
  const unknown = buildDesktopEvalReport({ ...args, trajectory: { ...trajectory, runs: [{ ...trajectory.runs[0],
    metrics: { ...trajectory.runs[0].metrics, unknownOutcomes: 1 } }] } });
  assert.equal(unknown.outcome, 'failed');
  const missingWrite = buildDesktopEvalReport({ ...args, toolCalls: args.toolCalls.slice(0, 1) });
  assert.equal(missingWrite.scopeCompliant, false);
  assert.ok(missingWrite.scopeViolations.includes('missing-action-evidence'));
});

test('a bounded semantic recovery is reported separately from executed scope compliance', () => {
  const report = buildDesktopEvalReport({
    ...scopeEvidence,
    scenario: 'edit',
    evaluationKind: 'live-model',
    oracle,
    trajectory,
    taskFinished: true,
    proxyMetrics: {
      requests: 2,
      rejectedResponses: 1,
      recoveredResponses: 1,
      unrecoveredResponses: 0,
      providerErrors: 0,
    },
  });

  assert.equal(report.outcome, 'passed');
  assert.equal(report.scopeCompliant, true);
  assert.equal(report.firstPassCompliant, false);
  assert.equal(report.protocolRejections, 1);
  assert.equal(report.protocolRecoveries, 1);
  assert.equal(report.protocolRecoveryExhausted, false);
  assert.doesNotMatch(JSON.stringify(report), /rejected-model-response/);
});

test('report distinguishes an unrecoverable response from exhausted recovery and provider failure', () => {
  const base = { ...scopeEvidence, scenario: 'edit', evaluationKind: 'live-model', oracle, trajectory, taskFinished: true };
  const unsupported = buildDesktopEvalReport({ ...base, proxyMetrics: {
    requests: 1, rejectedResponses: 1, unrecoveredResponses: 1, recoveryExhausted: 0,
    providerErrors: 0, fixtureErrors: 0,
  } });
  assert.equal(unsupported.outcome, 'failed');
  assert.equal(unsupported.protocolUnrecoveredResponses, 1);
  assert.equal(unsupported.protocolRecoveryExhausted, false);
  assert.equal(unsupported.providerErrors, 0);
  assert.equal(unsupported.fixtureErrors, 0);

  const exhausted = buildDesktopEvalReport({ ...base, proxyMetrics: {
    requests: 3, rejectedResponses: 3, unrecoveredResponses: 1, recoveryExhausted: 1,
    providerErrors: 0, fixtureErrors: 0,
  } });
  assert.equal(exhausted.protocolRecoveryExhausted, true);
  assert.equal(exhausted.protocolUnrecoveredResponses, 1);
});

test('report strips extra oracle content and cannot relabel unknown modes as a live pass', () => {
  const report = buildDesktopEvalReport({ scenario: 'edit', evaluationKind: 'pretend-live', oracle: { ...oracle, text: 'PRIVATE_TEXT' }, trajectory, taskFinished: true });
  assert.equal(report.evaluationKind, 'unknown');
  assert.notEqual(report.outcome, 'passed');
  assert.equal(JSON.stringify(report).includes('PRIVATE_TEXT'), false);
});

test('desktop proxy validates after provider response and scrubs failures without forwarding input', async (t) => {
  let ready = true;
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'never-forward-this', model: 'test' }, scope, {
    assertFixtureReady: () => ready,
    fetchImpl: async () => { ready = false; return new Response(tool(input)); },
  });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body.includes('never-forward-this'), false);
  assert.equal(body.includes('ax_type'), false);
  assert.equal(proxy.metrics.fixtureErrors, 1);
  assert.equal(proxy.metrics.providerErrors, 0);
});

test('desktop proxy retains a pending model request before its result arrives', async (t) => {
  let round = 0;
  const observe = { action: 'get_window_state', app: scope.appName, consequence: 'none' };
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async () => new Response(round++ === 0 ? tool(observe) : frame({ content: 'done' }) + 'data: [DONE]\n\n'),
  });
  t.after(() => proxy.close());
  const send = (messages) => fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages }) });
  assert.equal((await send([])).status, 200);
  assert.equal(proxy.scopeEvidence.length, 1);
  assert.equal(proxy.scopeEvidence[0].result, undefined);
  assert.equal((await send([{ role: 'tool', tool_call_id: 'one', content: 'state:\nwindow_ref: wr-test\nstate_id: state-test' }])).status, 200);
  assert.equal(proxy.scopeEvidence.length, 1);
  assert.equal(proxy.scopeEvidence[0].result.state_id, 'state-test');
});

test('desktop proxy accepts a WindowRef advertised by a target-ambiguous observation result', async (t) => {
  let round = 0;
  const initial = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' }, 'computer', 'ambiguous');
  const selected = tool({ action: 'get_window_state', window_ref: 'wr-test', consequence: 'none' }, 'computer', 'selected');
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async () => new Response(round++ === 0 ? initial : selected),
  });
  t.after(() => proxy.close());

  const send = (messages) => fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages }),
  });
  assert.equal((await send([])).status, 200);
  const response = await send([{ role: 'tool', tool_call_id: 'ambiguous', content:
    'Error: More than one visible window matches.\nwindows:\n- window_ref: wr-test\n  app: PRIVATE_APP\n  relation: root\n  title: PRIVATE_TITLE' }]);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), selected);
  assert.equal(proxy.metrics.rejectedResponses, 0);
  assert.deepEqual(proxy.scopeEvidence[0].result, {
    error_code: 'target-ambiguous', candidates: [{ window_ref: 'wr-test' }],
  });
  assert.equal(JSON.stringify(proxy.scopeEvidence).includes('PRIVATE_'), false);
});

test('desktop proxy recovers one semantic rejection without forwarding the rejected call', async (t) => {
  const requests = [];
  const accepted = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' });
  const rejected = tool({ action: 'get_window_state', app: 'PRIVATE_WRONG_APP', consequence: 'none' });
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? rejected : accepted);
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Operate the isolated app.' }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), accepted);
  assert.equal(requests.length, 2);
  const recovery = requests[1].messages.at(-1);
  assert.equal(recovery.role, 'user');
  assert.match(recovery.content, /unexpected-app/);
  assert.doesNotMatch(recovery.content, /PRIVATE_WRONG_APP/);
  assert.equal(proxy.metrics.requests, 2);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.equal(proxy.metrics.providerErrors, 0);
  assert.equal(proxy.scopeEvidence.length, 1);
  assert.equal(proxy.scopeEvidence[0].app, scope.appName);
});

test('desktop proxy rejects an invented WindowRef before Host execution and asks for a fresh scoped observation', async (t) => {
  const requests = [];
  const rejected = tool({ action: 'get_window_state', window_ref: 'wr-PRIVATE_INVENTED', consequence: 'none' });
  const accepted = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' });
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? rejected : accepted);
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), accepted);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /unexpected-window-ref/);
  assert.doesNotMatch(requests[1].messages.at(-1).content, /PRIVATE_INVENTED/);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.equal(proxy.scopeEvidence.length, 1);
  assert.equal(proxy.scopeEvidence[0].action, 'get_window_state');
});

test('desktop proxy rejects an unobserved state id before Host execution and requires a fresh observation', async (t) => {
  const observed = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' }, 'computer', 'observe-state');
  const rejected = tool({ ...input, expected_state_id: 'PRIVATE_INVENTED_STATE' }, 'computer', 'bad-state');
  const accepted = tool({ action: 'get_window_state', window_ref: 'wr-test', consequence: 'none' }, 'computer', 'refresh-state');
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? observed : requests.length === 2 ? rejected : accepted);
    },
  });
  t.after(() => proxy.close());

  const first = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages: [] }),
  });
  assert.equal(first.status, 200);
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages: [{
      role: 'tool', tool_call_id: 'observe-state',
      content: 'state:\nwindow_ref: wr-test\nstate_id: state-test\n[3] TextField "Document body"',
    }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), accepted);
  assert.equal(requests.length, 3);
  assert.match(requests[2].messages.at(-1).content, /unexpected-state-id/);
  assert.doesNotMatch(requests[2].messages.at(-1).content, /PRIVATE_INVENTED_STATE/);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.deepEqual(proxy.scopeEvidence.map((call) => call.action), ['get_window_state', 'get_window_state']);
});

test('desktop proxy invalidates a modal WindowRef removed by the latest post-action window graph', async (t) => {
  const observeModal = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' }, 'computer', 'observe-modal');
  const cancelModal = tool({ action: 'ax_click', window_ref: 'wr-modal', element_id: 4,
    expected_state_id: 'state-modal', consequence: 'none' }, 'computer', 'cancel-modal');
  const staleRead = tool({ action: 'get_window_state', window_ref: 'wr-modal', consequence: 'none' }, 'computer', 'stale-modal');
  const freshRead = tool({ action: 'get_window_state', window_ref: 'wr-main', consequence: 'none' }, 'computer', 'fresh-main');
  const responses = [observeModal, cancelModal, staleRead, freshRead];
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(responses[requests.length - 1]);
    },
  });
  t.after(() => proxy.close());
  const send = (messages) => fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages }),
  });

  assert.equal((await send([])).status, 200);
  assert.equal((await send([{ role: 'tool', tool_call_id: 'observe-modal', content:
    'state:\nwindow_ref: wr-modal\nstate_id: state-modal\nrelated_windows:\n- window_ref=wr-main relation=owned app=fixture\n- window_ref=wr-modal relation=modal app=fixture\n[4] Button "Cancel dialog"' }])).status, 200);
  const response = await send([{ role: 'tool', tool_call_id: 'cancel-modal', content:
    'next_state:\nwindow_ref: wr-main\nstate_id: state-main\nrelated_windows:\n- window_ref=wr-main relation=owned app=fixture\n[3] TextField "Document body"' }]);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), freshRead);
  assert.equal(requests.length, 4);
  assert.match(requests[3].messages.at(-1).content, /unexpected-window-ref/);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.deepEqual(proxy.scopeEvidence.map((call) => call.action), ['get_window_state', 'ax_click', 'get_window_state']);
});

test('desktop proxy asks the model to serialize multiple structured calls before execution', async (t) => {
  const multiple = frame({ tool_calls: [
    { index: 0, id: 'first', type: 'function', function: { name: 'computer', arguments: 'PRIVATE_FIRST_CALL' } },
    { index: 1, id: 'second', type: 'function', function: { name: 'computer', arguments: 'PRIVATE_SECOND_CALL' } },
  ] }) + 'data: [DONE]\n\n';
  const accepted = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' });
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? multiple : accepted);
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 2);
  const recovery = requests[1].messages.at(-1).content;
  assert.match(recovery, /multiple-calls/);
  assert.doesNotMatch(recovery, /PRIVATE_(?:FIRST|SECOND)_CALL/);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.equal(proxy.metrics.unrecoveredResponses, 0);
});

test('desktop proxy asks the model to omit an invalid verification predicate before execution', async (t) => {
  const observed = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' }, 'computer', 'observe');
  const rejected = tool({ ...input, expected_effect: { type: 'PRIVATE_UNSUPPORTED_EFFECT' } }, 'computer', 'bad-effect');
  const accepted = tool(input, 'computer', 'good-effect');
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? observed : requests.length === 2 ? rejected : accepted);
    },
  });
  t.after(() => proxy.close());

  const observation = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(observation.status, 200);

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [{
      role: 'tool',
      tool_call_id: 'observe',
      content: 'state:\nwindow_ref: wr-test\nstate_id: state-test\n[3] TextField "Document body"',
    }] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), accepted);
  assert.equal(requests.length, 3);
  const recovery = requests[2].messages.at(-1).content;
  assert.match(recovery, /unexpected-expected_effect/);
  assert.match(recovery, /omit expected_effect/i);
  assert.match(recovery, /latest window_ref/i);
  assert.match(recovery, /latest state_id/i);
  assert.match(recovery, /consequence.*none/i);
  assert.doesNotMatch(recovery, /PRIVATE_UNSUPPORTED_EFFECT/);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.equal(proxy.metrics.unrecoveredResponses, 0);
});

test('desktop proxy redirects forbidden activation to scoped observation before execution', async (t) => {
  const rejected = tool({ action: 'activate_app', app: scope.appName, consequence: 'none' });
  const accepted = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' });
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? rejected : accepted);
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), accepted);
  assert.equal(requests.length, 2);
  const recovery = requests[1].messages.at(-1).content;
  assert.match(recovery, /unsupported-activate_app/);
  assert.match(recovery, /list_windows|get_window_state/);
  assert.doesNotMatch(recovery, new RegExp(scope.appName));
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.equal(proxy.metrics.unrecoveredResponses, 0);
});

test('desktop proxy gives every known unsupported channel a fixed scoped recovery', async (t) => {
  const rejected = tool({ action: 'screenshot', app: scope.appName, consequence: 'none', show_user: false });
  const accepted = tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' });
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(requests.length === 1 ? rejected : accepted);
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), accepted);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /unsupported-screenshot/);
  assert.match(requests[1].messages.at(-1).content, /get_window_state/);
  assert.equal(proxy.metrics.rejectedResponses, 1);
  assert.equal(proxy.metrics.recoveredResponses, 1);
});

test('desktop proxy permits two fixed semantic corrections before forwarding a safe call', async (t) => {
  const responses = [
    tool({ action: 'get_window_state', app: scope.appName }),
    tool({ action: 'get_window_state', app: 'PRIVATE_WRONG_APP', consequence: 'none' }),
    tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' }),
  ];
  const requests = [];
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(responses[requests.length - 1]);
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 200);
  assert.equal(requests.length, 3);
  assert.match(requests[1].messages.at(-1).content, /invalid-consequence/);
  assert.match(requests[2].messages.at(-1).content, /unexpected-app/);
  assert.doesNotMatch(JSON.stringify(requests.slice(1)), /PRIVATE_WRONG_APP/);
  assert.equal(proxy.metrics.rejectedResponses, 2);
  assert.equal(proxy.metrics.recoveredResponses, 1);
  assert.equal(proxy.metrics.unrecoveredResponses, 0);
  assert.equal(proxy.metrics.providerErrors, 0);
});

test('desktop proxy stops after two semantic corrections without leaking rejected responses', async (t) => {
  let requests = 0;
  const proxy = await startDesktopLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'not-real', model: 'test' }, scope, {
    assertFixtureReady: () => true,
    fetchImpl: async () => {
      requests++;
      return new Response(tool({ action: 'get_window_state', app: `PRIVATE_WRONG_APP_${requests}`, consequence: 'none' }));
    },
  });
  t.after(() => proxy.close());

  const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  });

  assert.equal(response.status, 502);
  assert.equal(requests, 3);
  assert.equal(proxy.metrics.rejectedResponses, 3);
  assert.equal(proxy.metrics.recoveredResponses, 0);
  assert.equal(proxy.metrics.unrecoveredResponses, 1);
  assert.equal(proxy.metrics.recoveryExhausted, 1);
  assert.equal(proxy.metrics.providerErrors, 0);
  const body = await response.text();
  assert.doesNotMatch(body, /PRIVATE_WRONG_APP/);
  assert.doesNotMatch(body, /data:/);
});

test('deterministic driver selects only observation IDs and refreshes after every action', () => {
  const driver = createDesktopModelDriver(scope);
  const body = (content) => ({ tools: [{ type: 'function', function: { name: 'computer' } }], messages: content ? [{ role: 'tool', content }] : [] });
  assert.match(driver.respond(body()), /get_window_state/);
  const cancel = driver.respond(body('window_ref: wr-one\nstate_id: state-one\n[4] Button "Cancel dialog"'));
  assert.match(cancel, /ax_click/);
  assert.match(cancel, /element_id\\":4/);
  assert.equal(validateDesktopModelResponse(cancel, scope), true);
  assert.match(driver.respond(body('action completed')), /get_window_state/);
  const write = driver.respond(body('window_ref: wr-one\nstate_id: state-two\n[7] TextField "Document body"'));
  assert.match(write, /ax_type/);
  assert.match(write, /state-two/);
  const refresh = driver.respond(body('action completed'));
  assert.match(refresh, /get_window_state/);
  assert.match(refresh, /window_ref\\":\\"wr-one/);
  assert.match(driver.respond(body('window_ref: wr-one\nstate_id: state-three\n[7] TextField "Document body" value="ABU_CU_TEST"')), /ABU_DESKTOP_TASK_DONE/);
  assert.deepEqual(driver.errors, []);
});

test('deterministic driver consumes complete next_state without a redundant observation', () => {
  const driver = createDesktopModelDriver(scope);
  const body = (content) => ({ tools: [{ type: 'function', function: { name: 'computer' } }], messages: content ? [{ role: 'tool', content }] : [] });
  assert.match(driver.respond(body()), /get_window_state/);
  assert.match(driver.respond(body('state:\nwindow_ref: wr-one\nstate_id: state-one\n[7] TextField "Document body"')), /ax_type/);
  const done = driver.respond(body([
    'ax_type succeeded',
    'next_state:',
    'window_ref: wr-one',
    'state_id: state-two',
    '[7] TextField "Document body" val="ABU_CU_TEST"',
  ].join('\n')));
  assert.match(done, /ABU_DESKTOP_TASK_DONE/);
  assert.doesNotMatch(done, /get_window_state/);
  assert.deepEqual(driver.errors, []);
});

test('deterministic driver selects modal and secondary WindowRefs from explicit listings', () => {
  const body = (content) => ({ tools: [{ type: 'function', function: { name: 'computer' } }], messages: content ? [{ role: 'tool', content }] : [] });
  const windows = (...items) => ['windows:', ...items.map(({ ref, title }) => [
    `- window_ref: ${ref}`,
    `  app: ${scope.appName}`,
    '  relation: root',
    `  title: ${title}`,
  ].join('\n'))].join('\n');

  const modal = createDesktopModelDriver({ ...scope, scenario: 'modal-cancel' });
  assert.match(modal.respond(body()), /list_windows/);
  const modalObserve = modal.respond(body(windows(
    { ref: 'wr-main', title: 'Abu CU Desktop' },
    { ref: 'wr-dialog', title: 'Abu CU Dialog' },
  )));
  assert.match(modalObserve, /get_window_state/);
  assert.match(modalObserve, /window_ref\\":\\"wr-dialog/);

  const switched = createDesktopModelDriver({ ...scope, scenario: 'window-switch' });
  assert.match(switched.respond(body()), /get_window_state/);
  const open = switched.respond(body('window_ref: wr-main\nstate_id: state-main\n[3] Button "Open secondary window"'));
  assert.match(open, /ax_click/);
  assert.match(switched.respond(body('action completed\nnext_state:\nwindow_ref: wr-main\nstate_id: state-after\n[3] Button "Open secondary window"')), /list_windows/);
  const secondaryObserve = switched.respond(body(windows(
    { ref: 'wr-main', title: 'Abu CU Desktop' },
    { ref: 'wr-secondary', title: 'Abu CU Secondary' },
  )));
  assert.match(secondaryObserve, /get_window_state/);
  assert.match(secondaryObserve, /window_ref\\":\\"wr-secondary/);
});

test('deterministic driver cannot fabricate success on a missing state or an unrelated request', () => {
  const driver = createDesktopModelDriver(scope);
  assert.match(driver.respond({ messages: [] }), /\[\]/);
  const task = { tools: [{ type: 'function', function: { name: 'computer' } }], messages: [] };
  driver.respond(task);
  assert.match(driver.respond({ ...task, messages: [{ role: 'tool', content: 'No observation state returned' }] }), /ABU_DESKTOP_TASK_FAILED/);
  assert.deepEqual(driver.errors, ['observation-unavailable']);
});

test('lifecycle success is explicitly classified and cannot count as an edited document', () => {
  const stopped = { complete: true, runs: [{ ...trajectory.runs[0], phase: 'stopped', metrics: { actionAttempts: 0 } }] };
  const blank = { ...oracle, markerPresent: false, mainMarkerPresent: false };
  const args = { scenario: 'stop-during-approval', oracle: blank, trajectory: stopped };
  assert.equal(buildDesktopLifecycleReport(args).evaluationKind, 'deterministic-lifecycle');
  assert.equal(buildDesktopLifecycleReport(args).outcome, 'passed');
  assert.equal(buildDesktopLifecycleReport(args).documentEdited, false);
  for (const mutation of [{ oracle }, { trajectory: { complete: false, runs: [] } }, { scenario: 'edit' },
    { trajectory: { complete: true, runs: [{ ...stopped.runs[0], metrics: { actionAttempts: 1 } }] } }]) {
    assert.notEqual(buildDesktopLifecycleReport({ ...args, ...mutation }).outcome, 'passed');
  }
  const restart = { ...args, scenario: 'stop-helper-restart', staleRejected: true, freshObserved: true,
    trajectory: { complete: true, runs: [...stopped.runs, { ...trajectory.runs[0], metrics: { actionAttempts: 0 } }] } };
  assert.equal(buildDesktopLifecycleReport(restart).outcome, 'passed');
  assert.notEqual(buildDesktopLifecycleReport({ ...restart, staleRejected: false }).outcome, 'passed');
  assert.notEqual(buildDesktopLifecycleReport({ ...restart, freshObserved: false }).outcome, 'passed');
  assert.notEqual(buildDesktopEvalReport({ scenario: 'edit', evaluationKind: 'deterministic-lifecycle', oracle, trajectory, taskFinished: true }).outcome, 'passed');
});

test('deterministic driver stops on explicit tool failure instead of retrying the action', () => {
  const driver = createDesktopModelDriver(scope);
  const task = { tools: [{ type: 'function', function: { name: 'computer' } }], messages: [] };
  driver.respond(task);
  driver.respond({ ...task, messages: [{ role: 'tool', content: 'window_ref: wr-one\nstate_id: state-one\n[1] TextField "Document body"' }] });
  assert.match(driver.respond({ ...task, messages: [{ role: 'tool', content: 'Error executing tool "computer": Windows refused to activate target' }] }), /ABU_DESKTOP_TASK_FAILED/);
  assert.deepEqual(driver.errors, ['tool-execution-failed']);
});

test('deterministic driver records physical interruption inside a localized observation failure without retrying', () => {
  const driver = createDesktopModelDriver(scope);
  const task = { tools: [{ type: 'function', function: { name: 'computer' } }], messages: [] };
  driver.respond(task);
  const response = driver.respond({ ...task, messages: [{ role: 'tool', content:
    'AX 树获取失败：Error invoking remote method: physical user input occurred during observation; observe again\n（可尝试 screenshot 查看当前界面）',
  }] });
  assert.match(response, /ABU_DESKTOP_TASK_FAILED/);
  assert.doesNotMatch(response, /tool_calls/);
  assert.deepEqual(driver.errors, ['physical-input-interruption']);
});

test('failure-safe evaluation emits failed evidence and preserves the original journey error', async () => {
  const failure = new Error('original assertion');
  const reports = [];
  const evidence = () => ({ scenario: 'edit', evaluationKind: 'deterministic-model', oracle, trajectory, taskFinished: true, elapsedMs: 25000 });
  await assert.rejects(recordDesktopEvaluation({ execute: async () => { throw failure; }, evidence,
    attach: async (report) => { reports.push(report); } }), (error) => error === failure);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, 'failed');
  assert.equal(reports[0].approvalWaitMs, 20000);
  assert.equal(reports[0].executionFailed, true);
  await assert.rejects(recordDesktopEvaluation({ execute: async () => { throw failure; }, evidence,
    attach: async () => { throw new Error('attachment failure'); } }), (error) => error === failure);
  await assert.rejects(recordDesktopEvaluation({ execute: async () => { throw failure; }, evidence: () => { throw new Error('log missing'); },
    attach: async (report) => { assert.equal(report.outcome, 'incomplete'); } }), (error) => error === failure);
});
