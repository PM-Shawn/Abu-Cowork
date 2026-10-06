// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ds/button';
import { conversationRowProps, useConversationRowFocus, type ConversationRowFocus } from './conversationRowFocus';

let leave: (id: string) => void = () => undefined;
let focus: ConversationRowFocus | null = null;

// The sidebar's conversation rows as it draws them, the entry that starts a conversation, and an
// open row menu with one item.
function Rows({ start, withNewTask = true, menu = false }: { start: string[]; withNewTask?: boolean; menu?: boolean }) {
  const [ids, setIds] = useState(start);
  const rowFocus = useConversationRowFocus();
  useEffect(() => {
    focus = rowFocus;
    leave = (id) => {
      rowFocus.note(id);
      setIds((current) => current.filter((candidate) => candidate !== id));
    };
  }, [rowFocus]);
  return (
    <>
      {withNewTask && <Button data-sidebar-action="new-task">New task</Button>}
      {ids.map((id) => <Button key={id} {...conversationRowProps(id)}>{id}</Button>)}
      <Button>Elsewhere</Button>
      {menu && <div role="menu"><Button>Delete</Button></div>}
    </>
  );
}

const row = (id: string) => screen.getByRole('button', { name: id });
// What a menu hands its owner once it has gone: the owner may keep the focus for itself.
const menuClosed = () => new Event('closeAutoFocus', { cancelable: true });

afterEach(() => {
  cleanup();
  focus = null;
});

describe('useConversationRowFocus, a row that leaves under the focus', () => {
  it('moves the focus to the row that took its place', () => {
    render(<Rows start={['a', 'b', 'c']} />);
    row('b').focus();

    act(() => leave('b'));

    expect(row('c')).toHaveFocus();
  });

  it('moves the focus to the row before it when it was the last', () => {
    render(<Rows start={['a', 'b', 'c']} />);
    row('c').focus();

    act(() => leave('c'));

    expect(row('b')).toHaveFocus();
  });

  it('moves the focus to the entry that starts a conversation when no row is left', () => {
    render(<Rows start={['a']} />);
    row('a').focus();

    act(() => leave('a'));

    expect(row('New task')).toHaveFocus();
  });

  it('leaves the focus on the window when the page has neither', () => {
    render(<Rows start={['a']} withNewTask={false} />);
    row('a').focus();

    act(() => leave('a'));

    expect(screen.getByRole('button', { name: 'Elsewhere' })).not.toHaveFocus();
    expect(document.activeElement === document.body || document.activeElement?.isConnected === false).toBe(true);
  });

  it('leaves the focus alone when it is on another control', () => {
    render(<Rows start={['a', 'b']} />);
    row('Elsewhere').focus();

    act(() => leave('a'));

    expect(row('Elsewhere')).toHaveFocus();
  });

  it('acts once: a later render moves nothing', () => {
    const view = render(<Rows start={['a', 'b']} />);
    row('a').focus();
    act(() => leave('a'));
    expect(row('b')).toHaveFocus();

    act(() => { (document.activeElement as HTMLElement).blur(); });
    view.rerender(<Rows start={['a', 'b']} />);

    expect(document.activeElement).toBe(document.body);
  });
});

describe('useConversationRowFocus, a row that leaves while its menu is still closing', () => {
  it('waits for the menu, then keeps the focus for the row that took its place', () => {
    render(<Rows start={['a', 'b', 'c']} menu />);
    row('Delete').focus();

    act(() => leave('a'));
    expect(row('Delete')).toHaveFocus();

    const closed = menuClosed();
    act(() => { focus!.afterMenuClose(closed); });

    expect(closed.defaultPrevented).toBe(true);
    expect(row('b')).toHaveFocus();
  });

  it('acts once: the next menu that closes gives the focus back by itself', () => {
    render(<Rows start={['a', 'b', 'c']} menu />);
    row('Delete').focus();
    act(() => leave('a'));
    act(() => { focus!.afterMenuClose(menuClosed()); });

    row('Delete').focus();
    const later = menuClosed();
    act(() => { focus!.afterMenuClose(later); });

    expect(later.defaultPrevented).toBe(false);
    expect(row('Delete')).toHaveFocus();
  });

  it('leaves a menu that closes with no row gone to give the focus back by itself', () => {
    render(<Rows start={['a', 'b']} menu />);
    row('Delete').focus();
    const closed = menuClosed();

    act(() => { focus!.afterMenuClose(closed); });

    expect(closed.defaultPrevented).toBe(false);
    expect(row('Delete')).toHaveFocus();
  });

  it('forgets the row when a menu opens again before the first has gone', () => {
    render(<Rows start={['a', 'b']} menu />);
    row('Delete').focus();
    act(() => leave('a'));

    act(() => { focus!.forget(); });
    const closed = menuClosed();
    act(() => { focus!.afterMenuClose(closed); });

    expect(closed.defaultPrevented).toBe(false);
    expect(row('Delete')).toHaveFocus();
  });

  it('forgets the row when the focus is on another control once it has gone', () => {
    render(<Rows start={['a', 'b']} menu />);
    row('Elsewhere').focus();
    act(() => leave('a'));

    row('Delete').focus();
    const closed = menuClosed();
    act(() => { focus!.afterMenuClose(closed); });

    expect(closed.defaultPrevented).toBe(false);
    expect(row('Delete')).toHaveFocus();
  });

  it('gives the focus back the menu\'s own way when nothing is left to take it', () => {
    render(<Rows start={['a']} withNewTask={false} menu />);
    row('Delete').focus();
    act(() => leave('a'));
    const closed = menuClosed();

    act(() => { focus!.afterMenuClose(closed); });

    expect(closed.defaultPrevented).toBe(false);
  });
});
