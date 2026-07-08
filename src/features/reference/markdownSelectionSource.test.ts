import { describe, it, expect, beforeEach } from 'vitest';
import { markdownSelectionSource } from './markdownSelectionSource';

function selectWithin(html: string, selector: string): Selection {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  const el = document.querySelector(selector)!;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return sel;
}

describe('markdownSelectionSource', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('returns null for a collapsed/empty selection', () => {
    document.body.innerHTML = '<p>hi</p>';
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    expect(markdownSelectionSource.extract(sel, { path: 'a.md', name: 'a.md' })).toBeNull();
  });

  it('extracts selected text and paragraph context', () => {
    const sel = selectWithin('<p class="para">本文档用于定义订单在核心业务链路中的状态流转规则。</p>', '.para');
    const ref = markdownSelectionSource.extract(sel, { path: '/w/订单.md', name: '订单.md' });
    expect(ref).not.toBeNull();
    expect(ref!.source).toEqual({ path: '/w/订单.md', name: '订单.md', docType: 'markdown' });
    expect(ref!.selection.text).toContain('核心业务链路');
    expect(ref!.selection.context).toContain('本文档用于定义订单');
  });

  it('truncates very long text to the cap', () => {
    const long = 'x'.repeat(9000);
    const sel = selectWithin(`<p class="para">${long}</p>`, '.para');
    const ref = markdownSelectionSource.extract(sel, { path: 'a.md', name: 'a.md' });
    expect(ref!.selection.text.length).toBeLessThanOrEqual(8000);
  });
});
