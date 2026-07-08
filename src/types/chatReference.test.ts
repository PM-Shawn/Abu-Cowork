import { describe, it, expect } from 'vitest';
import { createDocReference, newReferenceId } from './chatReference';

describe('chatReference', () => {
  describe('newReferenceId', () => {
    it('generates unique-ish ids', () => {
      const a = newReferenceId();
      const b = newReferenceId();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThan(4);
    });
  });

  describe('createDocReference', () => {
    it('builds a doc-selection reference with required fields', () => {
      const ref = createDocReference({
        path: '/w/订单数据流转说明.md',
        name: '订单数据流转说明.md',
        docType: 'markdown',
        text: '本文档用于定义订单…',
        context: '概述\n本文档用于定义订单…',
      });
      expect(ref.kind).toBe('doc-selection');
      expect(ref.source).toEqual({ path: '/w/订单数据流转说明.md', name: '订单数据流转说明.md', docType: 'markdown' });
      expect(ref.selection.text).toBe('本文档用于定义订单…');
      expect(ref.selection.context).toBe('概述\n本文档用于定义订单…');
      expect(ref.comment).toBeUndefined();
      expect(typeof ref.id).toBe('string');
      expect(typeof ref.createdAt).toBe('number');
    });

    it('carries a comment when provided', () => {
      const ref = createDocReference({
        path: 'a.md', name: 'a.md', docType: 'markdown', text: 't', comment: '优化这段',
      });
      expect(ref.comment).toBe('优化这段');
    });
  });
});
