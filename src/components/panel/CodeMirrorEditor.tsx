import CodeMirror from '@uiw/react-codemirror';
import { langs } from '@uiw/codemirror-extensions-langs';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';

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

/**
 * Inline editable source view used by PreviewPanel for html/markdown "source"
 * mode and for code/text files (which have no rendered preview at all).
 * Wraps `@uiw/react-codemirror` with the project's dark theme so it matches
 * the existing read-only `SyntaxHighlighter` (oneDark) look.
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
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      theme={oneDark}
      extensions={resolveLanguageExtensions(language)}
      readOnly={readOnly}
      height="100%"
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly }}
      className="h-full text-[12px]"
    />
  );
}
