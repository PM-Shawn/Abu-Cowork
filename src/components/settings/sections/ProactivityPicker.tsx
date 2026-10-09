/**
 * ProactivityPicker — permanent home for the 主动度 preset (shy /
 * companion / butler). SkillDraftsPanel has a one-time onboarding
 * card for first-draft users, but they need a persistent place to
 * switch later — this is it.
 *
 * Mounted at the top of SoulSection since proactivity is a facet of
 * Abu's persona. Matches the PRD's "主动度 Preset UI" task; stats
 * tracking (7-day accept/reject counts) is deliberately out of scope
 * until the counter infrastructure exists.
 */

import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { Pressable } from '@/components/ds/pressable';
import { cn } from '@/lib/utils';

type Level = 'shy' | 'companion' | 'butler';

interface Option {
  id: Level;
  emoji: string;
  titleKey: keyof ReturnType<typeof useI18n>['t']['toolbox'];
  descKey: keyof ReturnType<typeof useI18n>['t']['toolbox'];
}

const OPTIONS: Option[] = [
  { id: 'shy', emoji: '🌱', titleKey: 'draftsOnboardPickShy', descKey: 'draftsOnboardShyDesc' },
  { id: 'companion', emoji: '🌿', titleKey: 'draftsOnboardPickCompanion', descKey: 'draftsOnboardCompanionDesc' },
  { id: 'butler', emoji: '🌳', titleKey: 'draftsOnboardPickButler', descKey: 'draftsOnboardButlerDesc' },
];

export default function ProactivityPicker() {
  const { t } = useI18n();
  const current = useSettingsStore((s) => s.soul?.proactivity ?? 'companion');
  const setProactivity = useSettingsStore((s) => s.setProactivity);

  return (
    <div className="rounded-panel border border-separator p-4">
      <div>
        <h4 className="text-ui font-medium text-label">
          {t.soul.proactivityTitle}
        </h4>
        <p className="mt-1 text-ui-sm text-label-secondary">
          {t.soul.proactivityDesc}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {OPTIONS.map((opt) => {
          const selected = current === opt.id;
          return (
            // A plain button: arrow keys do nothing, the choice takes a press, Enter or Space.
            <Pressable
              key={opt.id}
              aria-pressed={selected}
              onClick={() => setProactivity(opt.id)}
              className={cn(
                'flex flex-col items-start gap-1 rounded-control border px-3 py-2 text-left',
                selected ? 'border-control-border bg-fill-selected' : 'border-separator hover:bg-fill-hover',
              )}
            >
              <span className="flex items-center gap-2">
                <span className="text-title">{opt.emoji}</span>
                <span className="text-ui-sm font-medium text-label">
                  {t.toolbox[opt.titleKey]}
                </span>
              </span>
              <span className="text-caption text-label-secondary">
                {t.toolbox[opt.descKey]}
              </span>
            </Pressable>
          );
        })}
      </div>
    </div>
  );
}
