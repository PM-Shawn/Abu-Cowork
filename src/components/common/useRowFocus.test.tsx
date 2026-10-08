// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ds/button';
import { useRowFocus } from './useRowFocus';

let remove: (id: string) => void = () => undefined;
let closeForm: () => void = () => undefined;

// A list as the todos and the inbox draw it: rows that hold buttons, a header control, and a
// form above the rows that can close.
function List({ start, header = true }: { start: string[]; header?: boolean }) {
  const [ids, setIds] = useState(start);
  const [formOpen, setFormOpen] = useState(true);
  const { root, fallback, note } = useRowFocus('data-test-row');
  useEffect(() => {
    remove = (id) => {
      note(id);
      setIds((current) => current.filter((candidate) => candidate !== id));
    };
    closeForm = () => {
      note(null);
      setFormOpen(false);
    };
  }, [note]);
  return (
    <>
      {header && <Button ref={fallback}>New</Button>}
      <Button>Elsewhere</Button>
      <div ref={root}>
        {formOpen && <Button>Cancel the form</Button>}
        {ids.map((id) => (
          <div key={id} data-test-row={id}>
            {id !== 'bare' && <Button>{`Remove ${id}`}</Button>}
          </div>
        ))}
      </div>
    </>
  );
}

const button = (name: string) => screen.getByRole('button', { name });

afterEach(() => cleanup());

describe('useRowFocus', () => {
  it('moves the focus to the first button of the row that took the place of a removed one', () => {
    render(<List start={['a', 'b', 'c']} />);
    button('Remove b').focus();

    act(() => remove('b'));

    expect(button('Remove c')).toHaveFocus();
  });

  it('moves the focus to a row before it when the last row is removed', () => {
    render(<List start={['a', 'b']} />);
    button('Remove b').focus();

    act(() => remove('b'));

    expect(button('Remove a')).toHaveFocus();
  });

  it('passes over a row without a button', () => {
    render(<List start={['a', 'b', 'bare']} />);
    button('Remove b').focus();

    act(() => remove('b'));

    expect(button('Remove a')).toHaveFocus();
  });

  it('moves the focus to the header control when no row is left', () => {
    render(<List start={['a']} />);
    act(() => closeForm());
    button('Remove a').focus();

    act(() => remove('a'));

    expect(button('New')).toHaveFocus();
  });

  it('moves the focus to the header control when the form closes under it', () => {
    render(<List start={['a']} />);
    button('Cancel the form').focus();

    act(() => closeForm());

    expect(button('New')).toHaveFocus();
  });

  it('leaves the focus alone when it is on another control', () => {
    render(<List start={['a', 'b']} />);
    button('Elsewhere').focus();

    act(() => remove('a'));

    expect(button('Elsewhere')).toHaveFocus();
  });
});
