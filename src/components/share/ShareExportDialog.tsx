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
 * Cancel, Escape, the corner button and a press outside dismiss without writing anything.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Button } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Spinner } from '@/components/ds/spinner';
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

  // The owner mounts this window to open it and takes it off the page when told it has closed.
  // The window closes itself first and tells the owner once it has left the page, so it fades
  // out like every other window. It never opens again: the next export is a new window.
  const [open, setOpen] = useState(true);
  const isOpen = useRef(true);
  const onCloseRef = useRef(onClose);
  // The content of the window; present while the window is on the page, hidden or not.
  const contentRef = useRef<HTMLDivElement>(null);
  const told = useRef(false);
  // True once the owner has taken this window off the page. Its close-focus hook still runs a
  // moment later, and the owner's `onClose` would then close whatever window is there by then
  // (the export window of another conversation): a removed window tells nobody.
  const removed = useRef(false);
  useEffect(() => {
    removed.current = false;
    return () => { removed.current = true; };
  }, []);
  const tellOwner = () => {
    if (told.current || removed.current) return;
    told.current = true;
    onCloseRef.current();
  };
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    isOpen.current = open;
    // Closed before it was ever on the page (turned away because an approval is showing):
    // there is no fade to wait for.
    if (!open && !contentRef.current) tellOwner();
  });

  useEffect(() => {
    // Closing stops the build: a window that is fading out keeps what it showed.
    if (!open) return;
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
        // Ignore the abort we triggered on close or unmount.
        if (cancelled || controller.signal.aborted) return;
        setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [convId, exportForShare, open]);

  const cancelRef = useRef<HTMLButtonElement>(null);

  const exportingRef = useRef(false);
  const handleExport = async () => {
    // The window keeps rendering while it fades out: nothing is exported then. One export at a time.
    if (!open || state.phase !== 'ready' || exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    let written = false;
    try {
      const filePath = await saveDialog({
        defaultPath: defaultFilename,
        filters: [{ name: 'Abu Conversation', extensions: ['json'] }],
      });
      if (filePath) {
        await writeTextFile(filePath, serializeShareBundle(state.bundle));
        written = true;
        setOpen(false);
      }
    } catch (err) {
      // A window that is fading out shows nothing new.
      if (isOpen.current) setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      exportingRef.current = false;
      // After the file is written the window leaves as it is, its button still marked.
      if (!written && isOpen.current) setExporting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) setOpen(false); }}
      onCloseAutoFocus={tellOwner}
      title={t.share.exportDialogTitle}
      description={`${t.share.tierStandard} — ${t.share.tierNote}`}
      size="xl"
      closeButton
      // The save dialog is open or the file is being written: the window steps aside for an
      // approval and is still there for a failed write.
      busy={exporting}
      // Export is not ready when the window opens; it opens on Cancel, which writes nothing.
      initialFocus={() => cancelRef.current}
      footer={(
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0 text-ui-sm text-label-tertiary">
            {state.phase === 'ready' && <StatsLine bundle={state.bundle} />}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DialogClose asChild><Button ref={cancelRef} variant="plain">{t.share.cancel}</Button></DialogClose>
            {/* Not ready yet: disabled, and the window opens on Cancel. After a failure there is
                nothing to export either, but the focus may be on this button (a failed write),
                also when the window returns from behind an approval: it stays focusable then
                and takes no press. */}
            <Button
              variant="primary"
              icon={AppIcons.download}
              busy={exporting || state.phase === 'error'}
              disabled={state.phase === 'loading'}
              onClick={handleExport}
            >
              {t.share.exportBtn}
            </Button>
          </div>
        </div>
      )}
    >
      <div ref={contentRef}>
        {state.phase === 'loading' && (
          <div className="flex justify-center py-8">
            <Spinner label={progress ? `${t.share.loading} ${progress.done}/${progress.total}` : t.share.loading} />
          </div>
        )}
        {state.phase === 'error' && (
          <InlineMessage tone="danger">
            <span className="break-words">{format(t.share.exportError, { error: state.message })}</span>
          </InlineMessage>
        )}
        {state.phase === 'ready' && <BundlePreview bundle={state.bundle} />}
      </div>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Inner sections
// ───────────────────────────────────────────────────────────────────────────

function SectionTitle({ icon, iconClassName, children }: { icon: typeof AppIcons.visible; iconClassName: string; children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2 text-ui font-medium text-label">
      <Icon icon={icon} size="sm" className={iconClassName} />
      {children}
    </div>
  );
}

// One line of what the recipient will see (a check) or will not see (a cross).
function VisibilityItem({ seen, children }: { seen: boolean; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="flex h-4 shrink-0 items-center">
        <Icon icon={seen ? AppIcons.done : AppIcons.close} size="sm" className={seen ? 'text-success' : 'text-label-tertiary'} />
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function BundlePreview({ bundle }: { bundle: ShareBundle }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-4">
      {/* Visibility summary */}
      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-panel border border-separator p-3">
          <SectionTitle icon={AppIcons.visible} iconClassName="text-label-secondary">{t.share.visibleToOthers}</SectionTitle>
          <ul className="flex flex-col gap-1 text-ui-sm text-label-secondary">
            <VisibilityItem seen>{t.share.itemMessages}</VisibilityItem>
            <VisibilityItem seen>{t.share.itemToolCalls}</VisibilityItem>
          </ul>
        </div>
        <div className="rounded-panel border border-separator p-3">
          <SectionTitle icon={AppIcons.hidden} iconClassName="text-label-secondary">{t.share.hiddenFromOthers}</SectionTitle>
          <ul className="flex flex-col gap-1 text-ui-sm text-label-secondary">
            <VisibilityItem seen={false}>{t.share.itemUserFiles}</VisibilityItem>
            <VisibilityItem seen={false}>{t.share.itemCredentials}</VisibilityItem>
            <VisibilityItem seen={false}>{t.share.itemAiGenerated}</VisibilityItem>
          </ul>
        </div>
      </section>

      {/* Redaction summary */}
      <section className="rounded-panel border border-separator p-3">
        <SectionTitle icon={AppIcons.warning} iconClassName="text-warning">
          {t.share.redactionTitle}
          {bundle.stats.redactionCount > 0 && (
            <span className="text-ui-sm font-normal text-label-tertiary">
              · {format(t.share.redactionCount, { count: bundle.stats.redactionCount })}
            </span>
          )}
        </SectionTitle>
        {bundle.stats.redactionCount === 0 ? (
          <p className="text-ui-sm text-label-tertiary">{t.share.noRedaction}</p>
        ) : (
          <ul className="flex flex-col gap-1 font-code text-ui-sm text-label-secondary">
            {summarizeRedactionKinds(bundle).map((line) => (
              <li key={line}>• {line}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Message preview — mirrors ChatView's bubble layout (user right, assistant
          left with Abu avatar) so the recipient sees the same visual they would
          in a live conversation. */}
      <section className="rounded-panel border border-separator p-3">
        <SectionTitle icon={AppIcons.conversation} iconClassName="text-label-secondary">{t.share.previewTitle}</SectionTitle>
        {bundle.messages.length === 0 ? (
          <p className="text-ui-sm text-label-tertiary">{t.share.previewEmpty}</p>
        ) : (
          <div className="flex max-h-100 flex-col gap-4 overflow-y-auto rounded-control bg-code p-3">
            {bundle.messages.slice(0, 50).map((msg) => (
              <SharePreviewMessage key={msg.id} message={msg} />
            ))}
            {bundle.messages.length > 50 && (
              <p className="pt-1 text-center text-caption text-label-tertiary">
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
      <div className="flex w-full justify-end">
        <div className="flex max-w-5/6 flex-col items-end gap-2">
          {(imageCount > 0 || otherCount > 0) && (
            <AttachmentSummary imageCount={imageCount} otherCount={otherCount} align="right" />
          )}
          {truncated && (
            <div className="rounded-panel bg-fill px-4 py-2 text-label">
              <div className="break-words text-body">
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
    <div className="flex w-full gap-3">
      <img src={abuAvatar} alt="" className="mt-1 size-7 shrink-0 rounded-full object-cover" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {toolCalls.map((tc, i) => (
          <ToolCallPreviewCard key={tc.id ?? `${tc.name}-${i}`} toolCall={tc} />
        ))}
        {truncated && (
          <div className="break-words text-body text-label">
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
      className={`flex gap-2 text-caption text-label-tertiary ${align === 'right' ? 'justify-end' : 'justify-start'}`}
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
    <div className="rounded-panel border border-separator bg-fill px-3 py-2 text-ui">
      <div className="flex items-center gap-2 font-medium text-label-secondary">
        <Icon icon={AppIcons.tool} size="sm" />
        <span>{t.task.calledTool}</span>
        <code className="rounded-control bg-code px-1 font-code text-ui-sm text-label">
          {toolCall.name}
        </code>
      </div>
      {resultSnippet && (
        <div className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap break-words pl-5 font-code text-ui-sm text-label-tertiary">
          {resultSnippet}
        </div>
      )}
    </div>
  );
}

function StatsLine({ bundle }: { bundle: ShareBundle }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
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
