import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule } from 'postcss';
import { blend, parse, wcagContrast, type Color } from 'culori';
import { describe, it, expect } from 'vitest';

const TOKENS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/tokens.css');

type Block = 'root' | 'dark' | 'rootContrast' | 'darkContrast';
type Appearance = 'light' | 'dark' | 'light-contrast' | 'dark-contrast';

function collectBlocks(css: string): Record<Block, Map<string, string>> {
  const blocks: Record<Block, Map<string, string>> = {
    root: new Map(), dark: new Map(), rootContrast: new Map(), darkContrast: new Map(),
  };
  postcss.parse(css).walkRules((rule) => {
    const parent = rule.parent;
    const media = parent && parent.type === 'atrule' ? (parent as AtRule).params : '';
    let block: Block | null = null;
    if (media === '') {
      if (rule.selector === ':root') block = 'root';
      if (rule.selector === '.dark') block = 'dark';
    } else if (media.includes('prefers-contrast: more')) {
      if (rule.selector === ':root:not(.dark)') block = 'rootContrast';
      if (rule.selector === '.dark') block = 'darkContrast';
    }
    if (!block) return;
    const target = blocks[block];
    rule.walkDecls(/^--ds-/, (decl) => { target.set(decl.prop, decl.value); });
  });
  return blocks;
}

const blocks = collectBlocks(readFileSync(TOKENS_PATH, 'utf8'));

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

describe('design tokens — completeness', () => {
  it('overrides every semantic light token in dark', () => {
    const semantic = [...blocks.root.keys()].filter((k) => !k.startsWith('--ds-palette-') && !k.startsWith('--ds-font-'));
    const missing = semantic.filter((k) => !blocks.dark.has(k));
    expect(missing).toEqual([]);
  });

  it('lists the same properties in both increased-contrast blocks', () => {
    expect([...blocks.darkContrast.keys()].sort()).toEqual([...blocks.rootContrast.keys()].sort());
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

  it.each(['surface', 'field'])('placeholder on %s is at least 3:1', (surface) => {
    expect(wcagContrast(color(values, 'label-placeholder'), color(values, surface))).toBeGreaterThanOrEqual(3);
  });

  it('on-emphasis on emphasis is at least 4.5:1', () => {
    expect(wcagContrast(color(values, 'on-emphasis'), color(values, 'emphasis'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['surface', 'desk-solid'])('focus ring on %s is at least 3:1', (surface) => {
    expect(wcagContrast(color(values, 'focus'), color(values, surface))).toBeGreaterThanOrEqual(3);
  });
});
