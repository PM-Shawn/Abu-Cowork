import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { COMPACT_BOUNDARY_ID_PREFIX } from '@/core/context/compactBoundary';
import { activeChapterIndex, deriveChapters, shouldShowRail, topVisibleGroup, type Chapter } from './chapters';

const FALLBACK = '会话开始';

function message(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp: 0, ...extra };
}

function titles(chapters: Chapter[]): string[] {
  return chapters.map((c) => c.title);
}

describe('deriveChapters', () => {
  it('makes one chapter per user turn, titled from the user message', () => {
    const groups = [
      [message('u1', 'user', '帮我盘一下多模态现状'), message('a1', 'assistant', '两批都实施完了')],
      [message('u2', 'user', '批次一的环境预检跑一下'), message('a2', 'assistant', '预检通过')],
    ];

    expect(titles(deriveChapters(groups, FALLBACK))).toEqual([
      '帮我盘一下多模态现状',
      '批次一的环境预检跑一下',
    ]);
  });

  it('anchors each chapter on its group index and first message id', () => {
    const groups = [
      [message('u1', 'user', 'first')],
      [message('u2', 'user', 'second')],
      [message('u3', 'user', 'third')],
    ];

    expect(deriveChapters(groups, FALLBACK).map((c) => [c.groupIndex, c.messageId])).toEqual([
      [0, 'u1'],
      [1, 'u2'],
      [2, 'u3'],
    ]);
  });

  it('summarises with the first assistant reply of the chapter', () => {
    const groups = [
      [
        message('u1', 'user', '问题'),
        message('a1', 'assistant', '第一句回复'),
        message('a2', 'assistant', '第二句回复'),
      ],
    ];

    expect(deriveChapters(groups, FALLBACK)[0].summary).toBe('第一句回复');
  });

  it('summarises a many-line reply from its first line only', () => {
    // Guards the hand-rolled first-line scan in `toLabel`: it must stop at the
    // first line with content instead of materialising the whole reply, and the
    // result must not change because the reply is long.
    const reply = ['', '  ', '结论：不是 flake。', ...Array.from({ length: 60 }, (_, i) => `细节第 ${i} 行`)].join('\n');
    const groups = [[message('u1', 'user', '为什么挂了'), message('a1', 'assistant', reply)]];

    expect(deriveChapters(groups, FALLBACK)[0].summary).toBe('结论：不是 flake。');
  });

  it('leaves the summary empty while a turn has no reply yet', () => {
    const groups = [[message('u1', 'user', '刚发出去还没回')]];

    expect(deriveChapters(groups, FALLBACK)[0].summary).toBe('');
  });

  it('uses the first non-empty line and strips a leading markdown marker', () => {
    const groups = [
      [message('u1', 'user', '\n\n## 发版清单核对\n剩下的正文不该进标题')],
      [message('u2', 'user', '- 列表开头的一句')],
    ];

    expect(titles(deriveChapters(groups, FALLBACK))).toEqual(['发版清单核对', '列表开头的一句']);
  });

  it('truncates an over-long title without breaking a latin word', () => {
    const groups = [[message('u1', 'user', 'please investigate the flaky verify run again')]];

    const title = deriveChapters(groups, FALLBACK)[0].title;
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('please investigate the…');
  });

  it('reads multimodal content through its text parts', () => {
    const groups = [
      [
        message('u1', 'user', '', {
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
            { type: 'text', text: '这张图里的报错是什么' },
          ],
        } as Partial<Message>),
      ],
    ];

    expect(deriveChapters(groups, FALLBACK)[0].title).toBe('这张图里的报错是什么');
  });

  it('opens with the fallback title when the conversation does not start on a user turn', () => {
    const groups = [
      [message('r1', 'assistant', '上次任务被中断了', { isRecoveryNotice: true })],
      [message('u1', 'user', '继续吧')],
    ];

    expect(titles(deriveChapters(groups, FALLBACK))).toEqual([FALLBACK, '继续吧']);
  });

  it('does not start a chapter on a compact-boundary marker', () => {
    const groups = [
      [message('u1', 'user', '第一章')],
      [message(`${COMPACT_BOUNDARY_ID_PREFIX}1`, 'system', '', { compactBoundary: { summarizedToId: 'u1' } } as Partial<Message>)],
      [message('u2', 'user', '第二章')],
    ];

    expect(titles(deriveChapters(groups, FALLBACK))).toEqual(['第一章', '第二章']);
  });

  it('does not start a chapter on an internal system injection', () => {
    const groups = [
      [message('u1', 'user', '第一章')],
      [message('s1', 'user', 'max_tokens recovery', { isSystem: true })],
    ];

    expect(titles(deriveChapters(groups, FALLBACK))).toEqual(['第一章']);
  });

  it('returns nothing for an empty conversation', () => {
    expect(deriveChapters([], FALLBACK)).toEqual([]);
  });
});

describe('activeChapterIndex', () => {
  const chapters = deriveChapters(
    [
      [message('u1', 'user', 'one')],
      [message('a1', 'assistant', 'still one')],
      [message('u2', 'user', 'two')],
      [message('u3', 'user', 'three')],
    ],
    FALLBACK,
  );

  it('reports the chapter the top of the viewport sits inside', () => {
    expect(activeChapterIndex(chapters, 0)).toBe(0);
    // group 1 has no chapter of its own — still inside chapter one
    expect(activeChapterIndex(chapters, 1)).toBe(0);
    expect(activeChapterIndex(chapters, 2)).toBe(1);
    expect(activeChapterIndex(chapters, 3)).toBe(2);
  });

  it('holds the last chapter once scrolled past every start', () => {
    expect(activeChapterIndex(chapters, 99)).toBe(2);
  });

  it('stays on the first chapter for an empty or leading range', () => {
    expect(activeChapterIndex([], 5)).toBe(0);
  });
});

describe('topVisibleGroup', () => {
  it('reports the last row whose top has passed the viewport edge', () => {
    const rows = [
      { index: 0, top: -900 },
      { index: 1, top: -400 },
      { index: 2, top: -20 },
      { index: 3, top: 300 },
      { index: 4, top: 800 },
    ];

    expect(topVisibleGroup(rows)).toBe(2);
  });

  it('stays on the first row while the list is scrolled to the top', () => {
    expect(topVisibleGroup([
      { index: 0, top: 0 },
      { index: 1, top: 420 },
    ])).toBe(0);
  });

  it('reports the last row when scrolled to the bottom — the newest chapter', () => {
    const rows = [
      { index: 7, top: -1200 },
      { index: 8, top: -700 },
      { index: 9, top: -120 },
    ];

    expect(topVisibleGroup(rows)).toBe(9);
  });

  it('lights the newest chapter at the bottom even though its row never reaches the top', () => {
    // The real shape at the end of a conversation: the final turn is short, so
    // its row sits well below the top edge and a purely top-anchored rule would
    // hold the highlight on the previous chapter forever.
    const rows = [
      { index: 7, top: -900 },
      { index: 8, top: -300 },
      { index: 9, top: 260 },
    ];

    expect(topVisibleGroup(rows)).toBe(8);
    expect(topVisibleGroup(rows, { atBottom: true })).toBe(9);
  });

  it('falls back to the first chapter at the bottom of an empty list', () => {
    expect(topVisibleGroup([], { atBottom: true })).toBe(0);
  });

  it('ignores unparsed indexes at the bottom too', () => {
    expect(topVisibleGroup([
      { index: 4, top: -100 },
      { index: Number.NaN, top: 200 },
    ], { atBottom: true })).toBe(4);
  });

  it('ignores rows below the edge even when they carry a lower index', () => {
    // Overscan renders rows past the fold; none of them may win.
    expect(topVisibleGroup([
      { index: 5, top: -10 },
      { index: 6, top: 40 },
      { index: 7, top: 90 },
    ])).toBe(5);
  });

  it('skips a row whose data-index did not parse', () => {
    expect(topVisibleGroup([
      { index: 3, top: -50 },
      { index: Number.NaN, top: -10 },
    ])).toBe(3);
  });

  it('falls back to the first chapter when nothing is rendered', () => {
    expect(topVisibleGroup([])).toBe(0);
  });
});

describe('shouldShowRail', () => {
  function chapters(n: number): Chapter[] {
    return Array.from({ length: n }, (_, i) => ({ groupIndex: i, messageId: `m${i}`, title: `第 ${i}`, summary: '' }));
  }

  it('stays out of the way until scrubbing beats scrolling', () => {
    expect(shouldShowRail(chapters(0))).toBe(false);
    // A brand-new conversation: one turn, one tick, nothing to navigate.
    expect(shouldShowRail(chapters(1))).toBe(false);
    expect(shouldShowRail(chapters(2))).toBe(false);
  });

  it('appears from the third chapter on', () => {
    expect(shouldShowRail(chapters(3))).toBe(true);
    expect(shouldShowRail(chapters(40))).toBe(true);
  });
});
