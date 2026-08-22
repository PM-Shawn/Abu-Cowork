// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ChapterRail from './ChapterRail';
import type { Chapter } from './chapters';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { chat: { chapters: { railLabel: '会话章节', jumpTo: '跳到：{title}' } } },
  }),
  format: (template: string, values: Record<string, string>) =>
    template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ''),
}));

afterEach(cleanup);

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
