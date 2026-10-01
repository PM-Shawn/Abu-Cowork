import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, it, expect } from 'vitest';

const INDEX_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/index.css');

// Top-level rules that paint a selection or the committed doc reference, in source order.
const rules: { selector: string; background: string | undefined }[] = [];
postcss.parse(readFileSync(INDEX_PATH, 'utf8')).each((node) => {
  if (node.type !== 'rule' || !/::selection|::highlight\(abu-reference\)/.test(node.selector)) return;
  let background: string | undefined;
  node.walkDecls('background-color', (decl) => { background = decl.value; });
  rules.push({ selector: node.selector, background });
});
const position = (selector: string) => rules.findIndex((rule) => rule.selector === selector);

describe('selection styles', () => {
  it.each(['::highlight(abu-reference)', '[data-doc-selection-layer] ::selection'])('%s uses the panel selection color', (selector) => {
    expect(rules[position(selector)]?.background).toBe('var(--ds-selection)');
  });

  // White paper (Word, PDF and slide pages) never turns dark, so the light selection of the
  // dark appearance would vanish on it.
  it.each(['[data-page-canvas] ::selection', '[data-page-canvas] ::highlight(abu-reference)'])('%s uses the page selection color', (selector) => {
    expect(rules[position(selector)]?.background).toBe('var(--ds-page-selection)');
  });

  // Both ::selection rules have the same specificity; the later one wins on a page.
  it('puts the page rules after the panel rules', () => {
    expect(position('[data-page-canvas] ::selection')).toBeGreaterThan(position('[data-doc-selection-layer] ::selection'));
    expect(position('[data-page-canvas] ::highlight(abu-reference)')).toBeGreaterThan(position('::highlight(abu-reference)'));
  });
});
