/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { createRef } from 'react';
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

describe('VersionHistoryMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLanguage('zh-CN');
  });

  afterEach(() => cleanup());

  function renderMenu() {
    return render(
      <VersionHistoryMenu
        filePath="/w/a.html"
        open
        onClose={() => {}}
        anchorRef={createRef<HTMLElement>()}
        onRevert={async () => {}}
      />
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
});
