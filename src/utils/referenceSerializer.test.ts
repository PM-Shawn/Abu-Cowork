import { describe, it, expect } from 'vitest';
import { serializeReferences } from './referenceSerializer';
import { createDocReference, createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';

const mk = (text: string, comment?: string, name = 'doc.md') =>
  createDocReference({ path: `/w/${name}`, name, docType: 'markdown', text, comment });

const mkElement = (overrides: Partial<BrowserElementPayload> = {}) =>
  createDomElementReference({
    tagName: 'BUTTON',
    id: 'submit',
    classList: ['pay-btn'],
    selector: 'button#submit',
    outerHTML: '<button id="submit" class="pay-btn">支付</button>',
    text: '支付',
    computedStyle: { display: 'flex', color: 'rgb(0, 0, 0)' },
    rect: { x: 0, y: 0, width: 100, height: 40 },
    pageUrl: 'https://example.com/checkout',
    pageTitle: '结算页',
    ...overrides,
  });

describe('serializeReferences', () => {
  it('returns empty string for no references', () => {
    expect(serializeReferences([])).toBe('');
  });

  it('serializes a single reference without comment (Add to Chat)', () => {
    const out = serializeReferences([mk('本文档用于定义订单…')]);
    expect(out).toContain('[引用 1 · 来源：doc.md]');
    expect(out).toContain('> 本文档用于定义订单…');
    expect(out).not.toContain('指令：');
  });

  it('appends comment as an instruction line (Comment to Chat)', () => {
    const out = serializeReferences([mk('售后退款整段…', '把这段删掉')]);
    expect(out).toContain('> 售后退款整段…');
    expect(out).toContain('指令：把这段删掉');
  });

  it('numbers multiple references and keeps per-item instructions', () => {
    const out = serializeReferences([mk('段A', '优化'), mk('段B')]);
    expect(out).toContain('[引用 1 · 来源：doc.md]');
    expect(out).toContain('指令：优化');
    expect(out).toContain('[引用 2 · 来源：doc.md]');
    const idx2 = out.indexOf('[引用 2');
    expect(out.slice(idx2)).not.toContain('指令：');
  });

  it('escapes multi-line selected text into a blockquote', () => {
    const out = serializeReferences([mk('第一行\n第二行')]);
    expect(out).toContain('> 第一行\n> 第二行');
  });

  describe('dom-element references', () => {
    it('renders header + html fence, no style/instruction lines when absent', () => {
      const out = serializeReferences([mkElement({ computedStyle: {} })]);
      expect(out).toContain('[引用 1 · 网页元素 button#submit.pay-btn · 来源：https://example.com/checkout]');
      expect(out).toContain('```html\n<button id="submit" class="pay-btn">支付</button>\n```');
      expect(out).not.toContain('关键样式：');
      expect(out).not.toContain('指令：');
    });

    it('renders a 关键样式 line when style is non-empty', () => {
      const out = serializeReferences([mkElement({ computedStyle: { display: 'flex', color: 'rgb(0, 0, 0)' } })]);
      expect(out).toContain('关键样式：display: flex; color: rgb(0, 0, 0)');
    });

    it('appends 指令 line when a comment is present', () => {
      const out = serializeReferences([mkElement({ comment: '把这个按钮改成橙色' })]);
      expect(out).toContain('指令：把这个按钮改成橙色');
    });

    it('omits 指令 line when comment is absent', () => {
      const out = serializeReferences([mkElement()]);
      expect(out).not.toContain('指令：');
    });

    it('escalates to a 4-backtick fence when outerHTML contains a triple-backtick', () => {
      const out = serializeReferences([mkElement({ outerHTML: '<pre>```code```</pre>' })]);
      expect(out).toContain('````html\n<pre>```code```</pre>\n````');
    });

    it('mixes doc-selection and dom-element references with correct per-item numbering', () => {
      const out = serializeReferences([mk('段A'), mkElement({ comment: '改颜色' })]);
      expect(out).toContain('[引用 1 · 来源：doc.md]');
      expect(out).toContain('[引用 2 · 网页元素 button#submit.pay-btn · 来源：https://example.com/checkout]');
      expect(out).toContain('指令：改颜色');
    });
  });
});
