import type { Dispatch, SetStateAction } from 'react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
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
  const isAnthropic = apiFormat === 'anthropic';
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium text-[var(--abu-text-primary)]">
        {t.settings.advancedConfig}
      </div>
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setDeclared(d => ({ ...d, supportsTools: !d.supportsTools }))}>
            <Checkbox checked={!!declared.supportsTools}
              onChange={() => setDeclared(d => ({ ...d, supportsTools: !d.supportsTools }))} />
            <span className="text-sm text-[var(--abu-text-primary)]">{t.settings.capTools}</span>
          </div>
          <div className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setDeclared(d => ({ ...d, supportsImages: !d.supportsImages }))}>
            <Checkbox checked={!!declared.supportsImages}
              onChange={() => setDeclared(d => ({ ...d, supportsImages: !d.supportsImages }))} />
            <span className="text-sm text-[var(--abu-text-primary)]">{t.settings.capImages}</span>
          </div>
          <div className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setDeclared(d => ({ ...d, supportsReasoning: !d.supportsReasoning }))}>
            <Checkbox checked={!!declared.supportsReasoning}
              onChange={() => setDeclared(d => ({ ...d, supportsReasoning: !d.supportsReasoning }))} />
            <span className="text-sm text-[var(--abu-text-primary)]">{t.settings.capReasoning}</span>
          </div>
        </div>
        {!isAnthropic && declared.supportsReasoning && (
          <div className="pl-3 space-y-2 border-l border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--abu-text-secondary)]">{t.settings.capEffort}</span>
              {(['low', 'medium', 'high'] as const).map(e => (
                <div key={e} className="flex items-center gap-1 cursor-pointer select-none"
                  onClick={() => setDeclared(d => ({ ...d, supportedEfforts: toggleEffort(d.supportedEfforts, e) }))}>
                  <Checkbox checked={!!declared.supportedEfforts?.includes(e)}
                    onChange={() => setDeclared(d => ({ ...d, supportedEfforts: toggleEffort(d.supportedEfforts, e) }))} />
                  <span className="text-xs text-[var(--abu-text-secondary)]">
                    {{ low: t.settings.effortLow, medium: t.settings.effortMedium, high: t.settings.effortHigh }[e]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div className="space-y-1">
            <div className="text-sm text-[var(--abu-text-primary)]">{t.settings.capMaxInput}</div>
            <Input
              type="text"
              inputMode="numeric"
              placeholder={t.settings.capTokenDefault}
              value={declared.maxInputTokens ?? ''}
              className="h-8"
              onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ''); setDeclared(d => ({ ...d, maxInputTokens: raw === '' ? undefined : Number(raw) })); }}
            />
            <div className="flex gap-1 flex-wrap">
              {[32768, 65536, 131072, 262144].map(v => (
                <Button key={v} variant="ghost" size="xs" type="button"
                  onClick={() => setDeclared(d => ({ ...d, maxInputTokens: v }))}>{v / 1024}K</Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-sm text-[var(--abu-text-primary)]">{t.settings.capMaxOutput}</div>
            <Input
              type="text"
              inputMode="numeric"
              placeholder={t.settings.capTokenDefault}
              value={declared.maxOutputTokens ?? ''}
              className="h-8"
              onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ''); setDeclared(d => ({ ...d, maxOutputTokens: raw === '' ? undefined : Number(raw) })); }}
            />
            <div className="flex gap-1 flex-wrap">
              {[8192, 16384, 32768, 65536].map(v => (
                <Button key={v} variant="ghost" size="xs" type="button"
                  onClick={() => setDeclared(d => ({ ...d, maxOutputTokens: v }))}>{v / 1024}K</Button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
