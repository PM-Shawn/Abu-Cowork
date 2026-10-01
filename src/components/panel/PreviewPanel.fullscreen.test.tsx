// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import PreviewPanel from './PreviewPanel';

const testPlatform = vi.hoisted(() => ({ current: 'windows' }));

vi.mock('@/utils/platform', () => ({
  isWindows: () => testPlatform.current === 'windows',
  isMacOS: () => testPlatform.current === 'macos',
}));

// The real editor needs layout; the fullscreen tests only need the toolbar of an editable file.
vi.mock('./CodeMirrorEditor', () => ({ default: () => null }));
vi.mock('@/hooks/usePreviewFileWatch', () => ({ usePreviewFileWatch: () => {} }));
vi.mock('@/utils/canvasVersions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/canvasVersions')>()),
  snapshotVersion: vi.fn().mockResolvedValue(undefined),
  listVersions: vi.fn().mockResolvedValue([{ id: '1-0', ts: 1, byteSize: 10 }]),
}));

const FULLSCREEN = /^(全屏|Fullscreen)$/;
const EXIT_FULLSCREEN = /^(退出全屏|Exit fullscreen)$/;

function renderImagePreview() {
  return render(
    <DesignSystemProvider>
      <PreviewPanel
        filePath="data:image/png;base64,iVBORw0KGgo="
        tabId="preview-test"
        embedded
      />
    </DesignSystemProvider>,
  );
}

describe('PreviewPanel fullscreen layout', () => {
  beforeEach(() => {
    testPlatform.current = 'windows';
  });

  it('keeps the Windows native title bar above the maximized content', () => {
    const { container } = renderImagePreview();

    fireEvent.click(screen.getByRole('button', { name: FULLSCREEN }));

    expect(container.firstElementChild).toHaveClass('fixed', 'inset-0');
    expect(container.firstElementChild).toHaveStyle({
      top: 'calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 36px))',
    });
  });

  it('leaves the existing macOS fullscreen geometry unchanged', () => {
    testPlatform.current = 'macos';
    const { container } = renderImagePreview();

    fireEvent.click(screen.getByRole('button', { name: FULLSCREEN }));

    expect(container.firstElementChild).toHaveClass('fixed', 'inset-0');
    expect(container.firstElementChild).not.toHaveAttribute('style');
    expect(container.querySelector('.pl-20')).not.toBeNull();
  });

  it('names the button after what it does next, and shows Close only while fullscreen', () => {
    renderImagePreview();
    expect(screen.queryByRole('button', { name: /^(关闭预览|Close preview)$/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: FULLSCREEN }));
    expect(screen.getByRole('button', { name: /^(关闭预览|Close preview)$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: EXIT_FULLSCREEN }));
    expect(screen.getByRole('button', { name: FULLSCREEN })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(关闭预览|Close preview)$/ })).toBeNull();
  });

  describe('Escape with a toolbar menu open', () => {
    // happy-dom lacks the pointer-capture and scroll methods Radix menus call.
    beforeAll(() => {
      Element.prototype.hasPointerCapture ??= () => false;
      Element.prototype.setPointerCapture ??= () => {};
      Element.prototype.releasePointerCapture ??= () => {};
      Element.prototype.scrollIntoView ??= () => {};
    });

    beforeEach(() => {
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(readTextFile).mockResolvedValue('const a = 1;\n');
    });

    afterEach(() => {
      cleanup();
      vi.mocked(exists).mockResolvedValue(false);
      vi.mocked(readTextFile).mockResolvedValue('');
    });

    it.each([
      ['Version history'],
      ['More actions'],
    ])('closes the %s menu first and leaves fullscreen only on the next Escape', async (menuButton) => {
      const user = userEvent.setup();
      const { container } = render(
        <DesignSystemProvider>
          <PreviewPanel filePath="/w/main.ts" tabId="preview-test" embedded />
        </DesignSystemProvider>,
      );
      await user.click(await screen.findByRole('button', { name: FULLSCREEN }));
      expect(container.firstElementChild).toHaveClass('fixed');

      await user.click(screen.getByRole('button', { name: menuButton }));
      await screen.findAllByRole('menuitem');
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      expect(container.firstElementChild).toHaveClass('fixed');

      await user.keyboard('{Escape}');
      expect(container.firstElementChild).not.toHaveClass('fixed');
    });
  });
});
