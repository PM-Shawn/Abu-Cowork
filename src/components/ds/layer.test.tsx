// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { StrictMode, useLayoutEffect, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { getI18n } from '@/i18n';
import { Dialog } from './dialog';
import { LayerProvider, LayerScope } from './layer';
import { useLayer, useLayerContainer, useLayerRegistry, useOpenState, type LayerEntry, type LayerKind, type LayerRegistry } from './layer-context';
import { DesignSystemProvider } from './provider';
import { LAYER_FADE_MS } from './styles';

interface PendingDiscard { onDiscard: () => void; onKeep?: () => void }

function FakeLayer({ name, kind, dirty = false, busy = false, urgent = false, defaultOpen = false, onOpenChange, children }: {
  name: string;
  kind: LayerKind;
  dirty?: boolean;
  busy?: boolean;
  urgent?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}) {
  const [open, setOpenState] = useState(defaultOpen);
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    setOpenState(next);
  };
  const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
  const { id, held, onCloseAutoFocus } = useLayer(kind, open, setOpen, kind === 'dialog'
    ? {
        isDirty: () => dirty,
        isBusy: () => busy,
        // No fade: once it is not shown it is not on the page.
        isPainted: () => false,
        confirmDiscard: (onDiscard, onKeep) => {
          const pending = { onDiscard, onKeep };
          setPendingDiscard(pending);
          return () => setPendingDiscard((current) => (current === pending ? null : current));
        },
        escape: () => setOpen(false),
      }
    : undefined, urgent);
  const shown = open && !held;
  // This layer has no fade: it has left the page as soon as it is no longer shown or no longer
  // rendered, and says so the way a ds layer does once its fade has ended.
  useLayoutEffect(() => {
    if (!shown) onCloseAutoFocus(new Event('focus'));
    return () => onCloseAutoFocus(new Event('focus'));
  }, [shown, onCloseAutoFocus]);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>{`open ${name}`}</button>
      {shown && (
        <div data-testid={name}>
          <button type="button" onClick={() => setOpen(false)}>{`close ${name}`}</button>
          <LayerScope id={id}>{children}</LayerScope>
        </div>
      )}
      {pendingDiscard && (
        <>
          <button type="button" onClick={() => { setPendingDiscard(null); pendingDiscard.onDiscard(); }}>{`discard ${name}`}</button>
          <button type="button" onClick={() => { setPendingDiscard(null); pendingDiscard.onKeep?.(); }}>{`keep ${name}`}</button>
        </>
      )}
    </div>
  );
}

function ContainerProbe() {
  const container = useLayerContainer();
  return <span>{container ? container.id : 'body'}</span>;
}

function ContainerSwitch({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | undefined>(undefined);
  return (
    <LayerProvider container={container}>
      <button type="button" onClick={() => setContainer(document.createElement('div'))}>switch container</button>
      {children}
    </LayerProvider>
  );
}

function OpenStateProbe({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useOpenState(undefined, false, onOpenChange);
  return <button type="button" onClick={() => setOpen(!open)}>{open ? 'shown' : 'hidden'}</button>;
}

describe('LayerProvider', () => {
  it('keeps only one popover open', async () => {
    const user = userEvent.setup();
    render(<LayerProvider><FakeLayer name="a" kind="popover" /><FakeLayer name="b" kind="popover" /></LayerProvider>);
    await user.click(screen.getByText('open a'));
    await user.click(screen.getByText('open b'));
    expect(screen.queryByTestId('a')).toBeNull();
    expect(screen.getByTestId('b')).toBeInTheDocument();
  });

  it('leaves a parent popover open when a child opens inside it', async () => {
    const user = userEvent.setup();
    render(<LayerProvider><FakeLayer name="parent" kind="popover"><FakeLayer name="child" kind="popover" /></FakeLayer></LayerProvider>);
    await user.click(screen.getByText('open parent'));
    await user.click(screen.getByText('open child'));
    expect(screen.getByTestId('parent')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('leaves a child open when parent and child open in the same render', () => {
    render(
      <LayerProvider>
        <FakeLayer name="parent" kind="popover" defaultOpen>
          <FakeLayer name="child" kind="popover" defaultOpen />
        </FakeLayer>
      </LayerProvider>,
    );
    expect(screen.getByTestId('parent')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('leaves a popover inside a dialog open when both open in the same render', () => {
    render(
      <LayerProvider>
        <FakeLayer name="dialog" kind="dialog" defaultOpen>
          <FakeLayer name="select" kind="popover" defaultOpen />
        </FakeLayer>
      </LayerProvider>,
    );
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('select')).toBeInTheDocument();
  });

  it('keeps open parent and child layers open when the container changes', async () => {
    const user = userEvent.setup();
    render(
      <ContainerSwitch>
        <FakeLayer name="parent" kind="popover"><FakeLayer name="child" kind="popover" /></FakeLayer>
      </ContainerSwitch>,
    );
    await user.click(screen.getByText('open parent'));
    await user.click(screen.getByText('open child'));
    await user.click(screen.getByText('switch container'));
    expect(screen.getByTestId('parent')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('closes open popovers when a dialog opens, but not popovers inside that dialog', async () => {
    const user = userEvent.setup();
    render(
      <LayerProvider>
        <FakeLayer name="menu" kind="popover" />
        <FakeLayer name="dialog" kind="dialog"><FakeLayer name="select" kind="popover" /></FakeLayer>
      </LayerProvider>,
    );
    await user.click(screen.getByText('open menu'));
    await user.click(screen.getByText('open dialog'));
    expect(screen.queryByTestId('menu')).toBeNull();
    await user.click(screen.getByText('open select'));
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('select')).toBeInTheDocument();
  });

  it('keeps only one dialog open', async () => {
    const user = userEvent.setup();
    render(<LayerProvider><FakeLayer name="first" kind="dialog" /><FakeLayer name="second" kind="dialog" /></LayerProvider>);
    await user.click(screen.getByText('open first'));
    await user.click(screen.getByText('open second'));
    expect(screen.queryByTestId('first')).toBeNull();
    expect(screen.getByTestId('second')).toBeInTheDocument();
  });

  it('stacks an alert over an open dialog and closes popovers', async () => {
    const user = userEvent.setup();
    render(
      <LayerProvider>
        <FakeLayer name="dialog" kind="dialog" dirty />
        <FakeLayer name="menu" kind="popover" />
        <FakeLayer name="alert" kind="alert" />
      </LayerProvider>,
    );
    await user.click(screen.getByText('open dialog'));
    await user.click(screen.getByText('open menu'));
    await user.click(screen.getByText('open alert'));
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('alert')).toBeInTheDocument();
    expect(screen.queryByTestId('menu')).toBeNull();
    expect(screen.queryByText('discard dialog')).toBeNull();
  });

  it('closes an open alert when a dialog opens', async () => {
    const user = userEvent.setup();
    render(<LayerProvider><FakeLayer name="alert" kind="alert" /><FakeLayer name="dialog" kind="dialog" /></LayerProvider>);
    await user.click(screen.getByText('open alert'));
    await user.click(screen.getByText('open dialog'));
    expect(screen.queryByTestId('alert')).toBeNull();
    expect(screen.getByTestId('dialog')).toBeInTheDocument();
  });

  it('replaces an older alert with a new one', async () => {
    const user = userEvent.setup();
    render(<LayerProvider><FakeLayer name="older" kind="alert" /><FakeLayer name="newer" kind="alert" /></LayerProvider>);
    await user.click(screen.getByText('open older'));
    await user.click(screen.getByText('open newer'));
    expect(screen.queryByTestId('older')).toBeNull();
    expect(screen.getByTestId('newer')).toBeInTheDocument();
  });

  it('asks a dirty dialog to discard before another dialog replaces it', async () => {
    const user = userEvent.setup();
    render(<LayerProvider><FakeLayer name="draft" kind="dialog" dirty /><FakeLayer name="other" kind="dialog" /></LayerProvider>);
    await user.click(screen.getByText('open draft'));
    await user.click(screen.getByText('open other'));
    expect(screen.getByTestId('draft')).toBeInTheDocument();
    expect(screen.queryByTestId('other')).toBeNull();
    await user.click(screen.getByText('discard draft'));
    expect(screen.queryByTestId('draft')).toBeNull();
    expect(screen.getByTestId('other')).toBeInTheDocument();
  });

  describe('a new dialog facing a dialog with unsaved input', () => {
    function DraftAndOther({ onOther, withOther = true }: { onOther: (open: boolean) => void; withOther?: boolean }) {
      return (
        <LayerProvider>
          <FakeLayer name="draft" kind="dialog" dirty />
          {withOther && <FakeLayer name="other" kind="dialog" onOpenChange={onOther} />}
        </LayerProvider>
      );
    }

    it('is held: not shown, and not told to close, while the user decides', async () => {
      const user = userEvent.setup();
      const onOther = vi.fn();
      render(<DraftAndOther onOther={onOther} />);
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));

      expect(screen.getByText('discard draft')).toBeInTheDocument();
      expect(screen.getByTestId('draft')).toBeInTheDocument();
      expect(screen.queryByTestId('other')).toBeNull();
      expect(onOther.mock.calls).toEqual([[true]]);
    });

    it('opens after Discard, without ever being told to close', async () => {
      const user = userEvent.setup();
      const onOther = vi.fn();
      render(<DraftAndOther onOther={onOther} />);
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));
      await user.click(screen.getByText('discard draft'));

      expect(screen.queryByTestId('draft')).toBeNull();
      expect(screen.getByTestId('other')).toBeInTheDocument();
      expect(onOther.mock.calls).toEqual([[true]]);
    });

    it('is closed, once, when the user keeps editing', async () => {
      const user = userEvent.setup();
      const onOther = vi.fn();
      render(<DraftAndOther onOther={onOther} />);
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));
      await user.click(screen.getByText('keep draft'));

      expect(screen.getByTestId('draft')).toBeInTheDocument();
      expect(screen.queryByTestId('other')).toBeNull();
      expect(onOther.mock.calls).toEqual([[true], [false]]);
      // It was closed, not left hidden: it opens normally the next time.
      await user.click(screen.getByText('open other'));
      expect(screen.getByText('discard draft')).toBeInTheDocument();
    });

    it('opens when the dialog it waits for closes by itself, and the question goes', async () => {
      const user = userEvent.setup();
      const onOther = vi.fn();
      render(<DraftAndOther onOther={onOther} />);
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));
      await user.click(screen.getByText('close draft'));

      expect(screen.queryByTestId('draft')).toBeNull();
      expect(screen.queryByText('discard draft')).toBeNull();
      expect(screen.getByTestId('other')).toBeInTheDocument();
      expect(onOther.mock.calls).toEqual([[true]]);
    });

    it('withdraws the question when the held dialog goes away', async () => {
      const user = userEvent.setup();
      const onOther = vi.fn();
      const view = render(<DraftAndOther onOther={onOther} />);
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));
      expect(screen.getByText('discard draft')).toBeInTheDocument();

      view.rerender(<DraftAndOther onOther={onOther} withOther={false} />);

      expect(screen.queryByText('discard draft')).toBeNull();
      expect(screen.getByTestId('draft')).toBeInTheDocument();
    });

    it('closes an earlier held dialog when another one arrives, and holds the new one', async () => {
      const user = userEvent.setup();
      const onFirst = vi.fn();
      const onSecond = vi.fn();
      render(
        <LayerProvider>
          <FakeLayer name="draft" kind="dialog" dirty />
          <FakeLayer name="first" kind="dialog" onOpenChange={onFirst} />
          <FakeLayer name="second" kind="dialog" onOpenChange={onSecond} />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open first'));
      await user.click(screen.getByText('open second'));

      expect(onFirst.mock.calls).toEqual([[true], [false]]);
      expect(onSecond.mock.calls).toEqual([[true]]);
      expect(screen.queryByTestId('first')).toBeNull();
      expect(screen.queryByTestId('second')).toBeNull();

      await user.click(screen.getByText('discard draft'));
      expect(screen.queryByTestId('draft')).toBeNull();
      expect(screen.queryByTestId('first')).toBeNull();
      expect(screen.getByTestId('second')).toBeInTheDocument();
      expect(onSecond.mock.calls).toEqual([[true]]);
    });

    describe('when the unsaved input is in a dialog opened inside another', () => {
      function NestedDraftAndOther({ onOuter, onOther, onForm }: {
        onOuter: (open: boolean) => void;
        onOther: (open: boolean) => void;
        onForm?: (open: boolean) => void;
      }) {
        return (
          <LayerProvider>
            <FakeLayer name="outer" kind="dialog" onOpenChange={onOuter}>
              <FakeLayer name="form" kind="dialog" dirty onOpenChange={onForm} />
            </FakeLayer>
            <FakeLayer name="other" kind="dialog" onOpenChange={onOther} />
          </LayerProvider>
        );
      }

      it('asks on the inner dialog and leaves the outer one open', async () => {
        const user = userEvent.setup();
        const onOuter = vi.fn();
        const onOther = vi.fn();
        render(<NestedDraftAndOther onOuter={onOuter} onOther={onOther} />);
        await user.click(screen.getByText('open outer'));
        await user.click(screen.getByText('open form'));
        await user.click(screen.getByText('open other'));

        expect(screen.getByText('discard form')).toBeInTheDocument();
        expect(screen.queryByText('discard outer')).toBeNull();
        expect(screen.getByTestId('outer')).toBeInTheDocument();
        expect(screen.getByTestId('form')).toBeInTheDocument();
        expect(screen.queryByTestId('other')).toBeNull();
        expect(onOuter.mock.calls).toEqual([[true]]);
        expect(onOther.mock.calls).toEqual([[true]]);
      });

      it('closes the outer dialog on Discard and shows the new one, once', async () => {
        const user = userEvent.setup();
        const onOuter = vi.fn();
        const onOther = vi.fn();
        const onForm = vi.fn();
        render(<NestedDraftAndOther onOuter={onOuter} onOther={onOther} onForm={onForm} />);
        await user.click(screen.getByText('open outer'));
        await user.click(screen.getByText('open form'));
        await user.click(screen.getByText('open other'));
        await user.click(screen.getByText('discard form'));

        expect(screen.queryByTestId('outer')).toBeNull();
        expect(screen.queryByTestId('form')).toBeNull();
        expect(screen.getByTestId('other')).toBeInTheDocument();
        expect(screen.queryByText('discard form')).toBeNull();
        expect(onOuter.mock.calls).toEqual([[true], [false]]);
        expect(onOther.mock.calls).toEqual([[true]]);
        // The form inside the outer dialog is told to close with it.
        expect(onForm.mock.calls).toEqual([[true], [false]]);
      });

      it('keeps both dialogs and closes the new one when the user keeps editing', async () => {
        const user = userEvent.setup();
        const onOuter = vi.fn();
        const onOther = vi.fn();
        render(<NestedDraftAndOther onOuter={onOuter} onOther={onOther} />);
        await user.click(screen.getByText('open outer'));
        await user.click(screen.getByText('open form'));
        await user.click(screen.getByText('open other'));
        await user.click(screen.getByText('keep form'));

        expect(screen.getByTestId('outer')).toBeInTheDocument();
        expect(screen.getByTestId('form')).toBeInTheDocument();
        expect(onOuter.mock.calls).toEqual([[true]]);
        expect(onOther.mock.calls).toEqual([[true], [false]]);
      });
    });
  });

  describe('a dialog opened inside another dialog', () => {
    it('takes the alert asked over it along when it closes by itself, and leaves the outer dialog open', async () => {
      const user = userEvent.setup();
      const onAlert = vi.fn();
      render(
        <LayerProvider>
          <FakeLayer name="outer" kind="dialog"><FakeLayer name="inner" kind="dialog" /></FakeLayer>
          <FakeLayer name="alert" kind="alert" onOpenChange={onAlert} />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open outer'));
      await user.click(screen.getByText('open inner'));
      await user.click(screen.getByText('open alert'));
      expect(screen.getByTestId('alert')).toBeInTheDocument();

      await user.click(screen.getByText('close inner'));

      expect(screen.queryByTestId('inner')).toBeNull();
      expect(screen.queryByTestId('alert')).toBeNull();
      expect(screen.getByTestId('outer')).toBeInTheDocument();
      expect(onAlert.mock.calls).toEqual([[true], [false]]);
    });

    it('is told to close, once, when another dialog replaces the outer one', async () => {
      const user = userEvent.setup();
      const onInner = vi.fn();
      const onOther = vi.fn();
      render(
        <LayerProvider>
          <FakeLayer name="outer" kind="dialog"><FakeLayer name="inner" kind="dialog" onOpenChange={onInner} /></FakeLayer>
          <FakeLayer name="other" kind="dialog" onOpenChange={onOther} />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open outer'));
      await user.click(screen.getByText('open inner'));
      await user.click(screen.getByText('open other'));

      expect(screen.queryByTestId('outer')).toBeNull();
      expect(screen.queryByTestId('inner')).toBeNull();
      expect(screen.getByTestId('other')).toBeInTheDocument();
      expect(onInner.mock.calls).toEqual([[true], [false]]);
      expect(onOther.mock.calls).toEqual([[true]]);
    });
  });

  describe('reporting whether a dialog or an alert is open', () => {
    it('says so with the first dialog, stays quiet while an alert stacks over it, and says no when the last one leaves', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange}>
          <FakeLayer name="dialog" kind="dialog" />
          <FakeLayer name="alert" kind="alert" />
        </LayerProvider>,
      );
      expect(onModalChange.mock.calls).toEqual([[false]]);
      await user.click(screen.getByText('open dialog'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('open alert'));
      await user.click(screen.getByText('close alert'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close dialog'));
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    // The app shows one notification while the user is asked to decide; this is how it learns of it.
    it('says when an approval or a question is on the page, once per change, and not for a dialog', async () => {
      const user = userEvent.setup();
      const onDecisionChange = vi.fn();
      render(
        <LayerProvider onDecisionChange={onDecisionChange}>
          <FakeLayer name="dialog" kind="dialog" />
          <FakeLayer name="alert" kind="alert" />
          <FakeLayer name="approval" kind="approval" />
          <FakeLayer name="second" kind="approval" />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open dialog'));
      await user.click(screen.getByText('close dialog'));
      expect(onDecisionChange.mock.calls).toEqual([[false]]);
      await user.click(screen.getByText('open alert'));
      expect(onDecisionChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close alert'));
      expect(onDecisionChange.mock.calls).toEqual([[false], [true], [false]]);
      await user.click(screen.getByText('open approval'));
      expect(onDecisionChange.mock.calls).toEqual([[false], [true], [false], [true]]);
      // A second approval waits its turn and is shown when the first one leaves: still one report.
      await user.click(screen.getByText('open second'));
      await user.click(screen.getByText('close approval'));
      expect(onDecisionChange.mock.calls).toEqual([[false], [true], [false], [true]]);
      await user.click(screen.getByText('close second'));
      expect(onDecisionChange.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
    });

    it('counts an alert that is open by itself', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(<LayerProvider onModalChange={onModalChange}><FakeLayer name="alert" kind="alert" /></LayerProvider>);
      await user.click(screen.getByText('open alert'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close alert'));
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    it('never counts a menu or a popover', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange}>
          <FakeLayer name="menu" kind="popover" />
          <FakeLayer name="dialog" kind="dialog"><FakeLayer name="inner menu" kind="popover" /></FakeLayer>
        </LayerProvider>,
      );
      await user.click(screen.getByText('open menu'));
      await user.click(screen.getByText('close menu'));
      expect(onModalChange.mock.calls).toEqual([[false]]);

      // A menu inside a dialog comes and goes without a second report.
      await user.click(screen.getByText('open dialog'));
      await user.click(screen.getByText('open inner menu'));
      await user.click(screen.getByText('close inner menu'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    });

    it('stays yes while one dialog replaces another', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange}>
          <FakeLayer name="first" kind="dialog" />
          <FakeLayer name="second" kind="dialog" />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open first'));
      await user.click(screen.getByText('open second'));
      expect(screen.queryByTestId('first')).toBeNull();
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close second'));
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    it('says no when a dialog goes and takes the dialog opened inside it along', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange}>
          <FakeLayer name="outer" kind="dialog"><FakeLayer name="inner" kind="dialog" /></FakeLayer>
        </LayerProvider>,
      );
      await user.click(screen.getByText('open outer'));
      await user.click(screen.getByText('open inner'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close outer'));
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    it('stays yes for a held newcomer: while it waits, when it is shown, until it closes', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange}>
          <FakeLayer name="draft" kind="dialog" dirty />
          <FakeLayer name="other" kind="dialog" />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));
      expect(screen.queryByTestId('other')).toBeNull();
      await user.click(screen.getByText('discard draft'));
      expect(screen.getByTestId('other')).toBeInTheDocument();
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close other'));
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    it('says no when the held newcomer is turned away and the first dialog then closes', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange}>
          <FakeLayer name="draft" kind="dialog" dirty />
          <FakeLayer name="other" kind="dialog" />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open draft'));
      await user.click(screen.getByText('open other'));
      await user.click(screen.getByText('keep draft'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      await user.click(screen.getByText('close draft'));
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    // A provider that leaves reports nothing, so its listeners can be left on yes.
    it('tells both listeners on mount that nothing is open, then yes with the first layer', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      const onDecisionChange = vi.fn();
      const first = render(
        <LayerProvider onModalChange={onModalChange} onDecisionChange={onDecisionChange}>
          <FakeLayer name="approval" kind="approval" />
        </LayerProvider>,
      );
      await user.click(screen.getByText('open approval'));
      first.unmount();
      expect(onModalChange.mock.lastCall).toEqual([true]);
      expect(onDecisionChange.mock.lastCall).toEqual([true]);
      onModalChange.mockClear();
      onDecisionChange.mockClear();

      render(
        <LayerProvider onModalChange={onModalChange} onDecisionChange={onDecisionChange}>
          <FakeLayer name="alert" kind="alert" />
        </LayerProvider>,
      );
      expect(onModalChange.mock.calls).toEqual([[false]]);
      expect(onDecisionChange.mock.calls).toEqual([[false]]);
      await user.click(screen.getByText('open alert'));
      expect(onModalChange.mock.calls).toEqual([[false], [true]]);
      expect(onDecisionChange.mock.calls).toEqual([[false], [true]]);
    });

    it('reports a layer that is open when the provider mounts as open, and nothing before it', () => {
      const onModalChange = vi.fn();
      const onDecisionChange = vi.fn();
      render(
        <LayerProvider onModalChange={onModalChange} onDecisionChange={onDecisionChange}>
          <FakeLayer name="alert" kind="alert" defaultOpen />
        </LayerProvider>,
      );
      expect(onModalChange.mock.calls).toEqual([[true]]);
      expect(onDecisionChange.mock.calls).toEqual([[true]]);
    });

    it('leaves no listener on yes after a render error took the page away with a window open and the page was retried', async () => {
      const user = userEvent.setup();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const heard = { modal: false, decision: false };
      const page: { fails: boolean; render: () => void } = { fails: false, render: () => undefined };
      function Page() {
        const [open, setOpen] = useState(false);
        const [, setRevision] = useState(0);
        useLayoutEffect(() => { page.render = () => setRevision((revision) => revision + 1); }, []);
        if (page.fails) throw new Error('render failed');
        return (
          <>
            <button type="button" onClick={() => setOpen(true)}>open question</button>
            <Dialog open={open} onOpenChange={setOpen} role="alertdialog" title="Question" />
          </>
        );
      }
      try {
        render(
          <ErrorBoundary>
            <DesignSystemProvider
              onModalChange={(open) => { heard.modal = open; }}
              onDecisionChange={(asked) => { heard.decision = asked; }}
            >
              <Page />
            </DesignSystemProvider>
          </ErrorBoundary>,
        );
        await user.click(screen.getByText('open question'));
        expect(screen.getByRole('alertdialog')).toBeInTheDocument();
        expect(heard).toEqual({ modal: true, decision: true });

        page.fails = true;
        act(() => { page.render(); });
        expect(screen.queryByRole('alertdialog')).toBeNull();
        page.fails = false;
        fireEvent.click(screen.getByRole('button', { name: getI18n().common.retry }));

        expect(screen.getByText('open question')).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(heard).toEqual({ modal: false, decision: false });
      } finally {
        errors.mockRestore();
      }
    });
  });

  it('applies Escape to the layer opened inside another when both registered in one commit', async () => {
    const user = userEvent.setup();
    const parentChange = vi.fn();
    const childChange = vi.fn();
    function EscapeTop() {
      const registry = useLayerRegistry();
      return <button type="button" onClick={() => registry.escapeTop()}>escape top</button>;
    }
    render(
      <LayerProvider>
        <EscapeTop />
        {/* The child's effect runs first, so the child registers before its parent. */}
        <FakeLayer name="parent" kind="popover" defaultOpen onOpenChange={parentChange}>
          <FakeLayer name="child" kind="popover" defaultOpen onOpenChange={childChange} />
        </FakeLayer>
      </LayerProvider>,
    );
    await user.click(screen.getByText('escape top'));
    expect(childChange.mock.calls).toEqual([[false]]);
    expect(parentChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('child')).toBeNull();
    expect(screen.getByTestId('parent')).toBeInTheDocument();

    await user.click(screen.getByText('escape top'));
    expect(parentChange.mock.calls).toEqual([[false]]);
  });

  it('portals into the container it was given', () => {
    const container = document.createElement('div');
    container.id = 'preview-host';
    render(<LayerProvider container={container}><ContainerProbe /></LayerProvider>);
    expect(screen.getByText('preview-host')).toBeInTheDocument();
  });

  it('fails fast outside the provider', () => {
    expect(() => render(<ContainerProbe />)).toThrow(/DesignSystemProvider/);
  });
});

// A layer built by hand: every call the registry makes on it goes into one shared log, in order.
interface Spy {
  entry: LayerEntry;
  state: { dirty: boolean; busy: boolean; painted: boolean };
  // The discard question the registry asked on this layer, when one is pending.
  asked: () => PendingDiscard | null;
  confirmDiscard: ReturnType<typeof vi.fn>;
  // What the registry told this layer about being under another layer, in order.
  told: string[];
}

function spy(log: string[], name: string, kind: LayerKind, options: {
  ancestors?: string[];
  dirty?: boolean;
  busy?: boolean;
  urgent?: boolean;
} = {}): Spy {
  // `painted`: the layer's content is still on the page after it closed (it fades out).
  const state = { dirty: options.dirty ?? false, busy: options.busy ?? false, painted: false };
  let pending: PendingDiscard | null = null;
  const told: string[] = [];
  const confirmDiscard = vi.fn((onDiscard: () => void, onKeep?: () => void) => {
    log.push(`${name}.confirmDiscard`);
    const mine = { onDiscard, onKeep };
    pending = mine;
    return () => {
      log.push(`${name}.withdraw`);
      if (pending === mine) pending = null;
    };
  });
  const entry: LayerEntry = {
    id: name,
    kind,
    ancestors: options.ancestors ?? [],
    urgent: options.urgent ?? false,
    returnFocus: { current: null },
    close: () => { log.push(`${name}.close`); },
    escape: () => { log.push(`${name}.escape`); },
    hold: () => { log.push(`${name}.hold`); },
    release: () => { log.push(`${name}.release`); },
    focusTaken: () => { log.push(`${name}.focusTaken`); },
    isDirty: () => state.dirty,
    isBusy: () => state.busy,
    isPainted: () => state.painted,
    confirmDiscard,
    covered: () => { told.push('covered'); },
    uncovered: () => { told.push('uncovered'); },
  };
  return { entry, state, asked: () => pending, confirmDiscard, told };
}

function Grab({ onReady }: { onReady: (registry: LayerRegistry) => void }) {
  const registry = useLayerRegistry();
  useLayoutEffect(() => { onReady(registry); }, [registry, onReady]);
  return null;
}

function mountRegistry(onModalChange?: (open: boolean) => void) {
  const grabbed: { registry: LayerRegistry | null } = { registry: null };
  const onReady = (registry: LayerRegistry) => { grabbed.registry = registry; };
  const view = render(<LayerProvider onModalChange={onModalChange}><Grab onReady={onReady} /></LayerProvider>);
  if (!grabbed.registry) throw new Error('The registry did not render');
  return { registry: grabbed.registry, view };
}

const calls = (log: string[], name: string) => log.filter((line) => line.startsWith(`${name}.`));

describe('approval layers', () => {
  it('turns a new dialog away while an approval is on screen: held first, then closed', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'approval', 'approval').entry);
    registry.register(spy(log, 'search', 'dialog').entry);

    expect(log).toEqual(['search.hold', 'search.close']);
    // The approval is still the top layer.
    registry.escapeTop();
    expect(log).toEqual(['search.hold', 'search.close', 'approval.escape']);
  });

  describe('a busy dialog that arrives while an approval is on screen', () => {
    it('steps aside from the start, is never closed, and returns when the approval has left', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);

      expect(calls(log, 'login')).toEqual(['login.hold']);
      // The approval is still the top layer.
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('approval.escape');

      registry.unregister('approval');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('login.escape');
      expect(log).not.toContain('login.close');
      expect(log).not.toContain('approval.close');
    });

    it('returns after the last of two approvals', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'first', 'approval').entry);
      registry.register(spy(log, 'second', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);

      registry.unregister('first');
      expect(calls(log, 'second')).toEqual(['second.hold', 'second.release']);
      expect(calls(log, 'login')).toEqual(['login.hold']);

      registry.unregister('second');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      expect(log).not.toContain('login.close');
    });

    it('does not return when it left while it waited', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      registry.unregister('login');
      registry.unregister('approval');

      expect(calls(log, 'login')).toEqual(['login.hold']);
      registry.escapeTop();
      expect(log).not.toContain('login.escape');
    });

    it('steps aside the same way while an approval asks about unsaved input', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const draft = spy(log, 'draft', 'dialog', { dirty: true });
      registry.register(draft.entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);

      expect(calls(log, 'login')).toEqual(['login.hold']);
      expect(draft.asked()).not.toBeNull();
      expect(log).not.toContain('login.close');
    });

    it('is not counted as on the page while it waits', () => {
      const onModalChange = vi.fn();
      const log: string[] = [];
      const { registry } = mountRegistry(onModalChange);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      registry.unregister('login');
      registry.unregister('approval');
      registry.left('approval');
      expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    });

    it('takes the return target of the approval on screen when it has none of its own', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const opener = document.createElement('button');
      const approval = spy(log, 'approval', 'approval');
      approval.entry.returnFocus.current = opener;
      const login = spy(log, 'login', 'dialog', { busy: true });
      registry.register(approval.entry);
      registry.register(login.entry);
      expect(login.entry.returnFocus.current).toBe(opener);
    });

    it('still turns away a dialog that is not busy', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'search', 'dialog', { dirty: true }).entry);
      expect(calls(log, 'search')).toEqual(['search.hold', 'search.close']);
    });
  });

  // More than one window can be off the page for an approval: one that stepped aside when it
  // arrived, and busy ones that opened under it. They come back one at a time. A window that
  // comes back never takes the place of another window, nor of a question that is on the page.
  describe('several windows waiting to come back', () => {
    const closes = (log: string[]) => log.filter((line) => line.endsWith('.close'));

    it('brings back one of two busy dialogs that opened under an approval, and the other when that one has left', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'first', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'second', 'dialog', { busy: true }).entry);

      registry.unregister('approval');
      // The one that left last is shown; the other waits, held.
      expect(calls(log, 'second')).toEqual(['second.hold', 'second.release']);
      expect(calls(log, 'first')).toEqual(['first.hold']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('second.escape');

      registry.unregister('second');
      expect(calls(log, 'first')).toEqual(['first.hold', 'first.release']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('first.escape');
      expect(closes(log)).toEqual([]);
    });

    it('keeps the settings window and the form validating inside it aside while a busy sign-in that opened under the approval is on the page', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'settings', 'dialog').entry);
      registry.register(spy(log, 'provider', 'dialog', { ancestors: ['settings'], busy: true }).entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      expect(log).toEqual(['provider.hold', 'settings.hold', 'login.hold']);

      registry.unregister('approval');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      expect(calls(log, 'settings')).toEqual(['settings.hold']);
      expect(calls(log, 'provider')).toEqual(['provider.hold']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('login.escape');

      // The sign-in ends and its window closes: the group returns, the outer window first.
      registry.unregister('login');
      expect(calls(log, 'settings')).toEqual(['settings.hold', 'settings.release']);
      expect(calls(log, 'provider')).toEqual(['provider.hold', 'provider.release']);
      expect(log.indexOf('settings.release')).toBeLessThan(log.indexOf('provider.release'));
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('provider.escape');
      expect(closes(log)).toEqual([]);
    });

    it('does not replace the window that came back first when its work has ended meanwhile', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const second = spy(log, 'second', 'dialog', { busy: true });
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'first', 'dialog', { busy: true }).entry);
      registry.register(second.entry);
      second.state.busy = false;

      registry.unregister('approval');
      expect(calls(log, 'second')).toEqual(['second.hold', 'second.release']);
      expect(calls(log, 'first')).toEqual(['first.hold']);
      // Any later change leaves both as they are: a menu opens in the window on the page.
      registry.register(spy(log, 'menu', 'popover', { ancestors: ['second'] }).entry);
      expect(calls(log, 'first')).toEqual(['first.hold']);
      expect(closes(log)).toEqual([]);
    });

    it('keeps waiting when the user opens another window over the one that came back, and returns when that one closes', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'first', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'second', 'dialog', { busy: true }).entry);
      registry.unregister('approval');
      expect(calls(log, 'second')).toEqual(['second.hold', 'second.release']);

      // A window opened by the user replaces the one on the page, as any new window does.
      registry.register(spy(log, 'search', 'dialog').entry);
      expect(calls(log, 'second')).toContain('second.close');
      expect(calls(log, 'first')).toEqual(['first.hold']);
      expect(calls(log, 'search')).toEqual([]);

      registry.unregister('search');
      expect(calls(log, 'first')).toEqual(['first.hold', 'first.release']);
      expect(log).not.toContain('first.close');
      expect(log).not.toContain('search.close');
    });

    it('forgets a waiting window that its owner closes: it never comes back', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'first', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'second', 'dialog', { busy: true }).entry);
      registry.unregister('approval');
      registry.unregister('first');
      registry.unregister('second');

      expect(calls(log, 'first')).toEqual(['first.hold']);
      registry.escapeTop();
      expect(log.filter((line) => line.endsWith('.escape'))).toEqual([]);
      expect(closes(log)).toEqual([]);
    });

    it('steps aside again for the next approval and comes back after it, the window that left last first', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'first', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'second', 'dialog', { busy: true }).entry);
      registry.unregister('approval');
      registry.register(spy(log, 'later', 'approval').entry);
      expect(calls(log, 'second')).toEqual(['second.hold', 'second.release', 'second.hold']);
      expect(calls(log, 'first')).toEqual(['first.hold']);

      registry.unregister('later');
      expect(calls(log, 'second')).toEqual(['second.hold', 'second.release', 'second.hold', 'second.release']);
      expect(calls(log, 'first')).toEqual(['first.hold']);
      expect(closes(log)).toEqual([]);
    });

    it('brings a question about the page back first, and the busy dialog only once the question is answered', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'quit', 'alert').entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      expect(log).toEqual(['quit.hold', 'login.hold']);

      registry.unregister('approval');
      expect(calls(log, 'quit')).toEqual(['quit.hold', 'quit.release']);
      expect(calls(log, 'login')).toEqual(['login.hold']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('quit.escape');

      // The question is answered by its owner.
      registry.unregister('quit');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      expect(closes(log)).toEqual([]);
    });

    it('keeps a question aside with the window it was asked over, and brings both back together', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'install', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'question', 'alert').entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      expect(log).toEqual(['question.hold', 'install.hold', 'login.hold']);

      registry.unregister('approval');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      expect(calls(log, 'install')).toEqual(['install.hold']);
      expect(calls(log, 'question')).toEqual(['question.hold']);

      registry.unregister('login');
      expect(calls(log, 'install')).toEqual(['install.hold', 'install.release']);
      expect(calls(log, 'question')).toEqual(['question.hold', 'question.release']);
      expect(log.indexOf('install.release')).toBeLessThan(log.indexOf('question.release'));
      expect(closes(log)).toEqual([]);
      // The question still belongs to the window: it is answered with cancel when the window leaves.
      registry.unregister('install');
      expect(log[log.length - 1]).toBe('question.close');
    });

    // The user chose to keep the unsaved input, so the approval waits behind that dialog. A busy
    // dialog that opened meanwhile waits too: it is neither asked about nor closed.
    it('keeps a busy dialog waiting behind a dialog whose unsaved input the user kept, and brings it back after the approval', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const draft = spy(log, 'draft', 'dialog', { dirty: true });
      registry.register(draft.entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);

      draft.asked()?.onKeep?.();
      expect(draft.confirmDiscard).toHaveBeenCalledTimes(1);
      expect(calls(log, 'login')).toEqual(['login.hold']);
      expect(calls(log, 'approval')).toEqual(['approval.hold']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('draft.escape');

      // The form is saved and closes: the approval has its turn, the sign-in window after it.
      registry.unregister('draft');
      expect(calls(log, 'approval')).toEqual(['approval.hold', 'approval.release']);
      expect(calls(log, 'login')).toEqual(['login.hold']);
      registry.unregister('approval');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      expect(closes(log)).toEqual([]);
    });
  });

  it('holds a second approval and shows it when the first leaves; neither is closed', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'first', 'approval').entry);
    registry.register(spy(log, 'second', 'approval').entry);
    expect(log).toEqual(['second.hold']);

    registry.unregister('first');
    expect(calls(log, 'second')).toEqual(['second.hold', 'second.release']);
    registry.escapeTop();
    expect(log[log.length - 1]).toBe('second.escape');
    expect(log).not.toContain('first.close');
    expect(log).not.toContain('second.close');
  });

  it('closes an open dialog that holds nothing for an approval', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'settings', 'dialog').entry);
    registry.register(spy(log, 'approval', 'approval').entry);

    // The dialog is closed and told that the approval has the focus: its fade gives it to nobody.
    expect(log).toEqual(['settings.close', 'settings.focusTaken']);
    registry.escapeTop();
    expect(log[log.length - 1]).toBe('approval.escape');
  });

  describe('arriving at a dialog with unsaved input', () => {
    function arrive() {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const draft = spy(log, 'draft', 'dialog', { dirty: true });
      const approval = spy(log, 'approval', 'approval');
      registry.register(draft.entry);
      registry.register(approval.entry);
      return { log, registry, draft, approval };
    }

    it('is held while the dialog asks whether to discard', () => {
      const { log, registry } = arrive();
      expect(log).toEqual(['approval.hold', 'draft.confirmDiscard']);
      // The dialog is still the top layer.
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('draft.escape');
    });

    it('is shown after Discard, which closes the dialog', () => {
      const { log, registry, draft } = arrive();
      draft.asked()?.onDiscard();

      expect(calls(log, 'draft')).toContain('draft.close');
      expect(calls(log, 'approval')).toEqual(['approval.hold', 'approval.release']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('approval.escape');
    });

    it('stays held, and is not closed, when the user keeps editing; it is shown when the dialog leaves', () => {
      const { log, registry, draft } = arrive();
      draft.asked()?.onKeep?.();

      expect(calls(log, 'approval')).toEqual(['approval.hold']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('draft.escape');

      registry.unregister('draft');
      expect(calls(log, 'approval')).toEqual(['approval.hold', 'approval.release']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('approval.escape');
      expect(log).not.toContain('approval.close');
    });

    it('queues a second approval behind the first while the user keeps editing, without asking again', () => {
      const { log, registry, draft } = arrive();
      draft.asked()?.onKeep?.();
      registry.register(spy(log, 'later', 'approval').entry);

      expect(draft.confirmDiscard).toHaveBeenCalledTimes(1);
      expect(calls(log, 'later')).toEqual(['later.hold']);

      registry.unregister('draft');
      expect(calls(log, 'approval')).toEqual(['approval.hold', 'approval.release']);
      expect(calls(log, 'later')).toEqual(['later.hold']);
      registry.unregister('approval');
      expect(calls(log, 'later')).toEqual(['later.hold', 'later.release']);
    });

    it('turns a new dialog away while the question is on screen, and keeps asking for the approval', () => {
      const { log, registry, draft } = arrive();
      registry.register(spy(log, 'search', 'dialog').entry);

      expect(calls(log, 'search')).toEqual(['search.hold', 'search.close']);
      expect(draft.confirmDiscard).toHaveBeenCalledTimes(1);
      expect(draft.asked()).not.toBeNull();
      expect(calls(log, 'approval')).toEqual(['approval.hold']);
    });

    it('queues a second approval behind the one that is asking; both are shown in turn after Discard', () => {
      const { log, registry, draft } = arrive();
      registry.register(spy(log, 'later', 'approval').entry);
      expect(draft.confirmDiscard).toHaveBeenCalledTimes(1);
      expect(calls(log, 'later')).toEqual(['later.hold']);

      draft.asked()?.onDiscard();
      expect(calls(log, 'approval')).toEqual(['approval.hold', 'approval.release']);
      expect(calls(log, 'later')).toEqual(['later.hold']);
      registry.unregister('approval');
      expect(calls(log, 'later')).toEqual(['later.hold', 'later.release']);
    });

    it('takes its question back when it leaves by itself, and the dialog stays', () => {
      const { log, registry } = arrive();
      registry.unregister('approval');

      expect(log).toContain('draft.withdraw');
      expect(log).not.toContain('draft.close');
      expect(log).not.toContain('approval.close');
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('draft.escape');
    });
  });

  describe('arriving at a dialog whose work would be cancelled by closing it', () => {
    it('has the dialog step aside, neither closed nor asked, and brings it back when the approval leaves', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const login = spy(log, 'login', 'dialog', { busy: true, dirty: true });
      registry.register(login.entry);
      registry.register(spy(log, 'approval', 'approval').entry);

      expect(log).toEqual(['login.hold']);
      expect(login.confirmDiscard).not.toHaveBeenCalled();
      // A layer that stepped aside takes no Escape.
      registry.escapeTop();
      expect(log).toEqual(['login.hold', 'approval.escape']);

      registry.unregister('approval');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('login.escape');
      expect(log).not.toContain('login.close');
    });

    it('has the whole group step aside when the busy dialog is inside another: inner first, back outer first', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'settings', 'dialog').entry);
      registry.register(spy(log, 'provider', 'dialog', { ancestors: ['settings'], busy: true }).entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      expect(log).toEqual(['provider.hold', 'settings.hold']);

      registry.unregister('approval');
      // The approval hears, once, that another layer has the page.
      expect(log).toEqual(['provider.hold', 'settings.hold', 'settings.release', 'approval.focusTaken', 'provider.release']);
      registry.escapeTop();
      expect(log[log.length - 1]).toBe('provider.escape');
    });

    it('keeps a window that stepped aside off the page when the next approval in line is shown', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'first', 'approval').entry);
      registry.register(spy(log, 'second', 'approval').entry);

      registry.unregister('first');
      expect(calls(log, 'login')).toEqual(['login.hold']);
      registry.unregister('second');
      expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
    });

    it('does not bring back a window that was closed while it stood aside', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.unregister('login');
      registry.unregister('approval');

      expect(calls(log, 'login')).toEqual(['login.hold']);
      expect(log).not.toContain('approval.focusTaken');
      // Nothing is open: Escape finds no layer.
      registry.escapeTop();
      expect(log).toEqual(['login.hold']);
    });
  });

  describe('and questions', () => {
    it('has an open question step aside and brings it back, unanswered, when the approval leaves', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'question', 'alert').entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      expect(log).toEqual(['question.hold']);

      registry.unregister('approval');
      expect(log).toEqual(['question.hold', 'question.release', 'approval.focusTaken']);
      expect(log).not.toContain('question.close');
    });

    it('brings a question back after the busy window it was asked over', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'install', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'question', 'alert').entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      expect(log).toEqual(['question.hold', 'install.hold']);

      registry.unregister('approval');
      expect(log).toEqual(['question.hold', 'install.hold', 'install.release', 'approval.focusTaken', 'question.release']);
      // The question still belongs to the window: it is answered with cancel when the window leaves.
      registry.unregister('install');
      expect(log[log.length - 1]).toBe('question.close');
    });

    it('answers a question with cancel when the dialog it was asked over is closed for the approval', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'settings', 'dialog').entry);
      registry.register(spy(log, 'question', 'alert').entry);
      registry.register(spy(log, 'approval', 'approval').entry);

      expect(log).toEqual(['question.hold', 'question.close', 'settings.close', 'settings.focusTaken']);
      registry.unregister('approval');
      expect(log).not.toContain('question.release');
    });

    it('brings a question back when the user keeps editing the dialog it was asked over', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const draft = spy(log, 'draft', 'dialog', { dirty: true });
      registry.register(draft.entry);
      registry.register(spy(log, 'question', 'alert').entry);
      registry.register(spy(log, 'approval', 'approval').entry);
      expect(calls(log, 'question')).toEqual(['question.hold']);

      draft.asked()?.onKeep?.();
      expect(calls(log, 'question')).toEqual(['question.hold', 'question.release']);
      expect(calls(log, 'approval')).toEqual(['approval.hold']);
    });

    it('stacks a new question over the approval and answers it with cancel when the approval leaves', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'approval', 'approval').entry);
      registry.register(spy(log, 'quit', 'alert').entry);
      expect(log).toEqual([]);
      registry.escapeTop();
      expect(log).toEqual(['quit.escape']);

      registry.unregister('approval');
      expect(log).toEqual(['quit.escape', 'quit.close']);
    });
  });

  it('leaves a menu opened while an approval is on screen alone, and the approval too', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'approval', 'approval').entry);
    registry.register(spy(log, 'menu', 'popover').entry);
    expect(log).toEqual([]);
  });

  it('closes a dialog opened inside an approval when the approval leaves', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'setup', 'approval').entry);
    registry.register(spy(log, 'form', 'dialog', { ancestors: ['setup'] }).entry);
    expect(log).toEqual([]);

    registry.unregister('setup');
    expect(log).toEqual(['form.close']);
  });

  it('puts an urgent approval at the front of the line, and never in place of the one on screen', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'command', 'approval').entry);
    registry.register(spy(log, 'file', 'approval').entry);
    registry.register(spy(log, 'workspace', 'approval', { urgent: true }).entry);
    expect(log).toEqual(['file.hold', 'workspace.hold']);

    registry.unregister('command');
    expect(log).toEqual(['file.hold', 'workspace.hold', 'workspace.release', 'command.focusTaken']);
    registry.unregister('workspace');
    expect(calls(log, 'file')).toEqual(['file.hold', 'file.release']);
  });

  it('never shows nor releases an approval that left the line before its turn', () => {
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'first', 'approval').entry);
    registry.register(spy(log, 'second', 'approval').entry);
    registry.unregister('second');
    registry.unregister('first');
    registry.left('first');

    expect(calls(log, 'second')).toEqual(['second.hold']);
    expect(log).not.toContain('first.focusTaken');
    // Nothing is left on the page, and nothing takes Escape.
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    registry.escapeTop();
    expect(log).toEqual(['second.hold']);
  });

  describe('focus when a layer leaves as another is shown', () => {
    it('hands the return target of a dialog on to the approval that waited behind it, and marks the dialog', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const opener = document.createElement('button');
      const draft = spy(log, 'draft', 'dialog', { dirty: true });
      draft.entry.returnFocus.current = opener;
      const approval = spy(log, 'approval', 'approval');
      registry.register(draft.entry);
      registry.register(approval.entry);
      draft.asked()?.onKeep?.();
      expect(approval.entry.returnFocus.current).toBeNull();

      registry.unregister('draft');
      expect(approval.entry.returnFocus.current).toBe(opener);
      expect(log.slice(-2)).toEqual(['approval.release', 'draft.focusTaken']);
    });

    it('hands it on after Discard as well', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const opener = document.createElement('button');
      const draft = spy(log, 'draft', 'dialog', { dirty: true });
      draft.entry.returnFocus.current = opener;
      const approval = spy(log, 'approval', 'approval');
      registry.register(draft.entry);
      registry.register(approval.entry);
      draft.asked()?.onDiscard();
      expect(approval.entry.returnFocus.current).toBe(opener);
      expect(log).toContain('draft.focusTaken');
    });

    it('takes the target of the outer dialog when a dialog inside it leaves with it', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const opener = document.createElement('button');
      const inside = document.createElement('button');
      const outer = spy(log, 'outer', 'dialog');
      outer.entry.returnFocus.current = opener;
      const inner = spy(log, 'inner', 'dialog', { ancestors: ['outer'] });
      inner.entry.returnFocus.current = inside;
      const approval = spy(log, 'approval', 'approval');
      registry.register(outer.entry);
      registry.register(inner.entry);
      registry.register(approval.entry);
      expect(approval.entry.returnFocus.current).toBe(opener);
      expect(calls(log, 'outer')).toEqual(['outer.close', 'outer.focusTaken']);
      expect(calls(log, 'inner')).toEqual(['inner.close', 'inner.focusTaken']);
    });

    it('leaves a dialog that replaces another its own return target, and marks the one that leaves', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const first = spy(log, 'first', 'dialog');
      first.entry.returnFocus.current = document.createElement('button');
      const second = spy(log, 'second', 'dialog');
      registry.register(first.entry);
      registry.register(second.entry);
      expect(second.entry.returnFocus.current).toBeNull();
      expect(log).toEqual(['first.close', 'first.focusTaken']);
    });

    it('gives an approval the return target of the question that steps aside for it, and of the busy window first', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const asker = document.createElement('button');
      const question = spy(log, 'question', 'alert');
      question.entry.returnFocus.current = asker;
      const approval = spy(log, 'approval', 'approval');
      registry.register(question.entry);
      registry.register(approval.entry);
      expect(approval.entry.returnFocus.current).toBe(asker);
      registry.unregister('approval');
      registry.unregister('question');

      const opener = document.createElement('button');
      const install = spy(log, 'install', 'dialog', { busy: true });
      install.entry.returnFocus.current = opener;
      const over = spy(log, 'over', 'alert');
      over.entry.returnFocus.current = document.createElement('button');
      const next = spy(log, 'next', 'approval');
      registry.register(install.entry);
      registry.register(over.entry);
      registry.register(next.entry);
      expect(next.entry.returnFocus.current).toBe(opener);
    });

    it('marks nothing once the fade of the layer that left has ended', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      const first = spy(log, 'first', 'dialog');
      first.entry.returnFocus.current = document.createElement('button');
      const approval = spy(log, 'approval', 'approval');
      registry.register(first.entry);
      registry.unregister('first');
      registry.left('first');
      registry.register(approval.entry);
      expect(log).toEqual([]);
      expect(approval.entry.returnFocus.current).toBeNull();
    });
  });

  describe('focus when an approval leaves', () => {
    it('is marked as taken when the next approval in line is shown', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'first', 'approval').entry);
      registry.register(spy(log, 'second', 'approval').entry);
      registry.unregister('first');
      expect(log).toEqual(['second.hold', 'second.release', 'first.focusTaken']);
    });

    it('is left to the approval when no layer takes its place', () => {
      const log: string[] = [];
      const { registry } = mountRegistry();
      registry.register(spy(log, 'only', 'approval').entry);
      registry.unregister('only');
      expect(log).toEqual([]);
    });
  });

  it('keeps one copy of a layer that registers twice, and the window that stood aside for it stays aside', () => {
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    const approval = spy(log, 'approval', 'approval');
    registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
    registry.register(approval.entry);
    registry.register(approval.entry);

    expect(calls(log, 'login')).toEqual(['login.hold']);
    expect(log).not.toContain('approval.close');
    expect(log).not.toContain('approval.focusTaken');
    // One copy: Escape reaches it once, and once it has left nothing is on the page.
    registry.escapeTop();
    expect(log.filter((line) => line.endsWith('.escape'))).toEqual(['approval.escape']);
    registry.unregister('approval');
    registry.unregister('login');
    registry.left('approval');
    registry.left('login');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    registry.escapeTop();
    expect(log.filter((line) => line.endsWith('.escape'))).toEqual(['approval.escape']);
  });

  it('shows a new approval over one that registered and left in the same step, and brings the window back once', () => {
    // What StrictMode does to a layer that opens: register, unregister, register.
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
    registry.register(approval.entry);
    registry.unregister('approval');
    registry.register(approval.entry);

    expect(calls(log, 'login')).toEqual(['login.hold', 'login.release', 'login.hold']);
    registry.escapeTop();
    expect(log[log.length - 1]).toBe('approval.escape');
    expect(log).not.toContain('approval.close');
  });

  it('calls nothing on any layer when the provider goes away', () => {
    vi.useFakeTimers();
    try {
      const log: string[] = [];
      const onModalChange = vi.fn();
      const { registry, view } = mountRegistry(onModalChange);
      registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
      registry.register(spy(log, 'first', 'approval').entry);
      registry.register(spy(log, 'second', 'approval').entry);
      const before = [...log];
      onModalChange.mockClear();

      view.unmount();
      registry.unregister('first');
      registry.unregister('second');
      registry.unregister('login');
      vi.advanceTimersByTime(LAYER_FADE_MS * 2);

      expect(log).toEqual(before);
      expect(onModalChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // Every way a layer can arrive or leave, with an approval on screen, in line, and asking.
  it('never closes an approval, whatever arrives or leaves around it', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approvals = ['shown', 'queued', 'urgent', 'asking', 'kept', 'nested-owner'];
    const closed = () => log.filter((line) => line.endsWith('.close') && approvals.some((name) => line === `${name}.close`));

    // On screen, with every other kind arriving and leaving.
    registry.register(spy(log, 'shown', 'approval').entry);
    registry.register(spy(log, 'queued', 'approval').entry);
    registry.register(spy(log, 'urgent', 'approval', { urgent: true }).entry);
    registry.register(spy(log, 'dialog', 'dialog').entry);
    registry.register(spy(log, 'dirty', 'dialog', { dirty: true }).entry);
    registry.register(spy(log, 'busy', 'dialog', { busy: true }).entry);
    registry.register(spy(log, 'alert', 'alert').entry);
    registry.register(spy(log, 'other alert', 'alert').entry);
    registry.register(spy(log, 'menu', 'popover').entry);
    registry.register(spy(log, 'inner', 'dialog', { ancestors: ['shown'] }).entry);
    registry.register(spy(log, 'inner alert', 'alert', { ancestors: ['shown'] }).entry);
    registry.register(spy(log, 'shown', 'approval').entry);
    registry.unregister('other alert');
    registry.unregister('menu');
    registry.unregister('inner');
    registry.unregister('dialog');
    registry.unregister('queued');
    registry.unregister('shown');
    registry.left('shown');
    registry.unregister('urgent');
    expect(closed()).toEqual([]);

    // Asking over unsaved input: discard, keep, the dialog leaving, another dialog and another approval arriving.
    const draft = spy(log, 'draft', 'dialog', { dirty: true });
    registry.register(draft.entry);
    registry.register(spy(log, 'asking', 'approval').entry);
    registry.register(spy(log, 'search', 'dialog').entry);
    registry.register(spy(log, 'kept', 'approval').entry);
    registry.register(spy(log, 'confirm', 'alert').entry);
    draft.asked()?.onKeep?.();
    registry.register(spy(log, 'search', 'dialog').entry);
    registry.unregister('search');
    registry.register(spy(log, 'settings', 'dialog').entry);
    draft.asked()?.onDiscard();
    registry.unregister('asking');
    registry.unregister('kept');
    registry.unregister('settings');
    expect(closed()).toEqual([]);

    // Stepping aside and coming back around it.
    registry.register(spy(log, 'outer', 'dialog').entry);
    registry.register(spy(log, 'work', 'dialog', { ancestors: ['outer'], busy: true }).entry);
    registry.register(spy(log, 'question', 'alert').entry);
    registry.register(spy(log, 'nested-owner', 'approval').entry);
    registry.unregister('work');
    registry.unregister('outer');
    registry.unregister('nested-owner');
    expect(closed()).toEqual([]);
    expect(log.filter((line) => line.endsWith('.escape'))).toEqual([]);
  });
});

describe('approval layers on the page', () => {
  it('shows a dialog that an approval turned away the next time it is opened', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <LayerProvider>
        <FakeLayer name="approval" kind="approval" />
        <FakeLayer name="search" kind="dialog" onOpenChange={onSearch} />
      </LayerProvider>,
    );
    await user.click(screen.getByText('open approval'));
    await user.click(screen.getByText('open search'));
    expect(screen.getByTestId('approval')).toBeInTheDocument();
    expect(screen.queryByTestId('search')).toBeNull();
    expect(onSearch.mock.calls).toEqual([[true], [false]]);

    await user.click(screen.getByText('close approval'));
    await user.click(screen.getByText('open search'));
    expect(screen.getByTestId('search')).toBeInTheDocument();
  });

  function watchFor(testId: string) {
    let seen = false;
    const check = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.dataset.testid === testId || node.querySelector(`[data-testid="${testId}"]`)) seen = true;
        }
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      check(observer.takeRecords());
      observer.disconnect();
      return seen;
    };
  }

  function Approvals({ which, strict = false }: { which: 'none' | 'command' | 'workspace'; strict?: boolean }) {
    const tree = (
      <LayerProvider>
        <FakeLayer name="login" kind="dialog" busy defaultOpen />
        {which === 'command' && <FakeLayer key="command" name="command" kind="approval" defaultOpen />}
        {which === 'workspace' && <FakeLayer key="workspace" name="workspace" kind="approval" defaultOpen />}
      </LayerProvider>
    );
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  }

  it('keeps a window that stepped aside off the page when another approval replaces the one on screen in one render', () => {
    const view = render(<Approvals which="none" />);
    expect(screen.getByTestId('login')).toBeInTheDocument();
    view.rerender(<Approvals which="command" />);
    expect(screen.queryByTestId('login')).toBeNull();

    const sawLogin = watchFor('login');
    view.rerender(<Approvals which="workspace" />);
    expect(sawLogin()).toBe(false);
    expect(screen.queryByTestId('login')).toBeNull();
    expect(screen.getByTestId('workspace')).toBeInTheDocument();

    view.rerender(<Approvals which="none" />);
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });

  it('keeps a window that stepped aside off the page while an approval registers twice under StrictMode', () => {
    const view = render(<Approvals which="none" strict />);
    expect(screen.getByTestId('login')).toBeInTheDocument();

    view.rerender(<Approvals which="command" strict />);
    expect(screen.queryByTestId('login')).toBeNull();
    const sawLogin = watchFor('login');
    view.rerender(<Approvals which="workspace" strict />);
    expect(sawLogin()).toBe(false);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();

    view.rerender(<Approvals which="none" strict />);
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });

  it('shows one of two busy windows that opened under an approval, then the other; neither is told to close', () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <LayerProvider>
        <FakeLayer name="approval" kind="approval" defaultOpen />
        <FakeLayer name="first" kind="dialog" busy onOpenChange={onFirst} />
        <FakeLayer name="second" kind="dialog" busy onOpenChange={onSecond} />
      </LayerProvider>,
    );
    act(() => { screen.getByText('open first').click(); });
    act(() => { screen.getByText('open second').click(); });
    expect(screen.queryByTestId('first')).toBeNull();
    expect(screen.queryByTestId('second')).toBeNull();

    act(() => { screen.getByText('close approval').click(); });
    expect(screen.getByTestId('second')).toBeInTheDocument();
    expect(screen.queryByTestId('first')).toBeNull();

    act(() => { screen.getByText('close second').click(); });
    expect(screen.getByTestId('first')).toBeInTheDocument();
    expect(onFirst.mock.calls).toEqual([[true]]);
    expect(onSecond.mock.calls).toEqual([[true], [false]]);
  });

  it('shows queued approvals one at a time, the urgent one first', () => {
    function Queue({ shown }: { shown: boolean }) {
      return (
        <LayerProvider>
          {shown && <FakeLayer name="command" kind="approval" defaultOpen />}
          <FakeLayer name="file" kind="approval" />
          <FakeLayer name="workspace" kind="approval" urgent />
        </LayerProvider>
      );
    }
    const view = render(<Queue shown />);
    act(() => { screen.getByText('open file').click(); });
    act(() => { screen.getByText('open workspace').click(); });
    expect(screen.getByTestId('command')).toBeInTheDocument();
    expect(screen.queryByTestId('file')).toBeNull();
    expect(screen.queryByTestId('workspace')).toBeNull();

    view.rerender(<Queue shown={false} />);
    expect(screen.getByTestId('workspace')).toBeInTheDocument();
    expect(screen.queryByTestId('file')).toBeNull();
    act(() => { screen.getByText('close workspace').click(); });
    expect(screen.getByTestId('file')).toBeInTheDocument();
  });
});

describe('telling when the last dialog has left the page', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('says yes when a dialog registers, and no only once it has left the page', () => {
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'dialog', 'dialog').entry);
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);

    registry.unregister('dialog');
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    registry.left('dialog');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('says no one fade after a dialog unregistered when nothing reports that it left', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'dialog', 'dialog').entry);
    registry.unregister('dialog');

    vi.advanceTimersByTime(LAYER_FADE_MS - 1);
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    vi.advanceTimersByTime(1);
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('says no once, after the second of two dialogs has left the page', () => {
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'outer', 'dialog').entry);
    registry.register(spy(log, 'inner', 'dialog', { ancestors: ['outer'] }).entry);
    registry.unregister('inner');
    registry.unregister('outer');
    registry.left('outer');
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    registry.left('inner');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('stays yes when a dialog opens again before its fade has ended, and the old timer is dropped', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    const dialog = spy(log, 'dialog', 'dialog');
    registry.register(dialog.entry);
    registry.unregister('dialog');
    vi.advanceTimersByTime(LAYER_FADE_MS / 2);
    registry.register(dialog.entry);
    vi.advanceTimersByTime(LAYER_FADE_MS);
    registry.left('dialog');
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
  });

  it('counts an approval, and a window that steps aside until it has left the page', () => {
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
    registry.register(spy(log, 'approval', 'approval').entry);
    registry.left('login');
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);

    registry.unregister('approval');
    registry.left('approval');
    // The window is back.
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    registry.unregister('login');
    registry.left('login');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('never counts an approval that waits in line', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'first', 'approval').entry);
    registry.register(spy(log, 'second', 'approval').entry);
    registry.unregister('second');
    registry.unregister('first');
    registry.left('first');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    vi.advanceTimersByTime(LAYER_FADE_MS * 2);
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
  });

  // On a busy main thread a fade ends later than its nominal length. The timer never says a
  // layer has left while its content is still on the page: what is under it would show through.
  it('keeps saying yes after one fade while the content is still on the page, and says no once it has gone', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    const dialog = spy(log, 'dialog', 'dialog');
    registry.register(dialog.entry);
    dialog.state.painted = true;
    registry.unregister('dialog');

    vi.advanceTimersByTime(LAYER_FADE_MS);
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    vi.advanceTimersByTime(LAYER_FADE_MS * 2);
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);

    // The content has gone and nothing reported it (its owner left the page).
    dialog.state.painted = false;
    vi.advanceTimersByTime(LAYER_FADE_MS);
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says no when the fade reports its end, however late, and looks no more', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    const dialog = spy(log, 'dialog', 'dialog');
    registry.register(dialog.entry);
    dialog.state.painted = true;
    registry.unregister('dialog');

    vi.advanceTimersByTime(LAYER_FADE_MS * 2 + 113);
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    dialog.state.painted = false;
    registry.left('dialog');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops every timer when the provider goes away, also one that waits for content to leave', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry, view } = mountRegistry(onModalChange);
    const fading = spy(log, 'fading', 'dialog');
    const gone = spy(log, 'gone', 'dialog');
    registry.register(fading.entry);
    fading.state.painted = true;
    registry.unregister('fading');
    registry.register(gone.entry);
    registry.unregister('gone');
    // One timer has fired and armed itself again; the other is still pending.
    vi.advanceTimersByTime(LAYER_FADE_MS / 2);
    expect(vi.getTimerCount()).toBe(2);
    vi.advanceTimersByTime(LAYER_FADE_MS / 2);
    expect(vi.getTimerCount()).toBe(1);
    onModalChange.mockClear();

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    fading.state.painted = false;
    vi.advanceTimersByTime(LAYER_FADE_MS * 4);
    expect(onModalChange).not.toHaveBeenCalled();
  });
});

// What content that is not the user's asks before it takes the window.
describe('telling whether the user has something open or due', () => {
  it('is free on an empty page and with a menu or a popover open', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    expect(registry.isOccupied()).toBe(false);
    registry.register(spy(log, 'menu', 'popover').entry);
    expect(registry.isOccupied()).toBe(false);
  });

  it.each(['dialog', 'alert', 'approval'] as const)('is occupied while a %s is shown, and free once it has been taken off', (kind) => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'shown', kind).entry);
    expect(registry.isOccupied()).toBe(true);
    registry.unregister('shown');
    // A layer that only fades out no longer counts.
    expect(registry.isOccupied()).toBe(false);
    expect(log).toEqual([]);
  });

  it('is occupied while an approval waits its turn', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'first', 'approval').entry);
    registry.register(spy(log, 'second', 'approval').entry);
    registry.unregister('first');
    // The second one is shown now.
    expect(registry.isOccupied()).toBe(true);
    registry.unregister('second');
    expect(registry.isOccupied()).toBe(false);
  });

  it('is occupied while a busy window has stepped aside, with the approval gone or not', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    registry.register(spy(log, 'login', 'dialog', { busy: true }).entry);
    registry.register(spy(log, 'approval', 'approval').entry);
    expect(calls(log, 'login')).toEqual(['login.hold']);
    expect(registry.isOccupied()).toBe(true);
    registry.unregister('approval');
    // The window is back.
    expect(calls(log, 'login')).toEqual(['login.hold', 'login.release']);
    expect(registry.isOccupied()).toBe(true);
    registry.unregister('login');
    expect(registry.isOccupied()).toBe(false);
  });

  it('is occupied while an approval waits behind a window the user chose to keep editing', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const form = spy(log, 'form', 'dialog', { dirty: true });
    registry.register(form.entry);
    registry.register(spy(log, 'approval', 'approval').entry);
    // The form asks about its input; the approval waits behind the question.
    expect(registry.isOccupied()).toBe(true);
    form.asked()?.onKeep?.();
    expect(registry.isOccupied()).toBe(true);
    registry.unregister('form');
    // The approval is shown.
    expect(registry.isOccupied()).toBe(true);
    registry.unregister('approval');
    expect(registry.isOccupied()).toBe(false);
  });

  it('changes nothing by being asked', () => {
    const log: string[] = [];
    const onModalChange = vi.fn();
    const { registry } = mountRegistry(onModalChange);
    registry.register(spy(log, 'window', 'dialog').entry);
    onModalChange.mockClear();
    registry.isOccupied();
    registry.isOccupied();
    expect(log).toEqual([]);
    expect(onModalChange).not.toHaveBeenCalled();
  });
});

// An approval takes no pointer press while another layer is over it, nor for a moment after that
// layer has left. The registry is the one that knows both moments.
describe('telling an approval that another layer is over it', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('says so when a question is asked over it, and says it is uncovered once that question has left the page', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(approval.entry);
    expect(approval.told).toEqual([]);

    registry.register(spy(log, 'question', 'alert').entry);
    expect(approval.told).toEqual(['covered']);
    // Answered: the question is no longer shown, and still on the page while it fades out.
    registry.unregister('question');
    expect(approval.told).toEqual(['covered']);
    registry.left('question');
    expect(approval.told).toEqual(['covered', 'uncovered']);
  });

  it('says it is uncovered one fade after the question closed when nothing reports that it left', () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(approval.entry);
    registry.register(spy(log, 'question', 'alert').entry);
    registry.unregister('question');
    vi.advanceTimersByTime(LAYER_FADE_MS - 1);
    expect(approval.told).toEqual(['covered']);
    vi.advanceTimersByTime(1);
    expect(approval.told).toEqual(['covered', 'uncovered']);
  });

  it('says the same for a window opened inside the approval', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(approval.entry);
    registry.register(spy(log, 'sites', 'dialog', { ancestors: ['approval'] }).entry);
    expect(approval.told).toEqual(['covered']);
    registry.unregister('sites');
    registry.left('sites');
    expect(approval.told).toEqual(['covered', 'uncovered']);
    expect(log).toEqual([]);
  });

  it('counts a window that registered before the approval it is inside: effects run child-first', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(spy(log, 'sites', 'dialog', { ancestors: ['approval'] }).entry);
    registry.register(approval.entry);
    expect(approval.told).toEqual(['covered']);
    registry.unregister('sites');
    registry.left('sites');
    expect(approval.told).toEqual(['covered', 'uncovered']);
  });

  it('says it is uncovered only when the last layer over it has left: a question over a window inside it', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(approval.entry);
    registry.register(spy(log, 'sites', 'dialog', { ancestors: ['approval'] }).entry);
    registry.register(spy(log, 'question', 'alert').entry);
    expect(approval.told).not.toContain('uncovered');

    // The window closes, and the question asked over it with it; the window reports first.
    registry.unregister('sites');
    expect(log).toEqual(['question.close']);
    registry.left('sites');
    expect(approval.told).not.toContain('uncovered');
    registry.left('question');
    expect(approval.told.filter((word) => word === 'uncovered')).toHaveLength(1);
    expect(approval.told[approval.told.length - 1]).toBe('uncovered');
  });

  it('keeps it covered while a newer question takes the place of the one over it, and says uncovered once', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(approval.entry);
    registry.register(spy(log, 'first', 'alert').entry);
    registry.register(spy(log, 'second', 'alert').entry);
    expect(log).toContain('first.close');
    registry.left('first');
    expect(approval.told).not.toContain('uncovered');
    registry.unregister('second');
    registry.left('second');
    expect(approval.told.filter((word) => word === 'uncovered')).toHaveLength(1);
  });

  it('does not say uncovered for a question that is shown again before it reported that it left', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    const question = spy(log, 'question', 'alert');
    registry.register(approval.entry);
    registry.register(question.entry);
    registry.unregister('question');
    registry.register(question.entry);
    registry.left('question');
    expect(approval.told).not.toContain('uncovered');
    registry.unregister('question');
    registry.left('question');
    expect(approval.told.filter((word) => word === 'uncovered')).toHaveLength(1);
  });

  it('says nothing to a window: a question over a window that is no approval', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const settings = spy(log, 'settings', 'dialog');
    registry.register(settings.entry);
    registry.register(spy(log, 'question', 'alert').entry);
    registry.unregister('question');
    registry.left('question');
    expect(settings.told).toEqual([]);
  });

  it('says nothing to an approval that waits its turn: the question is over the one on the page', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const shown = spy(log, 'shown', 'approval');
    const waiting = spy(log, 'waiting', 'approval');
    registry.register(shown.entry);
    registry.register(waiting.entry);
    registry.register(spy(log, 'question', 'alert').entry);
    expect(shown.told).toEqual(['covered']);
    expect(waiting.told).toEqual([]);
  });

  it('says nothing more when the question leaves the page after the approval it was asked over', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    const next = spy(log, 'next', 'approval');
    registry.register(approval.entry);
    registry.register(next.entry);
    registry.register(spy(log, 'question', 'alert').entry);
    // The approval is answered: the question is cancelled with it, and the next approval is shown.
    registry.unregister('approval');
    const toldAsItLeft = [...approval.told];
    registry.left('question');
    expect(approval.told).toEqual(toldAsItLeft);
    // The approval that follows was never under that question.
    expect(next.told).toEqual([]);
  });

  it('tells an approval that leaves the page while covered that nothing is over it: one that registers again starts clean', () => {
    const log: string[] = [];
    const { registry } = mountRegistry();
    const approval = spy(log, 'approval', 'approval');
    registry.register(approval.entry);
    registry.register(spy(log, 'question', 'alert').entry);
    registry.unregister('approval');
    expect(approval.told).toEqual(['covered', 'uncovered']);
    registry.register(approval.entry);
    registry.left('question');
    expect(approval.told).toEqual(['covered', 'uncovered']);
  });
});

describe('useOpenState', () => {
  it('keeps its own state and reports every change', async () => {
    const user = userEvent.setup();
    const changes: boolean[] = [];
    render(<OpenStateProbe onOpenChange={(open) => changes.push(open)} />);
    await user.click(screen.getByText('hidden'));
    await user.click(screen.getByText('shown'));
    expect(changes).toEqual([true, false]);
  });
});
