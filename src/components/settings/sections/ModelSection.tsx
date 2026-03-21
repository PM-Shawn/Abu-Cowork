import { useSettingsStore, AVAILABLE_MODELS, getEffectiveModel } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { CircleCheck, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';

export default function ModelSection() {
  const store = useSettingsStore();
  const { provider, model, customModel, setModel, setCustomModel } = store;
  const { t } = useI18n();

  const models = AVAILABLE_MODELS[provider] ?? [];
  const effectiveModel = getEffectiveModel(store);
  const isCustomModel = model === '__custom__';
  const hasModel = effectiveModel.trim().length > 0;

  return (
    <div className="space-y-5">
      {/* Model select */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--abu-text-primary)]">{t.settings.model}</label>
        <Select
          value={model}
          onChange={(value) => setModel(value)}
          options={[
            ...models.map((m) => ({ value: m.id, label: m.label })),
            { value: '__custom__', label: t.settings.customModelOption },
          ]}
        />
      </div>

      {/* Custom model input */}
      {isCustomModel && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--abu-text-primary)]">{t.settings.customModelName}</label>
          <input
            type="text"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder={t.settings.customModelPlaceholder}
            className="w-full h-10 px-3 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg text-sm text-[var(--abu-text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all"
          />
          <p className="text-xs text-[var(--abu-text-tertiary)]">
            {t.settings.customModelDesc}
          </p>
        </div>
      )}

      {/* Current model status */}
      <div className="p-4 rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border)]">
        <h3 className="text-sm font-medium text-[var(--abu-text-primary)] mb-3">{t.settings.currentModel}</h3>
        <div className="flex items-center gap-2.5">
          {hasModel ? (
            <CircleCheck className="h-4 w-4 text-green-500 flex-none" />
          ) : (
            <CircleAlert className="h-4 w-4 text-amber-500 flex-none" />
          )}
          <span className={cn(
            'text-sm font-mono',
            hasModel ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-tertiary)]'
          )}>
            {effectiveModel || t.settings.notSet}
          </span>
        </div>
      </div>
    </div>
  );
}
