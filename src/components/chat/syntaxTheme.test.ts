import { readFileSync } from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { SYNTAX_THEME } from './syntaxTheme';

const tokens = readFileSync(path.resolve(__dirname, '../../styles/tokens.css'), 'utf8');
const defined = new Set<string>();
postcss.parse(tokens).walkDecls(/^--ds-/, (decl) => { defined.add(decl.prop); });

describe('SYNTAX_THEME', () => {
  const values = Object.values(SYNTAX_THEME).flatMap((style) => Object.values(style).filter((v): v is string => typeof v === 'string'));

  it('takes every color from a design token, so the appearance switches it', () => {
    const colors = Object.values(SYNTAX_THEME).map((style) => style.color).filter((v): v is string => typeof v === 'string');
    expect(colors.length).toBeGreaterThan(0);
    for (const value of colors) expect(value).toMatch(/^var\(--ds-[a-z0-9-]+\)$/);
  });

  it('only references tokens that tokens.css defines', () => {
    const referenced = values.flatMap((v) => [...v.matchAll(/var\((--ds-[a-z0-9-]+)\)/g)].map((m) => m[1]));
    expect(referenced.filter((name) => !defined.has(name))).toEqual([]);
  });
});
