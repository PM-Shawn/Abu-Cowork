import { describe, it, expect } from 'vitest';
import { fuzzyFindAndReplace } from './fuzzyPatch';

describe('fuzzyFindAndReplace · input validation', () => {
  it('errors on empty old_string', () => {
    const r = fuzzyFindAndReplace('hello', '', 'world');
    expect(r.error).toMatch(/cannot be empty/);
    expect(r.newContent).toBe('hello');
    expect(r.strategy).toBeNull();
  });

  it('errors when old_string and new_string are identical', () => {
    const r = fuzzyFindAndReplace('hello', 'hello', 'hello');
    expect(r.error).toMatch(/identical/);
    expect(r.newContent).toBe('hello');
  });
});

// ── Strategy 1: exact ───────────────────────────────────────────────────

describe('fuzzyFindAndReplace · exact strategy', () => {
  it('replaces single exact match', () => {
    const r = fuzzyFindAndReplace('hello world', 'world', 'there');
    expect(r.newContent).toBe('hello there');
    expect(r.matchCount).toBe(1);
    expect(r.strategy).toBe('exact');
    expect(r.error).toBeNull();
  });

  it('rejects multiple exact matches without replaceAll', () => {
    const r = fuzzyFindAndReplace('foo bar foo', 'foo', 'xxx');
    expect(r.error).toMatch(/2 matches/);
    expect(r.newContent).toBe('foo bar foo'); // unchanged
    expect(r.matchCount).toBe(0);
  });

  it('replaces all exact matches when replaceAll=true', () => {
    const r = fuzzyFindAndReplace('foo bar foo baz foo', 'foo', 'xxx', true);
    expect(r.newContent).toBe('xxx bar xxx baz xxx');
    expect(r.matchCount).toBe(3);
    expect(r.strategy).toBe('exact');
  });

  it('does not produce overlapping matches (aaa case)', () => {
    const r = fuzzyFindAndReplace('aaa', 'aa', 'b', true);
    // Greedy non-overlapping: matches at 0 (len 2), then continues at 2
    // "aaa".indexOf("aa",0)=0; start=2; "aaa".indexOf("aa",2)=-1
    // So one match, replaced.
    expect(r.newContent).toBe('ba');
    expect(r.matchCount).toBe(1);
  });

  it('reports "no match" when string is absent', () => {
    const r = fuzzyFindAndReplace('hello', 'xyz', 'abc');
    expect(r.error).toMatch(/Could not find a match/);
    expect(r.strategy).toBeNull();
  });
});

// ── Strategy 2: line-trimmed ────────────────────────────────────────────

describe('fuzzyFindAndReplace · line-trimmed strategy', () => {
  it('matches when content has trailing whitespace per line', () => {
    const content = 'line one   \nline two  \nline three';
    const pattern = 'line one\nline two';
    const r = fuzzyFindAndReplace(content, pattern, 'REPLACED');
    expect(r.strategy).toBe('line_trimmed');
    expect(r.newContent).toBe('REPLACED\nline three');
    expect(r.matchCount).toBe(1);
  });

  it('matches when pattern has trailing whitespace per line', () => {
    const content = 'alpha\nbeta\ngamma';
    const pattern = 'alpha\t\nbeta  ';
    const r = fuzzyFindAndReplace(content, pattern, 'X');
    expect(r.strategy).toBe('line_trimmed');
    expect(r.newContent).toBe('X\ngamma');
  });

  it('preserves content outside the matched range', () => {
    // Pattern has leading spaces that don't appear in content — exact fails,
    // line-trimmed (per-line trim) matches.
    const content = 'before\nindented line\nafter';
    const pattern = '  indented line';
    const r = fuzzyFindAndReplace(content, pattern, 'replaced');
    expect(r.strategy).toBe('line_trimmed');
    expect(r.newContent).toBe('before\nreplaced\nafter');
  });

  it('matches multi-line pattern with mixed whitespace drift', () => {
    const content = [
      'header',
      '  step 1  ',
      '  step 2\t',
      'footer',
    ].join('\n');
    const pattern = 'step 1\nstep 2';
    const r = fuzzyFindAndReplace(content, pattern, 'STEPS');
    expect(r.strategy).toBe('line_trimmed');
    expect(r.newContent).toBe('header\nSTEPS\nfooter');
  });
});

// ── Strategy 3: whitespace-normalized ───────────────────────────────────

describe('fuzzyFindAndReplace · whitespace-normalized strategy', () => {
  it('matches when content has extra inline spaces', () => {
    const content = 'a  ::  b';
    const pattern = 'a :: b';
    const r = fuzzyFindAndReplace(content, pattern, 'OK');
    expect(r.strategy).toBe('whitespace_normalized');
    expect(r.matchCount).toBe(1);
    // Output should have the replacement in the original content shape.
    expect(r.newContent).toBe('OK');
  });

  it('matches tab vs space drift', () => {
    const content = 'foo\tbar\tbaz';
    const pattern = 'foo bar baz';
    const r = fuzzyFindAndReplace(content, pattern, 'X');
    expect(r.strategy).toBe('whitespace_normalized');
    expect(r.newContent).toBe('X');
  });

  it('does not match across newlines (newlines preserved)', () => {
    const content = 'foo\nbar';
    const pattern = 'foo bar';
    const r = fuzzyFindAndReplace(content, pattern, 'X');
    // Newlines are preserved during normalization, so no match
    expect(r.error).toMatch(/Could not find a match/);
    expect(r.strategy).toBeNull();
  });
});

// ── Strategy precedence ────────────────────────────────────────────────

describe('fuzzyFindAndReplace · strategy precedence', () => {
  it('prefers exact over line-trimmed when both would match', () => {
    // The content has an exact match, plus a trailing-whitespace version
    // elsewhere. Under replaceAll, exact wins and line-trimmed doesn't
    // get its turn.
    const content = 'hello world\nhello world  \nend';
    const pattern = 'hello world';
    const r = fuzzyFindAndReplace(content, pattern, 'hi', true);
    expect(r.strategy).toBe('exact');
    // Exact finds both occurrences (the second one starts with the same
    // prefix, whitespace after doesn't prevent exact match).
    expect(r.matchCount).toBe(2);
  });

  it('falls back to line-trimmed when exact fails', () => {
    // Content has a 2-space indent on line 2 that pattern lacks — exact
    // can't find the literal pattern, but per-line trim makes them equal.
    const r = fuzzyFindAndReplace('hello\n  world', 'hello\nworld', 'X');
    expect(r.strategy).toBe('line_trimmed');
    expect(r.newContent).toBe('X');
  });
});

// ── Real SKILL.md-like scenarios ────────────────────────────────────────

describe('fuzzyFindAndReplace · realistic skill patch scenarios', () => {
  it('patches a frontmatter field with trailing-whitespace drift', () => {
    const skillMd = `---
name: weekly-report
description: 每周订单报表
version: 1.0
---

# 流程
1. 拉飞书订单
2. 写钉钉群 oc_old
3. 发送
`;
    const r = fuzzyFindAndReplace(skillMd, 'oc_old', 'oc_new');
    expect(r.newContent).toContain('oc_new');
    expect(r.newContent).not.toContain('oc_old');
    expect(r.strategy).toBe('exact');
  });

  it('patches a multi-line procedure block', () => {
    const skillMd = `# Steps
1. connect to Hive
2. query orders
3. export CSV
`;
    const oldBlock = '1. connect to Hive\n2. query orders';
    const newBlock = '1. connect to Hive (via SSH tunnel)\n2. query orders (last 7 days)';
    const r = fuzzyFindAndReplace(skillMd, oldBlock, newBlock);
    expect(r.newContent).toContain('SSH tunnel');
    expect(r.newContent).toContain('last 7 days');
    expect(r.matchCount).toBe(1);
  });

  it('reports helpful error when replace_all is needed', () => {
    const content = 'foo\nfoo\nfoo';
    const r = fuzzyFindAndReplace(content, 'foo', 'bar');
    expect(r.error).toMatch(/replace_all/);
    expect(r.error).toMatch(/3 matches/);
  });
});
