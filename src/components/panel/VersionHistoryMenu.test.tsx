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

  it('renders AI source badge and user-message label', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 10, source: 'ai', label: '把标题改成蓝色' },
      { id: '1-0', ts: 1, byteSize: 10 },
    ]);
    renderMenu();
    await waitFor(() => expect(screen.getByText('把标题改成蓝色')).toBeTruthy());
    expect(screen.getByText('AI 修改前')).toBeTruthy();
    expect(screen.getByText('手动')).toBeTruthy();
  });

  it('renders the REVERT_LABEL sentinel via i18n, not raw', async () => {
    listVersionsMock.mockResolvedValue([
      { id: '2-1', ts: 2, byteSize: 10, source: 'manual', label: REVERT_LABEL },
    ]);
    renderMenu();
    await waitFor(() => expect(screen.getByText('回退前')).toBeTruthy());
    expect(screen.queryByText(REVERT_LABEL)).toBeNull();
  });

  it('always shows the boundary note footer', async () => {
    listVersionsMock.mockResolvedValue([]);
    renderMenu();
    await waitFor(() =>
      expect(screen.getByText(/命令行\/脚本产生的改动不会进入版本历史/)).toBeTruthy()
    );
  });
});
