import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Nodes } from 'mdast';
import { remarkMath, remarkSingleDollarMath } from './mathSyntax';

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false }).use(remarkMath).use(remarkSingleDollarMath);

/** The math nodes of a document, as `kind(value)`. */
function mathIn(markdown: string): string[] {
  const found: string[] = [];
  const walk = (node: Nodes) => {
    if (node.type === 'math' || node.type === 'inlineMath') found.push(`${node.type}(${node.value})`);
    if ('children' in node) for (const child of node.children) walk(child);
  };
  walk(parser.parse(markdown));
  return found;
}

describe('mathSyntax', () => {
  describe('single dollar', () => {
    it.each([
      ['价格是 $5，另一件 $10。'],
      ['It costs $5 and $10.'],
      ['$100-$200'],
      ['echo $HOME and $PATH'],
      ['price: $5.'],
      ['$a}$'],
      ['$a\nb$'],
      ['$a`b$'],
      ['$ a$'],
      ['$a $'],
      ['$5$5'],
      ['总价 $$ 未定'],
    ])('leaves %j as text', (markdown) => {
      expect(mathIn(markdown)).toEqual([]);
    });

    it('takes the span after a rejected price', () => {
      expect(mathIn('$5 and $x$')).toEqual(['inlineMath(x)']);
    });

    it('reads every span of a sentence', () => {
      expect(mathIn('设 $x$ 为未知数，$y = x^2$。')).toEqual(['inlineMath(x)', 'inlineMath(y = x^2)']);
    });

    it('keeps balanced braces inside the span', () => {
      expect(mathIn('$\\frac{a}{b}$')).toEqual(['inlineMath(\\frac{a}{b})']);
    });

    it('keeps an escaped dollar inside the span', () => {
      expect(mathIn('$a\\$b$')).toEqual(['inlineMath(a\\$b)']);
    });

    it('does not open on a dollar escaped in the text', () => {
      expect(mathIn('\\$x$ costs')).toEqual([]);
    });
  });

  describe('double dollar and TeX delimiters', () => {
    it('reads $$…$$ inside a paragraph as inline math', () => {
      expect(mathIn('同一行 $$a+b$$ 结束')).toEqual(['inlineMath(a+b)']);
    });

    it('reads \\(…\\) as inline math', () => {
      expect(mathIn('行内 \\(a+b\\) 结束')).toEqual(['inlineMath(a+b)']);
    });

    it('reads a \\[…\\] block across lines', () => {
      expect(mathIn('\\[\n\\int_0^1 x\\,dx\n\\]')).toEqual(['math(\\int_0^1 x\\,dx)']);
    });

    it('reads a $$ block', () => {
      expect(mathIn('$$\nE = mc^2\n$$\n\n后文')).toEqual(['math(E = mc^2)']);
    });
  });

  describe('code', () => {
    it('leaves math delimiters in inline code and fenced code alone', () => {
      expect(mathIn('代码 `$x$` 与 `\\(y\\)`\n\n```\n\\[z\\]\n$w$\n```')).toEqual([]);
    });
  });

  describe('strikethrough', () => {
    it('still needs two tildes', () => {
      const tree = parser.parse('~~删除~~ 与 ~随口~');
      expect(JSON.stringify(tree)).toContain('"type":"delete"');
      expect(JSON.stringify(tree).match(/"type":"delete"/g)).toHaveLength(1);
    });
  });
});
