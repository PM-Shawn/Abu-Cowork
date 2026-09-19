// @vitest-environment node

/**
 * 契约测试：用量尝试快照跨进程传输的边界。
 *
 * 样例表在 `src/core/llm/__contractFixtures__/usageAttemptFixtures.ts`，
 * 期 1 第 3 步的 sidecar 采集器发送测试会读同一份表——两端任一单方面改协议都会红。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  REJECTED_ATTEMPTS,
  STRIPPED_ATTEMPTS,
  VALID_ATTEMPTS,
  baseAttempt,
} from '../src/core/llm/__contractFixtures__/usageAttemptFixtures';
import type { UsageAttempt } from '../src/core/llm/usageAccounting';

const require_ = createRequire(import.meta.url);
const {
  USAGE_FRAME_MARKER,
  MAX_FRAME_CHARS,
  validateUsageAttempt,
  encodeUsageFrame,
  decodeUsageFrame,
} = require_('./usageAttemptFrame.cjs') as {
  USAGE_FRAME_MARKER: string;
  MAX_FRAME_CHARS: number;
  validateUsageAttempt: (raw: unknown) =>
    | { ok: true; attempt: UsageAttempt }
    | { ok: false; reason: string };
  encodeUsageFrame: (attempt: UsageAttempt) => string;
  decodeUsageFrame: (
    line: unknown,
  ) =>
    | { kind: 'not-a-frame' }
    | { kind: 'frame'; attempt: UsageAttempt }
    | { kind: 'rejected'; reason: string };
};

describe('用量快照校验：合法样例', () => {
  it.each(VALID_ATTEMPTS.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const result = validateUsageAttempt(fixture.attempt);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 逐字段相同，不是"大致相同"：边界上任何一次补零、改写或丢字段都会红。
    expect(result.attempt).toEqual(fixture.attempt);
  });

  it('样例覆盖了两种协议、两种时区方向、以及每一种证据强度', () => {
    expect(new Set(VALID_ATTEMPTS.map((f) => f.attempt.protocol))).toEqual(
      new Set(['anthropic', 'openai-compatible']),
    );
    expect(VALID_ATTEMPTS.some((f) => f.attempt.offsetMinutes > 0)).toBe(true);
    expect(VALID_ATTEMPTS.some((f) => f.attempt.offsetMinutes < 0)).toBe(true);
    expect(new Set(VALID_ATTEMPTS.map((f) => f.attempt.usage.evidence))).toEqual(
      new Set(['none', 'partial', 'final']),
    );
  });

  it('每条样例都写明了它盯的是什么', () => {
    for (const fixture of [...VALID_ATTEMPTS, ...REJECTED_ATTEMPTS, ...STRIPPED_ATTEMPTS]) {
      expect(fixture.pins.length, `${fixture.name} 缺少 pins 说明`).toBeGreaterThan(20);
    }
  });
});

describe('用量快照校验：拒绝样例', () => {
  it.each(REJECTED_ATTEMPTS.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const result = validateUsageAttempt(fixture.raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(fixture.reason);
  });

  it('拒绝原因只含字段名，不含字段值', () => {
    // 这些错误码会进健康计数与诊断包。把用户内容带进错误码，等于绕开了
    // 「账本不存提示词与回答」这条规则（任务书 U06）。
    const secret = 'sk-live-0123456789';
    const result = validateUsageAttempt({ ...baseAttempt(), requestedModel: secret.repeat(40) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('field:requestedModel');
    expect(result.reason).not.toContain(secret);
  });
});

describe('用量快照校验：白名单重建', () => {
  it.each(STRIPPED_ATTEMPTS.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const result = validateUsageAttempt(fixture.raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt).toEqual(fixture.expected);
  });

  it('返回的是新对象，改它不会改到入参', () => {
    const raw = baseAttempt();
    const result = validateUsageAttempt(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt).not.toBe(raw);
    expect(result.attempt.usage).not.toBe(raw.usage);
    expect(result.attempt.usage.invalidFields).not.toBe(raw.usage.invalidFields);
  });
});

describe('stdout 帧', () => {
  it.each(VALID_ATTEMPTS.map((f) => [f.name, f] as const))(
    '编码再解码，逐字段还原：%s',
    (_name, fixture) => {
      const line = encodeUsageFrame(fixture.attempt);
      expect(line).not.toContain('\n');
      const decoded = decodeUsageFrame(line);
      expect(decoded.kind).toBe('frame');
      if (decoded.kind !== 'frame') return;
      expect(decoded.attempt).toEqual(fixture.attempt);
    },
  );

  it('普通 JSON-RPC 行照常交给消息通道', () => {
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    expect(decodeUsageFrame(rpc)).toEqual({ kind: 'not-a-frame' });
  });

  it('正文里出现标记串的 RPC 行照常投递，不被吞掉', () => {
    // sidecar 的 stdout 同时承载模型回答与工具结果，正文可以是任意文本。
    // 只按字面串判断就会把用户的一条回答吞进账本通道、让它在界面上消失。
    const rpc = JSON.stringify({
      jsonrpc: '2.0',
      method: 'agent.delta',
      params: { text: `这行里出现了 ${USAGE_FRAME_MARKER} 这个串` },
    });
    expect(rpc).toContain(USAGE_FRAME_MARKER);
    expect(decodeUsageFrame(rpc)).toEqual({ kind: 'not-a-frame' });
  });

  it('带标记串的坏 JSON 照常交给消息通道，不算被拒的帧', () => {
    expect(decodeUsageFrame(`{"${USAGE_FRAME_MARKER}":1,`)).toEqual({ kind: 'not-a-frame' });
  });

  it('超长的行不解析', () => {
    const line = JSON.stringify({
      [USAGE_FRAME_MARKER]: 1,
      attempt: baseAttempt(),
      padding: 'x'.repeat(MAX_FRAME_CHARS),
    });
    expect(line.length).toBeGreaterThan(MAX_FRAME_CHARS);
    expect(decodeUsageFrame(line)).toEqual({ kind: 'not-a-frame' });
  });

  it('帧版本不认识时按拒绝处理，不冒充普通消息', () => {
    const line = JSON.stringify({ [USAGE_FRAME_MARKER]: 2, attempt: baseAttempt() });
    expect(decodeUsageFrame(line)).toEqual({ kind: 'rejected', reason: 'frame-version' });
  });

  it('是用量帧但内容不合法时按拒绝处理', () => {
    const line = JSON.stringify({
      [USAGE_FRAME_MARKER]: 1,
      attempt: { ...baseAttempt(), localDate: '2026-09-15T00:00:00.000Z' },
    });
    // 已经自称是用量帧的行不能再交给 RPC 通道——那会把一条坏帧当成消息发给 renderer。
    expect(decodeUsageFrame(line)).toEqual({ kind: 'rejected', reason: 'field:localDate' });
  });

  it('非字符串输入不解析', () => {
    expect(decodeUsageFrame(null)).toEqual({ kind: 'not-a-frame' });
    expect(decodeUsageFrame(42)).toEqual({ kind: 'not-a-frame' });
  });

  it('JSON 数组不是帧', () => {
    expect(decodeUsageFrame(JSON.stringify([USAGE_FRAME_MARKER, 1]))).toEqual({
      kind: 'not-a-frame',
    });
  });
});
