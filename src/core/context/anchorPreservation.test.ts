import { describe, it, expect } from 'vitest';
import type { Message } from '../../types';
import {
  extractAnchorLines,
  formatKeptAnchors,
  KEPT_ANCHORS_HEADER,
  KEPT_ANCHORS_MAX_LINES,
  KEPT_ANCHORS_MAX_CHARS,
} from './anchorPreservation';

function msg(content: string, ts: number): Message {
  return { id: `m${ts}`, role: 'assistant', content, timestamp: ts };
}

describe('extractAnchorLines', () => {
  it('keeps plan-step bullets, headings, paths and URLs, first appearance first', () => {
    const lines = extractAnchorLines([
      msg('开始处理。\n- [ ] 扫描 d:/00malong/aiworkspace/测试目录 的文件\n- [ ] 按 spec 分组', 1),
      msg('## 第 2 步\n结果见 https://example.com/spec 和 /var/log/app/run.log', 2),
      msg('普通叙述行不含锚点', 3),
    ]);
    expect(lines).toEqual([
      '- [ ] 扫描 d:/00malong/aiworkspace/测试目录 的文件',
      '- [ ] 按 spec 分组',
      '## 第 2 步',
      '结果见 https://example.com/spec 和 /var/log/app/run.log',
    ]);
  });

  it('dedupes identical lines across messages', () => {
    const lines = extractAnchorLines([
      msg('- [ ] 同一步骤\n- [ ] 同一步骤', 1),
      msg('- [ ] 同一步骤', 2),
    ]);
    expect(lines).toEqual(['- [ ] 同一步骤']);
  });

  it('caps at 10 lines and truncates long lines to 200 chars', () => {
    const bullets = Array.from({ length: KEPT_ANCHORS_MAX_LINES + 5 }, (_, i) => `- [ ] 步骤 ${i}`).join('\n');
    const lines = extractAnchorLines([msg(bullets, 1)]);
    expect(lines).toHaveLength(KEPT_ANCHORS_MAX_LINES);

    const long = `- [ ] ${'x'.repeat(500)}`;
    const [truncated] = extractAnchorLines([msg(long, 1)]);
    expect(truncated).toHaveLength(KEPT_ANCHORS_MAX_CHARS + 1); // + the ellipsis
    expect(truncated!.endsWith('…')).toBe(true);
  });

  it('returns an empty list when nothing matches, and the formatter answers empty then', () => {
    const lines = extractAnchorLines([msg('普通叙述，没有锚点。', 1)]);
    expect(lines).toEqual([]);
    expect(formatKeptAnchors(lines)).toBe('');
  });
});

describe('formatKeptAnchors', () => {
  it('appends the header and the lines as a markdown block', () => {
    const block = formatKeptAnchors(['- [ ] 步骤', 'https://example.com']);
    expect(block).toBe(`\n\n${KEPT_ANCHORS_HEADER}\n- [ ] 步骤\nhttps://example.com`);
  });
});
