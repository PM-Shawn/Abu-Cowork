// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
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

  it('returns to the requested line when the same line is asked for again', async () => {
    const { container, rerender } = render(
      <CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} line={3} lineRequest={1} />,
    );
    await waitFor(() => expect(activeLineText(container)).toBe('third line'));

    // The reader moves the cursor away from the requested line.
    const content = container.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('editor content is missing');
    const view = EditorView.findFromDOM(content);
    if (!view) throw new Error('editor view is missing');
    act(() => { view.dispatch({ selection: { anchor: 0 } }); });
    await waitFor(() => expect(activeLineText(container)).toBe('first line'));

    rerender(<CodeMirrorEditor value={TEXT} language="txt" onChange={() => {}} line={3} lineRequest={2} />);

    await waitFor(() => expect(activeLineText(container)).toBe('third line'));
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
