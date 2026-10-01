import { readFileSync } from 'node:fs';
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

const APPEARANCES: Appearance[] = ['light', 'dark', 'light-contrast', 'dark-contrast'];
const TEXT = ['label', 'label-secondary', 'label-tertiary', 'link', 'success', 'warning', 'danger', 'info'];
const SURFACES = ['surface', 'raised', 'code', 'field', 'desk-solid'];
const STATUS = ['success', 'warning', 'danger', 'info'];
const SYNTAX = ['syntax-comment', 'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-function', 'syntax-property'];

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

  // Selected text in the terminal, the source editor and document previews.
  it.each(['label', 'label-secondary'])('%s on selection over surface is at least 4.5:1', (text) => {
    expect(wcagContrast(color(values, text), over(values, 'selection', 'surface'))).toBeGreaterThanOrEqual(4.5);
  });

  it('selection stands out from the surface it sits on', () => {
    expect(wcagContrast(over(values, 'selection', 'surface'), color(values, 'surface'))).toBeGreaterThanOrEqual(1.3);
  });

  // Web pages and Word pages bring their own dark text; their paper stays white.
  it('page canvas keeps default page text readable', () => {
    expect(wcagContrast(parse('#000000')!, color(values, 'page-canvas'))).toBeGreaterThanOrEqual(4.5);
  });

  // The source editor paints highlight colors on the panel surface.
  it.each(SYNTAX)('%s on surface is at least 4.5:1', (token) => {
    expect(wcagContrast(color(values, token), color(values, 'surface'))).toBeGreaterThanOrEqual(4.5);
  });
});
