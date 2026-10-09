import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { tags } from '@lezer/highlight';

// CodeMirror theme for the preview's source view. Colors are CSS variables, so light, dark and
// increased contrast come from tokens.css; the highlight colors are the chat code blocks' colors.
// CodeMirror's base theme carries fixed light colors; every rule it would show in the editor
// (focused selection, bracket match, word matches, completion list, search bar) is set here.
const token = (name: string) => `var(--ds-${name})`;
const hairline = (name: string) => `1px solid ${token(name)}`;

export const EDITOR_THEME_SPEC = {
  '&': { height: '100%', color: token('label'), backgroundColor: token('surface'), fontSize: 'var(--text-mono)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': { fontFamily: token('font-mono'), lineHeight: 'var(--text-mono--line-height)', caretColor: token('label') },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: token('label') },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: token('selection') },
  '.cm-gutters': { backgroundColor: token('surface'), color: token('label-tertiary'), borderRight: hairline('separator') },
  '.cm-activeLine': { backgroundColor: token('fill-hover') },
  '.cm-activeLineGutter': { backgroundColor: token('fill-hover'), color: token('label-secondary') },
  '.cm-foldPlaceholder': { backgroundColor: token('fill'), color: token('label-secondary'), border: 'none' },
  '.cm-selectionMatch': { backgroundColor: token('fill-selected') },
  // A search match can lie inside a selection on the active line; a third fill there drops
  // highlight colors under 3:1 in dark, so matches get a hairline and no fill.
  '.cm-searchMatch, .cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'transparent', outline: hairline('control-border') },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: token('fill-selected'), color: token('label') },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: token('danger-soft') },
  '.cm-snippetField': { backgroundColor: token('fill') },
  '.cm-snippetFieldPosition': { borderLeftColor: token('label-tertiary') },
  '.cm-specialChar': { color: token('danger') },
  '.cm-tooltip': { backgroundColor: token('raised'), color: token('label'), border: hairline('separator') },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: token('fill-selected'), color: token('label') },
  '.cm-panels': { backgroundColor: token('surface'), color: token('label') },
  '.cm-panels-top': { borderBottom: hairline('separator') },
  '.cm-panels-bottom': { borderTop: hairline('separator') },
  '.cm-button': { backgroundImage: 'none', backgroundColor: token('fill'), border: hairline('control-border') },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: token('fill-pressed') },
  '.cm-textfield': { backgroundColor: token('field'), border: hairline('control-border') },
} as const;

export const EDITOR_HIGHLIGHT_SPECS = [
  { tag: tags.comment, color: token('syntax-comment') },
  { tag: [tags.keyword, tags.bool, tags.null, tags.atom, tags.modifier, tags.controlKeyword], color: token('syntax-keyword') },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.url], color: token('syntax-string') },
  { tag: [tags.number, tags.integer, tags.float], color: token('syntax-number') },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.className, tags.typeName], color: token('syntax-function') },
  { tag: [tags.propertyName, tags.tagName, tags.attributeName, tags.namespace], color: token('syntax-property') },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: token('label-secondary') },
  { tag: tags.heading, color: token('label'), fontWeight: '600' },
  { tag: tags.link, color: token('link') },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.inserted, color: token('success') },
  { tag: tags.deleted, color: token('danger') },
];

export const CODE_EDITOR_THEME: Extension[] = [
  EditorView.theme(EDITOR_THEME_SPEC),
  syntaxHighlighting(HighlightStyle.define(EDITOR_HIGHLIGHT_SPECS)),
];
