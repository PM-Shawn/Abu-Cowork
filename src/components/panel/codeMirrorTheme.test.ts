import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { CODE_EDITOR_THEME, EDITOR_HIGHLIGHT_SPECS, EDITOR_THEME_SPEC } from './codeMirrorTheme';

const tokens = readFileSync(path.resolve(__dirname, '../../styles/tokens.css'), 'utf8');
const defined = new Set<string>();
postcss.parse(tokens).walkDecls(/^--ds-/, (decl) => { defined.add(decl.prop); });

const TOKEN_COLOR = /^var\(--ds-[a-z0-9-]+\)$/;
const themeRules = Object.entries(EDITOR_THEME_SPEC) as [string, Record<string, string>][];
const themeDeclarations = themeRules.flatMap(([selector, rule]) => Object.entries(rule).map(([prop, value]) => ({ selector, prop, value })));
const rule = (selector: string) => {
  const found = themeRules.find(([name]) => name.split(',').map((part) => part.trim()).includes(selector));
  if (!found) throw new Error(`no editor theme rule for ${selector}`);
  return found[1];
};

describe('EDITOR_THEME_SPEC', () => {
  it('takes every color from a design token, so the appearance switches it', () => {
    // `transparent` paints nothing: it only switches off a fill CodeMirror's base theme adds.
    const colors = themeDeclarations.filter(({ prop, value }) => /color$/i.test(prop) && value !== 'transparent');
    expect(colors.length).toBeGreaterThan(0);
    for (const { value } of colors) expect(value).toMatch(TOKEN_COLOR);
  });

  it('writes no literal color anywhere', () => {
    const literal = themeDeclarations.filter(({ value }) => /#[0-9a-f]{3,8}\b|\b(rgb|hsl|oklch)a?\(/i.test(value));
    expect(literal).toEqual([]);
  });

  it('paints the selection with the selection token on the panel surface', () => {
    expect(rule('.cm-selectionBackground').backgroundColor).toBe('var(--ds-selection)');
    expect(rule('&').backgroundColor).toBe('var(--ds-surface)');
  });

  // CodeMirror's base theme styles the focused selection and the focused bracket match with
  // longer selectors than a plain class; the theme has to match them or the base colors win.
  it('covers the focused selection and the focused bracket match', () => {
    expect(rule('&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground').backgroundColor).toBe('var(--ds-selection)');
    expect(rule('&.cm-focused .cm-matchingBracket').backgroundColor).toBe('var(--ds-fill-selected)');
  });

  it('uses the code type scale', () => {
    expect(rule('&').fontSize).toBe('var(--text-mono)');
    expect(rule('.cm-content').fontFamily).toBe('var(--ds-font-mono)');
    expect(rule('.cm-content').lineHeight).toBe('var(--text-mono--line-height)');
  });

  it('keeps the completion list and the search bar opaque and on tokens', () => {
    expect(rule('.cm-tooltip').backgroundColor).toBe('var(--ds-raised)');
    expect(rule('.cm-panels').backgroundColor).toBe('var(--ds-surface)');
  });
});

describe('EDITOR_HIGHLIGHT_SPECS', () => {
  it('takes every color from a design token', () => {
    const colors = EDITOR_HIGHLIGHT_SPECS.map((spec) => spec.color).filter((value): value is string => typeof value === 'string');
    expect(colors.length).toBeGreaterThan(0);
    for (const value of colors) expect(value).toMatch(TOKEN_COLOR);
  });

  it('uses the same highlight colors as chat code blocks', () => {
    const colors = new Set(EDITOR_HIGHLIGHT_SPECS.map((spec) => spec.color));
    for (const name of ['comment', 'keyword', 'string', 'number', 'function', 'property']) {
      expect(colors.has(`var(--ds-syntax-${name})`)).toBe(true);
    }
  });
});

describe('CODE_EDITOR_THEME', () => {
  it('only references tokens that tokens.css defines', () => {
    const values = [
      ...themeDeclarations.map(({ value }) => value),
      ...EDITOR_HIGHLIGHT_SPECS.flatMap((spec) => Object.values(spec).filter((value): value is string => typeof value === 'string')),
    ];
    const referenced = values.flatMap((value) => [...value.matchAll(/var\((--ds-[a-z0-9-]+)\)/g)].map((match) => match[1]));
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced.filter((name) => !defined.has(name))).toEqual([]);
  });

  it('is the editor theme plus the highlight style', () => {
    expect(CODE_EDITOR_THEME).toHaveLength(2);
  });
});
