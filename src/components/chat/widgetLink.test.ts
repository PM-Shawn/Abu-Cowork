// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openWidgetLink } from './widgetLink';

describe('openWidgetLink', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks the shell for a noopener popup, which the Electron boundary turns into an external open', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openWidgetLink('https://example.com/a');
    // `noopener` matters even though setWindowOpenHandler denies the popup:
    // it is the same call HtmlWidgetBlock has always made, and the one the
    // security boundary's tests are written against.
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener');
  });
});
