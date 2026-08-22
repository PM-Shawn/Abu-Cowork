// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import ChapterMenu from './ChapterMenu';
import type { Chapter } from './chapters';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { chat: { chapters: { railLabel: '会话章节', openList: '会话章节' } } },
  }),
}));

afterEach(cleanup);

const CHAPTERS: Chapter[] = [
  { groupIndex: 0, messageId: 'm0', title: '多模态现状盘点', summary: '' },
  { groupIndex: 4, messageId: 'm4', title: '批次一环境预检', summary: '' },
];

function openMenu() {
  fireEvent.click(screen.getByLabelText('会话章节'));
}

describe('ChapterMenu', () => {
  it('starts closed and opens on click', () => {
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={() => {}} />);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    openMenu();
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  });

  it('renders nothing when the conversation has no chapters', () => {
    const { container } = render(<ChapterMenu chapters={[]} currentIndex={0} onJump={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('jumps to the picked chapter and closes', () => {
    const onJump = vi.fn();
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={onJump} />);

    openMenu();
    fireEvent.click(screen.getAllByRole('menuitem')[1]);

    expect(onJump).toHaveBeenCalledWith(CHAPTERS[1]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks the current chapter', () => {
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={1} onJump={() => {}} />);

    openMenu();
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveAttribute('aria-current', 'false');
    expect(items[1]).toHaveAttribute('aria-current', 'true');
  });

  it('closes on an outside click', () => {
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={() => {}} />);

    openMenu();
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={() => {}} />);

    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('stays open when the click lands inside the menu', () => {
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={() => {}} />);

    openMenu();
    fireEvent.mouseDown(screen.getByRole('menu'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
