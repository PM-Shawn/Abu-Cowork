import type { Dispatch, SetStateAction } from 'react';
import { format, useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { formatContextLength } from '@/core/llm/contextWindow';
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
  detectedContextWindow,
  estimatedContextWindow,
}: {
  declared: ModelDeclaredCapabilities;
  setDeclared: Dispatch<SetStateAction<ModelDeclaredCapabilities>>;
  apiFormat: ApiFormat;
  /** 获取模型时服务报告的长度；没有就是 undefined */
  detectedContextWindow?: number;
  /** 留空时阿布按名字估计的长度 */
  estimatedContextWindow: number;
}) {
  const { t } = useI18n();
  const isAnthropic = apiFormat === 'anthropic';
  return (
    <div className="space-y-2">
      <div className="text-minor font-medium text-[var(--abu-text-primary)]">
        {t.settings.advancedConfig}
      </div>
      <div className="space-y-2">
        {/* items-start：每格按自身高度靠上，「能看图」多一行说明时两列第一行仍在同一水平线 */}
        <div className="grid grid-cols-2 gap-2 items-start">
          <div className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setDeclared(d => ({ ...d, supportsTools: !d.supportsTools }))}>
            <Checkbox checked={!!declared.supportsTools}
              onChange={() => setDeclared(d => ({ ...d, supportsTools: !d.supportsTools }))} />
            <span className="text-body text-[var(--abu-text-primary)]">{t.settings.capTools}</span>
          </div>
          <div className="flex flex-col cursor-pointer select-none"
            onClick={() => setDeclared(d => ({ ...d, supportsImages: !d.supportsImages }))}>
            <div className="flex items-center gap-2">
              <Checkbox checked={!!declared.supportsImages}
                onChange={() => setDeclared(d => ({ ...d, supportsImages: !d.supportsImages }))} />
              <span className="text-body text-[var(--abu-text-primary)]">{t.settings.capImages}</span>
            </div>
            {/* pl-6 = 勾选框宽度 16px + 间距 8px，说明与「能看图」文字左对齐 */}
            <span className="pl-6 text-caption text-[var(--abu-text-tertiary)]">{t.settings.capImagesHint}</span>
          </div>
          <div className="flex items-center gap-2 cursor-pointer select-none"
            onClick={() => setDeclared(d => ({ ...d, supportsReasoning: !d.supportsReasoning }))}>
            <Checkbox checked={!!declared.supportsReasoning}
              onChange={() => setDeclared(d => ({ ...d, supportsReasoning: !d.supportsReasoning }))} />
            <span className="text-body text-[var(--abu-text-primary)]">{t.settings.capReasoning}</span>
          </div>
        </div>
        {!isAnthropic && declared.supportsReasoning && (
          <div className="pl-3 space-y-2 border-l border-black/10">
            <div className="flex items-center gap-2">
              <span className="text-body text-[var(--abu-text-secondary)]">{t.settings.capEffort}</span>
              {(['low', 'medium', 'high'] as const).map(e => (
                <div key={e} className="flex items-center gap-1 cursor-pointer select-none"
                  onClick={() => setDeclared(d => ({ ...d, supportedEfforts: toggleEffort(d.supportedEfforts, e) }))}>
                  <Checkbox checked={!!declared.supportedEfforts?.includes(e)}
                    onChange={() => setDeclared(d => ({ ...d, supportedEfforts: toggleEffort(d.supportedEfforts, e) }))} />
                  <span className="text-minor text-[var(--abu-text-secondary)]">
                    {{ low: t.settings.effortLow, medium: t.settings.effortMedium, high: t.settings.effortHigh }[e]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div className="space-y-1">
            <div className="text-body text-[var(--abu-text-primary)]">{t.settings.capContextLength}</div>
            <div className="text-caption text-[var(--abu-text-tertiary)]">{t.settings.capContextLengthHint}</div>
            <Input
              type="text"
              inputMode="numeric"
              placeholder={detectedContextWindow !== undefined
                ? format(t.settings.capContextLengthDetected, { size: formatContextLength(detectedContextWindow) })
                : format(t.settings.capContextLengthEstimated, { size: formatContextLength(estimatedContextWindow) })}
              value={declared.maxInputTokens ?? ''}
              className="h-8"
              onChange={e => { const raw = e.target.value.replace(/[^0-9]/g, ''); setDeclared(d => ({ ...d, maxInputTokens: raw === '' ? undefined : Number(raw) })); }}
            />
            <div className="flex gap-1 flex-wrap">
              {[8192, 16384, 32768, 65536, 131072, 262144].map(v => (
                <Button key={v} variant="ghost" size="xs" type="button"
                  onClick={() => setDeclared(d => ({ ...d, maxInputTokens: v }))}>{formatContextLength(v)}</Button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <div className="text-body text-[var(--abu-text-primary)]">{t.settings.capMaxOutput}</div>
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
