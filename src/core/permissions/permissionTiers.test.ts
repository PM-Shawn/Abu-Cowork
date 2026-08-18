import { describe, expect, it, beforeEach } from 'vitest';
import { initLanguage } from '../../i18n';
import {
  getCapabilityTierLabel,
  getCapabilityTierDescription,
  type UnattendedCapability,
} from './permissionTiers';

const ALL: UnattendedCapability[] = ['chat_only', 'read_tools', 'safe_tools', 'full', 'custom'];

// The point of this module is that a user learns the words once. The tests
// therefore pin *sameness across scenarios* — every unattended surface pulls
// from here, so a divergent label can only reappear by adding a second source.
describe('permissionTiers', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
  });

  it('gives the three shared tiers the plan §4.2 wording', () => {
    expect(getCapabilityTierLabel('read_tools')).toBe('只看不动');
    expect(getCapabilityTierLabel('safe_tools')).toBe('常规');
    expect(getCapabilityTierLabel('full')).toBe('完全放开');
  });

  it('keeps the scenario-specific extras distinct from the shared three', () => {
    // chat_only is IM-only, custom is trigger-only. They are not a fourth and
    // fifth rung of the same ladder, so they get their own words.
    const shared = [
      getCapabilityTierLabel('read_tools'),
      getCapabilityTierLabel('safe_tools'),
      getCapabilityTierLabel('full'),
    ];
    expect(shared).not.toContain(getCapabilityTierLabel('chat_only'));
    expect(shared).not.toContain(getCapabilityTierLabel('custom'));
  });

  it('has a non-empty label and description for every value, in both locales', () => {
    for (const locale of ['zh-CN', 'en-US'] as const) {
      initLanguage(locale);
      for (const capability of ALL) {
        expect(getCapabilityTierLabel(capability), `${locale}/${capability} label`)
          .not.toBe('');
        expect(getCapabilityTierDescription(capability), `${locale}/${capability} desc`)
          .not.toBe('');
      }
    }
  });

  it('produces distinct labels — no two tiers read the same', () => {
    const labels = ALL.map(getCapabilityTierLabel);
    expect(new Set(labels).size).toBe(ALL.length);
  });
});
