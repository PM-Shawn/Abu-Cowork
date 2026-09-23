import { describe, expect, it } from 'vitest';
import { initLanguage } from '@/i18n';
import { notePendingInstruction, acknowledgeDispatchInstruction } from './dispatchInput';
import { takeDispatchInstructionReport } from './dispatchInstructionReport';

describe('instruction handoff report', () => {
  it('distinguishes user instructions received by the model from unconfirmed ones', () => {
    initLanguage('zh-CN');
    notePendingInstruction('report:0', 'a', '已送达的要求');
    notePendingInstruction('report:0', 'b', '结束窗口的要求');
    acknowledgeDispatchInstruction('report:0', 'a');
    const text = takeDispatchInstructionReport('report:0', 'zz取数员');
    expect(text).toContain('已送达专家的模型请求');
    expect(text).toContain('不等于已执行');
    expect(text).toContain('没有收到专家模型请求的送达确认');
    expect(text).toContain('现交回队长处理');
    expect(text).toContain('已送达的要求');
    expect(text).toContain('结束窗口的要求');
    expect(takeDispatchInstructionReport('report:0', 'zz取数员')).toBe('');
    expect(takeDispatchInstructionReport(undefined, 'A')).toBe('');
  });
});
