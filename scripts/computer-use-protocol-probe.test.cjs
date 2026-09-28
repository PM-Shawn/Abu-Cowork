'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProtocolProbeBatch, validateFirstProtocolResponse } = require('./computer-use-protocol-probe.cjs');

const frame = (delta) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
const tool = (input) => frame({ tool_calls: [{ index: 0, id: 'probe', type: 'function', function: {
  name: 'computer', arguments: JSON.stringify(input),
} }] }) + 'data: [DONE]\n\n';
const scope = { appName: 'AbuCuFixture-probe00', marker: 'ABU_CU_PROTOCOL_00' };

test('first protocol response must contain one scoped observation call', () => {
  assert.equal(validateFirstProtocolResponse(tool({ action: 'get_window_state', app: scope.appName,
    consequence: 'none', show_user: false }), scope), true);
  for (const body of [
    frame({ content: 'done' }) + 'data: [DONE]\n\n',
    tool({ action: 'activate_app', app: scope.appName, consequence: 'none' }),
    tool({ action: 'get_window_state', app: 'PRIVATE_WRONG_APP', consequence: 'none' }),
    frame({ tool_calls: [{ index: 0, type: 'function', function: { name: 'computer', arguments: JSON.stringify({
      action: 'get_window_state', app: scope.appName, consequence: 'none',
    }) } }] }) + 'data: [DONE]\n\n',
    tool({ action: 'get_window_state', app: scope.appName, consequence: 'none' })
      .replace('data: [DONE]', 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]'),
  ]) assert.throws(() => validateFirstProtocolResponse(body, scope));
});

test('protocol batch measures first responses without retrying or retaining model input', async () => {
  const requests = [];
  const responses = [
    tool({ action: 'get_window_state', app: 'AbuCuFixture-probe00', consequence: 'none', show_user: false }),
    tool({ action: 'activate_app', app: 'AbuCuFixture-probe01', consequence: 'none' }),
    tool({ action: 'get_window_state', app: 'AbuCuFixture-probe02', consequence: 'none' }),
  ];
  const report = await runProtocolProbeBatch({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'PRIVATE_API_KEY', model: 'test' },
    attempts: 3,
    minimumRate: 2 / 3,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(responses[requests.length - 1]);
    },
  });

  assert.equal(requests.length, 3);
  assert.equal(report.attempts, 3);
  assert.equal(report.compliant, 2);
  assert.equal(report.firstPassRate, 2 / 3);
  assert.equal(report.passed, true);
  assert.deepEqual(report.failureReasons, { 'unsupported-activate_app': 1 });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|API_KEY/);
  assert.equal(requests.every((request) => request.tools.length === 1
    && request.parallel_tool_calls === false), true);
});

test('protocol batch fails closed on provider errors and empty structured output', async () => {
  let request = 0;
  const report = await runProtocolProbeBatch({
    config: { baseUrl: 'https://example.test/v1', apiKey: 'secret', model: 'test' },
    attempts: 2,
    fetchImpl: async () => ++request === 1
      ? new Response('private provider body', { status: 429 })
      : new Response(frame({ content: 'PRIVATE_TEXT_ONLY' }) + 'data: [DONE]\n\n'),
  });

  assert.equal(report.passed, false);
  assert.equal(report.compliant, 0);
  assert.deepEqual(report.failureReasons, { 'provider-error': 1, 'missing-call': 1 });
  assert.doesNotMatch(JSON.stringify(report), /private provider body|PRIVATE_TEXT_ONLY|secret/);
});
