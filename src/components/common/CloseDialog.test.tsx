// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import { Button } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import CloseDialog from './CloseDialog';

// Every callback of the question, with the order they were called in.
function answers() {
  const order: string[] = [];
  return {
    order,
    onQuit: vi.fn(() => { order.push('quit'); }),
    onMinimize: vi.fn(() => { order.push('minimize'); }),
    onCancel: vi.fn(() => { order.push('cancel'); }),
    onCloseActionChange: vi.fn((action: 'ask' | 'minimize' | 'quit') => { order.push(`remember:${action}`); }),
  };
}

type Answers = ReturnType<typeof answers>;

function Question({ open = true, running = false, on }: { open?: boolean; running?: boolean; on: Answers }) {
  return (
    <CloseDialog
      open={open}
      hasRunningAgent={running}
      onQuit={on.onQuit}
      onMinimize={on.onMinimize}
      onCancel={on.onCancel}
      onCloseActionChange={on.onCloseActionChange}
    />
  );
}

function renderQuestion(props: { open?: boolean; running?: boolean } = {}) {
  const on = answers();
  const view = render(<Question {...props} on={on} />, { wrapper: DesignSystemProvider });
  return { on, view, rerender: (next: { open?: boolean; running?: boolean }) => view.rerender(<Question {...next} on={on} />) };
}

const quit = () => screen.getByRole('button', { name: 'Quit' });
const minimize = () => screen.getByRole('button', { name: 'Minimize to Tray' });
const remember = () => screen.getByRole('checkbox', { name: 'Remember my choice' });
// The button in the corner of the question, and the dimmed area around it.
const cornerButton = () => screen.getByRole('button', { name: 'Close' });
function scrim(): HTMLElement {
  const element = document.querySelector<HTMLElement>('.bg-scrim');
  if (!element) throw new Error('The close-window question has no scrim');
  return element;
}

describe('CloseDialog', () => {
  beforeEach(() => { initLanguage('en-US'); });
  afterEach(() => { cleanup(); });

  describe('what each answer means', () => {
    it('renders nothing while it is not open', () => {
      renderQuestion({ open: false });
      expect(screen.queryByText('Close Window')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Quit' })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
    });

    it('asks the question in the words of the close-window copy', () => {
      renderQuestion();
      const t = getI18n();
      expect(screen.getByText(t.windowClose.title)).toBeInTheDocument();
      expect(screen.getByText(t.windowClose.message)).toBeInTheDocument();
    });

    it('quits on Quit, once, and remembers nothing', async () => {
      const { on } = renderQuestion();
      await userEvent.setup().click(quit());
      expect(on.order).toEqual(['quit']);
      expect(on.onCloseActionChange).not.toHaveBeenCalled();
    });

    it('minimizes on Minimize to Tray, once, and remembers nothing', async () => {
      const { on } = renderQuestion();
      await userEvent.setup().click(minimize());
      expect(on.order).toEqual(['minimize']);
      expect(on.onCloseActionChange).not.toHaveBeenCalled();
    });

    it('remembers quit first and then quits when the box is ticked', async () => {
      const user = userEvent.setup();
      const { on } = renderQuestion();
      await user.click(remember());
      expect(on.order).toEqual([]);
      await user.click(quit());
      expect(on.order).toEqual(['remember:quit', 'quit']);
    });

    it('remembers minimize first and then minimizes when the box is ticked', async () => {
      const user = userEvent.setup();
      const { on } = renderQuestion();
      await user.click(remember());
      await user.click(minimize());
      expect(on.order).toEqual(['remember:minimize', 'minimize']);
    });

    it('remembers nothing once the box is unticked again', async () => {
      const user = userEvent.setup();
      const { on } = renderQuestion();
      await user.click(remember());
      await user.click(remember());
      expect(remember()).not.toBeChecked();
      await user.click(minimize());
      expect(on.order).toEqual(['minimize']);
    });

    it('starts with the box unticked', () => {
      renderQuestion();
      expect(remember()).not.toBeChecked();
    });
  });

  describe('every way out other than the two buttons cancels', () => {
    it('cancels on Escape: no quit, no minimize, nothing remembered', async () => {
      const { on } = renderQuestion();
      await userEvent.setup().keyboard('{Escape}');
      expect(on.order).toEqual(['cancel']);
    });

    it('cancels from the button in the corner', async () => {
      const { on } = renderQuestion();
      await userEvent.setup().click(cornerButton());
      expect(on.order).toEqual(['cancel']);
    });

    it('cancels on a press on the area around it', async () => {
      const { on } = renderQuestion();
      await userEvent.setup().click(scrim());
      expect(on.order).toEqual(['cancel']);
    });

    it('does nothing on a press on the question itself', async () => {
      const { on } = renderQuestion();
      await userEvent.setup().click(screen.getByText(getI18n().windowClose.message));
      expect(on.order).toEqual([]);
    });

    it('remembers nothing on Escape even with the box ticked', async () => {
      const user = userEvent.setup();
      const { on } = renderQuestion();
      await user.click(remember());
      await user.keyboard('{Escape}');
      expect(on.order).toEqual(['cancel']);
      expect(on.onCloseActionChange).not.toHaveBeenCalled();
    });

    it('remembers nothing on a press around it or on the corner button with the box ticked', async () => {
      const user = userEvent.setup();
      const { on } = renderQuestion();
      await user.click(remember());
      await user.click(scrim());
      await user.click(cornerButton());
      expect(on.onCloseActionChange).not.toHaveBeenCalled();
      expect(on.onQuit).not.toHaveBeenCalled();
      expect(on.onMinimize).not.toHaveBeenCalled();
    });
  });

  describe('the warning about a running task', () => {
    it('shows it while a task is running', () => {
      renderQuestion({ running: true });
      expect(screen.getByText(getI18n().windowClose.agentRunningWarning)).toBeInTheDocument();
    });

    it('leaves it out otherwise', () => {
      renderQuestion();
      expect(screen.queryByText(getI18n().windowClose.agentRunningWarning)).toBeNull();
    });
  });

  // A question always opens unticked. (The hand-drawn question kept the tick across a cancel;
  // it opened with no focus, so nothing answered it by Enter. This one opens on a button.)
  describe('the tick across closing and asking again', () => {
    it.each([
      ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
      ['the corner button', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(cornerButton()); }],
      ['a press around it', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(scrim()); }],
    ] as const)('is gone after %s: asked again, the box is unticked and Enter minimizes without remembering', async (_name, cancel) => {
      const user = userEvent.setup();
      const on = answers();
      useAppQuestion.setState({ open: true });
      render(<AppLike on={on} />, { wrapper: DesignSystemProvider });
      await user.click(remember());
      expect(remember()).toBeChecked();

      await cancel(user);
      expect(on.order).toEqual(['cancel']);
      act(() => useAppQuestion.setState({ open: true }));
      expect(await screen.findByRole('checkbox', { name: 'Remember my choice' })).not.toBeChecked();
      await waitFor(() => expect(minimize()).toHaveFocus());
      await user.keyboard('{Enter}');
      expect(on.order).toEqual(['cancel', 'minimize']);
      expect(on.onCloseActionChange).not.toHaveBeenCalled();
    });

    it('is gone when the owner closes the question without an answer', async () => {
      const user = userEvent.setup();
      const { on, rerender } = renderQuestion();
      await user.click(remember());
      rerender({ open: false });
      expect(on.order).toEqual([]);

      rerender({ open: true });
      expect(await screen.findByRole('checkbox', { name: 'Remember my choice' })).not.toBeChecked();
      await user.click(quit());
      expect(on.order).toEqual(['quit']);
    });

    it('writes nothing while the question is closed and asked again without an answer', async () => {
      const user = userEvent.setup();
      const { on, rerender } = renderQuestion();
      await user.click(remember());
      rerender({ open: false });
      rerender({ open: true });
      rerender({ open: false });
      expect(on.order).toEqual([]);
    });
  });
});

const question = () => screen.getByRole('alertdialog', { name: 'Close Window' });

describe('CloseDialog as a design-system question', () => {
  beforeEach(() => { initLanguage('en-US'); });
  afterEach(() => { cleanup(); });

  it('is an alert dialog named by its title and described by its message', () => {
    renderQuestion();
    expect(question()).toHaveAttribute('data-ds-layer');
    expect(question()).toHaveAccessibleDescription(getI18n().windowClose.message);
  });

  it('keeps itself and its scrim out of the window drag lanes', () => {
    renderQuestion();
    expect(question()).toHaveAttribute('data-electron-no-drag');
    expect(scrim()).toHaveAttribute('data-electron-no-drag');
  });

  it('shows the warning about a running task as a status message with its shape', () => {
    renderQuestion({ running: true });
    const warning = within(question()).getByRole('status');
    expect(warning).toHaveTextContent(getI18n().windowClose.agentRunningWarning);
    expect(warning.querySelector('svg')).not.toBeNull();
  });

  it('opens with the focus on Minimize to Tray', () => {
    renderQuestion();
    expect(minimize()).toHaveFocus();
  });

  it.each([
    ['Enter', '{Enter}'],
    ['Space', ' '],
  ])('minimizes and never quits when %s is pressed as soon as it opens', async (_name, keys) => {
    const { on } = renderQuestion();
    await userEvent.setup().keyboard(keys);
    expect(on.order).toEqual(['minimize']);
  });

  it('has one filled button: Quit', () => {
    renderQuestion();
    expect(quit()).toHaveClass('bg-emphasis');
    expect(minimize()).not.toHaveClass('bg-emphasis');
  });

  it('reaches Quit by Tab, and quits there on Enter', async () => {
    const user = userEvent.setup();
    const { on } = renderQuestion();
    await user.tab();
    expect(quit()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(on.order).toEqual(['quit']);
  });

  it('walks Minimize, Quit, the corner button and the box with Tab, and stays inside', async () => {
    const user = userEvent.setup();
    renderQuestion();
    const stops: Array<string | null> = [];
    for (let i = 0; i < 4; i += 1) {
      await user.tab();
      const stop = document.activeElement;
      stops.push(stop?.getAttribute('role') === 'checkbox' ? 'the box' : stop?.getAttribute('aria-label') ?? stop?.textContent ?? null);
    }
    expect(stops).toEqual(['Quit', 'Close', 'the box', 'Minimize to Tray']);
    expect(question()).toContainElement(document.activeElement as HTMLElement);
  });

  it('names the box as a checkbox, ticks it with Space, and neither Enter nor the arrow keys tick it or answer', async () => {
    const user = userEvent.setup();
    const { on } = renderQuestion();
    remember().focus();
    await user.keyboard('{Enter}{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}');
    expect(remember()).toHaveAttribute('aria-checked', 'false');
    await user.keyboard(' ');
    expect(remember()).toHaveAttribute('aria-checked', 'true');
    expect(on.order).toEqual([]);
  });

  it('does not answer on the arrow keys while the focus is on a button', async () => {
    const { on } = renderQuestion();
    await userEvent.setup().keyboard('{ArrowRight}{ArrowDown}{ArrowLeft}{ArrowUp}{Home}{End}');
    expect(minimize()).toHaveFocus();
    expect(on.order).toEqual([]);
  });

  it('puts no word of the question into a title attribute', () => {
    renderQuestion({ running: true });
    expect(question().querySelectorAll('[title]')).toHaveLength(0);
  });
});

// The app's side of the question: every answer closes it. `open` lives in a store and follows
// the answers, the way `App` keeps it in the preview store.
const useAppQuestion = create(() => ({ open: true }));
function AppLike({ on }: { on: Answers }) {
  const { open } = useAppQuestion();
  const close = () => useAppQuestion.setState({ open: false });
  return (
    <CloseDialog
      open={open}
      hasRunningAgent={false}
      onQuit={() => { close(); on.onQuit(); }}
      onMinimize={() => { close(); on.onMinimize(); }}
      onCancel={() => { close(); on.onCancel(); }}
      onCloseActionChange={on.onCloseActionChange}
    />
  );
}

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

describe('CloseDialog while it fades out', () => {
  let styles: ReturnType<typeof keepClosingLayersOnScreen>;
  beforeEach(() => {
    initLanguage('en-US');
    useAppQuestion.setState({ open: true });
    styles = keepClosingLayersOnScreen();
  });
  afterEach(() => {
    styles.mockRestore();
    cleanup();
  });

  const fading = () => {
    const closing = document.querySelector<HTMLElement>('[role="alertdialog"][data-state="closed"]');
    if (!closing) throw new Error('The question is not fading out');
    return closing;
  };

  it('answers nothing more after Escape: a key on the button that still has the focus neither minimizes nor quits', async () => {
    const user = userEvent.setup();
    const on = answers();
    render(<AppLike on={on} />, { wrapper: DesignSystemProvider });
    await user.keyboard('{Escape}');
    expect(on.order).toEqual(['cancel']);
    expect(fading()).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(on.order).toEqual(['cancel']);
  });

  it('quits once: a second key on Quit while the question fades out does nothing', async () => {
    const user = userEvent.setup();
    const on = answers();
    render(<AppLike on={on} />, { wrapper: DesignSystemProvider });
    await user.click(remember());
    await user.tab();
    await user.tab();
    expect(quit()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(on.order).toEqual(['remember:quit', 'quit']);

    fading();
    await user.keyboard('{Enter}');
    expect(on.order).toEqual(['remember:quit', 'quit']);
  });

  it('minimizes once the same way', async () => {
    const user = userEvent.setup();
    const on = answers();
    render(<AppLike on={on} />, { wrapper: DesignSystemProvider });
    await user.keyboard('{Enter}');
    expect(on.order).toEqual(['minimize']);
    fading();
    await user.keyboard('{Enter}');
    expect(on.order).toEqual(['minimize']);
  });
});

// A stand-in for an approval of a task: an approval layer the tests open and close.
const useApproval = create(() => ({ open: false }));
const onApprovalAnswer = vi.fn();
function Approval() {
  const { open } = useApproval();
  return (
    <Dialog
      open={open}
      onOpenChange={onApprovalAnswer}
      layer="approval"
      role="alertdialog"
      outsidePress="ignore"
      title="Confirm Action"
      initialFocus={(content) => content.querySelector<HTMLElement>('[data-approval-cancel]')}
      footer={<><Button data-approval-cancel="">Cancel the command</Button><Button variant="primary">Run the command</Button></>}
    />
  );
}
// Found in the page, not through the accessibility tree: under the question, which is modal, the
// approval is out of that tree like everything else behind a modal layer.
const approval = () => Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"]'))
  .find((box) => box.querySelector('h2')?.textContent === 'Confirm Action') ?? null;

describe('CloseDialog and an approval', () => {
  beforeEach(() => {
    initLanguage('en-US');
    onApprovalAnswer.mockReset();
    useApproval.setState({ open: false });
  });
  afterEach(() => {
    cleanup();
    useApproval.setState({ open: false });
  });

  function renderBoth(questionOpen: boolean) {
    const on = answers();
    const view = render(
      <><Question open={questionOpen} on={on} /><Approval /></>,
      { wrapper: DesignSystemProvider },
    );
    return { on, ask: (open: boolean) => view.rerender(<><Question open={open} on={on} /><Approval /></>) };
  }

  describe('asked while the approval is on screen', () => {
    it('stacks over the approval: both are on the page and the approval is not answered', () => {
      useApproval.setState({ open: true });
      const { on, ask } = renderBoth(false);
      expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();

      ask(true);
      expect(Array.from(document.querySelectorAll('[role="alertdialog"]')).map((box) => box.querySelector('h2')?.textContent))
        .toEqual(['Confirm Action', 'Close Window']);
      // The question is the one in front: the only one a screen reader is given.
      expect(screen.getAllByRole('alertdialog')).toEqual([question()]);
      expect(approval()).not.toHaveAttribute('hidden');
      expect(question()).not.toHaveAttribute('hidden');
      expect(minimize()).toHaveFocus();
      expect(onApprovalAnswer).not.toHaveBeenCalled();
      expect(on.order).toEqual([]);
    });

    it('closes alone on one Escape; the approval stays, unanswered, and takes the next Escape', async () => {
      const user = userEvent.setup();
      useApproval.setState({ open: true });
      useAppQuestion.setState({ open: false });
      const on = answers();
      render(<><Approval /><AppLike on={on} /></>, { wrapper: DesignSystemProvider });
      act(() => useAppQuestion.setState({ open: true }));
      expect(question()).toBeInTheDocument();

      await user.keyboard('{Escape}');
      expect(on.order).toEqual(['cancel']);
      expect(screen.queryByRole('alertdialog', { name: 'Close Window' })).toBeNull();
      expect(approval()).toBeInTheDocument();
      expect(onApprovalAnswer).not.toHaveBeenCalled();
      // The focus is back on the button of the approval that refuses it.
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus());

      await user.keyboard('{Escape}');
      expect(onApprovalAnswer.mock.calls).toEqual([[false]]);
      expect(on.order).toEqual(['cancel']);
    });

    it.each([
      ['Minimize to Tray', 'minimize'],
      ['Quit', 'quit'],
    ] as const)('answers only the question from %s', async (name, answer) => {
      useApproval.setState({ open: true });
      const { on, ask } = renderBoth(false);
      ask(true);
      await userEvent.setup().click(screen.getByRole('button', { name }));
      expect(on.order).toEqual([answer]);
      expect(onApprovalAnswer).not.toHaveBeenCalled();
      expect(approval()).toBeInTheDocument();
    });

    it('is cancelled, not answered, when the approval is answered elsewhere while it is open', () => {
      useApproval.setState({ open: true });
      const { on, ask } = renderBoth(false);
      ask(true);
      // The approval leaves by its owner: an answer from a chat channel, or its own timeout.
      act(() => useApproval.setState({ open: false }));
      expect(on.order).toEqual(['cancel']);
    });
  });

  describe('open when the approval arrives', () => {
    it('steps aside unanswered with its tick, the approval takes the page, and it returns as it was once the approval is answered', async () => {
      const user = userEvent.setup();
      const { on } = renderBoth(true);
      await user.click(remember());
      const box = question();

      act(() => useApproval.setState({ open: true }));
      expect(approval()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();
      // Still in the page, hidden: not on screen and not in the accessibility tree.
      expect(box).toHaveAttribute('hidden');
      expect(screen.queryByRole('alertdialog', { name: 'Close Window' })).toBeNull();
      expect(on.order).toEqual([]);

      // One Escape answers the approval alone.
      await user.keyboard('{Escape}');
      expect(onApprovalAnswer.mock.calls).toEqual([[false]]);
      expect(on.order).toEqual([]);

      act(() => useApproval.setState({ open: false }));
      expect(question()).toBe(box);
      expect(box).not.toHaveAttribute('hidden');
      expect(remember()).toHaveAttribute('aria-checked', 'true');
      expect(on.order).toEqual([]);

      await user.click(quit());
      expect(on.order).toEqual(['remember:quit', 'quit']);
    });

    // The user had moved to Quit when the approval took the focus. Keys pressed for the approval
    // must not land on Quit the moment the question returns.
    it('returns with the focus on Minimize to Tray even when the focus was on Quit: Enter then minimizes', async () => {
      const user = userEvent.setup();
      const { on } = renderBoth(true);
      await user.tab();
      expect(quit()).toHaveFocus();

      act(() => useApproval.setState({ open: true }));
      expect(screen.getByRole('button', { name: 'Cancel the command' })).toHaveFocus();
      act(() => useApproval.setState({ open: false }));

      await waitFor(() => expect(minimize()).toHaveFocus());
      expect(quit()).not.toHaveFocus();
      await user.keyboard('{Enter}');
      expect(on.order).toEqual(['minimize']);
    });

    it('takes no key and no press while it stands aside', async () => {
      const user = userEvent.setup();
      const { on } = renderBoth(true);
      act(() => useApproval.setState({ open: true }));

      await user.keyboard('{Enter}');
      await user.keyboard(' ');
      expect(on.order).toEqual([]);
      expect(onApprovalAnswer).not.toHaveBeenCalled();
    });
  });
});
