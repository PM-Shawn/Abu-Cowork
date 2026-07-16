import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, X, Globe } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { usePreviewStore } from '@/stores/previewStore';
import { useI18n } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { createLogger } from '@/core/logging/logger';
import { normalizeBrowserUrl } from '@/utils/browserUrl';

const browserLogger = createLogger('browser-tab');

/**
 * Sandboxed iframe-backed in-app browser (V1 — see "Browser V1 scope + V2
 * note" in docs/2026-07-17-workspace-tabs-design.md). A future V2 could swap
 * the iframe for a native child webview (Tauri `WebviewWindow`/`add_child`,
 * currently an unstable API) to render sites that refuse framing — deferred
 * out of this pass's scope.
 *
 * History is tracked locally (a ref-backed stack) because a cross-origin
 * iframe cannot expose its own `contentWindow.history` to the host page.
 */
export default function BrowserTab({ tabId, url }: { tabId: string; url: string }) {
  const { t } = useI18n();
  const updateBrowserUrl = usePreviewStore((s) => s.updateBrowserUrl);

  const [addressInput, setAddressInput] = useState(url);
  const [committedUrl, setCommittedUrl] = useState(url);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [hintDismissed, setHintDismissed] = useState(false);
  // Own history stack, seeded from the initial url (a tab opened from an
  // "open in browser" action elsewhere already carries one). Kept in React
  // state — NOT a ref — because a cross-origin iframe can't expose its own
  // history to the host, and the Back/Forward buttons must re-render on nav.
  const [history, setHistory] = useState<{ urls: string[]; index: number }>(() =>
    url ? { urls: [url], index: 0 } : { urls: [], index: -1 },
  );

  const addressInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!url) addressInputRef.current?.focus();
  }, [url]);

  const commit = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) return;
    const normalized = normalizeBrowserUrl(trimmed);
    setHistory((h) => {
      const truncated = h.urls.slice(0, h.index + 1);
      truncated.push(normalized);
      return { urls: truncated, index: truncated.length - 1 };
    });
    setAddressInput(normalized);
    setCommittedUrl(normalized);
    setHintDismissed(false);
    updateBrowserUrl(tabId, normalized);
  };

  const goTo = (index: number) => {
    if (index < 0 || index >= history.urls.length) return;
    const target = history.urls[index];
    setHistory((h) => ({ ...h, index }));
    setAddressInput(target);
    setCommittedUrl(target);
    setHintDismissed(false);
    updateBrowserUrl(tabId, target);
  };

  const canGoBack = history.index > 0;
  const canGoForward = history.index >= 0 && history.index < history.urls.length - 1;

  const handleReload = () => setReloadNonce((n) => n + 1);

  const handleOpenExternal = async () => {
    if (!committedUrl) return;
    try {
      await openUrl(committedUrl);
    } catch (err) {
      browserLogger.error('Failed to open URL in system browser', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 shrink-0 px-2 py-1.5 border-b border-[var(--abu-bg-pressed)] bg-[var(--abu-bg-subtle)]">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!canGoBack}
              onClick={() => goTo(history.index - 1)}
              className="text-[var(--abu-text-tertiary)]"
            >
              <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.back}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!canGoForward}
              onClick={() => goTo(history.index + 1)}
              className="text-[var(--abu-text-tertiary)]"
            >
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.forward}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!committedUrl}
              onClick={handleReload}
              className="text-[var(--abu-text-tertiary)]"
            >
              <RotateCw className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.reload}</TooltipContent>
        </Tooltip>

        <Input
          ref={addressInputRef}
          value={addressInput}
          placeholder={t.workspace.browser.addressPlaceholder}
          onChange={(e) => setAddressInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(addressInput);
          }}
          className="flex-1 h-7 text-[12px]"
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={!committedUrl}
              onClick={() => void handleOpenExternal()}
              className="text-[var(--abu-text-tertiary)]"
            >
              <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t.workspace.browser.openExternal}</TooltipContent>
        </Tooltip>
      </div>

      {committedUrl && !hintDismissed && (
        <div className="flex items-center gap-2 shrink-0 px-3 py-1 text-[11px] text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-subtle)] border-b border-[var(--abu-bg-pressed)]">
          <span className="flex-1 truncate">{t.workspace.browser.framingHint}</span>
          <button
            type="button"
            onClick={() => setHintDismissed(true)}
            className="shrink-0 rounded p-0.5 hover:bg-[var(--abu-bg-pressed)]"
            aria-label={t.workspace.browser.dismissHint}
          >
            <X className="w-3 h-3" strokeWidth={1.5} />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {committedUrl ? (
          <iframe
            key={`${committedUrl}:${reloadNonce}`}
            src={committedUrl}
            className="w-full h-full border-0 bg-white"
            // Deliberately WITHOUT allow-top-navigation: a framed page must
            // not be able to hijack the Abu app window.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            referrerPolicy="no-referrer-when-downgrade"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center p-4">
            <Globe className="w-6 h-6 text-[var(--abu-text-tertiary)]" strokeWidth={1.5} />
            <p className="text-[13px] font-medium text-[var(--abu-text-secondary)]">
              {t.workspace.browser.startPrompt}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
