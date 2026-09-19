import { useImperativeHandle, useLayoutEffect, useRef, useState, type Ref, type KeyboardEvent, type ClipboardEvent, type CompositionEvent } from 'react';
import { Textarea } from './textarea';

export interface InlineSkill {
  name: string;
  description: string;
  /** UTF-16 offset in the plain body, excluding the atomic skill label. */
  offset?: number;
}
export interface InlineSkillInputHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly style: CSSStyleDeclaration;
  readonly scrollHeight: number;
  focus(): void;
  setSelectionRange(start: number, end: number): void;
  insertText(text: string): void;
}
interface Props {
  ref?: Ref<InlineSkillInputHandle>;
  historyKey: string;
  imeActive?: boolean;
  value: string;
  skill: InlineSkill | null;
  onChange(value: string, skill: InlineSkill | null): void;
  onSelect(): void;
  onKeyDown(event: KeyboardEvent): void;
  onPaste(event: ClipboardEvent): void;
  onCompositionStart(event: CompositionEvent): void;
  onCompositionEnd(event: CompositionEvent): void;
  placeholder: string;
  removeLabel: string;
  disabled?: boolean;
  rows: number;
  className: string;
  'aria-autocomplete': 'list';
  'aria-expanded': boolean;
  'aria-controls'?: string;
  'aria-activedescendant'?: string;
}
interface Caret { start: number; end: number; startBeforeSkill?: boolean; endBeforeSkill?: boolean }
interface Snapshot extends Caret { text: string; skill: InlineSkill | null }
const offsetOf = (skill: InlineSkill, text: string) => Math.max(0, Math.min(skill.offset ?? 0, text.length));
const same = (a: Snapshot, b: Snapshot) => a.text === b.text && a.skill?.name === b.skill?.name && a.skill?.offset === b.skill?.offset;

/** Read only plain text and our atom. Pasted HTML is never admitted. Chromium
 * can still produce DIV/BR nodes while editing, so normalize those as lines. */
function read(root: Node): { text: string; offset: number | null } {
  let text = '';
  let offset: number | null = null;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent ?? ''; return; }
    if (node instanceof HTMLElement) {
      if (node.hasAttribute('data-skill-boundary')) {
        const content = node.textContent ?? '';
        const marker = node.dataset.skillBoundary === 'before' ? content.lastIndexOf('\u200b') : content.indexOf('\u200b');
        text += marker < 0 ? content : content.slice(0, marker) + content.slice(marker + 1);
        return;
      }
      if (node.hasAttribute('data-inline-skill')) { offset = text.length; return; }
      if (node.hasAttribute('data-editor-tail')) return;
      if (node.tagName === 'BR') { text += '\n'; return; }
      if ((node.tagName === 'DIV' || node.tagName === 'P') && node.previousSibling && !text.endsWith('\n')) text += '\n';
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return { text, offset };
}

/** Native textarea until an atom is present; rich editing only when needed.
 * A shared history survives this transition, including inserting/removing a
 * skill. Body and skill metadata stay separate from transport serialization. */
export function InlineSkillInput({ ref, historyKey, imeActive, value, skill, onChange, onSelect, onKeyDown, onPaste, onCompositionStart, onCompositionEnd, removeLabel, rows, className, ...attributes }: Props) {
  const plain = useRef<HTMLTextAreaElement>(null);
  const rich = useRef<HTMLDivElement>(null);
  const caret = useRef<Caret>({ start: value.length, end: value.length });
  const pendingCaret = useRef<Caret | null>(null);
  const focusAfterRender = useRef(false);
  const composing = useRef(false);
  const [richComposing, setRichComposing] = useState(false);
  const history = useRef<Snapshot[]>([]);
  const historyIndex = useRef(-1);
  const restoringHistory = useRef(false);
  const previousHistoryKey = useRef(historyKey);
  const previousMode = useRef(Boolean(skill));

  function selection(): Caret {
    if (plain.current) return { start: plain.current.selectionStart, end: plain.current.selectionEnd };
    const root = rich.current;
    const selected = window.getSelection();
    if (!root || !selected?.rangeCount || !root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) return caret.current;
    const range = selected.getRangeAt(0);
    const prefix = range.cloneRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = read(prefix.cloneContents());
    prefix.setEnd(range.endContainer, range.endOffset);
    const end = read(prefix.cloneContents());
    return { start: start.text.length, end: end.text.length, startBeforeSkill: start.offset === null, endBeforeSkill: end.offset === null };
  }
  function syncSelection() {
    caret.current = selection();
    const current = history.current[historyIndex.current];
    const body = plain.current?.value ?? (rich.current ? read(rich.current).text : value);
    if (current?.text === body) Object.assign(current, caret.current);
    onSelect();
  }
  function place(start: number, end: number, startBeforeSkill = false, endBeforeSkill = false) {
    caret.current = { start, end, startBeforeSkill, endBeforeSkill };
    if (plain.current) { plain.current.setSelectionRange(start, end); return; }
    const root = rich.current;
    if (!root) return;
    // External reconciliation uses canonical text/atom/text nodes. Prefer the
    // following text node at the atom boundary so typing continues after it.
    const position = (offset: number, beforeSkill: boolean): [Node, number] => {
      const atom = root.querySelector('[data-inline-skill]');
      if (atom && read(root).offset === offset) {
        const boundary = beforeSkill ? atom.previousSibling : atom.nextSibling;
        if (boundary instanceof HTMLElement && boundary.hasAttribute('data-skill-boundary')) {
          const node = beforeSkill ? boundary.lastChild : boundary.firstChild;
          if (node) return [node, beforeSkill ? Math.max(0, (node.textContent?.length ?? 0) - 1) : 1];
        }
      }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement?.closest('[data-inline-skill]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let remaining = offset;
      let node: Node | null;
      let last: Node = root;
      while ((node = walker.nextNode())) {
        last = node;
        const content = node.textContent ?? '';
        const boundary = node.parentElement?.dataset.skillBoundary;
        const marker = boundary === 'before' ? content.lastIndexOf('\u200b') : boundary === 'after' ? content.indexOf('\u200b') : -1;
        const length = content.length - (marker >= 0 ? 1 : 0);
        if (remaining <= length) return [node, remaining + (marker >= 0 && remaining >= marker ? 1 : 0)];
        remaining -= length;
      }
      return [last, last === root ? root.childNodes.length : last.textContent?.length ?? 0];
    };
    const range = document.createRange();
    range.setStart(...position(start, startBeforeSkill));
    range.setEnd(...position(end, endBeforeSkill));
    const selected = window.getSelection();
    selected?.removeAllRanges();
    selected?.addRange(range);
  }
  function change(text: string, nextSkill: InlineSkill | null, nextCaret = selection()) {
    caret.current = nextCaret;
    pendingCaret.current = nextCaret;
    focusAfterRender.current = true;
    onChange(text, nextSkill);
  }
  function insertText(insertion: string) {
    const { start, end } = selection();
    let nextSkill = skill;
    if (rich.current) {
      // Range insertion preserves the side of the atom even when both sides
      // have the same body offset. The browser selection is the authority.
      const selected = window.getSelection();
      if (selected?.rangeCount && rich.current.contains(selected.anchorNode)) {
        const range = selected.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(insertion);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selected.removeAllRanges();
        selected.addRange(range);
        const result = read(rich.current);
        nextSkill = skill && result.offset !== null ? { ...skill, offset: result.offset } : null;
        change(result.text, nextSkill, selection());
        return;
      }
    }
    change(value.slice(0, start) + insertion + value.slice(end), nextSkill, { start: start + insertion.length, end: start + insertion.length });
  }
  useImperativeHandle(ref, () => ({
    get value() { return plain.current?.value ?? (rich.current ? read(rich.current).text : value); },
    get selectionStart() { return selection().start; },
    get selectionEnd() { return selection().end; },
    get style() { return (plain.current ?? rich.current)!.style; },
    get scrollHeight() { return (plain.current ?? rich.current)!.scrollHeight; },
    focus() {
      const root = rich.current;
      const restore = root && !root.contains(window.getSelection()?.anchorNode ?? null);
      (plain.current ?? root)?.focus();
      if (restore) place(caret.current.start, caret.current.end, caret.current.startBeforeSkill, caret.current.endBeforeSkill);
    },
    setSelectionRange: place,
    insertText,
  }));

  useLayoutEffect(() => {
    if (previousHistoryKey.current !== historyKey) {
      history.current = [];
      historyIndex.current = -1;
      previousHistoryKey.current = historyKey;
      caret.current = { start: value.length, end: value.length };
    }
    const root = rich.current;
    if (root && skill && !composing.current) {
      const current = read(root);
      const offset = offsetOf(skill, value);
      const atom = root.querySelector('[data-inline-skill]');
      const beforeMarker = root.querySelector('[data-skill-boundary=before]');
      const afterMarker = root.querySelector('[data-skill-boundary=after]');
      const markersIntact = beforeMarker?.nextSibling === atom && afterMarker?.previousSibling === atom && beforeMarker?.textContent?.endsWith('\u200b') && afterMarker?.textContent?.startsWith('\u200b');
      if (current.text !== value || current.offset !== offset || atom?.getAttribute('data-inline-skill') !== skill.name || !markersIntact) {
        if (atom && !markersIntact) focusAfterRender.current = true;
        const button = document.createElement('button');
        button.type = 'button';
        button.contentEditable = 'false';
        button.dataset.inlineSkill = skill.name;
        button.setAttribute('aria-label', `/${skill.name}`);
        button.title = `${removeLabel} /${skill.name}`;
        button.className = 'inline-block max-w-full align-baseline rounded-md bg-[var(--abu-bg-muted)] px-1.5 mx-0.5 text-body font-medium text-[var(--abu-text-primary)] cursor-pointer';
        button.textContent = `/${skill.name} ×`;
        // Editable caret stops keep Chromium from canonicalizing a caret on a
        // new line before a non-editable atom to the other side of that atom.
        const before = document.createElement('span');
        before.dataset.skillBoundary = 'before';
        before.textContent = '\u200b';
        const after = document.createElement('span');
        after.dataset.skillBoundary = 'after';
        after.textContent = '\u200b';
        root.replaceChildren(document.createTextNode(value.slice(0, offset)), before, button, after, document.createTextNode(value.slice(offset)));
        if (value.endsWith('\n')) {
          const tail = document.createElement('br');
          tail.dataset.editorTail = '';
          root.append(tail);
        }
      }
    }
    if (previousMode.current !== (Boolean(skill) || richComposing)) focusAfterRender.current = true;
    previousMode.current = Boolean(skill) || richComposing;
    if (focusAfterRender.current) {
      (plain.current ?? root)?.focus();
      const target = pendingCaret.current ?? caret.current;
      place(target.start, target.end, target.startBeforeSkill, target.endBeforeSkill);
      focusAfterRender.current = false;
    }
    pendingCaret.current = null;
    const snapshot = { text: value, skill, ...caret.current };
    if (!restoringHistory.current && !composing.current && !same(history.current[historyIndex.current] ?? { text: '', skill: null, start: 0, end: 0 }, snapshot)) {
      history.current.splice(historyIndex.current + 1);
      history.current.push(snapshot);
      if (history.current.length > 100) history.current.shift();
      historyIndex.current = history.current.length - 1;
    } else if (historyIndex.current < 0) {
      history.current.push(snapshot);
      historyIndex.current = 0;
    }
    restoringHistory.current = false;
  });

  function keyDown(event: KeyboardEvent) {
    if (attributes.disabled) return;
    if (composing.current || imeActive || event.nativeEvent.isComposing || event.keyCode === 229) { onKeyDown(event); return; }
    if ((event.target as Element).closest('[data-inline-skill]')) {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); change(value, null); }
      return;
    }
    if (!composing.current && (event.metaKey || event.ctrlKey) && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
      event.preventDefault();
      const forward = event.shiftKey || event.key.toLowerCase() === 'y';
      const index = historyIndex.current + (forward ? 1 : -1);
      const snapshot = history.current[index];
      if (snapshot) {
        restoringHistory.current = true;
        historyIndex.current = index;
        change(snapshot.text, snapshot.skill, snapshot);
      }
      return;
    }
    if (rich.current && skill && !composing.current && (event.key === 'Backspace' || event.key === 'Delete')) {
      const selected = window.getSelection();
      const atom = rich.current.querySelector('[data-inline-skill]');
      if (selected?.isCollapsed && selected.rangeCount && atom) {
        const current = selected.getRangeAt(0);
        const adjacent = document.createRange();
        adjacent.selectNodeContents(rich.current);
        if (event.key === 'Backspace') { adjacent.setStartAfter(atom); adjacent.setEnd(current.startContainer, current.startOffset); }
        else { adjacent.setStart(current.startContainer, current.startOffset); adjacent.setEndBefore(atom); }
        const correctSide = event.key === 'Backspace'
          ? current.comparePoint(atom.parentNode!, Array.from(atom.parentNode!.childNodes).indexOf(atom) + 1) <= 0
          : current.comparePoint(atom.parentNode!, Array.from(atom.parentNode!.childNodes).indexOf(atom)) >= 0;
        if (correctSide && read(adjacent.cloneContents()).text === '') {
          event.preventDefault();
          change(value, null);
          return;
        }
      }
    }
    syncSelection();
    onKeyDown(event);
    if (rich.current && event.key === 'Enter' && !event.defaultPrevented && !composing.current && !event.nativeEvent.isComposing) {
      event.preventDefault();
      insertText('\n');
    }
  }
  function copySelection(event: ClipboardEvent, cut = false) {
    const root = rich.current;
    const selected = window.getSelection();
    if (!root || !selected?.rangeCount || !root.contains(selected.anchorNode) || !root.contains(selected.focusNode)) return;
    const range = selected.getRangeAt(0);
    const copy = range.cloneContents();
    copy.querySelectorAll<HTMLElement>('[data-inline-skill]').forEach((atom) => atom.replaceWith(document.createTextNode(`/${atom.dataset.inlineSkill}`)));
    event.clipboardData.setData('text/plain', read(copy).text);
    event.preventDefault();
    if (cut && !attributes.disabled) {
      range.deleteContents();
      const result = read(root);
      change(result.text, skill && result.offset !== null ? { ...skill, offset: result.offset } : null);
    }
  }
  const shared = {
    onKeyDown: keyDown,
    onCompositionStart: (event: CompositionEvent) => { composing.current = true; setRichComposing(rich.current !== null); onCompositionStart(event); },
    onCompositionEnd: (event: CompositionEvent) => { composing.current = false; setRichComposing(false); onCompositionEnd(event); },
    onPaste: (event: ClipboardEvent) => {
      onPaste(event);
      if (rich.current && !event.defaultPrevented) { event.preventDefault(); insertText(event.clipboardData.getData('text/plain')); }
    },
    onCopy: (event: ClipboardEvent) => copySelection(event),
    onCut: (event: ClipboardEvent) => copySelection(event, true),
    onSelect: syncSelection,
    onKeyUp: syncSelection,
    onBlur: syncSelection,
  };
  if (!skill && !richComposing) return <Textarea {...attributes} {...shared} ref={plain} data-chat-composer value={value} rows={rows}
    className={`border-0 rounded-none p-0 focus:ring-0 ${className}`}
    onClick={syncSelection}
    onChange={(event) => { caret.current = selection(); onChange(event.currentTarget.value, null); onSelect(); }} />;
  return <div {...shared} ref={rich} role="textbox" aria-multiline="true" aria-label={attributes.placeholder}
    aria-autocomplete={attributes['aria-autocomplete']} aria-expanded={attributes['aria-expanded']}
    aria-controls={attributes['aria-controls']} aria-activedescendant={attributes['aria-activedescendant']}
    aria-disabled={attributes.disabled} data-chat-composer contentEditable={!attributes.disabled} suppressContentEditableWarning
    className={`w-full whitespace-pre-wrap break-words overflow-y-auto ${className}`}
    onMouseDown={(event) => { if ((event.target as Element).closest('[data-inline-skill]')) event.preventDefault(); }}
    onClick={(event) => {
      if ((event.target as Element).closest('[data-inline-skill]') && !attributes.disabled) change(value, null);
      else syncSelection();
    }}
    onInput={() => {
      const result = read(rich.current!);
      caret.current = selection();
      // Keep native DOM and selection during IME and ordinary edits. Reconcile
      // only external changes, so React never replaces the composition node.
      onChange(result.text, !skill || result.offset === null ? null : { ...skill, offset: result.offset });
      onSelect();
    }} />;
}
