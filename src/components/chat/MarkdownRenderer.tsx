import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import { useState, memo, useMemo, useCallback, Suspense, type ReactNode } from 'react';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SearchResult } from '@/types';
import { usePreviewStore } from '@/stores/previewStore';
import { getBaseName } from '@/utils/pathUtils';
import type { FileMention } from '@/utils/turnFileMentions';
import { Button, IconButton } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { Link } from '@/components/ds/link';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';

import { getCodeBlockRenderer } from './codeBlockRenderers';
import { closeOpenFences } from './markdownUtils';
import { SYNTAX_THEME } from './syntaxTheme';

SyntaxHighlighter.registerLanguage('tsx', tsx);
SyntaxHighlighter.registerLanguage('typescript', tsx);
SyntaxHighlighter.registerLanguage('javascript', tsx);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('markdown', markdown);

// --- Citation utilities ---

const CITATION_REGEX = /\[(\d{1,2})\]/g;

/** Inline citation badge — small grounded pill that sits on the text baseline */
function CitationBadge({ index, title, onClick }: {
  index: number;
  title?: string;
  onClick?: (index: number) => void;
}) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(index);
  };
  return (
    <Pressable
      onClick={handleClick}
      aria-label={title ? `[${index}] ${title}` : String(index)}
      className="mx-1 inline-flex items-center justify-center rounded-control bg-fill px-1 align-baseline text-caption text-label-secondary transition-colors duration-fast hover:bg-fill-hover"
    >
      {index}
    </Pressable>
  );
}

/** Split text to replace [1]-style citation markers with CitationBadge components */
function splitTextWithCitations(
  text: string,
  searchResults: SearchResult[],
  onCitationClick?: (index: number) => void
): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let keyIdx = 0;

  CITATION_REGEX.lastIndex = 0;
  let match;
  while ((match = CITATION_REGEX.exec(text)) !== null) {
    const citNum = parseInt(match[1], 10);
    if (citNum < 1 || citNum > searchResults.length) continue;

    const idx = match.index;
    if (idx > lastIndex) {
      parts.push(text.slice(lastIndex, idx));
    }
    parts.push(
      <CitationBadge
        key={`cite-${keyIdx++}`}
        index={citNum}
        title={searchResults[citNum - 1]?.title}
        onClick={onCitationClick}
      />
    );
    lastIndex = idx + match[0].length;
  }

  if (parts.length === 0) return [text];
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

/** Process a single text node: split by paths, then optionally by citations */
function splitTextNode(
  text: string,
  searchResults: SearchResult[] | null,
  onCitationClick?: (index: number) => void
): ReactNode[] {
  let parts: ReactNode[] = [text];
  if (searchResults && searchResults.length > 0) {
    const expanded: ReactNode[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        expanded.push(...splitTextWithCitations(part, searchResults, onCitationClick));
      } else {
        expanded.push(part);
      }
    }
    parts = expanded;
  }
  return parts;
}

/** Process react-markdown children: detect file paths and citations in text nodes */
function processChildren(
  children: ReactNode,
  searchResults: SearchResult[] | null,
  onCitationClick?: (index: number) => void
): ReactNode {
  if (typeof children === 'string') {
    const parts = splitTextNode(children, searchResults, onCitationClick);
    return parts.length === 1 ? parts[0] : parts;
  }
  if (!Array.isArray(children)) return children;

  let modified = false;
  const result: ReactNode[] = [];

  for (const child of children) {
    if (typeof child === 'string') {
      const parts = splitTextNode(child, searchResults, onCitationClick);
      if (parts.length > 1 || parts[0] !== child) {
        modified = true;
        result.push(...parts);
      } else {
        result.push(child);
      }
    } else {
      result.push(child);
    }
  }

  return modified ? result : children;
}

// --- Language to file extension map ---
const LANG_EXT_MAP: Record<string, string> = {
  typescript: '.ts', tsx: '.tsx', javascript: '.js', jsx: '.jsx',
  python: '.py', bash: '.sh', shell: '.sh', json: '.json',
  html: '.html', css: '.css', sql: '.sql', rust: '.rs',
  go: '.go', java: '.java', kotlin: '.kt', swift: '.swift',
  ruby: '.rb', php: '.php', yaml: '.yml', toml: '.toml',
  xml: '.xml', markdown: '.md', c: '.c', cpp: '.cpp',
};

const COLLAPSE_THRESHOLD = 15;

// Memoized: ReactMarkdown rebuilds its tree on every streamed token, and a finished block
// (with its toolbar tooltips) should not re-render while the text after it grows.
export const CollapsibleCodeBlock = memo(function CollapsibleCodeBlock({ codeString, language }: { codeString: string; language: string | null }) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(true);
  const [copied, setCopied] = useState(false);

  const lineCount = codeString.split('\n').length;
  const shouldCollapse = lineCount > COLLAPSE_THRESHOLD;
  const isCollapsed = shouldCollapse && collapsed;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [codeString]);

  const handleSaveAs = useCallback(async () => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const ext = (language && LANG_EXT_MAP[language]) || '.txt';
      const filePath = await save({
        defaultPath: `code${ext}`,
        filters: [{ name: 'Code File', extensions: [ext.slice(1)] }],
      });
      if (filePath) {
        await writeTextFile(filePath, codeString);
        // Snapshot the saved file so it survives later user-initiated deletion.
        // Fire-and-forget; never block the save flow.
        const { useChatStore } = await import('@/stores/chatStore');
        const convId = useChatStore.getState().activeConversationId;
        if (convId) {
          import('@/core/session/outputSnapshots').then(({ snapshotCodeBlockSave }) => {
            snapshotCodeBlockSave(convId, filePath, language ?? undefined).catch(() => {});
          }).catch(() => {});
        }
      }
    } catch { /* ignore in non-Tauri env */ }
  }, [codeString, language]);

  return (
    <div className="relative my-3 max-w-full overflow-hidden rounded-panel bg-code">
      {/* Code area */}
      <div className="relative">
        <div
          style={
            isCollapsed
              ? { maxHeight: '360px', overflow: 'hidden' }
              : { maxHeight: '70vh', overflow: 'auto' }
          }
        >
          <SyntaxHighlighter
            style={SYNTAX_THEME}
            language={language || 'text'}
            PreTag="div"
            wrapLongLines={true}
            customStyle={{
              margin: 0,
              borderRadius: 0,
              padding: '12px 16px',
              overflowX: 'auto',
              maxWidth: '100%',
              background: 'var(--ds-code)',
              fontSize: 'var(--text-mono)',
              lineHeight: 'var(--text-mono--line-height)',
            }}
            codeTagProps={{ style: { background: 'transparent' } }}
          >
            {codeString}
          </SyntaxHighlighter>
        </div>
        {/* Gradient overlay when collapsed */}
        {isCollapsed && (
          <div className="absolute bottom-0 left-0 right-0 flex h-20 items-end justify-center bg-gradient-to-t from-code to-transparent pb-2">
            <Button variant="secondary" size="sm" icon={AppIcons.expand} onClick={() => setCollapsed(false)}>
              {format(t.chat.codeBlockExpand, { lines: String(lineCount) })}
            </Button>
          </div>
        )}
      </div>
      {/* Bottom toolbar — always visible */}
      <div className="flex items-center justify-between border-t border-separator bg-code px-3 py-1 text-ui-sm text-label-secondary">
        <div className="flex items-center gap-2">
          {language && <span>{language}</span>}
          {shouldCollapse && !isCollapsed && (
            <Button variant="plain" size="sm" icon={AppIcons.collapse} onClick={() => setCollapsed(true)}>
              {t.chat.codeBlockCollapse}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <IconButton
            size="sm"
            icon={copied ? AppIcons.done : AppIcons.copy}
            label={t.chat.copy}
            onClick={handleCopy}
            className={cn(copied && 'text-success hover:text-success')}
          />
          <IconButton size="sm" icon={AppIcons.download} label={t.chat.codeBlockSaveAs} onClick={handleSaveAs} />
        </div>
      </div>
    </div>
  );
});

// Placeholder while a diagram or widget renderer chunk loads. A component of its own
// because the markdown `code` override is a plain function and cannot call hooks.
function CodeRendererLoading() {
  const { t } = useI18n();
  return (
    <div className="my-3 flex justify-center rounded-panel bg-code p-6">
      <Spinner label={t.common.loading} />
    </div>
  );
}

// closeOpenFences moved to ./markdownUtils.ts so non-component utilities can
// be imported and unit-tested without tripping react-refresh/only-export-components.

// Stable references — avoid recreating on every render.
// `singleTilde: false` — a lone `~` must NOT become strikethrough. Chinese
// chat text uses `~` as a casual tone softener ("好的~", "操作了~"), and
// remark-gfm's default (`singleTilde: true`) turns any two of them in one
// message into a <del> span over the text between them. Require `~~` for
// strikethrough instead.
const remarkPluginsStable: PluggableList = [[remarkGfm, { singleTilde: false }], remarkBreaks];
const SAFE_URL_PATTERN = /^(https?:\/\/|mailto:|tel:|#)/i;

type MarkdownVariant = 'assistant' | 'user';
type FileMentionResolver = (text: string) => FileMention | null;

// react-markdown reads the drive letter of `C:/…` as a URL scheme and empties the
// link target; a drive path is kept so it can be matched against the turn's files.
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;
function keepLocalPathTargets(url: string): string {
  return WINDOWS_DRIVE_PATH.test(url) ? url : defaultUrlTransform(url);
}

/** A file name or path in a reply that opens the file in the side preview. */
function FileMentionButton({ mention, children }: { mention: FileMention; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <Pressable
      onClick={() => usePreviewStore.getState().openPreview(mention.path, { line: mention.line })}
      aria-label={format(t.chat.openFileInPreview, { name: getBaseName(mention.path) })}
      className="inline max-w-full break-all rounded-control text-left text-link underline-offset-2 hover:underline"
    >
      {children}
    </Pressable>
  );
}

/** Build markdown component overrides, optionally citation-aware and file-mention-aware */
function buildMarkdownComponents(
  searchResults: SearchResult[] | null,
  onCitationClick?: (index: number) => void,
  variant: MarkdownVariant = 'assistant',
  resolveFileMention?: FileMentionResolver,
) {
  const sr = searchResults && searchResults.length > 0 ? searchResults : null;
  const isUser = variant === 'user';
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code({ className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const codeString = String(children).replace(/\n$/, '');
      const isInline = !match && !codeString.includes('\n');

      if (isInline) {
        const mention = resolveFileMention ? resolveFileMention(codeString) : null;
        if (mention) {
          return (
            <FileMentionButton mention={mention}>
              <code className="rounded-control bg-code px-1 font-code text-code-inline text-link">{children}</code>
            </FileMentionButton>
          );
        }
        // Detect hex color codes and show a swatch
        const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(codeString.trim());
        return (
          <code className="rounded-control bg-code px-1 font-code text-code-inline text-label" {...props}>
            {hexMatch && (
              <span
                className="mr-1 inline-block size-3 rounded-full border border-separator align-middle"
                style={{ backgroundColor: hexMatch[0] }}
              />
            )}
            {children}
          </code>
        );
      }

      const renderer = match?.[1] ? getCodeBlockRenderer(match[1]) : undefined;
      if (renderer) {
        const BlockComponent = renderer.component;
        return (
          <Suspense fallback={<CodeRendererLoading />}>
            <BlockComponent code={codeString} />
          </Suspense>
        );
      }

      return (
        <CollapsibleCodeBlock
          codeString={codeString}
          language={match?.[1] || null}
        />
      );
    },

    img() {
      return null;
    },
    p({ children }: { children?: ReactNode }) {
      return <p className={isUser ? 'my-1 text-body text-label' : 'my-2 text-body text-label'}>{processChildren(children, sr, onCitationClick)}</p>;
    },
    h1({ children }: { children?: ReactNode }) {
      return <h1 className="mt-5 mb-2 text-h1 text-label">{children}</h1>;
    },
    h2({ children }: { children?: ReactNode }) {
      return <h2 className="mt-4 mb-2 text-h2 text-label">{children}</h2>;
    },
    h3({ children }: { children?: ReactNode }) {
      return <h3 className="mt-3 mb-1 text-h3 text-label">{children}</h3>;
    },
    ul({ children }: { children?: ReactNode }) {
      return <ul className="my-2 pl-6 list-outside list-disc space-y-1">{children}</ul>;
    },
    ol({ children }: { children?: ReactNode }) {
      return <ol className="my-2 pl-6 list-outside list-decimal space-y-1">{children}</ol>;
    },
    li({ children }: { children?: ReactNode }) {
      return <li className="text-body text-label">{processChildren(children, sr, onCitationClick)}</li>;
    },
    blockquote({ children }: { children?: ReactNode }) {
      return (
        <blockquote className="my-3 border-l-2 border-control-border pl-3 text-label-secondary">
          {children}
        </blockquote>
      );
    },
    a({ href, children }: { href?: string; children?: ReactNode }) {
      // A target that is no web address may be a local path of this turn's files.
      const mention = resolveFileMention && href && !SAFE_URL_PATTERN.test(href) ? resolveFileMention(href) : null;
      if (mention) return <FileMentionButton mention={mention}>{children}</FileMentionButton>;
      const safeHref = SAFE_URL_PATTERN.test(href ?? '') ? href : undefined;
      return (
        <Link
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
          className={isUser ? 'text-label underline decoration-control-border' : undefined}
        >
          {children}
        </Link>
      );
    },
    strong({ children }: { children?: ReactNode }) {
      return <strong className="font-semibold text-label">{children}</strong>;
    },
    table({ children }: { children?: ReactNode }) {
      return (
        <div className="my-3 overflow-x-auto rounded-panel border border-separator">
          <table className="min-w-full text-body">{children}</table>
        </div>
      );
    },
    thead({ children }: { children?: ReactNode }) {
      return <thead className="bg-code">{children}</thead>;
    },
    th({ children }: { children?: ReactNode }) {
      return <th className="min-w-20 px-3 py-2 text-left align-top font-medium text-label">{children}</th>;
    },
    td({ children }: { children?: ReactNode }) {
      return <td className="min-w-20 border-t border-separator px-3 py-2 align-top text-label">{children}</td>;
    },
    hr() {
      return <hr className="my-4 border-separator" />;
    },
  };
}

// Stable references for the default (no citations) cases
const defaultAssistantComponents = buildMarkdownComponents(null, undefined, 'assistant');
const defaultUserComponents = buildMarkdownComponents(null, undefined, 'user');

interface MarkdownRendererProps {
  content: string;
  searchResults?: SearchResult[];
  onCitationClick?: (index: number) => void;
  variant?: MarkdownVariant;
  /**
   * Names the file of the turn that an inline code span or a link target refers
   * to; such a span or link opens that file in the side preview. Pass a stable
   * function: a new one rebuilds every rendered node.
   */
  resolveFileMention?: FileMentionResolver;
}

export default memo(function MarkdownRenderer({ content, searchResults, onCitationClick, variant = 'assistant', resolveFileMention }: MarkdownRendererProps) {
  const components = useMemo(
    () => ((searchResults && searchResults.length > 0) || resolveFileMention)
      ? buildMarkdownComponents(searchResults ?? null, onCitationClick, variant, resolveFileMention)
      : variant === 'user' ? defaultUserComponents : defaultAssistantComponents,
    [searchResults, onCitationClick, variant, resolveFileMention]
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPluginsStable}
      components={components}
      urlTransform={resolveFileMention ? keepLocalPathTargets : undefined}
    >
      {closeOpenFences(content)}
    </ReactMarkdown>
  );
});
