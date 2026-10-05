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

import { useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { TextField } from '@/components/ds/text-field';
import { usePluginStore } from '@/stores/pluginStore';
import { canonicalizeElectronPathForPolicy } from '@/utils/electronHost';
import { expandHome, loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';

interface AddMarketplaceDialogProps {
  open: boolean;
  home: string;
  onClose: () => void;
  /** Fired with the marketplace's declared name once it is stored. */
  onAdded?: (name: string) => void;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the control that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export default function AddMarketplaceDialog({
  open,
  home,
  onClose,
  onAdded,
  onCloseAutoFocus,
}: AddMarketplaceDialogProps) {
  const { t } = useI18n();
  const addMarketplace = usePluginStore((s) => s.addMarketplace);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  // The authority for "a read is running": a second Enter can land before the next render.
  const reading = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts empty. While the window fades out it keeps showing what it held.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDir('');
      setError(null);
      setBusy(false);
    }
  }

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
    // The window stays on the page while it fades out; a key press there adds nothing.
    if (!open) return;
    const trimmed = dir.trim();
    if (!trimmed || reading.current) return;
    reading.current = true;
    setBusy(true);
    setError(null);
    try {
      const expanded = expandHome(trimmed, home);
      const absolute = await canonicalizeElectronPathForPolicy(expanded) ?? expanded;
      const marketplace = await loadMarketplaceFromDir(absolute);
      const existing = usePluginStore.getState().marketplaces.find(item => item.name === marketplace.name);
      const existingCanonical = existing ? await canonicalizeElectronPathForPolicy(expandHome(existing.dir, home)) : null;
      // Re-adding an alias of the same existing directory just selects it.
      if (!existing || existingCanonical !== absolute) addMarketplace(marketplace.name, absolute);
      onAdded?.(marketplace.name);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      reading.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      // Escape, a press outside and the close button ask to close; while the directory is being read the window stays.
      onOpenChange={(next) => { if (!next && !reading.current) onClose(); }}
      // For an approval the window steps aside while it reads, and comes back.
      busy={busy}
      title={tb.pluginsAddMarketplaceTitle}
      size="md"
      closeButton
      contentProps={{ 'data-testid': 'plugin-add-marketplace' }}
      dirty={!busy && dir.trim().length > 0}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain" disabled={busy}>{t.common.cancel}</Button></DialogClose>
          <Button
            variant="primary"
            data-testid="plugin-marketplace-submit"
            busy={busy}
            disabled={dir.trim().length === 0}
            onClick={() => void handleSubmit()}
          >
            {tb.pluginsAddMarketplace}
          </Button>
        </>
      )}
    >
      <label htmlFor="plugin-marketplace-dir" className="mb-1 block text-ui-sm font-medium text-label-secondary">
        {tb.pluginsMarketplaceDirLabel}
      </label>
      <div className="flex items-center gap-2">
        <TextField
          id="plugin-marketplace-dir"
          data-testid="plugin-marketplace-dir-input"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSubmit();
          }}
          placeholder={tb.pluginsMarketplaceDirPlaceholder}
          // Read-only, not disabled: Enter was pressed here and the focus stays here.
          readOnly={busy}
        />
        <Button variant="secondary" size="sm" icon={AppIcons.folderOpen} onClick={() => void handleBrowse()} disabled={busy}>
          {tb.pluginsBrowseDir}
        </Button>
      </div>
      <p className="mt-2 text-ui-sm text-label-tertiary">{tb.pluginsMarketplaceDirHint}</p>

      {error && (
        <div className="mt-3">
          <InlineMessage tone="danger">
            <p className="font-medium">{tb.pluginsMarketplaceReadFailed}</p>
            <p className="break-words text-ui-sm text-label-secondary">{error}</p>
          </InlineMessage>
        </div>
      )}
    </Dialog>
  );
}
