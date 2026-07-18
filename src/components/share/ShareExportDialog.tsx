/**
 * ShareExportDialog — preview-before-export UI for conversation sharing.
 *
 * The dialog mounts in "loading" state, builds the ShareBundle via
 * `chatStore.exportConversationForShare`, then renders three panels:
 *   1. Visibility summary (what the recipient will / will not see)
 *   2. Redaction summary (how many credentials / paths got replaced)
 *   3. Lightweight message preview (text-only — not a full MessageBubble)
 *
 * Clicking "Export" triggers a Tauri save-dialog and writes the JSON.
 * Cancel / backdrop click dismisses without writing anything.
 */

import { useEffect, useState } from 'react';
import { X, Eye, EyeOff, Download, ShieldAlert, Wrench, MessageSquare } from 'lucide-react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useChatStore } from '@/stores/chatStore';
import { useI18n, format } from '@/i18n';
import { serializeShareBundle, type ShareBundle } from '@/core/session/shareBundle';
import type { Message, MessageContent, ToolCall } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import abuAvatar from '@/assets/abu-avatar.png';

interface ShareExportDialogProps {
  convId: string;
  defaultFilename: string;
  onClose: () => void;
}

type DialogState =
  | { phase: 'loading' }
  | { phase: 'ready'; bundle: ShareBundle }
  | { phase: 'error'; message: string };

export default function ShareExportDialog({ convId, defaultFilename, onClose }: ShareExportDialogProps) {
  const { t } = useI18n();
  const exportForShare = useChatStore((s) => s.exportConversationForShare);
  const [state, setState] = useState<DialogState>({ phase: 'loading' });
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    exportForShare(convId, {
      signal: controller.signal,
      onProgress: (done, total) => { if (!cancelled) setProgress({ done, total }); },
    })
      .then((bundle) => {
        if (cancelled) return;
        if (!bundle) {
          setState({ phase: 'error', message: 'conversation not found' });
          return;
        }
        setState({ phase: 'ready', bundle });
      })
      .catch((err: unknown) => {
        // Ignore the abort we triggered on unmount.
        if (cancelled || controller.signal.aborted) return;
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [convId, exportForShare]);

  const handleExport = async () => {
    if (state.phase !== 'ready' || exporting) return;
    setExporting(true);
    try {
      const filePath = await saveDialog({
        defaultPath: defaultFilename,
        filters: [{ name: 'Abu Conversation', extensions: ['json'] }],
      });
      if (filePath) {
        await writeTextFile(filePath, serializeShareBundle(state.bundle));
        onClose();
      }
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-[760px] max-h-[85vh] flex flex-col animate-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-[var(--abu-border)]">
          <div>
            <h3 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
              {t.share.exportDialogTitle}
            </h3>
            <p className="text-minor text-[var(--abu-text-tertiary)] mt-0.5">
              {t.share.tierStandard} — {t.share.tierNote}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-[var(--abu-bg-hover)] text-[var(--abu-text-tertiary)]"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {state.phase === 'loading' && (
            <div className="py-8 flex flex-col items-center gap-3">
              <div className="text-body text-[var(--abu-text-tertiary)]">
                {progress ? `${t.share.loading} ${progress.done}/${progress.total}` : t.share.loading}
              </div>
              {progress && progress.total > 0 && (
                <div className="w-2/3 h-1 rounded-full bg-[var(--abu-bg-active)] overflow-hidden">
                  <div
                    className="h-full bg-[var(--abu-clay)] transition-[width] duration-150"
                    style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {state.phase === 'error' && (
            <div className="text-body text-[var(--abu-danger)] py-8 text-center">
              {format(t.share.exportError, { error: state.message })}
            </div>
          )}
          {state.phase === 'ready' && <BundlePreview bundle={state.bundle} />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-[var(--abu-border)]">
          <div className="text-minor text-[var(--abu-text-tertiary)]">
            {state.phase === 'ready' && (
              <StatsLine bundle={state.bundle} />
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-md text-body text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]"
            >
              {t.share.cancel}
            </button>
            <button
              onClick={handleExport}
              disabled={state.phase !== 'ready' || exporting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--abu-clay)] text-white text-body hover:bg-[var(--abu-clay-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="h-3.5 w-3.5" />
              {t.share.exportBtn}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Inner sections
// ───────────────────────────────────────────────────────────────────────────

function BundlePreview({ bundle }: { bundle: ShareBundle }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      {/* Visibility summary */}
      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-[var(--abu-border)] p-3">
          <div className="flex items-center gap-1.5 mb-2 text-body font-medium text-[var(--abu-text-primary)]">
            <Eye className="h-3.5 w-3.5 text-[var(--abu-success)]" />
            {t.share.visibleToOthers}
          </div>
          <ul className="space-y-1 text-minor text-[var(--abu-text-secondary)]">
            <li>✅ {t.share.itemMessages}</li>
            <li>✅ {t.share.itemToolCalls}</li>
          </ul>
        </div>
        <div className="rounded-lg border border-[var(--abu-border)] p-3">
          <div className="flex items-center gap-1.5 mb-2 text-body font-medium text-[var(--abu-text-primary)]">
            <EyeOff className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)]" />
            {t.share.hiddenFromOthers}
          </div>
          <ul className="space-y-1 text-minor text-[var(--abu-text-secondary)]">
            <li>❌ {t.share.itemUserFiles}</li>
            <li>❌ {t.share.itemCredentials}</li>
            <li>❌ {t.share.itemAiGenerated}</li>
          </ul>
        </div>
      </section>

      {/* Redaction summary */}
      <section className="rounded-lg border border-[var(--abu-border)] p-3">
        <div className="flex items-center gap-1.5 mb-2 text-body font-medium text-[var(--abu-text-primary)]">
          <ShieldAlert className="h-3.5 w-3.5 text-[var(--abu-warning)]" />
          {t.share.redactionTitle}
          {bundle.stats.redactionCount > 0 && (
            <span className="text-minor text-[var(--abu-text-tertiary)] ml-1">
              · {format(t.share.redactionCount, { count: bundle.stats.redactionCount })}
            </span>
          )}
        </div>
        {bundle.stats.redactionCount === 0 ? (
          <p className="text-minor text-[var(--abu-text-tertiary)]">{t.share.noRedaction}</p>
        ) : (
          <ul className="space-y-0.5 text-minor text-[var(--abu-text-secondary)] font-mono">
            {summarizeRedactionKinds(bundle).map((line) => (
              <li key={line}>• {line}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Message preview — mirrors ChatView's bubble layout (user right, assistant
          left with Abu avatar) so the recipient sees the same visual they would
          in a live conversation. */}
      <section className="rounded-lg border border-[var(--abu-border)] p-3">
        <div className="flex items-center gap-1.5 mb-3 text-body font-medium text-[var(--abu-text-primary)]">
          <MessageSquare className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
          {t.share.previewTitle}
        </div>
        {bundle.messages.length === 0 ? (
          <p className="text-minor text-[var(--abu-text-tertiary)]">{t.share.previewEmpty}</p>
        ) : (
          <div className="flex flex-col gap-4 max-h-[420px] overflow-y-auto px-3 py-3 bg-[var(--abu-bg-base)] rounded-md">
            {bundle.messages.slice(0, 50).map((msg) => (
              <SharePreviewMessage key={msg.id} message={msg} />
            ))}
            {bundle.messages.length > 50 && (
              <p className="text-caption text-[var(--abu-text-muted)] text-center pt-1">
                … {bundle.messages.length - 50} more
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Static, read-only message row that mirrors MessageBubble's visual
 * language (right-aligned grey bubble for the user, avatar + transparent
 * background for the assistant). Interaction-heavy affordances — edit,
 * regenerate, copy, full ExecutionStep timelines — are intentionally
 * dropped to keep the preview a faithful visual snapshot without turning
 * the dialog into a second chat surface.
 */
function SharePreviewMessage({ message }: { message: Message }) {
  const { text, imageCount, otherCount } = flattenContent(message.content);
  // Preview truncation — large enough that most messages fit whole but
  // caps runaway cell-output paste-ins from bloating the dialog.
  const truncated = text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  const toolCalls = message.toolCalls ?? [];

  if (message.role === 'user') {
    return (
      <div className="flex justify-end w-full">
        <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
          {(imageCount > 0 || otherCount > 0) && (
            <AttachmentSummary imageCount={imageCount} otherCount={otherCount} align="right" />
          )}
          {truncated && (
            <div className="px-4 py-2.5 rounded-2xl rounded-br-sm bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]">
              <div className="text-body leading-relaxed break-words">
                <MarkdownRenderer content={truncated} variant="user" />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Assistant / system — left-aligned with Abu avatar.
  return (
    <div className="flex gap-3 w-full">
      <img src={abuAvatar} alt="" className="h-7 w-7 rounded-full shrink-0 mt-1 object-cover" />
      <div className="flex-1 min-w-0 flex flex-col gap-2">
        {toolCalls.map((tc, i) => (
          <ToolCallPreviewCard key={tc.id ?? `${tc.name}-${i}`} toolCall={tc} />
        ))}
        {truncated && (
          <div className="text-body leading-relaxed text-[var(--abu-text-primary)] break-words">
            <MarkdownRenderer content={truncated} variant="assistant" />
          </div>
        )}
        {(imageCount > 0 || otherCount > 0) && (
          <AttachmentSummary imageCount={imageCount} otherCount={otherCount} align="left" />
        )}
      </div>
    </div>
  );
}

function AttachmentSummary({
  imageCount,
  otherCount,
  align,
}: {
  imageCount: number;
  otherCount: number;
  align: 'left' | 'right';
}) {
  return (
    <div
      className={`flex gap-2 text-caption text-[var(--abu-text-tertiary)] ${align === 'right' ? 'justify-end' : 'justify-start'}`}
    >
      {imageCount > 0 && <span>🖼️ × {imageCount}</span>}
      {otherCount > 0 && <span>📄 × {otherCount}</span>}
    </div>
  );
}

function ToolCallPreviewCard({ toolCall }: { toolCall: ToolCall }) {
  const { t } = useI18n();
  // Only string tool results are safe to eyeball — rich content (images,
  // structured blocks) is rare enough in preview context that we skip it.
  const resultSnippet =
    typeof toolCall.result === 'string' && toolCall.result.length > 0
      ? toolCall.result.length > 240
        ? `${toolCall.result.slice(0, 240)}…`
        : toolCall.result
      : null;

  return (
    <div className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-3 py-2 text-body">
      <div className="flex items-center gap-1.5 font-medium text-[var(--abu-text-secondary)]">
        <Wrench className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
        <span>{t.task.calledTool}</span>
        <code className="font-mono text-minor px-1.5 py-0.5 rounded bg-[var(--abu-bg-muted)] text-[var(--abu-text-primary)]">
          {toolCall.name}
        </code>
      </div>
      {resultSnippet && (
        <div className="mt-1.5 pl-5 text-minor text-[var(--abu-text-tertiary)] font-mono whitespace-pre-wrap break-words max-h-24 overflow-hidden">
          {resultSnippet}
        </div>
      )}
    </div>
  );
}

function StatsLine({ bundle }: { bundle: ShareBundle }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <span>{format(t.share.statsMessages, { count: bundle.messages.length })}</span>
      <span>·</span>
      <span>{format(t.share.statsAttachments, { count: bundle.stats.attachmentCount })}</span>
      <span>·</span>
      <span>{format(t.share.statsSize, { size: formatBytes(bundle.stats.sizeBytes) })}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

function flattenContent(content: string | MessageContent[]): { text: string; imageCount: number; otherCount: number } {
  if (typeof content === 'string') return { text: content, imageCount: 0, otherCount: 0 };
  let text = '';
  let imageCount = 0;
  let otherCount = 0;
  for (const block of content) {
    if (block.type === 'text') text += (text ? '\n' : '') + block.text;
    else if (block.type === 'image') imageCount += 1;
    else otherCount += 1;
  }
  return { text, imageCount, otherCount };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Group redaction sample kinds with counts, e.g. "anthropic-key · 2". */
function summarizeRedactionKinds(bundle: ShareBundle): string[] {
  // We don't have per-kind counts in stats (only total), but we can at least
  // surface that N redactions happened. If the bundle grows to include per-
  // sample breakdown later, this is where to expand. For now, show a single
  // aggregated line.
  return [`${bundle.stats.redactionCount} × credential / path occurrence(s)`];
}
