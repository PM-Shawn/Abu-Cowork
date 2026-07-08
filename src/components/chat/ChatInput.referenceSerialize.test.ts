// src/components/chat/ChatInput.referenceSerialize.test.ts
import { describe, it, expect } from 'vitest';
import { serializeReferences } from '@/utils/referenceSerializer';
import { createDocReference } from '@/types/chatReference';

// handleSend 的 message 组装 = [fileContext, serializeReferences(references), trimmed].join('\n\n')
// 这里断言组装契约(与 ChatInput.handleSend 同构)，纯函数即可覆盖序列化正确性。
describe('ChatInput reference assembly contract', () => {
  it('embeds serialized references before the typed text', () => {
    const refs = [createDocReference({ path: 'd.md', name: 'd.md', docType: 'markdown', text: '段落', comment: '优化' })];
    const referenceContext = serializeReferences(refs);
    const message = ['', referenceContext, '再帮我看下'].filter(Boolean).join('\n\n');
    expect(message).toContain('[引用 1 · 来源：d.md]');
    expect(message).toContain('指令：优化');
    expect(message.trim().endsWith('再帮我看下')).toBe(true);
  });
});
