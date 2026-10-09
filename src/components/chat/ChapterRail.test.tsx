// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';
import ChapterRail from './ChapterRail';
import type { Chapter } from './chapters';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { chat: { chapters: { railLabel: '会话章节', jumpTo: '跳到：{title}' } } },
  }),
  format: (template: string, values: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ''),
}));

const tickRenders = vi.hoisted(() => vi.fn());

// Counts renders of the rail's ticks.
vi.mock('@/components/ds/pressable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/pressable')>();
  return {
    ...actual,
    Pressable: (props: ComponentProps<typeof actual.Pressable>) => {
      tickRenders();
      return actual.Pressable(props);
    },
  };
});

afterEach(() => {
  cleanup();
  tickRenders.mockClear();
});

function chapter(index: number, title: string, summary = ''): Chapter {
  return { groupIndex: index, messageId: `m${index}`, title, summary };
}

const TWO = [chapter(0, '多模态现状盘点', '两批都实施完了'), chapter(1, '批次一环境预检')];

describe('ChapterRail', () => {
  it('renders one tick per chapter, labelled for screen readers', () => {
    render(<ChapterRail chapters={TWO} currentIndex={0} onJump={() => {}} />);

    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByLabelText('跳到：多模态现状盘点')).toBeInTheDocument();
  });

  it('renders nothing at all for a conversation with no chapters', () => {
    const { container } = render(<ChapterRail chapters={[]} currentIndex={0} onJump={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('marks only the current chapter', () => {
    render(<ChapterRail chapters={TWO} currentIndex={1} onJump={() => {}} />);

    const ticks = screen.getAllByRole('button');
    expect(ticks[0]).toHaveAttribute('aria-current', 'false');
    expect(ticks[1]).toHaveAttribute('aria-current', 'true');
  });

  it('jumps with the clicked chapter', () => {
    const onJump = vi.fn();
    render(<ChapterRail chapters={TWO} currentIndex={0} onJump={onJump} />);

    fireEvent.click(screen.getAllByRole('button')[1]);

    expect(onJump).toHaveBeenCalledWith(TWO[1]);
  });

  it('previews title and summary on hover, and clears them on leave', () => {
    render(<ChapterRail chapters={TWO} currentIndex={0} onJump={() => {}} />);

    fireEvent.mouseEnter(screen.getAllByRole('button')[0]);
    expect(screen.getByText('多模态现状盘点')).toBeInTheDocument();
    expect(screen.getByText('两批都实施完了')).toBeInTheDocument();

    fireEvent.mouseLeave(screen.getByRole('navigation'));
    expect(screen.queryByText('两批都实施完了')).not.toBeInTheDocument();
  });

  it('previews on keyboard focus so the rail is reachable without a mouse', () => {
    render(<ChapterRail chapters={TWO} currentIndex={0} onJump={() => {}} />);

    fireEvent.focus(screen.getAllByRole('button')[1]);

    expect(screen.getByText('批次一环境预检')).toBeInTheDocument();
  });

  it('omits the summary line while a chapter has no reply yet', () => {
    render(<ChapterRail chapters={TWO} currentIndex={0} onJump={() => {}} />);

    fireEvent.mouseEnter(screen.getAllByRole('button')[1]);

    expect(screen.getByText('批次一环境预检')).toBeInTheDocument();
    expect(screen.getByRole('navigation').querySelectorAll('.line-clamp-3')).toHaveLength(0);
  });

  it('caps its own height so a long conversation cannot clip the end ticks', () => {
    // 10px per tick means 150 chapters overflow a chat pane, and because the
    // rail is centred the overflow is cut off at BOTH ends — the oldest and
    // newest ticks would be unreachable without this cap.
    const many = Array.from({ length: 150 }, (_, i) => chapter(i, `第 ${i + 1} 段`));
    render(<ChapterRail chapters={many} currentIndex={0} onJump={() => {}} />);

    const list = screen.getAllByRole('button')[0].parentElement;
    expect(list?.className).toContain('max-h-[60vh]');
    expect(list?.className).toContain('overflow-y-auto');
  });

  it('brings the current tick into view when it changes', () => {
    const many = Array.from({ length: 60 }, (_, i) => chapter(i, `第 ${i + 1} 段`));
    const spy = vi.fn();
    // happy-dom has no layout, so scrollIntoView is a stub — assert we asked.
    Element.prototype.scrollIntoView = spy;

    const { rerender } = render(<ChapterRail chapters={many} currentIndex={0} onJump={() => {}} />);
    spy.mockClear();
    rerender(<ChapterRail chapters={many} currentIndex={59} onJump={() => {}} />);

    expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('draws resting ticks in the placeholder grey and the current one in the label colour', () => {
    render(<ChapterRail chapters={TWO} currentIndex={1} onJump={() => {}} />);
    const ticks = screen.getAllByRole('button');

    expect(ticks[0]).toHaveClass('before:bg-label-placeholder');
    expect(ticks[0]).not.toHaveClass('before:bg-label');
    expect(ticks[1]).toHaveClass('before:bg-label');
  });

  it('swells the hovered tick and its neighbours by distance, darkening only the hovered one', () => {
    const many = Array.from({ length: 9 }, (_, i) => chapter(i, `第 ${i + 1} 段`));
    render(<ChapterRail chapters={many} currentIndex={0} onJump={() => {}} />);
    const ticks = screen.getAllByRole('button');

    fireEvent.mouseEnter(ticks[4]);

    // Hovered: longest, and the label colour, like the chapter being read.
    expect(ticks[4]).toHaveClass('before:w-[24px]');
    expect(ticks[4]).toHaveClass('before:bg-label');
    // Neighbours fall off with distance, so the column reads as one wave — but
    // by LENGTH only. Colour stays exclusive to the tick under the pointer (and
    // to the current chapter), or the rail reads as three states at once.
    for (const [tick, width] of [[ticks[3], '16px'], [ticks[5], '16px'], [ticks[2], '10px']] as const) {
      expect(tick).toHaveClass(`before:w-[${width}]`);
      expect(tick).toHaveClass('before:bg-label-placeholder');
      expect(tick).not.toHaveClass('before:bg-label');
    }
    // Far enough away, nothing moves.
    expect(ticks[0]).not.toHaveClass('before:w-[10px]');
  });

  it('keeps the current chapter in the label colour while a neighbour is hovered', () => {
    const many = Array.from({ length: 5 }, (_, i) => chapter(i, `第 ${i + 1} 段`));
    render(<ChapterRail chapters={many} currentIndex={0} onJump={() => {}} />);
    const ticks = screen.getAllByRole('button');

    fireEvent.mouseEnter(ticks[1]);

    // Ramped in size by proximity, but still the chapter being read.
    expect(ticks[0]).toHaveClass('before:w-[16px]');
    expect(ticks[0]).toHaveClass('before:bg-label');
  });

  it('does not re-render while the chat view derives an equal chapter list per streamed token', () => {
    const onJump = () => {};
    const { rerender } = render(<ChapterRail chapters={TWO} currentIndex={0} onJump={onJump} />);
    const initial = tickRenders.mock.calls.length;
    expect(initial).toBe(2);

    rerender(<ChapterRail chapters={TWO.map((item) => ({ ...item }))} currentIndex={0} onJump={onJump} />);
    rerender(<ChapterRail chapters={TWO.map((item) => ({ ...item }))} currentIndex={0} onJump={onJump} />);
    expect(tickRenders).toHaveBeenCalledTimes(initial);

    rerender(<ChapterRail chapters={[TWO[0], { ...TWO[1], summary: '刚刚回答' }]} currentIndex={0} onJump={onJump} />);
    expect(tickRenders.mock.calls.length).toBeGreaterThan(initial);
  });

  it('condenses only the middle ticks once the rail gets long', () => {
    const many = Array.from({ length: 14 }, (_, i) => chapter(i, `第 ${i + 1} 段`));
    render(<ChapterRail chapters={many} currentIndex={0} onJump={() => {}} />);

    const ticks = screen.getAllByRole('button');
    expect(ticks[0].className).not.toContain('h-[6px]');
    expect(ticks[7].className).toContain('h-[6px]');
    expect(ticks[13].className).not.toContain('h-[6px]');
  });

  it('keeps every tick at full pitch while the rail is short', () => {
    render(<ChapterRail chapters={TWO} currentIndex={0} onJump={() => {}} />);

    for (const tick of screen.getAllByRole('button')) {
      expect(tick.className).not.toContain('h-[6px]');
    }
  });
});
