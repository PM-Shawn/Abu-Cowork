// @vitest-environment node

/**
 * 契约测试：sidecar 编出来的用量帧，主进程必须逐字段解得回来。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 3 步）。
 *
 * 两端各自实现（sidecar 是打包出去的 ESM，主进程是 Electron 的 CommonJS），
 * 共享的是 `src/core/llm/__contractFixtures__/usageAttemptFixtures.ts` 这份样例表。
 * 任一端单方面改帧格式、改标记、改版本号，这里都会红。
 *
 * sidecar 与主进程各自的单元测试只能证明自己这一半；两半连没连上，由这里证明。
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { encodeUsageFrame, USAGE_FRAME_MARKER, USAGE_FRAME_VERSION } from './usageFrame';
import {
  VALID_ATTEMPTS,
  baseAttempt,
} from '@/core/llm/__contractFixtures__/usageAttemptFixtures';
import type { UsageAttempt } from '@/core/llm/usageAccounting';

const require_ = createRequire(import.meta.url);
const mainSide = require_('../../electron/usageAttemptFrame.cjs') as {
  USAGE_FRAME_MARKER: string;
  USAGE_ATTEMPT_SCHEMA_VERSION: number;
  decodeUsageFrame: (
    line: string,
  ) =>
    | { kind: 'not-a-frame' }
    | { kind: 'frame'; attempt: UsageAttempt }
    | { kind: 'rejected'; reason: string };
};

describe('sidecar 编帧 → 主进程解帧', () => {
  it('两端的标记与版本号一致', () => {
    expect(USAGE_FRAME_MARKER).toBe(mainSide.USAGE_FRAME_MARKER);
    expect(USAGE_FRAME_VERSION).toBe(mainSide.USAGE_ATTEMPT_SCHEMA_VERSION);
  });

  it.each(VALID_ATTEMPTS.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const decoded = mainSide.decodeUsageFrame(encodeUsageFrame(fixture.attempt));
    expect(decoded.kind).toBe('frame');
    if (decoded.kind !== 'frame') return;
    expect(decoded.attempt).toEqual(fixture.attempt);
  });

  it('编出来的是单行，不会把一条帧劈成两条 stdout 行', () => {
    // sidecar 的 stdout 是按行分帧的：帧里出现换行会被主进程当成两行，
    // 前半段解析失败、后半段冒充另一条消息发给 renderer。
    for (const fixture of VALID_ATTEMPTS) {
      expect(encodeUsageFrame(fixture.attempt)).not.toContain('\n');
    }
  });

  it('标记是顶层键，不是正文里的一个串', () => {
    const line = encodeUsageFrame(baseAttempt());
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, USAGE_FRAME_MARKER)).toBe(true);
    expect(parsed[USAGE_FRAME_MARKER]).toBe(USAGE_FRAME_VERSION);
  });
});
