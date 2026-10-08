import { describe, it, expect } from 'vitest';
import { cn } from './utils';

/**
 * tailwind-merge reads every `text-<word>` it does not know as a text color, so a size name of
 * ours that is not registered would be dropped by the color that follows it in the same cn()
 * call, and the element would fall back to the inherited size with no test failing. Every token
 * name of tokens.css is registered in utils.ts under the property it sets; these cases hold one
 * name of each kind next to its neighbours, and the table below holds every name.
 */
describe('cn() — a size next to a color', () => {
  it('keeps a size token beside a text color, in either order', () => {
    expect(cn('text-caption', 'text-info')).toBe('text-caption text-info');
    expect(cn('text-danger', 'text-body')).toBe('text-danger text-body');
  });

  it('keeps size, line height and text color together', () => {
    expect(cn('text-body leading-5', 'text-label-tertiary')).toBe('text-body leading-5 text-label-tertiary');
  });

  it('lets the later of two sizes win, and the later of two text colors', () => {
    expect(cn('text-caption', 'text-body')).toBe('text-body');
    expect(cn('text-label', 'text-danger')).toBe('text-danger');
  });

  it('keeps a border width beside a border color, and lets the later border color win', () => {
    expect(cn('border', 'border-separator')).toBe('border border-separator');
    expect(cn('border border-separator', 'border-control-border')).toBe('border border-control-border');
  });

  it('keeps a ring width beside the focus ring color', () => {
    expect(cn('focus-visible:ring-2 focus-visible:ring-focus')).toBe('focus-visible:ring-2 focus-visible:ring-focus');
    expect(cn('ring-1', 'ring-focus')).toBe('ring-1 ring-focus');
  });
});

// Every name utils.ts registers, by the property it sets. A name missing there is read as
// something else (a size as a color, `font-code` as a weight) and merges wrongly.
const FONT_SIZES = ['caption', 'body', 'title-lg', 'title', 'ui', 'ui-sm', 'h1', 'h2', 'h3', 'mono', 'code-inline'];
const TEXT_COLORS = ['label', 'label-secondary', 'label-tertiary', 'label-placeholder', 'on-emphasis', 'link', 'success', 'warning', 'danger', 'info', 'brand-ink'];
const BG_COLORS = [
  'desk', 'desk-solid', 'surface', 'raised', 'code', 'diagram-canvas', 'page-canvas', 'field',
  'fill', 'fill-hover', 'fill-selected', 'fill-pressed', 'emphasis', 'scrim', 'brand',
  'success-soft', 'warning-soft', 'danger-soft', 'info-soft', 'heat-1', 'heat-2', 'heat-3', 'heat-4',
];
// A second name of the same list, to merge against.
const other = (names: string[], name: string) => names.find((candidate) => candidate !== name)!;

describe('cn() — every registered token name', () => {
  it.each(FONT_SIZES)('text-%s is a size: it replaces a size and stays beside a color', (name) => {
    expect(cn(`text-${other(FONT_SIZES, name)}`, `text-${name}`)).toBe(`text-${name}`);
    expect(cn(`text-${name}`, 'text-label')).toBe(`text-${name} text-label`);
    expect(cn('text-label', `text-${name}`)).toBe(`text-label text-${name}`);
  });

  it.each(TEXT_COLORS)('text-%s is a text color: it replaces a text color and stays beside a size', (name) => {
    expect(cn(`text-${other(TEXT_COLORS, name)}`, `text-${name}`)).toBe(`text-${name}`);
    expect(cn('text-ui', `text-${name}`)).toBe(`text-ui text-${name}`);
  });

  it.each(BG_COLORS)('bg-%s is a background color: it replaces another one', (name) => {
    expect(cn(`bg-${other(BG_COLORS, name)}`, `bg-${name}`)).toBe(`bg-${name}`);
  });

  it.each([
    ['border colors', ['border-separator', 'border-control-border']],
    ['radii', ['rounded-window', 'rounded-panel', 'rounded-control']],
    ['elevations', ['shadow-panel', 'shadow-float', 'shadow-dialog', 'shadow-composer']],
    ['levels', ['z-sticky', 'z-fullscreen', 'z-popover', 'z-dialog', 'z-toast', 'z-tooltip']],
    ['durations', ['duration-fast', 'duration-base', 'duration-slow']],
    ['easings', ['ease-enter', 'ease-exit']],
  ])('the %s replace each other, the later one winning', (_kind, classes) => {
    for (const earlier of classes) {
      for (const later of classes) {
        if (earlier !== later) expect(cn(earlier, later)).toBe(later);
      }
    }
  });

  it('the focus ring color replaces another ring color and stays beside a ring width', () => {
    expect(cn('ring-transparent', 'ring-focus')).toBe('ring-focus');
    expect(cn('ring-focus', 'ring-2')).toBe('ring-focus ring-2');
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

  it('merges background, radius, elevation, z-index, duration and easing tokens', () => {
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

  it('lets the composer elevation replace another design-system elevation', () => {
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
