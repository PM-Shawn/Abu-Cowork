import { describe, it, expect } from 'vitest';
import { mergeComposerAppend, referenceDedupeKey, referenceChipLabel } from './ChatInput';
import { createDocReference, createDomElementReference, type BrowserElementPayload } from '@/types/chatReference';

describe('mergeComposerAppend — window.sendPrompt draft merge (C1)', () => {
  it('appends with a newline separator when the draft is non-empty', () => {
    expect(mergeComposerAppend('user was typing', 'widget follow-up')).toBe('user was typing\nwidget follow-up');
  });

  it('uses the addition verbatim when the draft is empty', () => {
    expect(mergeComposerAppend('', 'widget follow-up')).toBe('widget follow-up');
  });

  it('treats a whitespace-only draft as empty (no leading blank line)', () => {
    expect(mergeComposerAppend('   \n  ', 'widget follow-up')).toBe('widget follow-up');
  });

  it('never clobbers the existing draft — the original text is preserved as a prefix', () => {
    const prev = 'important draft I do not want to lose';
    expect(mergeComposerAppend(prev, 'x')).toContain(prev);
  });
});

const mkDomElement = (overrides: Partial<BrowserElementPayload> = {}) =>
  createDomElementReference({
    tagName: 'DIV',
    id: 'hero',
    classList: ['card'],
    selector: 'div#hero.card',
    outerHTML: '<div id="hero" class="card">same structure</div>',
    text: 'same structure',
    computedStyle: {},
    rect: { x: 0, y: 0, width: 10, height: 10 },
    pageUrl: '/w/index.html',
    pageTitle: 'demo',
    ...overrides,
  });

const mkDocSelection = (text: string, comment?: string) =>
  createDocReference({ path: '/w/doc.md', name: 'doc.md', docType: 'markdown', text, comment });

describe('referenceDedupeKey', () => {
  it('keys dom-element references by their unique id, not by content', () => {
    // Two structurally-identical picks (same outerHTML/page) are deliberate
    // repeat selections and must produce DIFFERENT keys so both survive the
    // dedup pass in the pendingReferences drain effect.
    const a = mkDomElement();
    const b = mkDomElement(); // same payload -> same outerHTML/page, different id
    expect(a.id).not.toBe(b.id);
    expect(referenceDedupeKey(a)).not.toBe(referenceDedupeKey(b));
  });

  it('produces a stable key for the same reference object (guards the once-drain double-add case)', () => {
    const a = mkDomElement();
    expect(referenceDedupeKey(a)).toBe(referenceDedupeKey(a));
  });

  it('keys doc-selection references by path+text+comment, unchanged behavior', () => {
    const a = mkDocSelection('段A', '优化');
    const b = mkDocSelection('段A', '优化');
    // Same content -> same key (doc-selection still dedupes by content).
    expect(referenceDedupeKey(a)).toBe(referenceDedupeKey(b));
    const c = mkDocSelection('段B', '优化');
    expect(referenceDedupeKey(a)).not.toBe(referenceDedupeKey(c));
  });
});

describe('referenceChipLabel', () => {
  it('shows the readable source.name for dom-element, not raw outerHTML', () => {
    const r = mkDomElement({ outerHTML: '<div id="hero" class="card"><span>lots of nested tag soup</span></div>' });
    expect(referenceChipLabel(r)).toBe('div#hero.card');
    expect(referenceChipLabel(r)).not.toContain('<div');
  });

  it('keeps showing the quoted selected text for doc-selection (unchanged)', () => {
    const r = mkDocSelection('本文档用于定义订单…');
    expect(referenceChipLabel(r)).toBe('本文档用于定义订单…');
  });
});
