// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useEffect, useState } from 'react';
import { act, fireEvent, render as renderTree, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_SETTLE_MS } from './styles';
import { APPROVAL_TITLE, approvalProbe, windowBox } from '@/test/dsWindows';
import { Button } from './button';
import { useConfirm, type Confirm } from './confirm-context';
import { ConfirmDialog } from './confirm-dialog';
import { Dialog } from './dialog';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';

const DELETE = { title: 'Delete this channel?', message: 'Messages already sent stay in the task.', confirmLabel: 'Delete', tone: 'danger' } as const;

let captured: Confirm | null = null;
function Capture({ onReady }: { onReady: (confirm: Confirm) => void }) {
  const confirm = useConfirm();
  useEffect(() => { onReady(confirm); }, [confirm, onReady]);
  return null;
}

function keep(confirm: Confirm) {
  captured = confirm;
}

function render(ui: 'provider' | 'bare') {
  captured = null;
  return renderTree(<Capture onReady={keep} />, ui === 'provider' ? { wrapper: DesignSystemProvider } : undefined);
}

function EditChannelDialog() {
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [answer, setAnswer] = useState('none');
  return (
    <>
      <Dialog trigger={<Button>Edit channel</Button>} title="Edit channel" dirty={name !== ''}>
        <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Button onClick={() => { void confirm(DELETE).then((confirmed) => setAnswer(String(confirmed))); }}>Delete channel</Button>
      </Dialog>
      <output>{`answer ${answer}`}</output>
    </>
  );
}

function ask(): Promise<boolean> {
  if (!captured) throw new Error('Capture did not render');
  let result!: Promise<boolean>;
  act(() => { result = captured!(DELETE); });
  return result;
}

describe('useConfirm', () => {
  it('shows an alert dialog with Cancel first and the specific action second', () => {
    render('provider');
    void ask();
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this channel?' });
    expect(dialog).toHaveTextContent('Messages already sent stay in the task.');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Delete']);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('text-danger');
  });

  it('resolves true on the action', async () => {
    const user = userEvent.setup();
    render('provider');
    const answer = ask();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false on Cancel and on Escape', async () => {
    const user = userEvent.setup();
    render('provider');
    const cancelled = ask();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(cancelled).resolves.toBe(false);
    const escaped = ask();
    await user.keyboard('{Escape}');
    await expect(escaped).resolves.toBe(false);
  });

  it('answers an earlier request with false when a new one replaces it', async () => {
    render('provider');
    const first = ask();
    void ask();
    await expect(first).resolves.toBe(false);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('shows over an open dialog with unsaved input and returns to it after the answer', async () => {
    const user = userEvent.setup();
    renderTree(<EditChannelDialog />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Edit channel' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'Delete channel' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog', { name: 'Discard these changes?' })).toBeNull();
    // Radix hides the dialog underneath from screen readers while the alert is up.
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('answer none')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('answer true')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit channel' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('draft');
  });

  it('answers a pending request with false when a dialog opens without a click', async () => {
    captured = null;
    const tree = (open: boolean) => (
      <>
        <Capture onReady={keep} />
        <Dialog open={open} onOpenChange={() => undefined} title="Shortcut dialog" />
      </>
    );
    const { rerender } = renderTree(tree(false), { wrapper: DesignSystemProvider });
    const answer = ask();
    let settled: boolean | 'pending' = 'pending';
    void answer.then((confirmed) => { settled = confirmed; });
    expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();
    rerender(tree(true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Shortcut dialog' })).toBeInTheDocument();
  });

  describe('asked while a dialog is open', () => {
    const page = (settings: 'open' | 'closed' | 'absent', other = false) => (
      <>
        <Capture onReady={keep} />
        {settings !== 'absent' && <Dialog open={settings === 'open'} onOpenChange={() => undefined} title="Settings" />}
        <Dialog open={other} onOpenChange={() => undefined} title="Approval" />
      </>
    );
    const track = (answer: Promise<boolean>) => {
      const state: { settled: boolean | 'pending' } = { settled: 'pending' };
      void answer.then((confirmed) => { state.settled = confirmed; });
      return state;
    };
    const flush = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    it('answers false and goes away when that dialog closes', async () => {
      captured = null;
      const { rerender } = renderTree(page('open'), { wrapper: DesignSystemProvider });
      const state = track(ask());
      expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();

      rerender(page('closed'));
      await flush();

      expect(state.settled).toBe(false);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('answers false and goes away when that dialog is taken off the page', async () => {
      captured = null;
      const { rerender } = renderTree(page('open'), { wrapper: DesignSystemProvider });
      const state = track(ask());

      rerender(page('absent'));
      await flush();

      expect(state.settled).toBe(false);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('answers false when another dialog replaces that dialog', async () => {
      captured = null;
      const { rerender } = renderTree(page('open'), { wrapper: DesignSystemProvider });
      const state = track(ask());

      rerender(page('open', true));
      await flush();

      expect(state.settled).toBe(false);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    // The newcomer is only held, and the user may still keep editing. The confirmation is cancelled
    // all the same: the discard question has to be the top layer for the user to decide.
    it('answers false when a new dialog arrives and is held by unsaved input in that dialog', async () => {
      const user = userEvent.setup();
      captured = null;
      const onApprovalChange = vi.fn();
      let requestApproval!: () => void;
      function Form() {
        const [approval, setApproval] = useState(false);
        useEffect(() => { requestApproval = () => setApproval(true); }, []);
        return (
          <>
            <Capture onReady={keep} />
            <Dialog open onOpenChange={() => undefined} title="Edit channel" dirty>
              <input aria-label="Name" defaultValue="draft" />
            </Dialog>
            <Dialog open={approval} onOpenChange={(next) => { onApprovalChange(next); setApproval(next); }} title="Approval" />
          </>
        );
      }
      renderTree(<Form />, { wrapper: DesignSystemProvider });
      const state = track(ask());
      expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();

      act(() => requestApproval());
      await flush();

      expect(state.settled).toBe(false);
      expect(screen.queryByRole('alertdialog', { name: 'Delete this channel?' })).toBeNull();
      expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
      expect(screen.queryByText('Approval')).toBeNull();
      expect(onApprovalChange).not.toHaveBeenCalled();
      // Keep editing: the form and what was typed stay, and only now is the newcomer refused.
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('draft');
      expect(onApprovalChange).toHaveBeenCalledOnce();
      expect(onApprovalChange).toHaveBeenCalledWith(false);
    });

    it('is asked again without the earlier dialog deciding its fate', async () => {
      const user = userEvent.setup();
      captured = null;
      const { rerender } = renderTree(page('open'), { wrapper: DesignSystemProvider });
      const first = track(ask());
      rerender(page('closed'));
      await flush();
      expect(first.settled).toBe(false);

      // Asked with no dialog open: nothing but its own buttons answers it.
      const second = ask();
      const state = track(second);
      rerender(page('absent'));
      await flush();
      expect(state.settled).toBe('pending');
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await expect(second).resolves.toBe(true);
    });
  });

  it('stays open when it was asked with no dialog open and the page around it changes', async () => {
    const user = userEvent.setup();
    captured = null;
    const tree = (extra: boolean) => (
      <>
        <Capture onReady={keep} />
        <Dialog open={false} onOpenChange={() => undefined} title="Settings" />
        {extra && <output>later</output>}
      </>
    );
    const { rerender } = renderTree(tree(false), { wrapper: DesignSystemProvider });
    const answer = ask();
    let settled: boolean | 'pending' = 'pending';
    void answer.then((confirmed) => { settled = confirmed; });

    rerender(tree(true));
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe('pending');
    expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(answer).resolves.toBe(true);
  });

  it('answers a pending request with false when the provider goes away', async () => {
    const { unmount } = render('provider');
    const answer = ask();
    let settled: boolean | 'pending' = 'pending';
    void answer.then((confirmed) => { settled = confirmed; });
    unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('shows a message given as an element inside the question', () => {
    render('provider');
    if (!captured) throw new Error('Capture did not render');
    const confirm = captured;
    act(() => {
      void confirm({
        title: 'Open this link?',
        message: <code data-testid="link-address">https://example.test/docs</code>,
        confirmLabel: 'Open',
      });
    });
    const question = screen.getByRole('alertdialog', { name: 'Open this link?' });
    expect(question).toContainElement(screen.getByTestId('link-address'));
    expect(screen.getByTestId('link-address')).toHaveTextContent('https://example.test/docs');
  });

  // happy-dom lays nothing out: the message is 882px tall in a box of 240px.
  function tallMessage() {
    const isMessage = (element: Element) => element.classList.contains('max-h-60');
    const scroll = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return isMessage(this) ? 882 : 0; });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return isMessage(this) ? 240 : 0; });
    return () => { scroll.mockRestore(); client.mockRestore(); };
  }
  const LONG_ADDRESS = `https://long.example.test/?q=${'x'.repeat(2000)}`;

  it('opens on Cancel when its message is too long for its box, and Tab reaches the message', async () => {
    const restore = tallMessage();
    const user = userEvent.setup();
    render('provider');
    if (!captured) throw new Error('Capture did not render');
    const confirm = captured;
    act(() => { void confirm({ title: 'Open this link?', message: <code data-testid="link-address">{LONG_ADDRESS}</code>, confirmLabel: 'Open' }); });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    const message = screen.getByRole('group', { name: 'Open this link?' });
    expect(message).toContainElement(screen.getByTestId('link-address'));
    await user.tab({ shift: true });
    expect(message).toHaveFocus();
    // Enter on the text answers nothing.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('alertdialog', { name: 'Open this link?' })).toBeInTheDocument();
    restore();
  });

  it('does the same for a question a page holds itself', async () => {
    const restore = tallMessage();
    const user = userEvent.setup();
    const onResult = vi.fn();
    renderTree(
      <ConfirmDialog open title="Open this link?" message={LONG_ADDRESS} confirmLabel="Open" onResult={onResult} />,
      { wrapper: DesignSystemProvider },
    );

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    const message = screen.getByRole('group', { name: 'Open this link?' });
    await user.tab({ shift: true });
    expect(message).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(onResult).not.toHaveBeenCalled();
    restore();
  });

  describe('a question that takes the place of another', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const answers: string[] = [];
    function askFor(name: string, title: string, confirmLabel: string) {
      if (!captured) throw new Error('Capture did not render');
      const confirm = captured;
      act(() => { void confirm({ title, confirmLabel, tone: 'danger' }).then((confirmed) => answers.push(`${name}:${confirmed}`)); });
    }
    const flush = () => act(async () => { await Promise.resolve(); });
    // What follows a window that left the page: its focus hand-back runs one timer tick later.
    const tick = () => act(() => { vi.advanceTimersByTime(20); });
    // A pointer press reports detail 1; a click raised by Enter or Space reports 0.
    const pointerPress = (name: string) => fireEvent.click(screen.getByRole('button', { name }), { detail: 1 });
    function Page() {
      return (
        <>
          <Button>Opener</Button>
          <Capture onReady={keep} />
        </>
      );
    }
    function setUp() {
      answers.length = 0;
      captured = null;
      renderTree(<Page />, { wrapper: DesignSystemProvider });
      screen.getByRole('button', { name: 'Opener' }).focus();
    }

    it('opens in a window of its own, on Cancel: Enter meant for the first answers the second with no', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      const first = screen.getByRole('alertdialog', { name: 'Delete one memory?' });
      // The user has moved to the confirming button of the first question.
      screen.getByRole('button', { name: 'Delete' }).focus();

      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();
      tick();

      const second = screen.getByRole('alertdialog', { name: 'Clear every memory?' });
      expect(second).not.toBe(first);
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
      const cancel = screen.getByRole('button', { name: 'Cancel' });
      expect(cancel).toHaveFocus();
      expect(answers).toEqual(['A:false']);

      // Enter on the control that has the focus.
      fireEvent.click(document.activeElement as HTMLElement, { detail: 0 });
      await flush();
      expect(answers).toEqual(['A:false', 'B:false']);
    });

    it('takes no pointer press on its buttons until it has settled, and then acts', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();

      // A press that was on its way to the first question's button lands on the second's.
      pointerPress('Clear all');
      pointerPress('Cancel');
      await flush();
      expect(screen.getByRole('alertdialog', { name: 'Clear every memory?' })).toBeInTheDocument();
      expect(answers).toEqual(['A:false']);
      // Nothing about the button says it is held back.
      expect(screen.getByRole('button', { name: 'Clear all' })).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear all' })).not.toHaveAttribute('aria-disabled');

      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
      pointerPress('Clear all');
      await flush();
      expect(answers).toEqual(['A:false', 'B:true']);
    });

    it('never holds the keyboard back: Enter on the confirming button the user moved to acts at once', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();

      fireEvent.click(screen.getByRole('button', { name: 'Clear all' }), { detail: 0 });
      await flush();
      expect(answers).toEqual(['A:false', 'B:true']);
    });

    it('acts at once on a pointer press when no question was there before it', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      pointerPress('Delete');
      await flush();
      expect(answers).toEqual(['A:true']);

      // The next question follows an answered one, not a question on screen: not held back either.
      askFor('B', 'Clear every memory?', 'Clear all');
      pointerPress('Clear all');
      await flush();
      expect(answers).toEqual(['A:true', 'B:true']);
    });

    it('answers nothing from a window whose question is no longer the current one', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      // B is asked from code: it is registered, and the page still shows A until the next draw.
      if (!captured) throw new Error('Capture did not render');
      void captured({ title: 'Clear every memory?', confirmLabel: 'Clear all', tone: 'danger' }).then((confirmed) => answers.push(`B:${confirmed}`));
      expect(screen.getByRole('alertdialog', { name: 'Delete one memory?' })).toBeInTheDocument();

      pointerPress('Delete');
      await flush();

      expect(answers).toEqual(['A:false']);
      expect(screen.getByRole('alertdialog', { name: 'Clear every memory?' })).toBeInTheDocument();
    });

    it('takes a second press on the confirming button in one step as nothing', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      const confirmButton = screen.getByRole('button', { name: 'Delete' });
      // React reports an error thrown in a handler to the window.
      const errors: string[] = [];
      const onError = (event: ErrorEvent) => { errors.push(event.message); event.preventDefault(); };
      window.addEventListener('error', onError);

      act(() => {
        fireEvent.click(confirmButton, { detail: 1 });
        fireEvent.click(confirmButton, { detail: 1 });
      });
      await flush();
      window.removeEventListener('error', onError);
      expect(errors).toEqual([]);
      expect(answers).toEqual(['A:true']);
    });

    it('drops a press that began before it had settled, wherever the press ends', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();
      const clearAll = screen.getByRole('button', { name: 'Clear all' });

      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 20); });
      fireEvent.pointerDown(clearAll);
      act(() => { vi.advanceTimersByTime(70); });
      fireEvent.click(clearAll, { detail: 1 });
      await flush();
      expect(answers).toEqual(['A:false']);

      // A press that begins once it has settled acts.
      fireEvent.pointerDown(clearAll);
      fireEvent.click(clearAll, { detail: 1 });
      await flush();
      expect(answers).toEqual(['A:false', 'B:true']);
    });

    it('leaves the focus to an approval that is showing when the last question is answered over it', async () => {
      function WithApproval() {
        const [shown, setShown] = useState(false);
        return (
          <>
            <Button>Opener</Button>
            <Button onClick={() => setShown(true)}>an approval arrives</Button>
            <Capture onReady={keep} />
            {approvalProbe(shown, () => undefined)}
          </>
        );
      }
      answers.length = 0;
      captured = null;
      renderTree(<WithApproval />, { wrapper: DesignSystemProvider });
      const opener = screen.getByRole('button', { name: 'Opener' });
      opener.focus();
      askFor('A', 'Delete one memory?', 'Delete');
      await flush();
      // The approval arrives: the question steps aside.
      act(() => { fireEvent.click(screen.getByRole('button', { name: 'an approval arrives', hidden: true })); });
      await flush();
      tick();
      const approval = windowBox(APPROVAL_TITLE)!;
      expect(approval).not.toBeNull();

      // A second question, asked from code, stacks over the approval and is answered there.
      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();
      tick();
      expect(answers).toEqual(['A:false']);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 0 });
      await flush();
      tick();

      expect(answers).toEqual(['A:false', 'B:false']);
      expect(windowBox(APPROVAL_TITLE)).not.toBeNull();
      expect(opener).not.toHaveFocus();
      expect(approval.contains(document.activeElement)).toBe(true);
    });

    it('keeps the place for a question that is asked right after an answer', async () => {
      setUp();
      askFor('C', 'Delete one memory?', 'Delete');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 0 });
      await flush();
      // Asked before the first window has handed the focus back.
      askFor('D', 'Clear every memory?', 'Clear all');
      await flush();
      tick();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 0 });
      await flush();
      tick();

      expect(answers).toEqual(['C:false', 'D:false']);
      expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus();
    });

    it('returns the focus to the control that had it before the first question, after the last answer', async () => {
      setUp();
      askFor('A', 'Delete one memory?', 'Delete');
      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();
      tick();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 0 });
      await flush();
      tick();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Opener' })).toHaveFocus();
    });

    it('returns the focus to that control while a popover is open: a popover is no window', async () => {
      // A popover that opens by itself and stays (a held voice transcript), here while the
      // second question is on the page.
      function WithPopover() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <Button>Opener</Button>
            <Button onClick={() => setOpen(true)}>a popover opens</Button>
            <Capture onReady={keep} />
            <Popover
              trigger={<Button>Transcript</Button>}
              open={open}
              onOpenChange={setOpen}
              onOpenAutoFocus={(event) => event.preventDefault()}
              staysOnOutsidePress
              label="Held transcript"
            >
              Held words
            </Popover>
          </>
        );
      }
      answers.length = 0;
      captured = null;
      renderTree(<WithPopover />, { wrapper: DesignSystemProvider });
      const opener = screen.getByRole('button', { name: 'Opener' });
      opener.focus();
      askFor('A', 'Delete one memory?', 'Delete');
      askFor('B', 'Clear every memory?', 'Clear all');
      await flush();
      tick();
      act(() => { fireEvent.click(screen.getByRole('button', { name: 'a popover opens', hidden: true })); });
      await flush();
      tick();
      const popover = screen.getByRole('dialog', { name: 'Held transcript', hidden: true });
      expect(popover).toHaveAttribute('data-state', 'open');
      expect(screen.getByRole('alertdialog', { name: 'Clear every memory?' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }), { detail: 0 });
      await flush();
      tick();

      expect(answers).toEqual(['A:false', 'B:false']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(popover).toHaveAttribute('data-state', 'open');
      expect(opener).toHaveFocus();
    });
  });

  it('fails fast outside DesignSystemProvider', () => {
    expect(() => render('bare')).toThrow(/DesignSystemProvider/);
  });
});
