// @vitest-environment node

/**
 * 契约测试：主进程给出的用量汇总形状，必须与 renderer 声明的字段清单一致。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 *
 * 主进程是 `.cjs`、renderer 是 TypeScript，类型在运行时被抹掉，所以两边靠
 * `USAGE_AGGREGATE_FIELDS` 这份清单对齐：主进程少给一个字段，页面上那个数字
 * 会静默变成 undefined 再渲染成空白；主进程多给一个字段，说明有人加了统计口径
 * 而页面还不知道。两种都在这里红。
 */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USAGE_AGGREGATE_FIELDS,
  emptyUsageHealth,
  type UsageRangeResult,
  type UsageHealth,
} from '../src/core/usage/usageLedgerClient';
import { baseAttempt } from '../src/core/llm/__contractFixtures__/usageAttemptFixtures';

const require_ = createRequire(import.meta.url);
const usageDb = require_('./usageDb.cjs') as {
  recordUsageAttempt: (app: unknown, raw: unknown) => { ok: boolean };
  getUsageHealth: () => UsageHealth;
  _internal: {
    queryRange: (app: unknown, from: string, to: string) => UsageRangeResult;
    queryConversation: (
      app: unknown,
      conversationId: string,
    ) => { available: boolean; totals: Record<string, number> };
    resetForTest: () => void;
  };
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_ROOT = path.join(REPO_ROOT, '.scratch', 'usage-query-contract');

let appDataRoot = '';
let caseIndex = 0;

function fakeApp() {
  return {
    isPackaged: false,
    getPath(name: string) {
      if (name === 'appData') return appDataRoot;
      throw new Error(`fakeApp.getPath: unexpected key "${name}"`);
    },
  };
}

beforeEach(() => {
  usageDb._internal.resetForTest();
  caseIndex += 1;
  appDataRoot = path.join(SCRATCH_ROOT, `case-${caseIndex}`);
  fs.rmSync(appDataRoot, { recursive: true, force: true });
  fs.mkdirSync(appDataRoot, { recursive: true });
});

afterAll(() => {
  usageDb._internal.resetForTest();
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

function query(): UsageRangeResult {
  return usageDb._internal.queryRange(fakeApp(), '0000-01-01', '9999-12-31');
}

function expectedFields(): string[] {
  return [...USAGE_AGGREGATE_FIELDS].sort();
}

describe('汇总字段清单', () => {
  it('有数据时，逐日、按来源与合计三处的字段与清单完全一致', () => {
    usageDb.recordUsageAttempt(fakeApp(), baseAttempt());
    const result = query();

    const expectedTotals = [...USAGE_AGGREGATE_FIELDS].sort();
    expect(Object.keys(result.totals).sort()).toEqual(expectedTotals);
    expect(Object.keys(result.byDay[0]).sort()).toEqual([...expectedTotals, 'localDate'].sort());
    expect(Object.keys(result.bySource[0]).sort()).toEqual([...expectedTotals, 'source'].sort());
    expect(Object.keys(result.byModel[0]).sort()).toEqual(
      [...expectedTotals, 'requestedModel'].sort(),
    );
  });

  it('按技能分组只收有技能的尝试', () => {
    usageDb.recordUsageAttempt(fakeApp(), baseAttempt());
    usageDb.recordUsageAttempt(fakeApp(), {
      ...baseAttempt(),
      attemptId: 'att-skill',
      skill: 'code-review',
    });
    const result = query();

    // 基准样例的 skill 是 null，不该变成一个叫 null 的技能。
    expect(result.bySkill.map((s) => s.skill)).toEqual(['code-review']);
    expect(Object.keys(result.bySkill[0]).sort()).toEqual([...expectedFields(), 'skill'].sort());
  });

  it('命中率的分子分母都只取可比的尝试', () => {
    usageDb.recordUsageAttempt(fakeApp(), baseAttempt());
    usageDb.recordUsageAttempt(fakeApp(), {
      ...baseAttempt(),
      attemptId: 'att-no-cache',
      usage: { ...baseAttempt().usage, cacheRead: null },
    });
    const totals = query().totals;

    expect(totals.cacheComparableAttempts).toBe(1);
    // 不可比的那条的输入总量不进分母，否则命中率被系统性压低。
    expect(totals.inputComparableSum).toBe(2000);
    expect(totals.cacheReadComparableSum).toBe(800);
    expect(totals.inputKnownSum).toBe(4000);
  });

  it('空库时合计仍是完整的一组零，页面不会拿到 undefined', () => {
    const result = query();
    expect(Object.keys(result.totals).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());
    for (const field of USAGE_AGGREGATE_FIELDS) {
      expect(result.totals[field], `${field} 不是数字`).toBe(0);
    }
  });

  it('停写状态下的合计也是完整的一组零', () => {
    const dir = path.join(appDataRoot, 'com.abu.app.electron-dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'usage.sqlite'), 'not a database');

    const result = query();
    expect(result.available).toBe(false);
    expect(Object.keys(result.totals).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());
  });

  it('会话合计与范围合计用同一组字段', () => {
    usageDb.recordUsageAttempt(fakeApp(), baseAttempt());
    const conversation = usageDb._internal.queryConversation(fakeApp(), 'conv-0001');
    expect(Object.keys(conversation.totals).sort()).toEqual([...USAGE_AGGREGATE_FIELDS].sort());
  });
});

describe('健康计数字段', () => {
  it('主进程给出的健康计数与 renderer 声明的字段一致', () => {
    // 对照组是 renderer 那边的零值对象，键集由 `UsageHealth` 接口约束，
    // 不是这里手抄一份字段名。
    const health = usageDb.getUsageHealth();
    expect(Object.keys(health).sort()).toEqual(Object.keys(emptyUsageHealth()).sort());
  });

  it('范围查询里带着同一份健康计数，页面读一次就够', () => {
    const result = query();
    expect(Object.keys(result.health).sort()).toEqual(
      Object.keys(usageDb.getUsageHealth()).sort(),
    );
  });
});
