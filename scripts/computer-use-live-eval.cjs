'use strict';
const { createServer } = require('node:http');

function withoutLiveEvalCredential(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== 'ABU_CU_EVAL_API_KEY'));
}

function officeGracePeriodExpired(output) {
  return typeof output === 'string' && /ERROR CODE:\s*0xC004F009\b/i.test(output);
}

function readLiveEvalConfig(env = process.env) {
  const required = ['ABU_CU_EVAL_BASE_URL', 'ABU_CU_EVAL_API_KEY', 'ABU_CU_EVAL_MODEL'];
  const missing = required.filter((key) => !env[key]?.trim());
  if (env.ABU_CU_EVAL_LIVE !== '1' || missing.length) {
    return { status: 'unavailable', reason: 'explicit-live-configuration-required', missing };
  }
  try {
    const url = new URL(env.ABU_CU_EVAL_BASE_URL);
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.search || url.hash
      || /[\r\n]/.test(env.ABU_CU_EVAL_API_KEY) || env.ABU_CU_EVAL_MODEL.length > 160) throw new Error();
    return { status: 'ready', config: { baseUrl: url.href.replace(/\/$/, ''),
      apiKey: env.ABU_CU_EVAL_API_KEY, model: env.ABU_CU_EVAL_MODEL } };
  } catch {
    return { status: 'unavailable', reason: 'invalid-live-configuration', missing: [] };
  }
}

function assertOfficeInput(input, { appName, marker }) {
  // This on-host live benchmark is intentionally narrower than the product:
  // no control activation, navigation, opening files, or submitting dialogs.
  // Broader live journeys require a disposable desktop, not this user's Office.
  const allowed = new Set(['get_app_state', 'get_ui', 'type', 'ax_type', 'wait']);
  const matches = (app) => typeof app === 'string' && app.toLowerCase() === appName.toLowerCase();
  if (!input || !allowed.has(input.action) || input.consequence !== 'none'
    || (!matches(input.app) && !matches(input.app_name))
    || (input.app !== undefined && !matches(input.app))
    || (input.app_name !== undefined && !matches(input.app_name))) throw new Error('live-eval-scope-rejected');
  const fields = new Set(['action', 'app', 'app_name', 'consequence', 'show_user']);
  if (input.show_user !== undefined && input.show_user !== false) throw new Error('live-eval-scope-rejected');
  if (['type', 'ax_type'].includes(input.action)) {
    for (const field of ['text', 'element_id', 'window_ref', 'expected_state_id']) fields.add(field);
    if (input.text !== marker || !Number.isSafeInteger(input.element_id) || input.element_id < 0
      || typeof input.window_ref !== 'string' || !/^wr-[A-Za-z0-9_-]+$/.test(input.window_ref)
      || typeof input.expected_state_id !== 'string' || !input.expected_state_id.trim()
      || input.expected_state_id.length > 256) throw new Error('live-eval-scope-rejected');
  } else if (input.action === 'wait') {
    fields.add('duration');
    if (input.duration !== undefined && (!Number.isSafeInteger(input.duration) || input.duration < 0 || input.duration > 10000)) {
      throw new Error('live-eval-scope-rejected');
    }
  } else {
    fields.add('window_ref');
    if (input.window_ref !== undefined && (typeof input.window_ref !== 'string' || !/^wr-[A-Za-z0-9_-]+$/.test(input.window_ref))) {
      throw new Error('live-eval-scope-rejected');
    }
  }
  if (Object.keys(input).some((field) => !fields.has(field))) throw new Error('live-eval-scope-rejected');
}

function validateOfficeModelResponse(body, scope) {
  return validateComputerUseModelResponse(body, (input) => assertOfficeInput(input, scope));
}

function validateComputerUseModelResponse(body, validateInput) {
  const reject = (code) => { throw Object.assign(new Error('live-eval-scope-rejected'), { code }); };
  const calls = new Map();
  let done = false;
  let finished = false;
  let content = '';
  let frameCount = 0;
  for (const rawLine of body.split(/\r?\n/)) {
    // Match the consuming OpenAI-compatible reader's whitespace normalization.
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    // Do not concatenate bytes from a frame the consumer would ignore.
    if (!line.startsWith('data: ')) throw new Error('live-eval-invalid-response');
    const data = line.slice(5).trim();
    if (data === '[DONE]') { done = true; continue; }
    if (done) throw new Error('live-eval-invalid-response');
    let frame;
    try { frame = JSON.parse(data); } catch { throw new Error('live-eval-invalid-response'); }
    if (frame.error || !Array.isArray(frame.choices)) throw new Error('live-eval-invalid-response');
    frameCount++;
    if (frame.choices.length > 1 || frame.choices[0]?.message
      || (frame.choices[0]?.index !== undefined && frame.choices[0].index !== 0)) throw new Error('live-eval-invalid-response');
    const choice = frame.choices[0] ?? {};
    const finishReason = choice.finish_reason;
    if (finishReason !== undefined && finishReason !== null && typeof finishReason !== 'string') {
      throw new Error('live-eval-invalid-response');
    }
    const delta = choice.delta ?? {};
    if (finished && (delta.content || delta.tool_calls || delta.function_call)) throw new Error('live-eval-invalid-response');
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw new Error('live-eval-invalid-response');
      content += delta.content;
      // The product also executes these text-tag channels. The evaluation
      // admits structured calls only, including when tags span SSE frames.
      if (content.includes('<tool_call>') || content.includes('<|FunctionCallBegin|>')) reject('text-tool-channel');
    }
    // Legacy function_call is an alternate executable channel; never pass it.
    if (delta.function_call) reject('legacy-tool-channel');
    if (delta.tool_calls !== undefined && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 1)) reject('multiple-calls');
    for (const call of delta.tool_calls ?? []) {
      if (call.index !== 0 || (call.type && call.type !== 'function')) reject('multiple-calls');
      const existing = calls.get(0);
      if (!existing && call.id === undefined) reject('missing-call-id');
      const previous = existing ?? { name: '', args: '', id: undefined };
      if (call.id !== undefined) {
        // Consumer resets its argument buffer on every id, even a repeated
        // one. Forbid that alternate interpretation of concatenated args.
        if (typeof call.id !== 'string' || !call.id) reject('missing-call-id');
        if (previous.id !== undefined) reject('repeated-call-id');
        previous.id = call.id;
      }
      if (call.function?.name !== undefined) {
        if (call.function.name !== 'computer') reject('unexpected-tool');
        previous.name = call.function.name;
      }
      if (call.function?.arguments !== undefined && typeof call.function.arguments !== 'string') throw new Error('live-eval-invalid-response');
      previous.args += call.function?.arguments ?? '';
      calls.set(0, previous);
    }
    // The actual OpenAI-compatible adapter discards native tool buffers when
    // stop/stop_sequence closes the response. Never validate a call that the
    // consumer would turn into an ordinary end_turn.
    if (['stop', 'stop_sequence'].includes(finishReason) && calls.size > 0) {
      reject('incompatible-finish-reason');
    }
    if (finishReason) finished = true;
  }
  if (!done || !frameCount) throw new Error('live-eval-incomplete-response');
  for (const call of calls.values()) {
    if (call.name !== 'computer') reject('unexpected-tool');
    let input;
    try { input = JSON.parse(call.args); } catch { throw new Error('live-eval-invalid-response'); }
    validateInput(input, { id: call.id });
  }
  return true;
}

async function readBoundedBody(body, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('live-eval-body-limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startOfficeLiveProxy(config, scope, { fetchImpl = fetch, assertFixtureReady = () => false } = {}) {
  return startValidatedComputerUseProxy(config, {
    validateResponse: (body) => validateOfficeModelResponse(body, scope), assertFixtureReady,
  }, { fetchImpl });
}

async function startValidatedComputerUseProxy(config, {
  validateResponse,
  assertFixtureReady,
  recoveryMessage,
  maxSemanticRecoveries = 0,
}, { fetchImpl = fetch } = {}) {
  if (typeof validateResponse !== 'function' || typeof assertFixtureReady !== 'function') throw new Error('live-eval-guard-required');
  const metrics = {
    requests: 0,
    rejectedResponses: 0,
    recoveredResponses: 0,
    unrecoveredResponses: 0,
    recoveryExhausted: 0,
    providerErrors: 0,
    fixtureErrors: 0,
    clientErrors: 0,
    internalErrors: 0,
  };
  const codedError = (code) => Object.assign(new Error(code), { code });
  const requireFixture = async () => {
    try {
      if (await assertFixtureReady()) return;
    } catch { /* Normalize fixture failures without reflecting details. */ }
    throw codedError('live-eval-fixture-error');
  };
  const controllers = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end(); return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      let payload;
      try { payload = JSON.parse(await readBoundedBody(request, 8 * 1024 * 1024)); }
      catch { throw codedError('live-eval-client-error'); }
      const tools = Array.isArray(payload.tools)
        ? payload.tools.filter((tool) => tool?.type === 'function' && tool.function?.name === 'computer') : [];
      // Real credentials never enter renderer persistence, logs or traces.
      // The model has no shell/file/network tool channel in this fixture.
      const recoveryMessages = [];
      let recoveryCount = 0;
      let result;
      while (true) {
        await requireFixture();
        const body = { model: config.model, messages: [...payload.messages, ...recoveryMessages], stream: true,
          ...(tools.length ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}) };
        metrics.requests++;
        let upstream;
        try {
          upstream = await fetchImpl(`${config.baseUrl}/chat/completions`, {
            method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body), signal: controller.signal, redirect: 'error',
          });
        } catch { throw codedError('live-eval-provider-error'); }
        if (!upstream.ok) {
          metrics.lastProviderErrorStatus = upstream.status;
          throw codedError('live-eval-provider-error');
        }
        try { result = await readBoundedBody(upstream.body, 2 * 1024 * 1024); }
        catch { throw codedError('live-eval-provider-error'); }
        try {
          validateResponse(result);
          if (recoveryCount > 0) metrics.recoveredResponses++;
          break;
        } catch (error) {
          metrics.rejectedResponses++;
          const message = typeof recoveryMessage === 'function'
            ? recoveryMessage(error, recoveryCount + 1) : null;
          if (typeof message !== 'string' || !message) {
            metrics.unrecoveredResponses++;
            throw codedError('live-eval-unrecoverable-response');
          }
          if (recoveryCount >= maxSemanticRecoveries) {
            metrics.unrecoveredResponses++;
            metrics.recoveryExhausted++;
            throw codedError('live-eval-unrecoverable-response');
          }
          recoveryCount++;
          recoveryMessages.push({ role: 'user', content: message });
        }
      }
      await requireFixture();
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      response.end(result);
    } catch (error) {
      if (error?.code === 'live-eval-provider-error') metrics.providerErrors++;
      else if (error?.code === 'live-eval-fixture-error') metrics.fixtureErrors++;
      else if (error?.code === 'live-eval-client-error') metrics.clientErrors++;
      else if (error?.code !== 'live-eval-unrecoverable-response') metrics.internalErrors++;
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Live evaluation response unavailable or outside fixture scope' } }));
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  });
  server.requestTimeout = 65_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { baseUrl: `http://2130706433:${server.address().port}/v1`, metrics,
    close: () => new Promise((resolve, reject) => {
      for (const controller of controllers) controller.abort();
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }) };
}

function buildLiveEvalReport({ oraclePassed = false, taskFinished = false, trajectory,
  elapsedMs = 0, fixture = 'unknown', proxyMetrics = {} } = {}) {
  const runs = trajectory?.runs ?? [];
  const complete = trajectory?.complete === true && runs.length > 0 && runs.every((r) => r.historyComplete);
  const clean = complete && runs.every((r) => r.phase === 'ended' && r.metrics?.interventions === 0);
  const count = (key) => runs.reduce((sum, run) => sum + (Number.isSafeInteger(run.metrics?.[key]) ? run.metrics[key] : 0), 0);
  return { schemaVersion: 1, evaluationKind: 'live-model', observationMode: 'uia-only',
    fixture: ['word', 'excel', 'powerpoint'].includes(fixture) ? fixture : 'unknown',
    outcome: !complete ? 'incomplete' : oraclePassed && taskFinished && clean && !proxyMetrics.providerErrors ? 'passed' : 'failed',
    oraclePassed: oraclePassed === true, taskFinished: taskFinished === true,
    elapsedMs: Math.max(0, Math.round(elapsedMs)), actionAttempts: count('actionAttempts'),
    approvalWaitMs: count('approvalWaitMs'), interventions: count('interventions'), unknownOutcomes: count('unknownOutcomes'),
    modelRequests: proxyMetrics.requests ?? 0, scopeRejections: proxyMetrics.rejectedResponses ?? 0,
    trajectory };
}

if (require.main === module) {
  const result = readLiveEvalConfig();
  // Never stringify result.config: it contains the dedicated credential.
  process.stdout.write(`${JSON.stringify({ evaluationKind: 'live-model', status: result.status,
    reason: result.reason, missing: result.missing })}\n`);
  process.exitCode = result.status === 'ready' ? 0 : 2;
}
module.exports = { readLiveEvalConfig, validateOfficeModelResponse, validateComputerUseModelResponse, startValidatedComputerUseProxy, buildLiveEvalReport, startOfficeLiveProxy, withoutLiveEvalCredential, officeGracePeriodExpired };
