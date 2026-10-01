// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { setLanguage } from '@/i18n';
import { REVERT_LABEL } from '@/utils/canvasVersions';

const listVersionsMock = vi.fn();
vi.mock('@/utils/canvasVersions', async () => {
  const actual = await vi.importActual<typeof import('@/utils/canvasVersions')>('@/utils/canvasVersions');
  return {
    ...actual,
    listVersions: (...args: unknown[]) => listVersionsMock(...args),
  };
});

import { VersionHistoryMenu } from './VersionHistoryMenu';

const TIME = /\d{2}:\d{2}:\d{2}/;

function Harness({ onRevert, initialOpen }: { onRevert: (id: string) => Promise<void>; initialOpen: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <VersionHistoryMenu
      filePath="/w/a.html"
      open={open}
      onOpenChange={setOpen}
      trigger={<Button>History</Button>}
      onRevert={onRevert}
    />
  );
}

describe('VersionHistoryMenu', () => {
  // happy-dom lacks the pointer-capture and scroll methods Radix menus call.
  beforeAll(() => {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.releasePointerCapture ??= () => {};
    Element.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    vi.clearAllMocks();
    setLanguage('zh-CN');
  });

  afterEach(() => {
    cleanup();
    setLanguage('system');
  });

  function renderMenu({ onRevert = async () => {}, initialOpen = true }: { onRevert?: (id: string) => Promise<void>; initialOpen?: boolean } = {}) {
    return render(
      <DesignSystemProvider>
        <Harness onRevert={onRevert} initialOpen={initialOpen} />
      </DesignSystemProvider>,
    );
  }

  it('renders the AI source badge and user-message label, but no badge for a manual entry', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 10, source: 'ai', label: '把标题改成蓝色' },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu();
    await waitFor(() => expect(screen.getByText('把标题改成蓝色')).toBeTruthy());
    expect(screen.getByText('AI 修改前')).toBeTruthy();
    // The unlabeled, source-less entry gets no badge at all — only AI edits are called out.
    expect(screen.queryByText('手动')).toBeNull();
  });

  it('renders the REVERT_LABEL sentinel via i18n as a self-explanatory label, with no badge', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 10, source: 'manual', label: REVERT_LABEL },
    ]);
    renderMenu();
    await waitFor(() => expect(screen.getByText('回退前备份')).toBeTruthy());
    expect(screen.queryByText(REVERT_LABEL)).toBeNull();
    expect(screen.queryByText('自动')).toBeNull();
    expect(screen.queryByText('手动')).toBeNull();
  });

  it('shows one menu item per version: the time as its name, the label and size as its description', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 2048, source: 'ai', label: '把标题改成蓝色' },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu();

    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAccessibleName(TIME);
    expect(items[0]).toHaveAccessibleDescription('把标题改成蓝色 · 2.0 KB');
    expect(items[1]).toHaveAccessibleName(TIME);
    expect(items[1]).toHaveAccessibleDescription('10 B');
    expect(screen.getByRole('menu')).toHaveTextContent('历史版本');
    // The second line stays one line: the label is cut short, the size is never pushed out.
    expect(screen.getByText('把标题改成蓝色')).toHaveClass('truncate');
    expect(screen.getByText(/2\.0 KB/)).toHaveClass('shrink-0');
    // Choosing a row overwrites the file, and its name is only a time: the hint says what it does.
    for (const item of items) expect(item).toHaveAttribute('title', '恢复到此版本');
    // Rows with and without the AI tag have the same first-line height (the tag's).
    expect(screen.getByText('AI 修改前').parentElement).toHaveClass('h-5');
    expect(within(items[1]).getByText(TIME).parentElement).toHaveClass('h-5');
    // The list keeps its own compact height and scrolls inside the menu.
    const list = items[0].parentElement;
    expect(list).toHaveClass('max-h-80');
    expect(list).toHaveClass('overflow-y-auto');
    expect(list?.parentElement).toBe(screen.getByRole('menu'));
  });

  it('reverts only on Enter: the arrow keys move the highlight', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn().mockResolvedValue(undefined);
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 10 },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu({ onRevert, initialOpen: false });

    await user.click(screen.getByRole('button', { name: 'History' }));
    await screen.findAllByRole('menuitem');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(onRevert).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(onRevert).toHaveBeenCalledOnce();
    expect(onRevert).toHaveBeenCalledWith('1-0');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  it('closes on Escape without reverting and returns focus to its button', async () => {
    const user = userEvent.setup();
    const onRevert = vi.fn().mockResolvedValue(undefined);
    listVersionsMock.mockResolvedValue([{ id: '1-0', ts: 1, byteSize: 10 }]);
    renderMenu({ onRevert, initialOpen: false });

    const trigger = screen.getByRole('button', { name: 'History' });
    await user.click(trigger);
    await screen.findAllByRole('menuitem');
    await user.keyboard('{ArrowDown}{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(onRevert).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
  });

  it('shows one spinner with its sentence while the list is being read', async () => {
    listVersionsMock.mockReturnValue(new Promise(() => {}));
    renderMenu();

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('加载中...');
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });

  it('says so when the file has no versions', async () => {
    listVersionsMock.mockResolvedValue([]);
    renderMenu();

    await waitFor(() => expect(screen.getByText('暂无历史版本')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disables every version while a revert is running', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onRevert = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 10 },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu({ onRevert, initialOpen: false });

    const trigger = screen.getByRole('button', { name: 'History' });
    await user.click(trigger);
    await user.click((await screen.findAllByRole('menuitem'))[0]);
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());

    await user.click(trigger);
    const items = await screen.findAllByRole('menuitem');
    for (const item of items) expect(item).toHaveAttribute('aria-disabled', 'true');
    await user.click(items[1]);
    expect(onRevert).toHaveBeenCalledOnce();

    finish();
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });
});
