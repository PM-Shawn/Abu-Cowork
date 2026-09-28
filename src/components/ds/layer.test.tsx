// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LayerProvider, LayerScope } from './layer';
import { useLayer, useLayerContainer, useOpenState, type LayerKind } from './layer-context';

function FakeLayer({ name, kind, dirty = false, defaultOpen = false, children }: {
  name: string;
  kind: LayerKind;
  dirty?: boolean;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  const id = useLayer(kind, open, setOpen, kind === 'dialog'
    ? { isDirty: () => dirty, confirmDiscard: (onDiscard) => setPendingDiscard(() => onDiscard) }
    : undefined);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>{`open ${name}`}</button>
      {open && <div data-testid={name}><LayerScope id={id}>{children}</LayerScope></div>}
      {pendingDiscard && (
        <button type="button" onClick={() => { setPendingDiscard(null); pendingDiscard(); }}>{`discard ${name}`}</button>
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
