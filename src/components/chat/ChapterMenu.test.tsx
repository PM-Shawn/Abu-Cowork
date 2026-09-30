// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { render as renderBare, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChapterMenu from './ChapterMenu';
import type { Chapter } from './chapters';

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { chat: { chapters: { railLabel: '会话章节', openList: '会话章节' } } },
  }),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const CHAPTERS: Chapter[] = [
  { groupIndex: 0, messageId: 'm0', title: '多模态现状盘点', summary: '' },
  { groupIndex: 4, messageId: 'm4', title: '批次一环境预检', summary: '' },
];

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

async function openMenu(user: ReturnType<typeof setupUser>) {
  await user.click(screen.getByRole('button', { name: '会话章节' }));
  return screen.findByRole('menu');
}

describe('ChapterMenu', () => {
  it('starts closed and opens on click', async () => {
    const user = setupUser();
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={() => {}} />);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await openMenu(user);
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
  });

  it('renders nothing when the conversation has no chapters', () => {
    const { container } = render(<ChapterMenu chapters={[]} currentIndex={0} onJump={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('jumps to the picked chapter and closes', async () => {
    const user = setupUser();
    const onJump = vi.fn();
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={onJump} />);

    await openMenu(user);
    await user.click(screen.getByRole('menuitemradio', { name: '批次一环境预检' }));

    expect(onJump).toHaveBeenCalledWith(CHAPTERS[1]);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('checks the current chapter', async () => {
    const user = setupUser();
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={1} onJump={() => {}} />);

    await openMenu(user);
    expect(screen.getByRole('menuitemradio', { name: '多模态现状盘点' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitemradio', { name: '批次一环境预检' })).toHaveAttribute('aria-checked', 'true');
  });

  it('closes on Escape without jumping', async () => {
    const user = setupUser();
    const onJump = vi.fn();
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={onJump} />);

    await openMenu(user);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(onJump).not.toHaveBeenCalled();
  });

  it('moves the highlight with the arrow keys without jumping', async () => {
    const user = setupUser();
    const onJump = vi.fn();
    render(<ChapterMenu chapters={CHAPTERS} currentIndex={0} onJump={onJump} />);

    await openMenu(user);
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(onJump).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
