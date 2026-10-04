'use strict';

/**
 * 故障注入用的写入子进程：不停往用量账本里写，等着被父进程杀掉。
 *
 * 由 `electron/usageDb.integration.test.ts` 启动。每成功写入一条就在 stdout 报一行
 * `{"committed":n}`，父进程据此知道哪些条目是账本**确认过**的——被杀之后这些条目
 * 必须一条不少地还在，库也必须还能打开。
 *
 * 用法：`node electron/__fixtures__/usageCrashWriter.cjs <appDataRoot>`
 */

const appDataRoot = process.argv[2];
if (!appDataRoot) throw new Error('usageCrashWriter: 缺少 appDataRoot 参数');

const { recordUsageAttempt } = require('../usageDb.cjs');

const app = {
  isPackaged: false,
  getPath(name) {
    if (name === 'appData') return appDataRoot;
    throw new Error(`usageCrashWriter: unexpected getPath key "${name}"`);
  },
};

function attemptAt(index) {
  return {
    schemaVersion: 1,
    attemptId: `att-${index}`,
    logicalCallId: `call-${index}`,
    revision: 1,
    providerInstanceId: 'provider-anthropic-default',
    protocol: 'anthropic',
    requestedModel: 'claude-opus-5',
    servedModel: 'claude-opus-5',
    source: 'main',
    conversationId: 'conv-crash',
    skill: null,
    startedAtUtc: 1_789_000_000_000 + index,
    localDate: '2026-09-15',
    tzId: 'Asia/Shanghai',
    offsetMinutes: 480,
    endedAtUtc: 1_789_000_000_500 + index,
    outcome: 'succeeded',
    usage: {
      inputTotal: 100,
      uncachedInput: 100,
      cacheRead: 0,
      cacheWrite: 0,
      outputTotal: 10,
      reasoningOutput: null,
      evidence: 'final',
      invalidFields: [],
    },
  };
}

let index = 0;

// 用 setImmediate 排下一次写入：留出事件循环的空档让 stdout 真的写出去，
// 否则父进程看不到任何"已确认"的条目，这个测试就会变成什么都没验。
function writeNext() {
  index += 1;
  const result = recordUsageAttempt(app, attemptAt(index));
  if (!result.ok) {
    process.stdout.write(`${JSON.stringify({ failed: index, code: result.code })}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ committed: index })}\n`);
  setImmediate(writeNext);
}

writeNext();
