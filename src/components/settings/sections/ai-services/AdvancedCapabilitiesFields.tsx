import { useId, type Dispatch, type SetStateAction } from 'react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { TextField } from '@/components/ds/text-field';
import { toggleEffort } from './providerCapabilities';
import type { ApiFormat } from '@/types';
import type { ModelDeclaredCapabilities } from '@/types/provider';

/** Advanced capabilities editor (per-model declared capabilities) shared by AddProviderModal
 *  and ProviderCard so the add / edit forms never drift apart. The caller decides
 *  whether to render it (via computeShowAdvanced) and owns the `declared` state.
 *  For anthropic-format endpoints reasoning-effort levels (OpenAI reasoning_effort only;
 *  claude.ts uses native budget_tokens) are hidden as they have no effect. */
export default function AdvancedCapabilitiesFields({
  declared,
  setDeclared,
  apiFormat,
}: {
  declared: ModelDeclaredCapabilities;
  setDeclared: Dispatch<SetStateAction<ModelDeclaredCapabilities>>;
  apiFormat: ApiFormat;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const isAnthropic = apiFormat === 'anthropic';
  return (
    <div className="space-y-2">
      <div className="text-ui-sm font-medium text-label">
        {t.settings.advancedConfig}
      </div>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Checkbox
            checked={!!declared.supportsTools}
            onCheckedChange={() => setDeclared(d => ({ ...d, supportsTools: !d.supportsTools }))}
            label={t.settings.capTools}
          />
          <Checkbox
            checked={!!declared.supportsImages}
            onCheckedChange={() => setDeclared(d => ({ ...d, supportsImages: !d.supportsImages }))}
            label={t.settings.capImages}
          />
          <Checkbox
            checked={!!declared.supportsReasoning}
            onCheckedChange={() => setDeclared(d => ({ ...d, supportsReasoning: !d.supportsReasoning }))}
            label={t.settings.capReasoning}
          />
        </div>
        {!isAnthropic && declared.supportsReasoning && (
          <div className="flex items-center gap-3 border-l border-separator pl-3">
            <span className="text-ui text-label-secondary">{t.settings.capEffort}</span>
            {(['low', 'medium', 'high'] as const).map(e => (
              <Checkbox
                key={e}
                checked={!!declared.supportedEfforts?.includes(e)}
                onCheckedChange={() => setDeclared(d => ({ ...d, supportedEfforts: toggleEffort(d.supportedEfforts, e) }))}
                label={{ low: t.settings.effortLow, medium: t.settings.effortMedium, high: t.settings.effortHigh }[e]}
              />
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-input`} className="block text-ui text-label">{t.settings.capMaxInput}</label>
            <TextField
              id={`${fieldId}-input`}
              inputMode="numeric"
              placeholder={t.settings.capTokenDefault}
              value={declared.maxInputTokens ?? ''}
              onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ''); setDeclared(d => ({ ...d, maxInputTokens: raw === '' ? undefined : Number(raw) })); }}
            />
            <div className="flex flex-wrap gap-1">
              {[32768, 65536, 131072, 262144].map(v => (
                <Button key={v} variant="plain" size="sm"
                  onClick={() => setDeclared(d => ({ ...d, maxInputTokens: v }))}>{v / 1024}K</Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${fieldId}-output`} className="block text-ui text-label">{t.settings.capMaxOutput}</label>
            <TextField
              id={`${fieldId}-output`}
              inputMode="numeric"
              placeholder={t.settings.capTokenDefault}
              value={declared.maxOutputTokens ?? ''}
              onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ''); setDeclared(d => ({ ...d, maxOutputTokens: raw === '' ? undefined : Number(raw) })); }}
            />
            <div className="flex flex-wrap gap-1">
              {[8192, 16384, 32768, 65536].map(v => (
                <Button key={v} variant="plain" size="sm"
                  onClick={() => setDeclared(d => ({ ...d, maxOutputTokens: v }))}>{v / 1024}K</Button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
