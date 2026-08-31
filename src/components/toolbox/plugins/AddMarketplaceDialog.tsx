/**
 * Add a local marketplace directory.
 *
 * The directory is validated by actually parsing its manifest before it is
 * stored — a pointer that does not resolve is worse than no pointer, because
 * the failure would then surface later, in the middle of browsing, with no
 * obvious cause.
 *
 * The marketplace's *own* declared name is what gets stored, never the folder
 * name: install keys are `${plugin}@${marketplace}`, so a user who renamed the
 * folder must not end up with a second identity for the same marketplace.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, FolderOpen, Loader2 } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePluginStore } from '@/stores/pluginStore';
import { expandHome, loadMarketplaceFromDir } from './loadMarketplace';

interface AddMarketplaceDialogProps {
  open: boolean;
  home: string;
  onClose: () => void;
  /** Fired with the marketplace's declared name once it is stored. */
  onAdded?: (name: string) => void;
}

export default function AddMarketplaceDialog({
  open,
  home,
  onClose,
  onAdded,
}: AddMarketplaceDialogProps) {
  const { t } = useI18n();
  const addMarketplace = usePluginStore((s) => s.addMarketplace);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDir('');
    setError(null);
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);

  if (!open) return null;
  const tb = t.toolbox;

  const handleBrowse = async () => {
    try {
      const picked = await openDialog({ directory: true, multiple: false });
      if (typeof picked === 'string') setDir(picked);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleSubmit = async () => {
    const trimmed = dir.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const absolute = expandHome(trimmed, home);
      const marketplace = await loadMarketplaceFromDir(absolute);
      addMarketplace(marketplace.name, absolute);
      onAdded?.(marketplace.name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      data-electron-no-drag
      data-testid="plugin-add-marketplace"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 p-6 animate-in fade-in duration-150"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={tb.pluginsAddMarketplaceTitle}
        className="w-[480px] rounded-2xl bg-[var(--abu-bg-base)] p-6 shadow-xl animate-in zoom-in-95 duration-150"
      >
        <h3 className="text-h-sm text-[var(--abu-text-primary)]">{tb.pluginsAddMarketplaceTitle}</h3>

        <label
          htmlFor="plugin-marketplace-dir"
          className="mt-4 block text-h-xs text-[var(--abu-text-secondary)]"
        >
          {tb.pluginsMarketplaceDirLabel}
        </label>
        <div className="mt-1.5 flex items-center gap-2">
          <Input
            id="plugin-marketplace-dir"
            data-testid="plugin-marketplace-dir-input"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSubmit();
            }}
            placeholder={tb.pluginsMarketplaceDirPlaceholder}
            disabled={busy}
          />
          <Button variant="outline" size="sm" onClick={handleBrowse} disabled={busy}>
            <FolderOpen className="h-3.5 w-3.5" />
            {tb.pluginsBrowseDir}
          </Button>
        </div>
        <p className="mt-2 text-minor leading-relaxed text-[var(--abu-text-muted)]">
          {tb.pluginsMarketplaceDirHint}
        </p>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-[var(--abu-danger-bg)] p-2.5">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--abu-danger)]" />
            <div className="min-w-0">
              <p className="text-minor font-medium text-[var(--abu-text-primary)]">
                {tb.pluginsMarketplaceReadFailed}
              </p>
              <p className="mt-0.5 break-words text-minor text-[var(--abu-text-tertiary)]">{error}</p>
            </div>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button
            data-testid="plugin-marketplace-submit"
            onClick={handleSubmit}
            disabled={busy || dir.trim().length === 0}
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {tb.pluginsAddMarketplace}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
