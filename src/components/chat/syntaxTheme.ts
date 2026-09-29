import type { CSSProperties } from 'react';

// Prism style for react-syntax-highlighter. Colors are CSS variables, so light, dark and
// increased contrast all come from tokens.css; nothing here knows the current appearance.
const token = (name: string) => `var(--ds-syntax-${name})`;
const comment = { color: token('comment') };
const keyword = { color: token('keyword') };
const string = { color: token('string') };
const number = { color: token('number') };
const fn = { color: token('function') };
const property = { color: token('property') };
const punctuation = { color: 'var(--ds-label-secondary)' };

export const SYNTAX_THEME: Record<string, CSSProperties> = {
  'code[class*="language-"]': { color: 'var(--ds-label)', background: 'none', fontFamily: 'var(--ds-font-mono)', whiteSpace: 'pre', wordBreak: 'normal', tabSize: 2 },
  'pre[class*="language-"]': { color: 'var(--ds-label)', background: 'var(--ds-code)', fontFamily: 'var(--ds-font-mono)', overflow: 'auto', tabSize: 2 },
  comment, prolog: comment, doctype: comment, cdata: comment,
  punctuation, operator: punctuation,
  keyword, boolean: keyword, important: keyword, atrule: keyword, rule: keyword,
  string, char: string, 'attr-value': string, regex: string, url: string,
  number, constant: number, symbol: number, builtin: number,
  function: fn, 'class-name': fn,
  property, tag: property, 'attr-name': property, variable: property, namespace: property, selector: property,
  inserted: { color: 'var(--ds-success)' },
  deleted: { color: 'var(--ds-danger)' },
  italic: { fontStyle: 'italic' },
  bold: { fontWeight: 600 },
};
