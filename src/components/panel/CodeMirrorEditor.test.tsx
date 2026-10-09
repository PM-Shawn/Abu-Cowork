// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import CodeMirrorEditor from './CodeMirrorEditor';

afterEach(cleanup);

const TEXT = 'first line\nsecond line\nthird line\nfourth line';

/** The line that holds the cursor: the editor marks it as the active line. */
function activeLineText(container: HTMLElement): string | null {
  return container.querySelector('.cm-activeLine')?.textContent ?? null;
}

describe('CodeMirrorEditor line', () => {
  it('keeps the cursor on the first line when no line is asked for', async () => {
    const { container } = render(<CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} />);

    await waitFor(() => expect(activeLineText(container)).toBe('first line'));
  });

  it('puts the cursor on the requested line', async () => {
    const { container } = render(<CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} line={3} />);

    await waitFor(() => expect(activeLineText(container)).toBe('third line'));
  });

  it('moves to another line when the request changes', async () => {
    const { container, rerender } = render(<CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} line={3} />);
    await waitFor(() => expect(activeLineText(container)).toBe('third line'));

    rerender(<CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} line={2} />);

    await waitFor(() => expect(activeLineText(container)).toBe('second line'));
  });

  it('stops at the last line when the request is past the end of the text', async () => {
    const { container } = render(<CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} line={99} />);

    await waitFor(() => expect(activeLineText(container)).toBe('fourth line'));
  });

  it('reports no edit for moving to a line', async () => {
    const edits: string[] = [];
    const { container } = render(<CodeMirrorEditor value={TEXT} language="txt" onChange={(value) => edits.push(value)} line={2} />);

    await waitFor(() => expect(activeLineText(container)).toBe('second line'));
    expect(edits).toEqual([]);
  });
});
