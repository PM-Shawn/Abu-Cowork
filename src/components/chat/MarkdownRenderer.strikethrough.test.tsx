/// <reference types="@testing-library/jest-dom" />
/**
 * Regression: a lone `~` must NOT render as strikethrough.
 *
 * Chinese chat text uses `~` as a casual tone softener ("好的~", "操作了~").
 * remark-gfm's default (`singleTilde: true`) turns any two lone tildes in one
 * message into a <del> over the text between them — which is exactly what a
 * user reported (diagnostic mrlgtngq: a repeated reply, each copy ending "了~",
 * rendered with alternating strikethrough). We pass `singleTilde: false` so
 * strikethrough requires the explicit GFM `~~...~~` form.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import MarkdownRenderer from './MarkdownRenderer';

afterEach(cleanup);

describe('MarkdownRenderer — single tilde is not strikethrough', () => {
  it('does not strike text between two lone `~` (casual Chinese tone)', () => {
    // Mirrors the reported content: two copies each ending in a lone `~`.
    const content = '操作了~请你先在Chrome里打开阿布官网首页操作了~';
    const { container } = render(<MarkdownRenderer content={content} />);
    expect(container.querySelector('del')).toBeNull();
    expect(container.textContent).toContain('请你先在Chrome里打开阿布官网首页');
  });

  it('still renders explicit GFM double-tilde `~~text~~` as strikethrough', () => {
    const { container } = render(<MarkdownRenderer content={'这是~~删除线~~文本'} />);
    const del = container.querySelector('del');
    expect(del).not.toBeNull();
    expect(del?.textContent).toBe('删除线');
  });
});
