// @vitest-environment happy-dom
import { useState, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { InlineSkillInput, type InlineSkill, type InlineSkillInputHandle } from './InlineSkillInput';

afterEach(cleanup);
function setup(initial = '前文后文', initialSkill: InlineSkill | null = null, more: { className?: string; disabled?: boolean } = {}) {
  const ref = createRef<InlineSkillInputHandle>();
  const output = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    const [skill, setSkill] = useState(initialSkill);
    return <><InlineSkillInput ref={ref} value={value} skill={skill} historyKey="one"
      onChange={(text, next) => { setValue(text); setSkill(next); output(text, next); }}
      onSelect={() => {}} onKeyDown={() => {}} onPaste={() => {}} onCompositionStart={() => {}} onCompositionEnd={() => {}}
      placeholder="message" removeLabel="remove" rows={2} className={more.className ?? ''} disabled={more.disabled} aria-autocomplete="list" aria-expanded={false} />
      <Button onClick={() => setSkill({ name: 'brief', description: 'brief', offset: ref.current!.selectionStart })}>pick</Button></>;
  }
  render(<Harness />);
  return { ref, output };
}
const box = () => screen.getByRole('textbox');
function beforeSkillText(atom: HTMLElement): string {
  const range = document.createRange();
  range.selectNodeContents(atom.parentElement!);
  range.setEndBefore(atom);
  const copy = range.cloneContents();
  copy.querySelectorAll<HTMLElement>('[data-skill-boundary]').forEach((node) => { node.textContent = node.dataset.skillBoundary === 'before' ? node.textContent!.replace(/\u200b$/, '') : node.textContent!.replace(/^\u200b/, ''); });
  return copy.textContent ?? '';
}


describe('inline skill editor', () => {
  it.each([0, 2, 4])('inserts an atom at body offset %i without changing text and resumes after it', (offset) => {
    const { ref, output } = setup();
    act(() => { ref.current!.focus(); ref.current!.setSelectionRange(offset, offset); });
    fireEvent.click(screen.getByText('pick'));
    const atom = screen.getByRole('button', { name: '/brief' });
    expect(atom.parentElement).toBe(box());
    expect(beforeSkillText(atom)).toBe('前文后文'.slice(0, offset));
    expect(ref.current!.value).toBe('前文后文');
    act(() => { ref.current!.insertText('继续'); });
    expect(output).toHaveBeenLastCalledWith('前文后文'.slice(0, offset) + '继续' + '前文后文'.slice(offset), expect.objectContaining({ offset }));
  });
  it('click removal and undo/redo preserve surrounding body and restore the atom', () => {
    const { ref } = setup('前文\n  后文', { name: 'brief', description: '', offset: 2 });
    fireEvent.click(screen.getByRole('button', { name: '/brief' }));
    expect(ref.current!.value).toBe('前文\n  后文');
    expect(screen.queryByRole('button', { name: '/brief' })).toBeNull();
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: '/brief' })).toBeTruthy();
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('button', { name: '/brief' })).toBeNull();
    expect(ref.current!.value).toBe('前文\n  后文');
  });
  it('undoes the menu insertion back to the original native input', () => {
    const { ref } = setup();
    act(() => ref.current!.setSelectionRange(2, 2));
    fireEvent.click(screen.getByText('pick'));
    fireEvent.keyDown(box(), { key: 'z', metaKey: true });
    expect(screen.queryByRole('button', { name: '/brief' })).toBeNull();
    expect(ref.current!.value).toBe('前文后文');
  });
  it('keeps pasted HTML as plain text and preserves newlines', () => {
    const { ref } = setup('正文', { name: 'brief', description: '', offset: 0 });
    act(() => { ref.current!.focus(); ref.current!.setSelectionRange(0, 0); });
    fireEvent.paste(box(), { clipboardData: { getData: () => '<b>文字</b>\n  缩进' } });
    expect(ref.current!.value).toBe('<b>文字</b>\n  缩进正文');
    expect(box().querySelector('b')).toBeNull();
  });
  it('keeps the composition node alive across IME updates', () => {
    const { ref } = setup('正文', { name: 'brief', description: '', offset: 0 });
    const node = box().lastChild!;
    fireEvent.compositionStart(box());
    node.textContent = '中文正文';
    fireEvent.input(box());
    expect(box().lastChild).toBe(node);
    fireEvent.compositionEnd(box());
    expect(ref.current!.value).toBe('中文正文');
  });
  it('retains the before-atom caret affinity through repeated insertion and undo', () => {
    const { ref } = setup('AB', { name: 'brief', description: '', offset: 1 });
    const atom = screen.getByRole('button', { name: '/brief' });
    act(() => {
      ref.current!.focus();
      const range = document.createRange();
      range.setStartBefore(atom);
      range.collapse(true);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      ref.current!.insertText('X');
    });
    act(() => ref.current!.insertText('Y'));
    expect(ref.current!.value).toBe('AXYB');
    const before = document.createRange();
    before.selectNodeContents(box());
    before.setEndBefore(screen.getByRole('button', { name: '/brief' }));
    expect(beforeSkillText(screen.getByRole('button', { name: '/brief' }))).toBe('AXY');
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true });
    act(() => ref.current!.insertText('Z'));
    expect(ref.current!.value).toBe('AXZB');
    const range = document.createRange();
    range.setStart(box(), 0);
    range.setEndBefore(screen.getByRole('button', { name: '/brief' }));
    expect(beforeSkillText(screen.getByRole('button', { name: '/brief' }))).toBe('AXZ');
  });

  it('keeps rich mode until IME finishes even when composition replaces the atom', () => {
    const { ref } = setup('正文', { name: 'brief', description: '', offset: 0 });
    const root = box();
    fireEvent.compositionStart(root);
    root.replaceChildren(document.createTextNode('zhong'));
    fireEvent.input(root, { isComposing: true });
    expect(box()).toBe(root);
    root.textContent = '中文';
    fireEvent.input(root, { isComposing: true });
    fireEvent.compositionEnd(root);
    expect(box()).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current!.value).toBe('中文');
    expect(document.activeElement).toBe(box());
  });
  it('Enter on the focusable atom removes it without invoking the composer send key', () => {
    const { ref } = setup('正文', { name: 'brief', description: '', offset: 0 });
    const atom = screen.getByRole('button', { name: '/brief' });
    fireEvent.keyDown(atom, { key: 'Enter' });
    expect(screen.queryByRole('button', { name: '/brief' })).toBeNull();
    expect(ref.current!.value).toBe('正文');
  });

  it('never admits a private caret marker when arrow navigation places text beyond it', () => {
    const { ref, output } = setup('AB', { name: 'brief', description: '', offset: 1 });
    const boundary = box().querySelector('[data-skill-boundary=before]')!;
    boundary.textContent = '\u200bX';
    fireEvent.input(box());
    expect(ref.current!.value).toBe('AXB');
    expect(output).toHaveBeenLastCalledWith('AXB', expect.objectContaining({ offset: 2 }));
  });
  it('preserves user-authored zero-width characters outside private caret boundaries', () => {
    const { ref } = setup('A\u200bB', { name: 'brief', description: '', offset: 1 });
    expect(ref.current!.value).toBe('A\u200bB');
  });

  it.each(['copy', 'cut'] as const)('%s serializes the skill without caret markers or the remove affordance', (kind) => {
    const { ref } = setup('AB', { name: 'brief', description: '', offset: 1 });
    const root = box();
    const range = document.createRange();
    range.selectNodeContents(root);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    const setData = vi.fn();
    fireEvent[kind](root, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', 'A/briefB');
    expect(ref.current!.value).toBe(kind === 'cut' ? '' : 'AB');
  });

  it('gives every line break typed at the end a line to type on', () => {
    // Chromium draws no line for a break that ends the box and moves the caret
    // in front of it, so the next character lands before the break. The tail
    // <br> is what makes that last line exist.
    const { ref } = setup('', { name: 'brief', description: '', offset: 0 });
    const tail = () => box().querySelector('[data-editor-tail]');
    act(() => { ref.current!.focus(); ref.current!.insertText('a'); });
    expect(tail()).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(ref.current!.value).toBe('a\n');
    expect(tail()).toBe(box().lastChild);
    act(() => ref.current!.insertText('b'));
    expect(ref.current!.value).toBe('a\nb');
    expect(tail()).toBeNull();
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(tail()).toBe(box().lastChild);
    act(() => ref.current!.insertText('c'));
    expect(ref.current!.value).toBe('a\nb\nc');
    expect(tail()).toBeNull();
  });
  it.each(['Backspace', 'Delete'])('%s over everything, tag included, empties the box', (key) => {
    const { ref, output } = setup('ab\nc', { name: 'brief', description: '', offset: 0 });
    const root = box();
    act(() => {
      ref.current!.focus();
      const range = document.createRange();
      range.selectNodeContents(root);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    if (fireEvent.keyDown(root, { key })) {
      // What Chromium leaves when its own deletion empties the box: the
      // placeholder break of an empty pre-wrap block.
      const after = document.createElement('span');
      after.dataset.skillBoundary = 'after';
      after.textContent = '\n';
      root.replaceChildren(after);
      fireEvent.input(root);
    }
    expect(output).toHaveBeenLastCalledWith('', null);
    expect(box()).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current!.value).toBe('');
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: '/brief' })).toBeTruthy();
    expect(ref.current!.value).toBe('ab\nc');
  });

});

// The plain field is the design-system text area without a box of its own: the composer card
// around it draws the border, the fill and the focus mark.
describe('inline skill editor: the plain field', () => {
  it('renders a text area without a border class', () => {
    setup('', null, { className: 'flex-1 text-body' });
    const names = [...box().classList];
    expect(box()).toBeInstanceOf(HTMLTextAreaElement);
    expect(box()).not.toHaveClass('border');
    expect(names.filter((name) => /^(focus:|focus-visible:)?border/.test(name))).toEqual([]);
  });
  it('carries no class of the old component library and no slot mark', () => {
    setup('', null, { className: 'flex-1 text-body' });
    const names = [...box().classList];
    expect(names.filter((name) => name.includes('--abu-'))).toEqual([]);
    expect(names.filter((name) => /^(focus:|focus-visible:)?(ring|rounded)/.test(name))).toEqual([]);
    expect(box()).not.toHaveClass('transition-all');
    expect(box()).not.toHaveClass('bg-field');
    expect(box()).not.toHaveAttribute('data-slot');
  });
  it('is the bare text area plus the classes its caller gives', () => {
    setup('', null, { className: 'flex-1 text-body' });
    expect(box().className).toBe('w-full resize-none bg-transparent outline-none flex-1 text-body');
  });
  it('hands the composer mark, the placeholder, the rows and the list attributes to the text area', () => {
    setup('');
    expect(box()).toHaveAttribute('data-chat-composer', 'true');
    expect(box()).toHaveAttribute('placeholder', 'message');
    expect(box()).toHaveAttribute('rows', '2');
    expect(box()).toHaveAttribute('aria-autocomplete', 'list');
    expect(box()).toHaveAttribute('aria-expanded', 'false');
    expect(box()).not.toHaveAttribute('aria-invalid');
    expect(box()).not.toBeDisabled();
  });
  it('is disabled when its caller says so, and the editable box then takes no input either', () => {
    setup('', null, { disabled: true });
    expect(box()).toBeDisabled();
    cleanup();
    setup('正文', { name: 'brief', description: '', offset: 0 }, { disabled: true });
    expect(box()).toHaveAttribute('aria-disabled', 'true');
    expect(box()).toHaveAttribute('contenteditable', 'false');
  });
});
