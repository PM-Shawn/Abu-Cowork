import { useId, type Dispatch, type SetStateAction } from 'react';
import { format, useI18n } from '@/i18n';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { TextField } from '@/components/ds/text-field';
import { formatContextLength, positiveInteger, type ResolvedContextWindow } from '@/core/llm/contextWindow';
import { toggleEffort } from './providerCapabilities';
import ThinkingEffortSelect from './ThinkingEffortSelect';
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
  contextWindow,
}: {
  declared: ModelDeclaredCapabilities;
  setDeclared: Dispatch<SetStateAction<ModelDeclaredCapabilities>>;
  apiFormat: ApiFormat;
  /** Model capacity and the default limit, resolved without the user's override. */
  contextWindow: ResolvedContextWindow;
}) {
  const { t } = useI18n();
  const fieldId = useId();
  const isAnthropic = apiFormat === 'anthropic';
  const customContextLength = positiveInteger(declared.maxInputTokens);
  const currentContextLength = customContextLength ?? contextWindow.size;
  return (
    <div className="space-y-2">
      <div className="text-ui-sm font-medium text-label">
        {t.settings.advancedConfig}
      </div>
      <div className="space-y-2">
        {/* items-start：每格按自身高度靠上，「能看图」多一行说明时两列第一行仍在同一水平线 */}
        <div className="grid grid-cols-2 items-start gap-2">
          <Checkbox
            checked={!!declared.supportsTools}
            onCheckedChange={() => setDeclared(d => ({ ...d, supportsTools: !d.supportsTools }))}
            label={t.settings.capTools}
          />
          <div className="flex flex-col">
            <Checkbox
              checked={!!declared.supportsImages}
              onCheckedChange={() => setDeclared(d => ({ ...d, supportsImages: !d.supportsImages }))}
              label={t.settings.capImages}
              aria-describedby={`${fieldId}-images-hint`}
            />
            {/* pl-6 = 勾选框宽度 16px + 间距 8px，说明与「能看图」文字左对齐 */}
            <span id={`${fieldId}-images-hint`} className="pl-6 text-ui-sm text-label-tertiary">{t.settings.capImagesHint}</span>
          </div>
          <Checkbox
            checked={!!declared.supportsReasoning}
            onCheckedChange={() => setDeclared(d => ({ ...d, supportsReasoning: !d.supportsReasoning }))}
            label={t.settings.capReasoning}
          />
        </div>
        {declared.supportsReasoning && (
          <div className="space-y-2 border-l border-separator pl-3">
            {!isAnthropic && (
              <div className="flex items-center gap-3">
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
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="text-ui text-label-secondary">{t.settings.capThinkingEffort}</span>
                <ThinkingEffortSelect
                  value={declared.thinkingEffort}
                  onChange={(thinkingEffort) => setDeclared(d => ({ ...d, thinkingEffort }))}
                />
              </div>
              <div className="text-ui-sm text-label-tertiary">{t.settings.capThinkingEffortHint}</div>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="min-w-0 space-y-1.5">
            <label htmlFor={`${fieldId}-input`} className="block text-ui text-label">{t.settings.capContextLength}</label>
            <TextField
              id={`${fieldId}-input`}
              aria-describedby={`${fieldId}-input-hint ${fieldId}-input-summary`}
              inputMode="numeric"
              placeholder={format(t.settings.capContextLengthPlaceholder, { size: formatContextLength(contextWindow.size) })}
              value={declared.maxInputTokens ?? ''}
              onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ''); setDeclared(d => ({ ...d, maxInputTokens: raw === '' ? undefined : Number(raw) })); }}
            />
            <div id={`${fieldId}-input-hint`} className="text-ui-sm text-label-tertiary">{t.settings.capContextLengthHint}</div>
            <div className="flex flex-wrap gap-1">
              {[8192, 16384, 32768, 65536, 131072, 262144, 1_000_000].map(v => (
                <Button key={v} variant="plain" size="sm"
                  aria-pressed={customContextLength === v}
                  className="aria-pressed:bg-fill-selected aria-pressed:hover:bg-fill-selected"
                  onClick={() => setDeclared(d => ({ ...d, maxInputTokens: v }))}>{formatContextLength(v)}</Button>
              ))}
            </div>
            <div id={`${fieldId}-input-summary`} className="space-y-0.5 text-ui-sm text-label-secondary" aria-live="polite" aria-atomic="true">
              <div>{format(contextWindow.source === 'estimate'
                ? t.settings.capContextLengthEstimated
                : t.settings.capContextLengthDetected, { size: formatContextLength(contextWindow.uncappedSize) })}</div>
              <div className="font-medium text-label">{format(customContextLength === undefined
                ? t.settings.capContextLengthCurrentDefault
                : t.settings.capContextLengthCurrent, { size: formatContextLength(currentContextLength) })}</div>
            </div>
          </div>
          <div className="min-w-0 space-y-1.5">
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
