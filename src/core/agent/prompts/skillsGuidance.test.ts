import { describe, it, expect } from 'vitest';
import {
  SKILLS_GUIDANCE_BY_LEVEL,
  DEFAULT_PROACTIVITY,
  getSkillsGuidance,
  type ProactivityLevel,
} from './skillsGuidance';

describe('skillsGuidance', () => {
  it('exposes three distinct levels with non-empty content', () => {
    const levels: ProactivityLevel[] = ['shy', 'companion', 'butler'];
    const texts = levels.map((l) => SKILLS_GUIDANCE_BY_LEVEL[l]);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(100);
      expect(text).toContain('使用技能');
    }
    // All three must differ — this is the whole point of the preset.
    expect(new Set(texts).size).toBe(3);
  });

  it('default proactivity is companion', () => {
    expect(DEFAULT_PROACTIVITY).toBe('companion');
  });

  it('getSkillsGuidance(undefined) falls back to companion', () => {
    expect(getSkillsGuidance(undefined)).toBe(SKILLS_GUIDANCE_BY_LEVEL.companion);
  });

  it('getSkillsGuidance returns the requested level', () => {
    expect(getSkillsGuidance('shy')).toBe(SKILLS_GUIDANCE_BY_LEVEL.shy);
    expect(getSkillsGuidance('companion')).toBe(SKILLS_GUIDANCE_BY_LEVEL.companion);
    expect(getSkillsGuidance('butler')).toBe(SKILLS_GUIDANCE_BY_LEVEL.butler);
  });

  it('shy prompt is conservative: no proactive create language', () => {
    const shy = SKILLS_GUIDANCE_BY_LEVEL.shy;
    // Shy must tell the agent NOT to auto-create.
    expect(shy).toMatch(/不主动调用 skill_manage|不主动.*create|被动/);
    // Shy must not sell the "积极沉淀" butler framing.
    expect(shy).not.toContain('积极沉淀');
  });

  it('companion prompt covers create triggers and scope 3-question guide', () => {
    const companion = SKILLS_GUIDANCE_BY_LEVEL.companion;
    expect(companion).toContain('skill_manage');
    expect(companion).toContain("action='create'");
    expect(companion).toContain('scope');
    expect(companion).toContain('workspace-auto');
    // 3-question scope guide anchors the user/workspace-auto decision.
    expect(companion).toMatch(/判据 3 问|3 问/);
    // Must tell agent to respect past feedback before creating.
    expect(companion).toContain('feedback');
  });

  it('butler prompt is most aggressive about consumption', () => {
    const butler = SKILLS_GUIDANCE_BY_LEVEL.butler;
    expect(butler).toMatch(/必须|强制|激进/);
    // Butler inherits the same scope + feedback rules as companion.
    expect(butler).toContain('workspace-auto');
    expect(butler).toContain('feedback');
  });
});
