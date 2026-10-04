'use strict';

/**
 * sidecar → main 的用量帧拦截，走真实的 mcp_spawn 与真实的 stdout 行循环。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 *
 * 这里要证的是三件事，全部是本次故障的直接教训：
 *  1. 用量帧被 main 直接写进账本，**不经过 renderer**——renderer 刷新、卡住或者
 *     没有订阅的时候，用户的对话仍在 sidecar 里正常进行，这条链不能跟着断。
 *  2. 用量帧不会冒充普通消息投给 renderer，普通消息也不会被当成用量帧吞掉。
 *  3. 这个桥同时承载第三方 MCP stdio 服务，它们写不进用户的用量账本。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { afterEach, test } = require('node:test');

const { mcpDispatch } = require('./mcpBridge.cjs');
const { SIDECAR_ID, sidecarRunRegistry } = require('./sidecarRunRegistry.cjs');
const { encodeUsageFrame, USAGE_FRAME_MARKER } = require('./usageAttemptFrame.cjs');
const usageDb = require('./usageDb.cjs');
const { REPO_ROOT } = require('./appEnv.cjs');

const SCRATCH_ROOT = path.join(REPO_ROOT, '.scratch', 'usage-frame-test');

let appDataRoot = '';
const activeIds = new Set();

const app = {
  isPackaged: false,
  getPath(name) {
    if (name === 'appData') return appDataRoot;
    throw new Error(`test app.getPath: unexpected key "${name}"`);
  },
};

function freshAppData(label) {
  usageDb._internal.resetForTest();
  appDataRoot = path.join(SCRATCH_ROOT, label);
  fs.rmSync(appDataRoot, { recursive: true, force: true });
  fs.mkdirSync(appDataRoot, { recursive: true });
}

function attemptFixture(attemptId) {
  return {
    schemaVersion: 1,
    attemptId,
    logicalCallId: 'call-frame',
    revision: 1,
    providerInstanceId: 'provider-anthropic-default',
    protocol: 'anthropic',
    requestedModel: 'claude-opus-5',
    servedModel: 'claude-opus-5',
    source: 'main',
    conversationId: 'conv-frame',
    skill: null,
    startedAtUtc: 1_789_000_000_000,
    localDate: '2026-09-15',
    tzId: 'Asia/Shanghai',
    offsetMinutes: 480,
    endedAtUtc: 1_789_000_002_000,
    outcome: 'succeeded',
    usage: {
      inputTotal: 2000,
      uncachedInput: 1000,
      cacheRead: 800,
      cacheWrite: 200,
      outputTotal: 500,
      reasoningOutput: null,
      evidence: 'final',
      invalidFields: [],
    },
  };
}

/** 一个把给定行原样打到 stdout 的子进程，收到 stdin 才开始打。 */
function printerFixture(lines) {
  return `
    const lines = ${JSON.stringify(lines)};
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      for (const line of lines) process.stdout.write(line + '\\n');
    });
    setInterval(() => {}, 1000);
  `;
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, description, attempts = 100) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await wait(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function spawnPrinter(id, lines) {
  activeIds.add(id);
  await mcpDispatch(app, 'mcp_spawn', {
    id,
    command: 'node',
    args: ['-e', printerFixture(lines)],
    env: {},
  });
  await mcpDispatch(app, 'mcp_write', { id, message: '{"start":true}' });
}

function totalAttempts() {
  return usageDb._internal.queryRange(app, '0000-01-01', '9999-12-31').totals.attempts;
}

function deliveredPayloads() {
  return sidecarRunRegistry
    .snapshot()
    .events.filter((event) => event.type === 'message')
    .map((event) => event.payload);
}

afterEach(() => {
  for (const id of activeIds) mcpDispatch(app, 'mcp_kill', { id });
  activeIds.clear();
  usageDb._internal.resetForTest();
  sidecarRunRegistry.reset();
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

test('sidecar 的用量帧进账本，不进消息通道；普通消息照常投递', async () => {
  freshAppData('sidecar');

  const goodFrame = encodeUsageFrame(attemptFixture('att-frame-1'));
  const rpcLine = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  // 正文里含有标记串的普通消息：只按字面串判断就会把用户的一条回答吞掉。
  const rpcWithMarker = JSON.stringify({
    jsonrpc: '2.0',
    method: 'agent.delta',
    params: { text: `正文里出现了 ${USAGE_FRAME_MARKER}` },
  });
  const badFrame = JSON.stringify({
    [USAGE_FRAME_MARKER]: 1,
    attempt: { ...attemptFixture('att-frame-2'), localDate: '2026-9-15' },
  });

  await spawnPrinter(SIDECAR_ID, [goodFrame, rpcLine, rpcWithMarker, badFrame]);

  await waitUntil(() => totalAttempts() === 1, '用量帧写进账本');
  await waitUntil(() => deliveredPayloads().length === 2, '两条普通消息投递完成');

  const delivered = deliveredPayloads();
  assert.deepEqual(delivered, [rpcLine, rpcWithMarker]);
  assert.equal(
    delivered.some((line) => line === goodFrame || line === badFrame),
    false,
    '用量帧不得作为普通消息投给 renderer',
  );

  // 坏帧被拒但没有冒充消息：账本里只有那一条合法的。
  const health = usageDb.getUsageHealth();
  assert.equal(health.rejectedFrames, 1);
  assert.equal(health.lastErrorCode, 'invalid-attempt:field:localDate');
  assert.equal(health.writeFailures, 0);

  const conversation = usageDb._internal.queryConversation(app, 'conv-frame');
  assert.equal(conversation.totals.attempts, 1);
  assert.equal(conversation.totals.inputKnownSum, 2000);
});

test('第三方 MCP 服务发的用量帧写不进账本', async () => {
  freshAppData('third-party');

  const frame = encodeUsageFrame(attemptFixture('att-from-mcp-server'));
  await spawnPrinter('some-third-party-mcp-server', [frame]);

  // 给它足够的时间把那一行打出来并走完行循环；写进账本才是异常，所以这里
  // 等的是"一段时间之后仍然没有写进去"。
  await wait(500);
  assert.equal(totalAttempts(), 0);
  assert.equal(usageDb.getUsageHealth().rejectedFrames, 0);
});
