/**
 * 「市场」 for the Skills tab — every skill that came from somewhere other than
 * the user's own files: bundled with Abu (`builtin`), shipped inside an
 * installed plugin (`plugin`), or pushed by the organization (`enterprise`).
 *
 * The panel is deliberately read-only. A plugin's skill has no life of its own:
 * it arrived with a package and leaves when that package is uninstalled, from
 * the Plugins tab. Offering "卸载" here would promise a removal this surface
 * cannot perform and would leave the plugin's install record describing files
 * that are gone. Organization skills are managed in the 组织 view for the same
 * reason. So the `···` offers exactly what is true here: try it, or read it.
 *
 * The hint card stays at the top even when the list is empty — with nothing
 * installed, "how do skills get here" is the only question worth answering.
 */

import { useMemo, useState } from 'react';
import { FileText, Puzzle } from 'lucide-react';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { skillLoader } from '@/core/skill/loader';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import InstalledItemMenu from '@/components/toolbox/InstalledItemMenu';
import { useTrialLauncher } from '@/components/toolbox/useTrialLauncher';
import SkillDetailPanel from './SkillDetailPanel';
import type { Skill, SkillMetadata, SkillSource } from '@/types';

/**
 * The complement of MINE_SOURCES in `customize/SkillsSection.tsx`: a source is
 * either the user's own or from outside, never both and never neither. An
 * un-tagged legacy skill counts as the user's own, so it is absent here.
 */
const EXTERNAL_SOURCES: ReadonlySet<SkillSource> = new Set<SkillSource>([
  'builtin', 'plugin', 'enterprise',
]);

const BADGE_TONE: Record<'neutral' | 'blue' | 'clay', string> = {
  neutral: 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-muted)]',
  blue: 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]',
  clay: 'bg-[var(--abu-clay-tint)] text-[var(--abu-clay)]',
};

type BadgeKey = 'skillSourceBuiltin' | 'skillSourcePlugin' | 'organizationSource';

/** Provenance is the one thing a market row must say — where did this come from. */
function sourceBadge(source: SkillSource | undefined): { labelKey: BadgeKey; tone: keyof typeof BADGE_TONE } {
  if (source === 'plugin') return { labelKey: 'skillSourcePlugin', tone: 'blue' };
  if (source === 'enterprise') return { labelKey: 'organizationSource', tone: 'clay' };
  return { labelKey: 'skillSourceBuiltin', tone: 'neutral' };
}

/**
 * Discovery only carries metadata; the detail needs the loaded body. A skill the
 * loader cannot hand back still gets its row — dropping it would make an
 * installed skill invisible — it just opens with an empty body.
 */
function toSkill(meta: SkillMetadata): Skill {
  return skillLoader.getSkill(meta.name) ?? { ...meta, content: '', filePath: '', skillDir: '' };
}

export default function ExternalSkillsPanel({ searchQuery }: { searchQuery: string }) {
  const { t } = useI18n();
  const tb = t.toolbox;
  const skills = useDiscoveryStore((s) => s.skills);
  const setActiveExtensionsTab = useSettingsStore((s) => s.setActiveExtensionsTab);
  // Same switch, same store action as a 「我的」 card (customize/SkillsSection.tsx
  // renderSkillCard) — a skill is enabled or not, and which half of the tab it
  // is looked at from must not change that. Read-only here means "you cannot
  // delete what a plugin owns", not "you cannot silence it".
  const disabledSkills = useSettingsStore((s) => s.disabledSkills);
  const toggleSkillEnabled = useSettingsStore((s) => s.toggleSkillEnabled);
  const launchTrial = useTrialLauncher();
  const [viewing, setViewing] = useState<Skill | null>(null);

  const disabledSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

  const external = useMemo(
    () => skills.filter((s) => s.source !== undefined && EXTERNAL_SOURCES.has(s.source)).map(toSkill),
    [skills],
  );

  const visible = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return external;
    return external.filter((s) => {
      const tags = (s.tags ?? []).join(' ').toLowerCase();
      return s.name.toLowerCase().includes(query)
        || s.description.toLowerCase().includes(query)
        || tags.includes(query);
    });
  }, [external, searchQuery]);

  return (
    <div className="h-full overflow-y-auto overlay-scroll px-8 py-3">
      <div className="mx-auto max-w-5xl">
        {/* Where skills come from — kept above the list, empty or not. */}
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] px-4 py-3">
          <Puzzle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
          <div className="min-w-0 flex-1">
            <p className="text-h-xs text-[var(--abu-text-primary)]">{tb.skillsMarketHintTitle}</p>
            <p className="mt-0.5 text-minor text-[var(--abu-text-tertiary)]">{tb.skillsMarketHintBody}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            data-testid="skills-market-go-plugins"
            onClick={() => setActiveExtensionsTab('plugins')}
          >
            {tb.skillsMarketGoPlugins}
          </Button>
        </div>

        {visible.length === 0 ? (
          <p className="py-8 text-center text-body text-[var(--abu-text-tertiary)]">
            {tb.noSkillsFound}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {visible.map((skill) => {
              const badge = sourceBadge(skill.source);
              return (
                <li
                  key={skill.name}
                  data-testid="external-skill-row"
                  className="flex items-center gap-3 rounded-lg border border-[var(--abu-border)] px-3 py-2.5"
                >
                  <FileText className="h-4 w-4 shrink-0 text-[var(--abu-text-muted)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-h-xs text-[var(--abu-text-primary)]">{skill.name}</span>
                      <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-caption font-medium', BADGE_TONE[badge.tone])}>
                        {tb[badge.labelKey]}
                      </span>
                    </div>
                    <p className="truncate text-minor text-[var(--abu-text-tertiary)]">{skill.description}</p>
                  </div>
                  <Toggle
                    checked={!disabledSet.has(skill.name)}
                    onChange={() => toggleSkillEnabled(skill.name)}
                    size="sm"
                    tone="green"
                  />
                  <InstalledItemMenu
                    testId="skill-item-menu"
                    ariaLabel={format(tb.itemMenuLabel, { name: skill.name })}
                    actions={[
                      {
                        id: 'trial',
                        label: tb.menuTrial,
                        onSelect: () => launchTrial({ name: skill.name, description: skill.description }),
                      },
                      { id: 'view', label: tb.menuView, onSelect: () => setViewing(skill) },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Same detail 「我的」 shows, minus the actions only an owner has. */}
      <SkillDetailPanel skill={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
