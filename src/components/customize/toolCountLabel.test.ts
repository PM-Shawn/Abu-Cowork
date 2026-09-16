import { describe, it, expect } from 'vitest';
import { toolCountLabel } from './toolCountLabel';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

describe('toolCountLabel', () => {
  it('names app-only tools only when the server has some', () => {
    expect(toolCountLabel(zhCN, 3, 1)).toBe('3 个工具（含 1 个界面专用）');
    expect(toolCountLabel(enUS, 3, 1)).toBe('3 tools (1 app-only)');
  });

  it('says nothing about app-only tools when there are none', () => {
    // "3 tools (0 app-only)" would invent an empty category on every ordinary
    // connector — the count is a decision aid, not a schema dump.
    expect(toolCountLabel(zhCN, 3, 0)).toBe('3 个工具');
    expect(toolCountLabel(enUS, 3, 0)).toBe('3 tools');
  });

  it('treats an absent count as zero — an older result must not render "undefined"', () => {
    expect(toolCountLabel(zhCN, undefined, undefined)).toBe('0 个工具');
    expect(toolCountLabel(enUS, undefined, undefined)).toBe('0 tools');
  });

  it('keeps toolCount meaning model-visible tools — the two numbers do not overlap', () => {
    // 2 model-visible + 1 app-only, never "3 tools (1 app-only)".
    expect(toolCountLabel(enUS, 2, 1)).toBe('2 tools (1 app-only)');
  });
});
