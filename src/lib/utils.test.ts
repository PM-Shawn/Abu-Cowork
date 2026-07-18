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
