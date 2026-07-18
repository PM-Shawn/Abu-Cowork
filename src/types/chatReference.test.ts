import { describe, it, expect } from 'vitest';
import { createDocReference, newReferenceId, createDomElementReference, domElementDisplayName, type BrowserElementPayload } from './chatReference';

const mkPayload = (overrides: Partial<BrowserElementPayload> = {}): BrowserElementPayload => ({
  tagName: 'BUTTON',
  id: '',
  classList: [],
  selector: 'button',
  outerHTML: '<button class="pay-btn">支付</button>',
  text: '支付',
  computedStyle: { display: 'flex', color: 'rgb(0, 0, 0)' },
  rect: { x: 0, y: 0, width: 100, height: 40 },
  pageUrl: 'https://example.com/checkout',
  pageTitle: '结算页',
  ...overrides,
});

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

  describe('domElementDisplayName', () => {
    it('renders tag#id.class', () => {
      expect(domElementDisplayName({ tagName: 'BUTTON', id: 'submit', classList: ['pay-btn', 'primary'] })).toBe(
        'button#submit.pay-btn.primary',
      );
    });

    it('skips a missing id', () => {
      expect(domElementDisplayName({ tagName: 'DIV', id: '', classList: ['card'] })).toBe('div.card');
    });

    it('skips missing classes', () => {
      expect(domElementDisplayName({ tagName: 'SPAN', id: 'x', classList: [] })).toBe('span#x');
    });

    it('renders just the lowercase tag when both id and classes are missing', () => {
      expect(domElementDisplayName({ tagName: 'A', id: '', classList: [] })).toBe('a');
    });

    it('truncates to 60 chars with an ellipsis', () => {
      const longClass = 'x'.repeat(80);
      const name = domElementDisplayName({ tagName: 'DIV', id: '', classList: [longClass] });
      expect(name.length).toBe(61); // 60 chars + ellipsis
      expect(name.endsWith('…')).toBe(true);
    });

    it('does not append an ellipsis when exactly at the limit', () => {
      // "div." (4) + 56 'x' = 60 chars exactly
      const cls = 'x'.repeat(56);
      const name = domElementDisplayName({ tagName: 'DIV', id: '', classList: [cls] });
      expect(name.length).toBe(60);
      expect(name.endsWith('…')).toBe(false);
    });
  });

  describe('createDomElementReference', () => {
    it('maps a BrowserElementPayload to a dom-element reference', () => {
      const payload = mkPayload({ id: 'submit', classList: ['pay-btn'] });
      const ref = createDomElementReference(payload);
      expect(ref.kind).toBe('dom-element');
      expect(ref.source).toEqual({
        path: 'https://example.com/checkout',
        name: 'button#submit.pay-btn',
        docType: 'web',
      });
      expect(ref.selection.text).toBe(payload.outerHTML);
      expect(ref.selection.context).toBe(payload.text);
      expect(ref.selection.style).toEqual(payload.computedStyle);
      expect(ref.comment).toBeUndefined();
      expect(typeof ref.id).toBe('string');
      expect(typeof ref.createdAt).toBe('number');
    });

    it('carries a comment when provided (Comment to Chat)', () => {
      const ref = createDomElementReference(mkPayload({ comment: '把这个按钮改成橙色' }));
      expect(ref.comment).toBe('把这个按钮改成橙色');
    });
  });
});
