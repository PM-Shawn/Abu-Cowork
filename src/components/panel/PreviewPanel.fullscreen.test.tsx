// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exists, readTextFile } from '@tauri-apps/plugin-fs';
import { useState } from 'react';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
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

  it('is a layout state of the panel on the fullscreen level: no dialog, no scrim, and Escape leaves it', () => {
    const { container } = renderImagePreview();
    const surface = container.firstElementChild!;
    expect(surface).toHaveClass('contents');
    expect(surface).not.toHaveAttribute('role');

    fireEvent.click(screen.getByRole('button', { name: FULLSCREEN }));

    // The level is the surface's own: above the window's title-bar controls, under every
    // floating level. The panel passes no stacking class.
    expect(surface).toHaveClass('z-fullscreen');
    expect(surface).not.toHaveClass('z-sticky');
    expect(surface).not.toHaveClass('z-popover');
    expect(surface).not.toHaveClass('z-dialog');
    expect(surface).toHaveClass('bg-surface');
    expect(surface).toHaveAttribute('data-electron-no-drag');
    // Named after the file it shows; a group, never a dialog.
    expect(surface).toHaveAttribute('role', 'group');
    expect(surface).not.toHaveAttribute('aria-modal');
    expect(surface).not.toHaveAttribute('data-ds-layer');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.bg-scrim')).toBeNull();
    // The panel's own column fills the surface, between the surface's two Tab stops.
    const [before, column, after] = Array.from(surface.children);
    expect(before).toHaveAttribute('data-ds-focus-guard');
    expect(column).toHaveClass('h-full');
    expect(after).toHaveAttribute('data-ds-focus-guard');

    fireEvent.keyDown(document.body, { key: 'Escape' });

    expect(surface).not.toHaveClass('fixed');
    expect(surface).toHaveClass('contents');
    expect(screen.getByRole('button', { name: FULLSCREEN })).toBeInTheDocument();
  });

  it('leaves an Escape pressed inside a window to that window', async () => {
    function Stage() {
      const [open, setOpen] = useState(false);
      return (
        <DesignSystemProvider>
          <PreviewPanel filePath="data:image/png;base64,iVBORw0KGgo=" tabId="preview-test" embedded />
          <Button onClick={() => setOpen(true)}>open a window</Button>
          <Dialog open={open} onOpenChange={setOpen} title="A window"><Button>Inside</Button></Dialog>
        </DesignSystemProvider>
      );
    }
    const { container } = render(<Stage />);
    fireEvent.click(screen.getByRole('button', { name: FULLSCREEN }));
    const surface = container.firstElementChild!;
    expect(surface).toHaveClass('fixed');

    fireEvent.click(screen.getByRole('button', { name: 'open a window' }));
    const inside = screen.getByRole('button', { name: 'Inside' });
    expect(inside.closest('[data-ds-layer]')).not.toBeNull();
    // A window over the panel does not end the panel's fullscreen.
    expect(surface).toHaveClass('fixed');

    fireEvent.keyDown(inside, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(surface).toHaveClass('fixed');

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(surface).not.toHaveClass('fixed');
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
