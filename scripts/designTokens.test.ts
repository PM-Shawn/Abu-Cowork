import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { blend, parse, wcagContrast, type Color } from 'culori';
import { describe, it, expect } from 'vitest';
import { APPEARANCE_ATTRIBUTES } from '../src/styles/appearance';
import { MERMAID_THEME_VARIABLES } from '../src/components/chat/mermaidTheme';

const TOKENS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/tokens.css');

type Block = 'root' | 'dark' | 'rootContrast' | 'darkContrast' | 'reducedTransparency' | 'noMaterial';
type Appearance = 'light' | 'dark' | 'light-contrast' | 'dark-contrast';

const [CONTRAST_ATTR, CONTRAST_ON] = APPEARANCE_ATTRIBUTES.contrast;
const [TRANSPARENCY_ATTR, TRANSPARENCY_ON] = APPEARANCE_ATTRIBUTES.transparency;
const [MOTION_ATTR, MOTION_ON] = APPEARANCE_ATTRIBUTES.motion;
const CONTRAST = `:root[${CONTRAST_ATTR}="${CONTRAST_ON}"]`;
const SELECTORS: Record<Block, string> = {
  root: ':root',
  dark: '.dark',
  rootContrast: `${CONTRAST}:not(.dark)`,
  darkContrast: `${CONTRAST}.dark`,
  reducedTransparency: `:root[${TRANSPARENCY_ATTR}="${TRANSPARENCY_ON}"]`,
  noMaterial: ':root[data-window-material="none"]',
};

const css = readFileSync(TOKENS_PATH, 'utf8');
const SRC_DIR = path.resolve(path.dirname(TOKENS_PATH), '..');

// The z-index of each layer utility in tokens.css.
function layerLevels(source: string): Map<string, number> {
  const levels = new Map<string, number>();
  postcss.parse(source).walkAtRules('utility', (rule) => {
    rule.walkDecls('z-index', (decl) => { levels.set(rule.params, Number(decl.value)); });
  });
  return levels;
}

// Every stacking value written by hand in src/: arbitrary classes (`z-[9999]`), Tailwind steps
// (`z-50`) and inline `zIndex` / `z-index` numbers. Design-system files use the layer utilities.
function handWrittenLevels(): { file: string; value: number }[] {
  const found: { file: string; value: number }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx?|css)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || full === TOKENS_PATH) continue;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(/\bz-\[(\d+)\]|(?<![\w-])z-(\d+)(?![\w-])|\bzIndex:\s*(\d+)|\bz-index:\s*(\d+)/g)) {
        found.push({ file: path.relative(SRC_DIR, full), value: Number(match[1] ?? match[2] ?? match[3] ?? match[4]) });
      }
    }
  };
  walk(SRC_DIR);
  return found;
}

// A modal design-system layer turns pointer input off for the rest of the page. A hand-drawn
// overlay painted above it would hide it while presses fall through to it, so every floating
// level of the design system is above every hand-written stacking value.
describe('design tokens — layer levels', () => {
  const levels = layerLevels(css);
  const level = (name: string) => {
    const value = levels.get(name);
    if (value === undefined || Number.isNaN(value)) throw new Error(`${name} has no z-index`);
    return value;
  };

  it('keeps the order of the levels: page, popover, dialog, toast, tooltip', () => {
    const order = ['z-sticky', 'z-popover', 'z-dialog', 'z-toast', 'z-tooltip'].map(level);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(order.length);
  });

  it('finds the hand-written stacking values it is meant to compare with', () => {
    const values = handWrittenLevels();
    expect(values.length).toBeGreaterThan(20);
    expect(Math.max(...values.map((entry) => entry.value))).toBeGreaterThanOrEqual(9999);
  });

  it.each(['z-popover', 'z-dialog', 'z-toast', 'z-tooltip'])('puts %s above every hand-written stacking value in src/', (name) => {
    const above = handWrittenLevels().filter((entry) => entry.value >= level(name));
    expect(above).toEqual([]);
  });

  it('keeps z-sticky inside the page, below the hand-drawn windows', () => {
    expect(level('z-sticky')).toBeLessThan(50);
  });
});

function collectBlocks(source: string): Record<Block, Map<string, string>> {
  const blocks = Object.fromEntries(
    (Object.keys(SELECTORS) as Block[]).map((block) => [block, new Map<string, string>()]),
  ) as Record<Block, Map<string, string>>;
  postcss.parse(source).walkRules((rule) => {
    if (rule.parent?.type !== 'root') return;
    const block = (Object.keys(SELECTORS) as Block[]).find((name) => SELECTORS[name] === rule.selector);
    if (!block) return;
    rule.walkDecls(/^--ds-/, (decl) => { blocks[block].set(decl.prop, decl.value); });
  });
  return blocks;
}

const blocks = collectBlocks(css);

function appearance(name: Appearance): Map<string, string> {
  const light = new Map(blocks.root);
  const dark = new Map([...light, ...blocks.dark]);
  if (name === 'light') return light;
  if (name === 'dark') return dark;
  if (name === 'light-contrast') return new Map([...light, ...blocks.rootContrast]);
  return new Map([...dark, ...blocks.darkContrast]);
}

function color(values: Map<string, string>, token: string): Color {
  const raw = values.get(`--ds-${token}`);
  if (raw === undefined) throw new Error(`--ds-${token} is not defined`);
  const reference = /^var\((--ds-[a-z0-9-]+)\)$/.exec(raw);
  if (reference) return color(values, reference[1].slice('--ds-'.length));
  const parsed = parse(raw);
  if (!parsed) throw new Error(`--ds-${token} has an unparseable color: ${raw}`);
  return parsed;
}

function over(values: Map<string, string>, top: string, bottom: string): Color {
  return blend([color(values, bottom), color(values, top)], 'normal');
}

// Layers painted bottom to top.
function stack(values: Map<string, string>, ...layers: string[]): Color {
  return blend(layers.map((layer) => color(values, layer)), 'normal');
}

const APPEARANCES: Appearance[] = ['light', 'dark', 'light-contrast', 'dark-contrast'];
const TEXT = ['label', 'label-secondary', 'label-tertiary', 'link', 'success', 'warning', 'danger', 'info'];
const SURFACES = ['surface', 'raised', 'code', 'field', 'desk-solid'];
const STATUS = ['success', 'warning', 'danger', 'info'];
const SYNTAX = ['syntax-comment', 'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-function', 'syntax-property'];
const SELECTION_BASES = ['surface', 'code'];

describe('design tokens — completeness', () => {
  it('overrides every semantic light token in dark', () => {
    const semantic = [...blocks.root.keys()].filter((k) => !k.startsWith('--ds-palette-') && !k.startsWith('--ds-font-'));
    const missing = semantic.filter((k) => !blocks.dark.has(k));
    expect(missing).toEqual([]);
  });

  it('lists the same properties in both increased-contrast blocks', () => {
    expect([...blocks.darkContrast.keys()].sort()).toEqual([...blocks.rootContrast.keys()].sort());
  });

  it('finds both increased-contrast blocks', () => {
    expect(blocks.rootContrast.size).toBeGreaterThan(0);
    expect(blocks.darkContrast.size).toBeGreaterThan(0);
  });

  it('makes desk opaque when transparency is reduced', () => {
    expect(blocks.reducedTransparency.get('--ds-desk')).toBe('var(--ds-desk-solid)');
  });

  // Menus, popovers, tooltips, toasts and dialogs paint `raised`; the window material is the
  // only translucent layer.
  it.each(APPEARANCES)('keeps the floating-layer surface opaque in %s', (name) => {
    expect(color(appearance(name), 'raised').alpha ?? 1).toBe(1);
  });

  it('makes desk opaque when the window has no system material', () => {
    expect(blocks.noMaterial.get('--ds-desk')).toBe('var(--ds-desk-solid)');
  });

  it('keys accessibility appearances off <html> attributes, never media queries', () => {
    const queries: string[] = [];
    postcss.parse(css).walkAtRules('media', (rule) => { queries.push(rule.params); });
    expect(queries).toEqual([]);
  });

  it('stops scaling and sliding floating layers when motion is reduced', () => {
    const declarations = new Map<string, string>();
    postcss.parse(css).walkRules(`[${MOTION_ATTR}="${MOTION_ON}"] [data-ds-motion]`, (rule) => {
      rule.walkDecls((decl) => { declarations.set(decl.prop, `${decl.value}${decl.important ? ' !important' : ''}`); });
    });
    expect(declarations.get('--tw-enter-scale')).toBe('1 !important');
    expect(declarations.get('--tw-exit-scale')).toBe('1 !important');
    expect(declarations.get('animation-duration')).toBe('120ms !important');
  });
});

describe.each(APPEARANCES)('design tokens — contrast (%s)', (name) => {
  const values = appearance(name);

  it.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface] as const)))(
    '%s on %s is at least 4.5:1',
    (text, surface) => {
      expect(wcagContrast(color(values, text), color(values, surface))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(STATUS)('%s on its soft background is at least 4.5:1', (role) => {
    const background = over(values, `${role}-soft`, 'surface');
    expect(wcagContrast(color(values, role), background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['surface', 'raised', 'field'])('placeholder on %s is at least 3:1', (surface) => {
    expect(wcagContrast(color(values, 'label-placeholder'), color(values, surface))).toBeGreaterThanOrEqual(3);
  });

  it('on-emphasis on emphasis is at least 4.5:1', () => {
    expect(wcagContrast(color(values, 'on-emphasis'), color(values, 'emphasis'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['surface', 'desk-solid'])('focus ring on %s is at least 3:1', (surface) => {
    expect(wcagContrast(color(values, 'focus'), color(values, surface))).toBeGreaterThanOrEqual(3);
  });

  // Code is content (brief P1-1): every highlight color stays readable on the code block.
  it.each(SYNTAX)('%s on code is at least 4.5:1', (token) => {
    expect(wcagContrast(color(values, token), color(values, 'code'))).toBeGreaterThanOrEqual(4.5);
  });

  // Diagrams keep Mermaid's fixed light colors, so their canvas stays light in every appearance.
  it('Mermaid text on the diagram canvas is at least 4.5:1', () => {
    const text = parse(MERMAID_THEME_VARIABLES.primaryTextColor);
    if (!text) throw new Error('Mermaid text color is unparseable');
    expect(wcagContrast(text, color(values, 'diagram-canvas'))).toBeGreaterThanOrEqual(4.5);
  });

  // The user's own message sits on a fill over the content card.
  it.each(['label', 'label-secondary'])('%s on fill over surface is at least 4.5:1', (text) => {
    expect(wcagContrast(color(values, text), over(values, 'fill', 'surface'))).toBeGreaterThanOrEqual(4.5);
  });

  // Selected text in the terminal, the source editor and document previews sits on the panel
  // surface or on a code block. Selection is a transient state: primary text keeps 4.5:1, and
  // secondary text and code highlighting keep 3:1, the bar the spec sets for placeholder and focus.
  it.each(SELECTION_BASES)('label on selection over %s is at least 4.5:1', (base) => {
    expect(wcagContrast(color(values, 'label'), over(values, 'selection', base))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['label-secondary', ...SYNTAX].flatMap((text) => SELECTION_BASES.map((base) => [text, base] as const)))(
    '%s on selection over %s is at least 3:1',
    (text, base) => {
      expect(wcagContrast(color(values, text), over(values, 'selection', base))).toBeGreaterThanOrEqual(3);
    },
  );

  it.each(SELECTION_BASES)('selection stands out from the %s it sits on', (base) => {
    expect(wcagContrast(over(values, 'selection', base), color(values, base))).toBeGreaterThanOrEqual(1.3);
  });

  // Web pages and Word pages bring their own dark text; their paper stays white.
  it('page canvas keeps default page text readable', () => {
    expect(wcagContrast(parse('#000000')!, color(values, 'page-canvas'))).toBeGreaterThanOrEqual(4.5);
  });

  // White paper needs a dark selection in every appearance; the panel selection is light in dark.
  it('page selection stands out from the page canvas', () => {
    expect(wcagContrast(over(values, 'page-selection', 'page-canvas'), color(values, 'page-canvas'))).toBeGreaterThanOrEqual(1.3);
  });

  it('page selection keeps default page text readable', () => {
    expect(wcagContrast(parse('#000000')!, over(values, 'page-selection', 'page-canvas'))).toBeGreaterThanOrEqual(4.5);
  });

  // The source editor paints highlight colors on the panel surface.
  it.each(SYNTAX)('%s on surface is at least 4.5:1', (token) => {
    expect(wcagContrast(color(values, token), color(values, 'surface'))).toBeGreaterThanOrEqual(4.5);
  });

  // The line being edited is where the user reads most: it keeps the full text bar.
  it.each(['label', 'label-secondary', 'link', 'success', 'danger', ...SYNTAX])('%s on the editor active line is at least 4.5:1', (text) => {
    expect(wcagContrast(color(values, text), stack(values, 'surface', 'fill-hover'))).toBeGreaterThanOrEqual(4.5);
  });

  // CodeMirror paints the active line over the selection, so selected text on that line sits
  // on both fills. Word and bracket matches sit on the match fill, on the active line or off it.
  it.each([
    ['selection on the active line', ['surface', 'selection', 'fill-hover']],
    ['a match on the active line', ['surface', 'fill-hover', 'fill-selected']],
  ] as const)('label on %s is at least 4.5:1', (_name, layers) => {
    expect(wcagContrast(color(values, 'label'), stack(values, ...layers))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['label-secondary', 'link', 'success', 'danger', ...SYNTAX].flatMap((text) => [
    [text, 'selection on the active line', ['surface', 'selection', 'fill-hover']] as const,
    [text, 'a match on the active line', ['surface', 'fill-hover', 'fill-selected']] as const,
    // Folded-code placeholders and snippet fields are a fill; a bracket without a partner is a soft danger fill.
    [text, 'a fold placeholder on the active line', ['surface', 'fill-hover', 'fill']] as const,
    [text, 'an unmatched bracket on the active line', ['surface', 'fill-hover', 'danger-soft']] as const,
  ]))('%s on %s is at least 3:1', (text, _name, layers) => {
    expect(wcagContrast(color(values, text), stack(values, ...layers))).toBeGreaterThanOrEqual(3);
  });

  // The usage heatmap: an empty day, then four steps that must be told apart without color.
  it.each([
    ['heat-1', 'fill', 1.15],
    ['heat-2', 'heat-1', 1.3],
    ['heat-3', 'heat-2', 1.3],
    ['heat-4', 'heat-3', 1.3],
  ] as const)('%s stands out from %s on a dialog', (step, previous, ratio) => {
    expect(wcagContrast(over(values, step, 'raised'), over(values, previous, 'raised'))).toBeGreaterThanOrEqual(ratio);
  });

  // The editor's completion list is a floating layer; its current row is a selected fill.
  it('label on the selected row of a floating list is at least 4.5:1', () => {
    expect(wcagContrast(color(values, 'label'), stack(values, 'raised', 'fill-selected'))).toBeGreaterThanOrEqual(4.5);
  });
});
