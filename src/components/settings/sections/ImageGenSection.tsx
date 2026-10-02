import { useId, useLayoutEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Select, type SelectOption } from '@/components/ds/select';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import SecretField from '@/components/settings/SecretField';
import { isVolcengineChatEndpoint, VOLCENGINE_IMAGE_BASE_URL } from '@/core/llm/imageGen';
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

const DRAFT_FIELDS = ['name', 'vendor', 'baseUrl', 'apiKey', 'model'] as const satisfies readonly (keyof BackendDraft)[];
const FIELD_LABEL = 'block text-ui-sm font-medium text-label';

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
  const fieldId = useId();

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
        <label htmlFor={`${fieldId}-name`} className={FIELD_LABEL}>{t.settings.imageGenBackendName}</label>
        <TextField
          id={`${fieldId}-name`}
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t.settings.imageGenBackendNamePlaceholder}
        />
      </div>
      <div className="space-y-1">
        <label className={FIELD_LABEL}>{t.settings.imageGenVendor}</label>
        <Select
          fullWidth
          label={t.settings.imageGenVendor}
          value={draft.vendor}
          options={vendorOptions}
          onValueChange={(v) => onChange({ vendor: v as ImageGenVendor })}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${fieldId}-address`} className={FIELD_LABEL}>{t.settings.imageGenBaseUrl}</label>
        <TextField
          id={`${fieldId}-address`}
          value={draft.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder={t.settings.imageGenBaseUrlPlaceholder}
        />
        {/* Non-blocking: the save button stays enabled — the user may know
            better (e.g. a gateway that proxies /api/coding/ to an image
            model), so this only warns about the known-broken V41 shape. */}
        {isVolcengineChatEndpoint(draft.baseUrl, draft.vendor) && (
          <InlineMessage tone="warning">
            {t.settings.imageGenChatEndpointWarning.replace('{url}', VOLCENGINE_IMAGE_BASE_URL)}
          </InlineMessage>
        )}
      </div>
      <div className="space-y-1">
        <label htmlFor={`${fieldId}-key`} className={FIELD_LABEL}>{t.settings.imageGenApiKey}</label>
        <SecretField
          id={`${fieldId}-key`}
          value={draft.apiKey}
          onChange={(apiKey) => onChange({ apiKey })}
          placeholder={t.settings.imageGenApiKeyPlaceholder}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${fieldId}-model`} className={FIELD_LABEL}>{t.settings.imageGenModel}</label>
        <TextField
          id={`${fieldId}-model`}
          value={draft.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder={t.settings.imageGenModelPlaceholder}
          className="font-code"
        />
      </div>
    </div>
  );
}

/** Add/edit form in a dialog. Escape, a click outside, Cancel and the close
 *  button all close it; once something was typed they ask before discarding it. */
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
  // What the form held when it opened; the user has something to lose once the draft differs.
  const [opened, setOpened] = useState<BackendDraft>(draft);

  // Prefill/reset synchronously before paint, keyed on the edited backend's id
  // (not the object reference) so a background store update to the same
  // backend while the modal is open doesn't clobber in-progress edits —
  // mirrors AddProviderModal's prefillFromEditProvider/resetFormState effect.
  useLayoutEffect(() => {
    if (!open) return;
    const next = editBackend ? draftFromBackend(editBackend) : emptyDraft();
    setOpened(next);
    setDraft(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editBackend?.id]);

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

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={editBackend ? t.settings.imageGenEditBackend : t.settings.imageGenAddBackend}
      size="md"
      closeButton
      dirty={DRAFT_FIELDS.some((field) => draft[field] !== opened[field])}
      footer={(
        <>
          {/* Cancel closes the way Escape does: typed input is asked about first. */}
          <DialogClose asChild><Button variant="secondary">{t.common.cancel}</Button></DialogClose>
          <Button variant="primary" onClick={handleSave} disabled={!canSave}>{t.common.save}</Button>
        </>
      )}
    >
      <BackendForm draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
    </Dialog>
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
  const confirm = useConfirm();

  const { backends, defaultId } = imageGeneration;
  const defaultBackend = backends.find((b) => b.id === defaultId) ?? backends[0] ?? null;

  const deleteBackend = async (backend: ImageGenBackend) => {
    const confirmed = await confirm({
      title: t.settings.imageGenDeleteConfirmTitle,
      message: format(t.settings.imageGenDeleteConfirmMessage, { name: backend.name }),
      confirmLabel: t.common.delete,
      tone: 'danger',
    });
    if (!confirmed) return;
    // The answer is about the backend as it is now: it may have gone while the question was open.
    const current = useSettingsStore.getState().imageGeneration.backends.find((b) => b.id === backend.id);
    if (current) removeImageGenBackend(current.id);
  };

  return (
    <div className="space-y-3">
      {backends.length === 0 && (
        <div className="py-4 text-center">
          <p className="text-ui text-label-secondary">{t.settings.imageGenNoBackends}</p>
          <p className="mt-1 text-ui-sm text-label-secondary">{t.settings.imageGenNoBackendsHint}</p>
        </div>
      )}

      {backends.length > 0 && (
        <div className="space-y-2">
          {backends.map((backend) => {
            const isDefault = defaultBackend?.id === backend.id;
            return (
              <div
                key={backend.id}
                className="flex items-center gap-2 rounded-control border border-separator px-3 py-2"
              >
                <IconButton
                  size="sm"
                  icon={AppIcons.favorite}
                  label={t.settings.imageGenSetDefault}
                  aria-pressed={isDefault}
                  // The default is shown by the filled star alone.
                  pressedFill={false}
                  className={cn(isDefault && '[&_svg]:fill-current')}
                  onClick={() => setDefaultImageBackend(backend.id)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-ui text-label">{backend.name}</span>
                    {isDefault && (
                      <span className="inline-flex shrink-0">
                        <Tag>{t.settings.imageGenDefaultBadge}</Tag>
                      </span>
                    )}
                  </div>
                  <div className="truncate text-ui-sm text-label-secondary">
                    {backend.model || backend.name}
                  </div>
                </div>
                <IconButton size="sm" icon={AppIcons.rename} label={t.settings.imageGenEditBackend} onClick={() => onEdit(backend)} />
                <IconButton size="sm" icon={AppIcons.delete} label={t.common.delete} onClick={() => { void deleteBackend(backend); }} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

