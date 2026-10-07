import { describe, it, expect } from 'vitest';
import { cn } from './utils';

/**
 * Regression: tailwind-merge used to misclassify `text-[var(--abu-*)]` color
 * classes as font-sizes and silently DROP our custom size tokens from the
 * same cn() call — e.g. cn('text-caption', 'text-[var(--abu-info)]') lost
 * text-caption, so the element fell back to the body default size. Found via
 * a live-DOM probe (the "结果" toggle rendered 14px while its source said
 * text-caption). Fixed by extendTailwindMerge config in utils.ts.
 */
describe('cn (tailwind-merge token config)', () => {
  it('keeps a size token alongside a CSS-var color (color after size)', () => {
    expect(cn('text-caption', 'text-[var(--abu-info)]')).toBe(
      'text-caption text-[var(--abu-info)]'
    );
  });

  it('keeps a size token alongside a CSS-var color (size after color)', () => {
    expect(cn('text-[var(--abu-danger)]', 'text-body')).toBe(
      'text-[var(--abu-danger)] text-body'
    );
  });

  it('keeps size + line-height + var color together', () => {
    expect(cn('text-body leading-5', 'text-[var(--abu-text-tertiary)]')).toBe(
      'text-body leading-5 text-[var(--abu-text-tertiary)]'
    );
  });

  it('still merges genuine size conflicts (later wins)', () => {
    expect(cn('text-caption', 'text-body')).toBe('text-body');
    // eslint-disable-next-line no-restricted-syntax -- deliberately testing that a banned arbitrary px size still merges correctly
    expect(cn('text-[13px]', 'text-body')).toBe('text-body');
  });

  it('still merges genuine var-color conflicts (later wins)', () => {
    expect(cn('text-[var(--abu-info)]', 'text-[var(--abu-danger)]')).toBe(
      'text-[var(--abu-danger)]'
    );
  });

  it('does not disturb border width + var border color', () => {
    expect(cn('border', 'border-[var(--abu-border)]')).toBe(
      'border border-[var(--abu-border)]'
    );
  });

  it('does not disturb ring width + var ring color (form focus rings)', () => {
    expect(cn('focus:ring-2 focus:ring-[var(--abu-clay-ring)]')).toBe(
      'focus:ring-2 focus:ring-[var(--abu-clay-ring)]'
    );
    expect(cn('ring-1 ring-[var(--abu-warning-bg)]')).toBe(
      'ring-1 ring-[var(--abu-warning-bg)]'
    );
  });
});

describe('cn() — design-system tokens', () => {
  it('keeps a new font-size token alongside a new text color token', () => {
    expect(cn('text-ui', 'text-label-secondary')).toBe('text-ui text-label-secondary');
  });

  it('lets a later font-size token win over an earlier one', () => {
    expect(cn('text-ui', 'text-body')).toBe('text-body');
    expect(cn('text-h1', 'text-mono')).toBe('text-mono');
  });

  it('lets a later text color token win over an earlier one', () => {
    expect(cn('text-label', 'text-danger')).toBe('text-danger');
  });

  it('merges background, radius, shadow, z-index, duration and easing tokens', () => {
    expect(cn('bg-surface', 'bg-raised')).toBe('bg-raised');
    expect(cn('rounded-panel', 'rounded-control')).toBe('rounded-control');
    expect(cn('shadow-panel', 'shadow-float')).toBe('shadow-float');
    expect(cn('z-popover', 'z-dialog')).toBe('z-dialog');
    expect(cn('z-sticky', 'z-fullscreen')).toBe('z-fullscreen');
    expect(cn('duration-fast', 'duration-slow')).toBe('duration-slow');
    expect(cn('ease-enter', 'ease-exit')).toBe('ease-exit');
  });

  it('keeps the inline-code size next to a text color token', () => {
    expect(cn('text-code-inline', 'text-label')).toBe('text-code-inline text-label');
  });

  it('lets the composer shadow replace another design-system shadow', () => {
    expect(cn('shadow-panel', 'shadow-composer')).toBe('shadow-composer');
  });

  it('lets the page canvas replace another surface color', () => {
    expect(cn('bg-surface', 'bg-page-canvas')).toBe('bg-page-canvas');
  });

  it('lets a heatmap step replace the empty-day fill', () => {
    expect(cn('bg-fill', 'bg-heat-2')).toBe('bg-heat-2');
  });
});

// A ds button writes its hover and pressed classes `not-aria-disabled:hover:` / `:active:` (off
// while it is busy). A caller's class for the same property replaces them, with or without that
// variant, as it did when the button wrote plain `hover:`.
describe('cn() — a caller\'s hover class against a ds button\'s own', () => {
  it('lets a plain hover class replace the button\'s gated one', () => {
    expect(cn('not-aria-disabled:hover:text-label', 'text-success hover:text-success')).toBe('text-success hover:text-success');
    expect(cn('not-aria-disabled:hover:bg-fill-hover not-aria-disabled:active:bg-fill-pressed', 'hover:bg-raised')).toBe('not-aria-disabled:active:bg-fill-pressed hover:bg-raised');
    expect(cn('not-aria-disabled:active:opacity-80', 'active:opacity-100')).toBe('active:opacity-100');
  });

  it('lets a gated hover class replace the button\'s gated one, and the later of two wins either way', () => {
    expect(cn('not-aria-disabled:hover:text-label', 'not-aria-disabled:hover:text-on-emphasis')).toBe('not-aria-disabled:hover:text-on-emphasis');
    expect(cn('hover:bg-raised', 'not-aria-disabled:hover:bg-fill-hover')).toBe('not-aria-disabled:hover:bg-fill-hover');
  });

  it('keeps classes that answer something else', () => {
    // Another property, another state, or the busy look itself.
    expect(cn('not-aria-disabled:hover:bg-fill-hover', 'hover:text-success')).toBe('not-aria-disabled:hover:bg-fill-hover hover:text-success');
    expect(cn('not-aria-disabled:hover:bg-fill-hover', 'bg-raised')).toBe('not-aria-disabled:hover:bg-fill-hover bg-raised');
    expect(cn('aria-pressed:not-aria-disabled:hover:bg-fill-selected', 'hover:bg-raised')).toBe('aria-pressed:not-aria-disabled:hover:bg-fill-selected hover:bg-raised');
    expect(cn('aria-disabled:opacity-40', 'not-aria-disabled:hover:opacity-90')).toBe('aria-disabled:opacity-40 not-aria-disabled:hover:opacity-90');
  });
});

describe('cn() — design-system font family', () => {
  it('treats font-code as a font family, not a weight', () => {
    expect(cn('font-code', 'font-medium')).toBe('font-code font-medium');
    expect(cn('font-mono', 'font-code')).toBe('font-code');
  });
});
