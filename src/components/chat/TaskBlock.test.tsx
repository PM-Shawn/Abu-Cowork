import { describe, it, expect } from 'vitest';
import { generateSummary, type UnifiedStep } from './TaskBlock';
import { getI18n, getLocale, format } from '@/i18n';

function thinkingStep(duration?: number): UnifiedStep {
  return { id: 't1', type: 'thinking', label: '思考中...', status: 'completed', duration } as UnifiedStep;
}

describe('generateSummary — thinking-only block', () => {
  const t = getI18n();
  const locale = getLocale();
  it('shows "思考了 N 秒" when the thinking step has a duration', () => {
    expect(generateSummary([thinkingStep(5)], t, locale, false)).toBe(format(t.task.thoughtFor, { seconds: 5 }));
  });
  it('falls back to "思考过程" when no duration', () => {
    expect(generateSummary([thinkingStep(undefined)], t, locale, false)).toBe(t.chat.thinkingProcess);
  });
});
