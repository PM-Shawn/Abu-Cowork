import { useCallback } from 'react';
import { usePluginStore } from '@/stores/pluginStore';
import { isSkillAllowedIn } from '@/core/plugin/activationPolicy';

/** The skills page deliberately lists skills of disabled plugins so they stay
 * discoverable, but the model excludes them. Reading the master gate here keeps
 * the switch and the trial button honest about what the model can actually see.
 */
export function usePluginSkillGate(): (skill: { skillDir: string }) => boolean {
  const activations = usePluginStore(s => s.activationByKey);
  const ready = usePluginStore(s => s.activationReady);
  return useCallback(skill => isSkillAllowedIn(activations, ready, skill.skillDir), [activations, ready]);
}
