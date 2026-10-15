import type { Root } from 'mdast';
import type {} from 'remark-parse';
import type { Plugin } from 'unified';
import type { Code, Construct, Extension, State, TokenizeContext, Tokenizer } from 'micromark-util-types';
import { codes, types } from 'micromark-util-symbol';
import { asciiDigit, markdownLineEnding, markdownSpace } from 'micromark-util-character';
import { math } from 'micromark-extension-llm-math';
import { mathFromMarkdown } from 'mdast-util-math';

// TeX math in replies: `$$…$$`, `\(…\)` and `\[…\]` come from micromark-extension-llm-math,
// a fork of micromark-extension-math that adds the TeX delimiters models write.
// Its own single-dollar rule is switched off: `$5 and $10` is two prices, so a
// single-dollar span is read by the construct below instead.

/**
 * A `$…$` span is math only when Pandoc's boundary rules hold: the opening `$`
 * is followed by a non-space character, the closing `$` is preceded by one and
 * is not followed by a digit or another `$`. The span stays on one line, holds
 * no backtick, keeps a backslash and the character after it together, and
 * closes with balanced braces. Any failed check rejects the whole attempt, so
 * micromark tries again from the next `$` and a price never stretches a span.
 */
const tokenizeSingleDollarMath: Tokenizer = function (effects, ok, nok) {
  let before: Code = null;
  let braceDepth = 0;

  const opening: State = (code) => {
    if (
      code === codes.eof ||
      code === codes.dollarSign ||
      code === codes.graveAccent ||
      markdownSpace(code) ||
      markdownLineEnding(code)
    ) {
      return nok(code);
    }
    effects.enter('mathTextData');
    return inside(code);
  };

  const inside: State = (code) => {
    if (code === codes.eof || code === codes.graveAccent || markdownLineEnding(code)) return nok(code);
    if (code === codes.dollarSign) {
      if (markdownSpace(before) || braceDepth !== 0) return nok(code);
      effects.exit('mathTextData');
      effects.enter('mathTextSequence');
      effects.consume(code);
      effects.exit('mathTextSequence');
      return closing;
    }
    if (code === codes.backslash) {
      effects.consume(code);
      return escaped;
    }
    if (code === codes.leftCurlyBrace) braceDepth += 1;
    if (code === codes.rightCurlyBrace) {
      if (braceDepth === 0) return nok(code);
      braceDepth -= 1;
    }
    before = code;
    effects.consume(code);
    return inside;
  };

  const escaped: State = (code) => {
    if (code === codes.eof || markdownLineEnding(code)) return nok(code);
    before = code;
    effects.consume(code);
    return inside;
  };

  const closing: State = (code) => {
    if (code === codes.dollarSign || asciiDigit(code)) return nok(code);
    effects.exit('mathText');
    return ok(code);
  };

  return (code) => {
    effects.enter('mathText');
    effects.enter('mathTextSequence');
    effects.consume(code);
    effects.exit('mathTextSequence');
    return opening;
  };
};

/** A `$` opens math unless it follows a `$` that is not escaped. */
function previousDollar(this: TokenizeContext, code: Code): boolean {
  return code !== codes.dollarSign || this.events[this.events.length - 1][1].type === types.characterEscape;
}

const singleDollarMathText: Construct = {
  name: 'singleDollarMathText',
  tokenize: tokenizeSingleDollarMath,
  previous: previousDollar,
};

/** Currency-safe `$…$` inline math, emitting the tokens `mdast-util-math` turns into `inlineMath`. */
export const singleDollarMath: Extension = {
  text: { [codes.dollarSign]: singleDollarMathText },
};

/** `$$…$$`, `\(…\)`, `\[…\]` and `$$` blocks, plus the mdast handlers for every math token. */
export const remarkMath: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(math({ singleDollarTextMath: false }));
  (data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
};

/** The single-dollar construct; runs alongside {@link remarkMath}, which compiles its tokens. */
export const remarkSingleDollarMath: Plugin<[], Root> = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(singleDollarMath);
};
