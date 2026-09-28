'use strict';

const { validateDesktopModelResponse } = require('./computer-use-desktop-eval.cjs');

const PROBE_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'computer',
    description: 'Operate a named GUI application. Begin by observing the exact named app. Emit exactly one structured call and wait for its result before any next action.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'Action such as list_windows, get_window_state, click, type, ax_click, ax_type, or wait.' },
        app: { type: 'string', description: 'Exact application name from the task. Required for the first observation.' },
        app_name: { type: 'string', description: 'Legacy alias for app.' },
        window_ref: { type: 'string', description: 'Opaque reference returned by an earlier observation.' },
        element_id: { type: 'number' },
        expected_state_id: { type: 'string' },
        text: { type: 'string' },
        duration: { type: 'number' },
        show_user: { type: 'boolean' },
        consequence: { type: 'string', enum: ['none', 'send', 'publish', 'delete', 'overwrite', 'install', 'purchase', 'credential-change', 'security-change'] },
      },
      required: ['action', 'consequence'],
    },
  },
});

function fixedError(error) {
  const known = new Set([
    'missing-call', 'unexpected-first-action', 'invalid-scope', 'missing-app', 'unexpected-app',
    'invalid-consequence', 'unexpected-display', 'multiple-calls', 'text-tool-channel',
    'legacy-tool-channel', 'unexpected-tool', 'repeated-call-id',
    'missing-call-id', 'incompatible-finish-reason', 'unsupported-activate_app',
  ]);
  return known.has(error?.code) ? error.code : 'invalid-response';
}

function reject(code) {
  throw Object.assign(new Error('computer-use-protocol-probe-rejected'), { code });
}

function validateFirstProtocolResponse(body, scope) {
  let calls = 0;
  let first;
  validateDesktopModelResponse(body, scope, (input) => {
    calls++;
    first = input;
  });
  if (calls !== 1) reject('missing-call');
  if (first.action !== 'get_window_state' || first.app !== scope.appName
    || first.app_name !== undefined || first.window_ref !== undefined) reject('unexpected-first-action');
  return true;
}

async function boundedText(response, maximum = 2 * 1024 * 1024) {
  if (!response.body) throw new Error('provider-error');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maximum) throw new Error('provider-error');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function probeScope(index) {
  const suffix = String(index).padStart(2, '0');
  return { appName: `AbuCuFixture-probe${suffix}`, marker: `ABU_CU_PROTOCOL_${suffix}` };
}

function probeMessages(scope) {
  return [
    { role: 'system', content: 'Use only the structured computer tool. Make exactly one call, then wait for its result. Never emit tool tags as text.' },
    { role: 'user', content: `Begin a GUI task in the exact isolated application ${scope.appName}. Your first and only call in this response must be get_window_state with app exactly ${scope.appName}, consequence none, and show_user false. Do not activate, write, click, list windows, use coordinates, or claim completion yet.` },
  ];
}

async function runProtocolProbeBatch({ config, attempts = 20, minimumRate = 0.95,
  fetchImpl = fetch, timeoutMs = 60_000, onProgress } = {}) {
  if (!config || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100
    || typeof minimumRate !== 'number' || minimumRate < 0 || minimumRate > 1
    || typeof fetchImpl !== 'function') throw new Error('protocol-probe-configuration-invalid');
  let compliant = 0;
  const failureReasons = {};
  for (let index = 0; index < attempts; index++) {
    const scope = probeScope(index);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: probeMessages(scope),
          tools: [PROBE_TOOL],
          tool_choice: 'auto',
          parallel_tool_calls: false,
          stream: true,
        }),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw Object.assign(new Error('provider-error'), { code: 'provider-error' });
      validateFirstProtocolResponse(await boundedText(response), scope);
      compliant++;
    } catch (error) {
      const reason = error?.code === 'provider-error' || error?.name === 'AbortError'
        ? 'provider-error' : fixedError(error);
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    } finally {
      clearTimeout(timer);
      onProgress?.(index + 1, attempts);
    }
  }
  const firstPassRate = compliant / attempts;
  return {
    schemaVersion: 1,
    evaluationKind: 'live-protocol-first-response',
    attempts,
    compliant,
    firstPassRate,
    minimumRate,
    passed: firstPassRate >= minimumRate,
    failureReasons,
  };
}

async function main() {
  const { readLiveEvalConfig } = require('./computer-use-live-eval.cjs');
  const { readSavedDesktopEvalConfig } = require('./computer-use-saved-config.cjs');
  let config;
  if (process.env.ABU_CU_EVAL_SAVED_PROFILE) {
    config = await readSavedDesktopEvalConfig({
      sourceProfile: process.env.ABU_CU_EVAL_SAVED_PROFILE,
      secretsFile: process.env.ABU_CU_EVAL_SAVED_SECRETS,
    });
  } else {
    const live = readLiveEvalConfig();
    if (live.status !== 'ready') throw new Error('protocol-probe-configuration-unavailable');
    config = live.config;
  }
  const report = await runProtocolProbeBatch({ config,
    onProgress: (complete, total) => { if (complete % 5 === 0 || complete === total) process.stderr.write(`[computer-use-protocol-probe] ${complete}/${total}\n`); },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('[computer-use-protocol-probe] unavailable\n');
    process.exitCode = 1;
  });
}

module.exports = { PROBE_TOOL, validateFirstProtocolResponse, runProtocolProbeBatch };
