// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ds/button';
import { focusProjectRow, projectCreateProps, projectRowPlace, projectRowProps, useProjectRowFocus } from './projectRowFocus';

let leave: (id: string) => void = () => undefined;

// A list of project rows as the sidebar draws them: one button per project, and the create button.
function Rows({ start, withCreate = true }: { start: string[]; withCreate?: boolean }) {
  const [ids, setIds] = useState(start);
  const note = useProjectRowFocus();
  useEffect(() => {
    leave = (id) => {
      note(id);
      setIds((current) => current.filter((candidate) => candidate !== id));
    };
  }, [note]);
  return (
    <>
      {withCreate && <Button {...projectCreateProps}>Create a project</Button>}
      {ids.map((id) => <Button key={id} {...projectRowProps(id)}>{id}</Button>)}
      <Button>Elsewhere</Button>
    </>
  );
}

const row = (id: string) => screen.getByRole('button', { name: id });

afterEach(() => cleanup());

describe('focusProjectRow', () => {
  it('focuses the row itself while it is on the page', () => {
    render(<Rows start={['a', 'b', 'c']} />);

    expect(focusProjectRow(projectRowPlace('b'))).toBe(true);

    expect(row('b')).toHaveFocus();
  });

  it('focuses the row that took its place once it has gone', () => {
    render(<Rows start={['a', 'b', 'c']} />);
    const place = projectRowPlace('b');
    act(() => leave('b'));
    row('Elsewhere').focus();

    expect(focusProjectRow(place)).toBe(true);

    expect(row('c')).toHaveFocus();
  });

  it('focuses the row before it when it was the last', () => {
    render(<Rows start={['a', 'b', 'c']} />);
    const place = projectRowPlace('c');
    act(() => leave('c'));
    row('Elsewhere').focus();

    focusProjectRow(place);

    expect(row('b')).toHaveFocus();
  });

  it('focuses the create button when no row is left', () => {
    render(<Rows start={['a']} />);
    const place = projectRowPlace('a');
    act(() => leave('a'));
    row('Elsewhere').focus();

    expect(focusProjectRow(place)).toBe(true);

    expect(row('Create a project')).toHaveFocus();
  });

  it('moves nothing and says so when the page has neither rows nor the create button', () => {
    render(<Rows start={['a']} withCreate={false} />);
    const place = projectRowPlace('a');
    act(() => leave('a'));
    row('Elsewhere').focus();

    expect(focusProjectRow(place)).toBe(false);

    expect(row('Elsewhere')).toHaveFocus();
  });
});

describe('useProjectRowFocus', () => {
  it('moves the focus to the row that took its place when the focused row leaves', () => {
    render(<Rows start={['a', 'b', 'c']} />);
    row('b').focus();

    act(() => leave('b'));

    expect(row('c')).toHaveFocus();
  });

  it('moves the focus to the create button when the only row leaves', () => {
    render(<Rows start={['a']} />);
    row('a').focus();

    act(() => leave('a'));

    expect(row('Create a project')).toHaveFocus();
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
