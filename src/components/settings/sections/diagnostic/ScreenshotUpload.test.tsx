// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLayoutEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import type { ScreenshotDraft } from '@/stores/feedbackDraftStore';
import { useToastStore } from '@/stores/toastStore';
import ScreenshotUpload from './ScreenshotUpload';

// Compression needs a canvas; here every image goes through as it came.
vi.mock('@/utils/imageCompress', () => ({
  compressImage: vi.fn(async (input: { bytes: Uint8Array; mediaType: string }) => input),
}));

const addToast = vi.fn();
const createObjectURL = vi.fn();
const revokeObjectURL = vi.fn();
// The screenshots the page around the panel holds after the latest change.
let held: ScreenshotDraft[] = [];

// Made-up images: a few bytes each, never decoded.
function image(name: string, size = 3, type = 'image/png'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function shot(id: string, size = 3): ScreenshotDraft {
  return { id, name: `${id}.png`, bytes: new Uint8Array(size), mediaType: 'image/png', previewUrl: `blob:made-up-${id}` };
}

function Page({ initial, disabled }: { initial: ScreenshotDraft[]; disabled: boolean }) {
  const [screenshots, setScreenshots] = useState(initial);
  useLayoutEffect(() => { held = screenshots; }, [screenshots]);
  return <ScreenshotUpload screenshots={screenshots} onChange={setScreenshots} disabled={disabled} />;
}

function renderPanel(initial: ScreenshotDraft[] = [], disabled = false) {
  held = initial;
  return render(<Page initial={initial} disabled={disabled} />, { wrapper: DesignSystemProvider });
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('No file input');
  return input;
}

function choose(...files: File[]) {
  fireEvent.change(fileInput(), { target: { files } });
}

describe('ScreenshotUpload', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    addToast.mockReset();
    let made = 0;
    createObjectURL.mockReset().mockImplementation(() => `blob:made-up-new-${++made}`);
    revokeObjectURL.mockReset();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    useToastStore.setState({ addToast });
  });

  afterEach(cleanup);

  describe('adding', () => {
    it('adds the images chosen in the file picker and leaves other files out', async () => {
      renderPanel();
      expect(screen.getByText('点击、拖拽或粘贴图片添加（最多 5 张，合计 5MB）')).toBeInTheDocument();

      choose(image('first.png'), new File(['notes'], 'notes.txt', { type: 'text/plain' }), image('second.jpg', 4, 'image/jpeg'));

      await waitFor(() => expect(held).toHaveLength(2));
      expect(held.map((s) => [s.name, s.mediaType, s.bytes.length, s.previewUrl])).toEqual([
        ['first.png', 'image/png', 3, 'blob:made-up-new-1'],
        ['second.jpg', 'image/jpeg', 4, 'blob:made-up-new-2'],
      ]);
      expect(screen.getByRole('img', { name: 'first.png' })).toHaveAttribute('src', 'blob:made-up-new-1');
      expect(addToast).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it('opens the file picker from the add button', async () => {
      const user = userEvent.setup();
      renderPanel([shot('a')]);
      const opened = vi.spyOn(fileInput(), 'click').mockImplementation(() => undefined);
      const buttons = screen.getAllByRole('button');

      // The add button comes after the thumbnails and their remove buttons.
      await user.click(buttons[buttons.length - 1]);

      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('adds images dropped on the panel and images pasted into it', async () => {
      renderPanel();
      const panel = fileInput().parentElement as HTMLElement;

      fireEvent.drop(panel, { dataTransfer: { files: [image('dropped.png')] } });
      await waitFor(() => expect(held).toHaveLength(1));

      const pasted = image('pasted.png');
      fireEvent.paste(panel, { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }] } });
      await waitFor(() => expect(held).toHaveLength(2));
      expect(held.map((s) => s.name)).toEqual(['dropped.png', 'pasted.png']);
    });

    it('stops at five images, says so, and lets go of the ones it did not take', async () => {
      renderPanel([shot('a'), shot('b'), shot('c'), shot('d')]);

      choose(image('fifth.png'), image('sixth.png'));

      await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
      expect(held.map((s) => s.name)).toEqual(['a.png', 'b.png', 'c.png', 'd.png', 'fifth.png']);
      expect(addToast).toHaveBeenCalledWith({ title: '最多添加 5 张截图', type: 'warning', duration: 4000 });
      expect(revokeObjectURL.mock.calls).toEqual([['blob:made-up-new-2']]);
      // With five in place there is nothing left to add.
      expect(screen.getAllByRole('button')).toHaveLength(5);
    });

    it('takes no image that would bring the total over 5 MB', async () => {
      renderPanel([shot('a', 4 * 1024 * 1024)]);

      choose(image('large.png', 2 * 1024 * 1024));

      await waitFor(() => expect(addToast).toHaveBeenCalledTimes(1));
      expect(held).toHaveLength(1);
      expect(addToast).toHaveBeenCalledWith({ title: '截图总大小超过 5MB，未添加', type: 'warning', duration: 4000 });
      expect(revokeObjectURL.mock.calls).toEqual([['blob:made-up-new-1']]);
    });

    it('adds nothing while the form is busy', async () => {
      renderPanel([], true);

      choose(image('first.png'));
      await Promise.resolve();

      expect(held).toHaveLength(0);
      expect(createObjectURL).not.toHaveBeenCalled();
    });
  });

  describe('removing', () => {
    it('takes one screenshot out and lets go of its preview', async () => {
      const user = userEvent.setup();
      renderPanel([shot('a'), shot('b')]);
      const thumbnail = screen.getByRole('img', { name: 'b.png' }).parentElement as HTMLElement;

      await user.click(within(thumbnail).getByRole('button', { name: '删除截图' }));

      expect(held.map((s) => s.id)).toEqual(['a']);
      expect(revokeObjectURL.mock.calls).toEqual([['blob:made-up-b']]);
      expect(screen.queryByRole('img', { name: 'b.png' })).not.toBeInTheDocument();
    });
  });

  describe('as design-system controls', () => {
    it('keeps the file input out of sight and out of the tab order, taking several images', () => {
      renderPanel();

      expect(fileInput()).toHaveClass('hidden');
      expect(fileInput()).toHaveAttribute('tabindex', '-1');
      expect(fileInput()).toHaveAttribute('accept', 'image/*');
      expect(fileInput().multiple).toBe(true);
    });

    it('names the add button', () => {
      renderPanel();

      expect(screen.getByRole('button', { name: '附加截图' })).toBeInTheDocument();
    });
  });
});
