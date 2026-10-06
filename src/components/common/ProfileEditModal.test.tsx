// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { APPROVAL_TITLE, approvalProbe, closingWindow, discardQuestion, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import ProfileEditModal from './ProfileEditModal';

// Everything the window does, in the order it does it.
const h = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('@/stores/settingsStore', async () => {
  const { create } = await import('zustand');
  const useSettingsStore = create<{
    userNickname: string;
    userAvatar: string;
    setUserNickname: (name: string) => void;
    setUserAvatar: (avatar: string) => void;
  }>()((set) => ({
    userNickname: '',
    userAvatar: '',
    setUserNickname: (userNickname) => { h.log.push(`setUserNickname [${userNickname}]`); set({ userNickname }); },
    setUserAvatar: (userAvatar) => { h.log.push(`setUserAvatar [${userAvatar}]`); set({ userAvatar }); },
  }));
  return { useSettingsStore };
});

import { useSettingsStore } from '@/stores/settingsStore';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();
const OLD_PICTURE = 'data:image/png;base64,T0xE';
const NEW_PICTURE = 'data:image/png;base64,TkVX';

// A file reader the test finishes by hand: reading a picture takes time in the app.
class HeldReader {
  static readers: HeldReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL(_file: Blob) { HeldReader.readers.push(this); }
  fail() { act(() => { this.onerror?.(); }); }
  abort() { act(() => { this.onabort?.(); }); }
  finish(result: string) {
    this.result = result;
    act(() => { this.onload?.(); });
  }
}

const ui = {
  nickname: () => screen.getByPlaceholderText<HTMLInputElement>(t().sidebar.nicknamePlaceholder),
  picture: () => screen.queryByAltText<HTMLImageElement>('Avatar'),
  fileInput: () => document.querySelector<HTMLInputElement>('input[type="file"]')!,
  save: () => screen.getByRole('button', { name: t().common.save }),
  cancel: () => screen.getByRole('button', { name: t().common.cancel }),
  reset: () => screen.queryByRole('button', { name: t().sidebar.resetProfile }),
  type: (value: string) => fireEvent.change(ui.nickname(), { target: { value } }),
  choosePicture: () => {
    const file = new File(['picture'], 'me.png', { type: 'image/png' });
    fireEvent.change(ui.fileInput(), { target: { files: [file] } });
    return HeldReader.readers.at(-1)!;
  },
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

function open() {
  const onClose = vi.fn(() => { h.log.push('onClose'); });
  const view = render(<ProfileEditModal open onClose={onClose} />);
  return {
    onClose,
    close: () => view.rerender(<ProfileEditModal open={false} onClose={onClose} />),
    reopen: () => view.rerender(<ProfileEditModal open onClose={onClose} />),
  };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  h.log.length = 0;
  HeldReader.readers = [];
  vi.stubGlobal('FileReader', HeldReader);
  useSettingsStore.setState({ userNickname: '', userAvatar: '' });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProfileEditModal', () => {
  describe('what it shows', () => {
    it('fills the nickname and the picture from the settings', () => {
      useSettingsStore.setState({ userNickname: 'Mango', userAvatar: OLD_PICTURE });
      open();

      expect(screen.getByText(t().sidebar.editProfile)).toBeInTheDocument();
      expect(ui.nickname().value).toBe('Mango');
      expect(ui.picture()).toHaveAttribute('src', OLD_PICTURE);
    });

    it('shows the default picture when none is set', () => {
      open();
      expect(ui.picture()).not.toBeInTheDocument();
    });

    it('takes at most 20 characters for the nickname', () => {
      open();
      expect(ui.nickname()).toHaveAttribute('maxlength', '20');
    });

    it('offers to restore the defaults only when a nickname or a picture is set', () => {
      open();
      expect(ui.reset()).not.toBeInTheDocument();

      ui.type('M');
      expect(ui.reset()).toBeInTheDocument();
    });
  });

  describe('saving', () => {
    it('saves the trimmed nickname and the picture, then closes', () => {
      useSettingsStore.setState({ userAvatar: OLD_PICTURE });
      const { onClose } = open();
      ui.type('  Mango  ');

      fireEvent.click(ui.save());

      expect(h.log).toEqual(['setUserNickname [Mango]', `setUserAvatar [${OLD_PICTURE}]`, 'onClose']);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('saves on Enter in the nickname field', () => {
      open();
      ui.type('Mango');

      fireEvent.keyDown(ui.nickname(), { key: 'Enter' });

      expect(h.log).toEqual(['setUserNickname [Mango]', 'setUserAvatar []', 'onClose']);
    });

    it('shows a chosen picture and saves it', () => {
      open();

      ui.choosePicture().finish(NEW_PICTURE);
      expect(ui.picture()).toHaveAttribute('src', NEW_PICTURE);

      fireEvent.click(ui.save());
      expect(h.log).toEqual(['setUserNickname []', `setUserAvatar [${NEW_PICTURE}]`, 'onClose']);
    });

    it('restores the defaults: no nickname and no picture', () => {
      useSettingsStore.setState({ userNickname: 'Mango', userAvatar: OLD_PICTURE });
      open();

      fireEvent.click(ui.reset()!);
      expect(ui.nickname().value).toBe('');
      expect(ui.picture()).not.toBeInTheDocument();
      expect(h.log).toEqual([]);

      fireEvent.click(ui.save());
      expect(h.log).toEqual(['setUserNickname []', 'setUserAvatar []', 'onClose']);
    });
  });

  describe('closing', () => {
    it('closes on Escape when nothing was changed', () => {
      const { onClose } = open();

      ui.escape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(h.log).toEqual(['onClose']);
    });

    it('closes on Cancel without saving', () => {
      useSettingsStore.setState({ userNickname: 'Mango' });
      const { onClose } = open();

      fireEvent.click(ui.cancel());

      expect(h.log).toEqual(['onClose']);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows the saved values again the next time it opens', () => {
      useSettingsStore.setState({ userNickname: 'Mango' });
      const { close, reopen } = open();
      ui.type('Something else');

      close();
      reopen();

      expect(ui.nickname().value).toBe('Mango');
    });
  });

  describe('as a design-system window', () => {
    it('is a dialog named by its title, whose heading the account specs read', () => {
      open();

      const window = screen.getByRole('dialog', { name: t().sidebar.editProfile });
      expect(within(window).getByRole('heading', { name: t().sidebar.editProfile })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().common.close })).toBeInTheDocument();
    });

    it('names the picture button and the words under it the same, and both open the file chooser', () => {
      open();
      const chooser = vi.spyOn(ui.fileInput(), 'click').mockImplementation(() => undefined);

      const both = screen.getAllByRole('button', { name: t().sidebar.changeAvatar });
      expect(both).toHaveLength(2);
      for (const button of both) fireEvent.click(button);

      expect(chooser).toHaveBeenCalledTimes(2);
      expect(ui.fileInput()).toHaveAttribute('accept', 'image/*');
    });

    it('opens on the picture button', () => {
      open();
      expect(screen.getAllByRole('button', { name: t().sidebar.changeAvatar })[0]).toHaveFocus();
    });

    describe('with something changed', () => {
      it('asks before it closes on Escape; keeping on leaves the nickname, discarding saves nothing', () => {
        const { onClose } = open();
        ui.type('Mango');

        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        discardQuestion.keepEditing();
        expect(ui.nickname().value).toBe('Mango');

        ui.escape();
        discardQuestion.discard();
        expect(h.log).toEqual(['onClose']);
      });

      it('asks after a picture was chosen, and after the defaults were restored', () => {
        useSettingsStore.setState({ userNickname: 'Mango', userAvatar: OLD_PICTURE });
        open();
        ui.choosePicture().finish(NEW_PICTURE);
        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
        cleanup();

        open();
        fireEvent.click(ui.reset()!);
        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
      });

      it('saves without asking', () => {
        const { onClose } = open();
        ui.type('Mango');

        fireEvent.click(ui.save());

        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    describe('while it fades out', () => {
      it('saves nothing on Save or on Enter in the nickname field', () => {
        keepClosingLayersOnScreen();
        const { onClose, close } = open();
        ui.type('Mango');
        close();
        expect(closingWindow()).toHaveTextContent(t().sidebar.editProfile);
        expect(ui.nickname().value).toBe('Mango');

        fireEvent.click(screen.getByRole('button', { name: t().common.save, hidden: true }));
        fireEvent.keyDown(ui.nickname(), { key: 'Enter' });

        expect(h.log).toEqual([]);
        expect(onClose).not.toHaveBeenCalled();
      });
    });

    // The form is filled when the window opens; what is saved elsewhere meanwhile leaves it alone.
    it('keeps what was typed when the saved values change while it is open', () => {
      open();
      ui.type('Mango');

      act(() => { useSettingsStore.setState({ userNickname: 'Saved elsewhere', userAvatar: OLD_PICTURE }); });

      expect(ui.nickname().value).toBe('Mango');
      expect(ui.picture()).not.toBeInTheDocument();
    });

    describe('a picture that is still being read', () => {
      it('is dropped when the window was closed and opened again meanwhile', () => {
        const { close, reopen } = open();
        const reader = ui.choosePicture();

        close();
        reopen();
        reader.finish(NEW_PICTURE);

        expect(ui.picture()).not.toBeInTheDocument();
        ui.escape();
        expect(discardQuestion.box()).toBeNull();
      });

      it('gives way to a picture chosen after it', () => {
        open();
        const first = ui.choosePicture();
        const second = ui.choosePicture();

        second.finish(NEW_PICTURE);
        first.finish(OLD_PICTURE);

        expect(ui.picture()).toHaveAttribute('src', NEW_PICTURE);
      });
    });

    describe('when an approval arrives', () => {
      const onAnswer = vi.fn();
      function Host({ approval, onClosed }: { approval: boolean; onClosed: () => void }) {
        const [isOpen, setOpen] = useState(true);
        return (
          <>
            <ProfileEditModal open={isOpen} onClose={() => { onClosed(); setOpen(false); }} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
      }
      function besideApproval() {
        onAnswer.mockReset();
        const onClosed = vi.fn(() => { h.log.push('onClose'); });
        const view = render(<Host approval={false} onClosed={onClosed} />);
        return {
          onClosed,
          arrive: () => view.rerender(<Host approval onClosed={onClosed} />),
          leave: () => view.rerender(<Host approval={false} onClosed={onClosed} />),
        };
      }
      const approval = () => windowBox(APPROVAL_TITLE);
      const own = () => windowBox(t().sidebar.editProfile);

      it('asks about the typed nickname; the approval waits off the page, unanswered, and keeping on keeps the nickname', () => {
        const { onClosed, arrive } = besideApproval();
        ui.type('Mango');

        arrive();
        expect(discardQuestion.box()).not.toBeNull();
        expect(approval()).toBeNull();

        discardQuestion.keepEditing();
        expect(approval()).toBeNull();
        expect(ui.nickname().value).toBe('Mango');
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.log).toEqual([]);
      });

      it('is closed for the approval when nothing was changed, and saves nothing', () => {
        const { onClosed, arrive } = besideApproval();

        arrive();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.log).toEqual(['onClose']);
      });

      it('steps aside while a picture is being read, unasked and unclosed, and returns with the picture', () => {
        const { onClosed, arrive, leave } = besideApproval();
        const reader = ui.choosePicture();
        const window = own();

        arrive();
        expect(approval()).not.toBeNull();
        expect(own()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expect(discardQuestion.box()).toBeNull();
        expect(onClosed).not.toHaveBeenCalled();

        reader.finish(NEW_PICTURE);
        leave();

        expect(own()).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(ui.picture()).toHaveAttribute('src', NEW_PICTURE);
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.log).toEqual([]);
      });

      // A read that ended without a picture is over: the window, unchanged, is closed for the approval.
      it.each(['fail', 'abort'] as const)('is closed for the approval after the read of a picture ended with %s', (ending) => {
        const { onClosed, arrive } = besideApproval();
        const reader = ui.choosePicture();
        reader[ending]();

        arrive();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
      });
    });

    describe('a picture that cannot be read', () => {
      it('leaves the picture as it was, says nothing, and asks nothing on Escape', () => {
        useSettingsStore.setState({ userAvatar: OLD_PICTURE });
        const { onClose } = open();
        const reader = ui.choosePicture();

        reader.fail();

        expect(ui.picture()).toHaveAttribute('src', OLD_PICTURE);
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        ui.escape();
        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('does not end the read of a picture chosen after it', () => {
        const onAnswer = vi.fn();
        const onClose = vi.fn();
        const page = (approval: boolean) => (
          <>
            <ProfileEditModal open onClose={onClose} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
        const view = render(page(false));
        const first = ui.choosePicture();
        ui.choosePicture();
        first.fail();

        view.rerender(page(true));

        // The second read is still under way: the window steps aside for the approval.
        expect(windowBox(t().sidebar.editProfile)).toHaveAttribute('hidden');
        expect(onClose).not.toHaveBeenCalled();
      });
    });
  });
});
