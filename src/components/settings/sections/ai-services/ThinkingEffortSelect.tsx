import { useI18n } from '@/i18n';
import { Select } from '@/components/ds/select';
import { isThinkingEffort } from '@/core/llm/thinkingEffort';
import { SETTING_CONTROL_WIDTH } from '@/components/settings/settingsLayout';
import type { ThinkingEffort } from '@/types/provider';

const ALL_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'high', 'max'];

/** The Select's value for 「默认」: no effort stored, Abu's own setting for the model. */
const DEFAULT_EFFORT = 'default';

/**
 * 思考强度 picker for one model: 默认 / 关闭 / 低 / 高 / 最高. `undefined` is 默认.
 *
 * Shared by the advanced-capabilities editor (custom and local endpoints) and the model
 * list of the curated built-in providers, which have no advanced section: every provider
 * offers the same control, and a pick is stored the same way on the model.
 */
export default function ThinkingEffortSelect({
  value,
  onChange,
  label,
  modelDefault,
  efforts = ALL_EFFORTS,
}: {
  value: ThinkingEffort | undefined;
  onChange: (value: ThinkingEffort | undefined) => void;
  /** Accessible name; defaults to 「思考强度」. Give each model's select its own when several are on screen. */
  label?: string;
  /** What 「默认」 resolves to for this model, when known; shown as 「默认（高）」. */
  modelDefault?: 'high';
  /** The levels the model carries on its wire (`offeredThinkingEffortsFor`); only these are listed. */
  efforts?: readonly ThinkingEffort[];
}) {
  const { t } = useI18n();
  const switchOnly = efforts.length === 2 && efforts.includes('off') && efforts.includes('high');
  const effortLabel = (effort: ThinkingEffort) => {
    switch (effort) {
      case 'off': return t.settings.thinkingEffortOff;
      case 'low': return t.settings.effortLow;
      // A model with an on/off switch and no depth has one "on", listed under the stored value 'high'.
      case 'high': return switchOnly ? t.settings.thinkingEffortOn : t.settings.effortHigh;
      case 'max': return t.settings.thinkingEffortMax;
    }
  };
  const defaultLabel = modelDefault
    ? `${t.settings.thinkingEffortDefault}${t.settings.thinkingEffortDefaultIs.replace('{effort}', t.settings.effortHigh)}`
    : t.settings.thinkingEffortDefault;
  return (
    <div className={SETTING_CONTROL_WIDTH.thinkingEffort}>
      <Select
        fullWidth
        label={label ?? t.settings.capThinkingEffort}
        value={isThinkingEffort(value) ? value : DEFAULT_EFFORT}
        onValueChange={(next) => onChange(isThinkingEffort(next) ? next : undefined)}
        options={[
          { value: DEFAULT_EFFORT, label: defaultLabel },
          ...efforts.map((effort) => ({ value: effort, label: effortLabel(effort) })),
        ]}
      />
    </div>
  );
}
