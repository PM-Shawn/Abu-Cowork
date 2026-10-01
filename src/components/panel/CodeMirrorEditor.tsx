import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { langs } from '@uiw/codemirror-extensions-langs';
import type { Extension } from '@codemirror/state';
import { CODE_EDITOR_THEME } from './codeMirrorTheme';

/**
 * Aliases for file extensions whose CodeMirror language doesn't share the
 * same key as `@uiw/codemirror-extensions-langs`'s own vocabulary (mostly
 * file-extension keyed already — `ts`, `tsx`, `py`, `md`, `yml`, `html`, ...).
 * Anything not covered here or by the library itself degrades to no language
 * extension (plain text highlighting) rather than throwing.
 */
const LANG_ALIASES: Record<string, string> = {
  zsh: 'bash',
};

type LangFactoryMap = Record<string, (() => Extension) | undefined>;

function resolveLanguageExtensions(language: string): Extension[] {
  const key = LANG_ALIASES[language] ?? language;
  const factory = (langs as LangFactoryMap)[key];
  if (typeof factory !== 'function') return [];
  try {
    return [factory()];
  } catch {
    // Defensive: never let an unrecognized/broken language extension crash the editor.
    return [];
  }
}

const BASIC_SETUP = { lineNumbers: true, foldGutter: true, highlightActiveLine: true };
const READ_ONLY_SETUP = { lineNumbers: true, foldGutter: true, highlightActiveLine: false };

/**
 * Inline editable source view used by PreviewPanel for html/markdown "source"
 * mode and for code/text files (which have no rendered preview at all).
 * Wraps `@uiw/react-codemirror`. Every color, the font and the type size come
 * from `codeMirrorTheme.ts`, which reads design tokens, so the editor follows
 * light, dark and increased contrast without checking the appearance itself.
 */
export default function CodeMirrorEditor({
  value,
  language,
  onChange,
  readOnly = false,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => [...CODE_EDITOR_THEME, ...resolveLanguageExtensions(language)], [language]);

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme="none"
      extensions={extensions}
      readOnly={readOnly}
      height="100%"
      basicSetup={readOnly ? READ_ONLY_SETUP : BASIC_SETUP}
      className="h-full"
    />
  );
}
