import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Eye, EyeOff, Pencil, Trash2, Star, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import type { ImageGenBackend, ImageGenVendor } from '@/types/provider';

type BackendDraft = Omit<ImageGenBackend, 'id'>;

function emptyDraft(): BackendDraft {
  // 'custom' here means "auto-detect from baseUrl" (see vendorResolve.ts) —
  // the default until the user explicitly picks a real vendor below. This
  // is NOT the same "always custom, no picker" default from P2: the picker
  // came back in P3 (finding F5) so users on a proxy/gateway domain that
  // doesn't match the baseUrl-host heuristics can force the right mapper.
  return { name: '', vendor: 'custom', baseUrl: '', apiKey: '', model: '' };
}

function draftFromBackend(b: ImageGenBackend): BackendDraft {
  return { name: b.name, vendor: b.vendor, baseUrl: b.baseUrl, apiKey: b.apiKey, model: b.model };
}

function isDraftValid(draft: BackendDraft): boolean {
  return draft.name.trim().length > 0 && draft.baseUrl.trim().length > 0 && draft.model.trim().length > 0;
}

/** Add/edit form fields for a single backend, including the vendor picker
 *  (F5 — lets a user on a corporate proxy/gateway domain that doesn't match
 *  the baseUrl-host heuristics in `vendorResolve.ts` force the right
 *  request/response mapper instead of silently falling back to 'custom').
 *  Uncontrolled from the outside beyond `draft`/`onChange` — the parent owns
 *  save/cancel. */
function BackendForm({
  draft,
  onChange,
}: {
  draft: BackendDraft;
  onChange: (patch: Partial<BackendDraft>) => void;
}) {
  const { t } = useI18n();
  const [showKey, setShowKey] = useState(false);

  const vendorOptions: SelectOption[] = [
    { value: 'custom', label: t.settings.imageGenVendorAuto },
    { value: 'openai', label: t.settings.imageGenVendorOpenAI },
    { value: 'volcengine', label: t.settings.imageGenVendorVolcengine },
    { value: 'siliconflow', label: t.settings.imageGenVendorSiliconFlow },
    { value: 'zhipu', label: t.settings.imageGenVendorZhipu },
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--abu-text-primary)]">{t.settings.imageGenBackendName}</label>
        <Input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t.settings.imageGenBackendNamePlaceholder}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--abu-text-primary)]">{t.settings.imageGenVendor}</label>
        <Select
          value={draft.vendor}
          options={vendorOptions}
          onChange={(v) => onChange({ vendor: v as ImageGenVendor })}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--abu-text-primary)]">{t.settings.imageGenBaseUrl}</label>
        <Input
          value={draft.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder={t.settings.imageGenBaseUrlPlaceholder}
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--abu-text-primary)]">{t.settings.imageGenApiKey}</label>
        <div className="relative">
          <Input
            type={showKey ? 'text' : 'password'}
            value={draft.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder={t.settings.imageGenApiKeyPlaceholder}
            className="pr-9"
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] rounded"
          >
            {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-[var(--abu-text-primary)]">{t.settings.imageGenModel}</label>
        <Input
          value={draft.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder={t.settings.imageGenModelPlaceholder}
          className="font-mono"
        />
      </div>
    </div>
  );
}

/** Add/edit modal — mirrors AddProviderModal's structural pattern (portal to
 *  <body>, backdrop that swallows mousedown but doesn't close-on-click,
 *  header with title + X, scrolling body, footer with cancel/save) so the
 *  image-gen backend flow matches the "add model" affordance elsewhere in
 *  Settings instead of the old inline-expanding row. */
export function ImageGenBackendModal({
  open,
  onClose,
  editBackend,
}: {
  open: boolean;
  onClose: () => void;
  editBackend?: ImageGenBackend;
}) {
  const { t } = useI18n();
  const addImageGenBackend = useSettingsStore((s) => s.addImageGenBackend);
  const updateImageGenBackend = useSettingsStore((s) => s.updateImageGenBackend);
  const [draft, setDraft] = useState<BackendDraft>(emptyDraft());

  // Prefill/reset synchronously before paint, keyed on the edited backend's id
  // (not the object reference) so a background store update to the same
  // backend while the modal is open doesn't clobber in-progress edits —
  // mirrors AddProviderModal's prefillFromEditProvider/resetFormState effect.
  useLayoutEffect(() => {
    if (!open) return;
    setDraft(editBackend ? draftFromBackend(editBackend) : emptyDraft());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editBackend?.id]);

  useEffect(() => {
    if (!open) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  if (!open) return null;

  const canSave = isDraftValid(draft);
  const handleSave = () => {
    if (!canSave) return;
    if (editBackend) {
      updateImageGenBackend(editBackend.id, draft);
    } else {
      addImageGenBackend(draft);
    }
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { e.stopPropagation(); }}
    >
      <div
        className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[var(--abu-border)]">
          <h2 className="text-lg font-semibold text-[var(--abu-text-primary)]">
            {editBackend ? t.settings.imageGenEditBackend : t.settings.imageGenAddBackend}
          </h2>
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 pt-4 pb-5">
          <BackendForm draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 border-t border-[var(--abu-border)] flex items-center justify-end gap-3">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={handleSave} disabled={!canSave}>{t.common.save}</Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Inline mode: just the backends list (star/edit/delete rows), without a
 *  section header or the add/edit modal itself — the parent owns the "add
 *  backend" trigger (placed in its own header row, see AIServicesSection)
 *  and passes `onEdit` to route a row's pencil click into its modal state. */
export function ImageGenBackendsPanel({ onEdit }: { onEdit: (backend: ImageGenBackend) => void }) {
  const { t } = useI18n();
  const imageGeneration = useSettingsStore((s) => s.imageGeneration);
  const removeImageGenBackend = useSettingsStore((s) => s.removeImageGenBackend);
  const setDefaultImageBackend = useSettingsStore((s) => s.setDefaultImageBackend);

  const [deleteTarget, setDeleteTarget] = useState<ImageGenBackend | null>(null);

  const { backends, defaultId } = imageGeneration;
  const defaultBackend = backends.find((b) => b.id === defaultId) ?? backends[0] ?? null;

  return (
    <div className="space-y-3">
      {backends.length === 0 && (
        <div className="text-center py-4">
          <p className="text-sm text-[var(--abu-text-muted)]">{t.settings.imageGenNoBackends}</p>
          <p className="text-xs text-[var(--abu-text-muted)] mt-1">{t.settings.imageGenNoBackendsHint}</p>
        </div>
      )}

      {backends.length > 0 && (
        <div className="space-y-2">
          {backends.map((backend) => {
            const isDefault = defaultBackend?.id === backend.id;
            return (
              <div
                key={backend.id}
                className="flex items-center gap-2 rounded-lg border border-[var(--abu-border)] px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => setDefaultImageBackend(backend.id)}
                  title={t.settings.imageGenSetDefault}
                  className={cn(
                    'shrink-0 p-0.5 rounded transition-colors',
                    isDefault ? 'text-amber-500' : 'text-[var(--abu-text-muted)] hover:text-amber-500',
                  )}
                >
                  <Star className={cn('h-4 w-4', isDefault && 'fill-current')} />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-[var(--abu-text-primary)] truncate">{backend.name}</span>
                    {isDefault && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400">
                        {t.settings.imageGenDefaultBadge}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-[var(--abu-text-muted)] truncate">
                    {backend.model || backend.name}
                  </div>
                </div>
                <Button variant="ghost" size="icon-xs" onClick={() => onEdit(backend)} title={t.settings.imageGenEditBackend}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setDeleteTarget(backend)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  title={t.common.delete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        title={t.settings.imageGenDeleteConfirmTitle}
        message={t.settings.imageGenDeleteConfirmMessage.replace('{name}', deleteTarget?.name ?? '')}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) removeImageGenBackend(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

