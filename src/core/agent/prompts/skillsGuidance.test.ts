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
      expect(text).toContain('Using Skills');
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
    expect(shy).toMatch(/Do NOT proactively call skill_manage|passive/i);
    // Shy must not sell the "proactively distill" butler framing.
    expect(shy).not.toContain('Proactively distill');
  });

  it('companion prompt covers create triggers and scope 3-question guide', () => {
    const companion = SKILLS_GUIDANCE_BY_LEVEL.companion;
    expect(companion).toContain('skill_manage');
    expect(companion).toContain("action='create'");
    expect(companion).toContain('scope');
    expect(companion).toContain('workspace-auto');
    // 3-question scope guide anchors the user/workspace-auto decision.
    expect(companion).toMatch(/3-question test|3 question/i);
    // Must tell agent to respect past feedback before creating.
    expect(companion).toContain('feedback');
  });

  it('companion + butler prompts carry a concrete create payload example', () => {
    // LLMs miss required nested fields without a worked example.
    // Fix B: guidance must show what a successful create call looks like.
    for (const level of ['companion', 'butler'] as const) {
      const prompt = SKILLS_GUIDANCE_BY_LEVEL[level];
      expect(prompt).toContain('"action": "create"');
      expect(prompt).toContain('frontmatter');
      // description is the field we saw LLMs omit in production — make sure
      // the example explicitly shows it inside frontmatter.
      expect(prompt).toMatch(/"description":\s*"/);
    }
  });

  it('companion + butler prompts explain agent_proposed explicit vs auto split', () => {
    // After the scope-A regression fix: default create writes direct to
    // workspace-auto; agent_proposed=true is the opt-in flag for auto
    // proposals. Guidance must teach both modes + show a worked example
    // with agent_proposed=true, otherwise the agent will never use drafts.
    for (const level of ['companion', 'butler'] as const) {
      const prompt = SKILLS_GUIDANCE_BY_LEVEL[level];
      expect(prompt).toContain('agent_proposed');
      // Must explicitly distinguish the user-asked case from the auto case.
      expect(prompt).toMatch(/User explicitly asked/i);
      expect(prompt).toMatch(/proposed it yourself|Self-proposed/i);
      // And a concrete payload example showing the flag on.
      expect(prompt).toMatch(/"agent_proposed":\s*true/);
    }
  });

  it('butler prompt is most aggressive about consumption', () => {
    const butler = SKILLS_GUIDANCE_BY_LEVEL.butler;
    expect(butler).toMatch(/mandatory|must|aggressive/i);
    // Butler inherits the same scope + feedback rules as companion.
    expect(butler).toContain('workspace-auto');
    expect(butler).toContain('feedback');
  });
});
