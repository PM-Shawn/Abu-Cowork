// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LayerProvider, LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState, type LayerKind } from './layer-context';

interface PendingDiscard { onDiscard: () => void; onKeep?: () => void }

function FakeLayer({ name, kind, dirty = false, defaultOpen = false, onOpenChange, children }: {
  name: string;
  kind: LayerKind;
  dirty?: boolean;
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
  const { id, held } = useLayer(kind, open, setOpen, kind === 'dialog'
    ? {
        isDirty: () => dirty,
        confirmDiscard: (onDiscard, onKeep) => {
          const pending = { onDiscard, onKeep };
          setPendingDiscard(pending);
          return () => setPendingDiscard((current) => (current === pending ? null : current));
        },
      }
    : undefined);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>{`open ${name}`}</button>
      {open && !held && (
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
      expect(onModalChange).not.toHaveBeenCalled();
      await user.click(screen.getByText('open dialog'));
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('open alert'));
      await user.click(screen.getByText('close alert'));
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('close dialog'));
      expect(onModalChange.mock.calls).toEqual([[true], [false]]);
    });

    it('counts an alert that is open by itself', async () => {
      const user = userEvent.setup();
      const onModalChange = vi.fn();
      render(<LayerProvider onModalChange={onModalChange}><FakeLayer name="alert" kind="alert" /></LayerProvider>);
      await user.click(screen.getByText('open alert'));
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('close alert'));
      expect(onModalChange.mock.calls).toEqual([[true], [false]]);
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
      expect(onModalChange).not.toHaveBeenCalled();

      // A menu inside a dialog comes and goes without a second report.
      await user.click(screen.getByText('open dialog'));
      await user.click(screen.getByText('open inner menu'));
      await user.click(screen.getByText('close inner menu'));
      expect(onModalChange.mock.calls).toEqual([[true]]);
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
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('close second'));
      expect(onModalChange.mock.calls).toEqual([[true], [false]]);
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
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('close outer'));
      expect(onModalChange.mock.calls).toEqual([[true], [false]]);
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
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('close other'));
      expect(onModalChange.mock.calls).toEqual([[true], [false]]);
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
      expect(onModalChange.mock.calls).toEqual([[true]]);
      await user.click(screen.getByText('close draft'));
      expect(onModalChange.mock.calls).toEqual([[true], [false]]);
    });
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
