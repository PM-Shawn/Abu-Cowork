import type { AppDefinition, AppLocale, AppRunRef, AppScene } from '@/types/app';
import type { TranslationDict } from '@/i18n/types';
import { effectiveRun } from '@/core/app/appBinding';
import { targetDisplayName, type ResolvedRun } from '@/core/app/appRefs';

type Format = (template: string, values: Record<string, string | number>) => string;

/**
 * What a scene card says about who handles it: 「由 某某 负责」, 「使用技能 某某」,
 * 「由阿布负责」 when nothing is named, and 「负责人 某某 已不可用」 when the
 * owner is gone for good.
 */
export function describeSceneRun(
  app: AppDefinition,
  scene: AppScene | undefined,
  resolved: ResolvedRun | undefined,
  t: TranslationDict,
  format: Format,
  locale: AppLocale,
): { label: string; unavailable: boolean } {
  const run: AppRunRef | undefined = effectiveRun(app, scene);
  if (!run || !resolved) return { label: t.appHome.sceneRunDefault, unavailable: false };
  const owner = resolved.owner;
  if (owner?.status === 'unavailable') return { label: format(t.appHome.sceneRunUnavailable, { name: owner.label }), unavailable: true };
  if (owner) {
    const name = targetDisplayName(owner, locale);
    return { label: format(owner.status === 'ok' && owner.kind === 'expert' ? t.appHome.sceneRunExpert : t.appHome.sceneRunTeam, { name }), unavailable: false };
  }
  const skill = resolved.skill!;
  if (skill.status === 'unavailable') return { label: format(t.appHome.sceneRunUnavailable, { name: skill.label }), unavailable: true };
  return { label: format(t.appHome.sceneRunSkill, { name: targetDisplayName(skill, locale) }), unavailable: false };
}
