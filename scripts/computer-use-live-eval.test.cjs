'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readLiveEvalConfig, validateOfficeModelResponse, buildLiveEvalReport, startOfficeLiveProxy, withoutLiveEvalCredential, officeGracePeriodExpired } = require('./computer-use-live-eval.cjs');
const configEnv = { ABU_CU_EVAL_LIVE: '1', ABU_CU_EVAL_BASE_URL: 'https://example.test/v1',
  ABU_CU_EVAL_API_KEY: 'test-secret-not-real', ABU_CU_EVAL_MODEL: 'test-model' };
const tool = (name, input) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] })}\n\ndata: [DONE]\n\n`;

test('dedicated credential stays in the proxy and is stripped from child environments', () => {
  const source = { ABU_CU_EVAL_API_KEY: 'private', PATH: 'keep-path', ABU_CU_EVAL_LIVE: '1' };
  assert.deepEqual(withoutLiveEvalCredential(source), { PATH: 'keep-path', ABU_CU_EVAL_LIVE: '1' });
  assert.equal(source.ABU_CU_EVAL_API_KEY, 'private');
  assert.deepEqual(withoutLiveEvalCredential({ abu_cu_eval_api_key: 'private', PATH: 'keep' }), { PATH: 'keep' });
});

test('only a concrete local license error identifies an expired Office fixture', () => {
  assert.equal(officeGracePeriodExpired('LICENSE STATUS: ---NOTIFICATIONS---\nERROR CODE: 0xC004F009'), true);
  assert.equal(officeGracePeriodExpired('LICENSE STATUS: ---LICENSED---'), false);
  assert.equal(officeGracePeriodExpired(''), false);
});

test('live evaluation is opt-in and missing settings never fall back to simulated pass', () => {
  assert.equal(readLiveEvalConfig({}).status, 'unavailable');
  assert.equal(readLiveEvalConfig(configEnv).status, 'ready');
  for (const url of ['http://example.test/v1', 'https://user:pass@example.test/v1', 'https://example.test/v1?key=secret']) {
    assert.equal(readLiveEvalConfig({ ...configEnv, ABU_CU_EVAL_BASE_URL: url }).status, 'unavailable');
  }
  assert.equal(readLiveEvalConfig({ ...configEnv, ABU_CU_EVAL_BASE_URL: 'http://127.0.0.1:1234/v1' }).status, 'ready');
});

test('model boundary only admits UIA operations inside the named Office test', () => {
  const scope = { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' };
  const input = { action: 'type', app: 'WINWORD', consequence: 'none', text: scope.marker,
    window_ref: 'wr-word', expected_state_id: 'state-word', element_id: 3 };
  assert.equal(validateOfficeModelResponse(tool('computer', input), scope), true);
  assert.throws(() => validateOfficeModelResponse(tool('run_command', input), scope), /scope/);
  assert.throws(() => validateOfficeModelResponse(tool('computer', { ...input, app: 'Explorer' }), scope), /scope/);
  assert.throws(() => validateOfficeModelResponse(tool('computer', { ...input, text: 'arbitrary content' }), scope), /scope/);
  assert.throws(() => validateOfficeModelResponse(tool('computer', { ...input, action: 'key', key: 's', modifiers: ['ctrl'] }), scope), /scope/);
  assert.throws(() => validateOfficeModelResponse(tool('computer', { ...input, action: 'screenshot' }), scope), /scope/);
  for (const action of ['click', 'ax_click', 'scroll', 'activate_app', 'key', 'perform_action']) {
    assert.throws(() => validateOfficeModelResponse(tool('computer', { ...input, action, element_id: 3, key: 'Return' }), scope), /scope/);
  }
  assert.throws(() => validateOfficeModelResponse('data: {\n\ndata: [DONE]\n\n', scope), /invalid/);
});

test('Office writes cannot borrow a window/state or fall back to coordinates and unindexed typing', () => {
  const scope = { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' };
  const input = { action: 'type', app: 'WINWORD', consequence: 'none', text: scope.marker,
    window_ref: 'wr-word', expected_state_id: 'state-word', element_id: 3 };
  for (const change of [{ window_ref: undefined }, { expected_state_id: undefined }, { element_id: undefined },
    { element_id: -1 }, { window_ref: 'raw-hwnd' }, { expected_state_id: '' },
    { x: 1, y: 2 }, { action: 'click', x: 1, y: 2, screenshot_id: 'shot-word' },
  ]) assert.throws(() => validateOfficeModelResponse(tool('computer', { ...input, ...change }), scope), /scope/);
});

test('fragmented tool arguments are checked only after the entire response is received', () => {
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fragmented', function: { name: 'computer', arguments: '{"action":"get_app_state",' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"app":"WINWORD","consequence":"none"}' } }] } }] },
  ];
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  assert.equal(validateOfficeModelResponse(body, { appName: 'WINWORD', marker: 'x' }), true);
  assert.throws(() => validateOfficeModelResponse(body.replace('data: [DONE]', ''), { appName: 'WINWORD', marker: 'x' }), /incomplete/);
});

test('multiple executable calls retain a fixed diagnostic reason without exposing arguments', () => {
  const body = 'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'first', function: { name: 'computer', arguments: 'PRIVATE_ARGS' } },
    { index: 1, id: 'second', function: { name: 'computer', arguments: 'PRIVATE_ARGS' } },
  ] } }] }) + '\n\ndata: [DONE]\n\n';
  assert.throws(() => validateOfficeModelResponse(body, { appName: 'WINWORD', marker: 'x' }),
    (error) => error.code === 'multiple-calls' && !error.message.includes('PRIVATE_ARGS'));
});

test('evaluation requires an independent oracle and clean terminal state, not model prose or UI change', () => {
  const trajectory = { complete: true, runs: [{ phase: 'ended', historyComplete: true, metrics: { actionAttempts: 3, verifiedChanges: 2, approvalWaitMs: 15000, interventions: 0 } }] };
  assert.equal(buildLiveEvalReport({ oraclePassed: false, taskFinished: true, trajectory }).outcome, 'failed');
  assert.equal(buildLiveEvalReport({ oraclePassed: true, taskFinished: false, trajectory }).outcome, 'failed');
  assert.equal(buildLiveEvalReport({ oraclePassed: true, taskFinished: true, trajectory }).outcome, 'passed');
  assert.equal(buildLiveEvalReport({ oraclePassed: true, taskFinished: true, trajectory: { ...trajectory, complete: false } }).outcome, 'incomplete');
  const stopped = { complete: true, runs: [{ ...trajectory.runs[0], phase: 'stopped' }] };
  assert.equal(buildLiveEvalReport({ oraclePassed: true, taskFinished: true, trajectory: stopped }).outcome, 'failed');
});

test('loopback proxy never forwards arbitrary tools or exposes real credentials to the renderer', async (t) => {
  const requests = [];
  const proxy = await startOfficeLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'private-real-key', model: 'real-model' },
    { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' }, { assertFixtureReady: () => true, fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
      return new Response(tool('computer', { action: 'get_app_state', app: 'WINWORD', consequence: 'none' }), { status: 200 });
    } });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fake-renderer-model', messages: [], tools: [
      { type: 'function', function: { name: 'computer' } }, { type: 'function', function: { name: 'run_command' } },
    ] }) });
  assert.equal(response.status, 200);
  assert.equal(requests[0].authorization, 'Bearer private-real-key');
  assert.equal(requests[0].body.model, 'real-model');
  assert.equal(requests[0].body.tools.length, 1);
  assert.equal((await response.text()).includes('private-real-key'), false);
  assert.equal(proxy.metrics.requests, 1);
});

test('a changed or absent test document prevents any outbound provider request', async (t) => {
  let requests = 0;
  const proxy = await startOfficeLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'private', model: 'test' },
    { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' }, { assertFixtureReady: () => false, fetchImpl: () => { requests++; throw new Error('must not fetch'); } });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
  assert.equal(response.status, 502);
  assert.equal(requests, 0);
  assert.equal(proxy.metrics.fixtureErrors, 1);
  assert.equal(proxy.metrics.providerErrors, 0);
});

function rejectedChannelStreams() {
  const frame = (delta, finish_reason) => `data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\n`;
  const raw = JSON.stringify({ name: 'run_command', arguments: { command: 'DO_NOT_EXECUTE_TEST_ONLY' } });
  const text = `<tool_call>${raw}</tool_call>`;
  const unsafe = tool('computer', { action: 'key', app: 'Explorer', consequence: 'none', key: 'Return' });
  const safe = tool('computer', { action: 'get_app_state', app: 'WINWORD', consequence: 'none' });
  return [
    frame({ content: text }) + 'data: [DONE]\n\n',
    frame({ content: '<tool_' }) + frame({ content: `call>${raw}</tool_call>` }) + 'data: [DONE]\n\n',
    frame({ content: '<|FunctionCall' }) + frame({ content: `Begin|>[${raw}]<|FunctionCallEnd|>` }) + 'data: [DONE]\n\n',
    frame({ content: text }) + safe,
    ' \t' + unsafe.replace('data: [DONE]\n\n', '') + safe,
    safe.replace('data: ', 'data:'),
    frame({ content: [] }) + safe,
    // A finish marker ends executable parsing in the real consumer. Later
    // bytes must not alter what the boundary believes the earlier call was.
    frame({ content: 'finished' }, 'stop') + safe,
    safe.replace('data: [DONE]\n\n', '') + safe,
  ];
}

test('SSE scope matches consumer whitespace, text-tool tags and terminal boundaries', () => {
  const scope = { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' };
  for (const stream of rejectedChannelStreams()) {
    assert.throws(() => validateOfficeModelResponse(stream, scope), /scope|invalid/);
  }
});

test('loopback proxy withholds the whole response for alternate executable channels', async (t) => {
  let upstream;
  const proxy = await startOfficeLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'private', model: 'test' },
    { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' }, { assertFixtureReady: () => true,
      fetchImpl: async () => new Response(upstream) });
  t.after(() => proxy.close());
  for (const stream of rejectedChannelStreams()) {
    upstream = stream;
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.equal(body.includes('DO_NOT_EXECUTE_TEST_ONLY'), false);
    assert.equal(body.includes('data:'), false);
  }
  assert.equal(proxy.metrics.rejectedResponses, rejectedChannelStreams().length);
});

test('proxy records provider HTTP failure status without returning its private body', async (t) => {
  const proxy = await startOfficeLiveProxy({ baseUrl: 'https://example.test/v1', apiKey: 'private', model: 'test' },
    { appName: 'WINWORD', marker: 'ABU_LIVE_TEST' }, { assertFixtureReady: () => true,
      fetchImpl: async () => new Response('PRIVATE_PROVIDER_BODY', { status: 429 }) });
  t.after(() => proxy.close());
  const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
  assert.equal(response.status, 502);
  assert.equal(proxy.metrics.lastProviderErrorStatus, 429);
  assert.equal(proxy.metrics.rejectedResponses, 0);
  assert.equal((await response.text()).includes('PRIVATE_PROVIDER_BODY'), false);
});
