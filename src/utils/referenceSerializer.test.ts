import { describe, it, expect } from 'vitest';
import { serializeReferences } from './referenceSerializer';
import { createDocReference } from '@/types/chatReference';

const mk = (text: string, comment?: string, name = 'doc.md') =>
  createDocReference({ path: `/w/${name}`, name, docType: 'markdown', text, comment });

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
});
