import { describe, expect, it } from 'vitest';
import { resolveModelProfile } from '@/core/llm/modelProfile';
import type { PromptSection } from '@/core/llm/promptSections';
import { refreshModelPromptSections } from './modelPromptSections';

const sections: PromptSection[] = [
  { name: 'persona', text: 'initial persona', cacheable: true },
  { name: 'planning', text: 'initial plan', cacheable: true },
  { name: 'family-notes', text: 'initial family', cacheable: true },
  { name: 'skill-content', text: 'Already generated command result', cacheable: true },
  { name: 'computer-use', text: 'initial computer instructions', cacheable: true },
  { name: 'safety-anchor', text: 'safety', cacheable: false, pinToEnd: true },
];
const profile = resolveModelProfile({ modelId: 'gpt-5.4' });

describe('model-dependent prompt recovery', () => {
  it('refreshes family and structured computer guidance while preserving skill results', () => {
    const refreshed = refreshModelPromptSections(sections, profile, {
      supportsTools: true, computerUseTier: 'structured', windows: false, customIdentity: false,
    });
    expect(refreshed.find((section) => section.name === 'computer-use')?.text).toContain('current model cannot see images');
    expect(refreshed.find((section) => section.name === 'family-notes')?.text).not.toBe('initial family');
    expect(refreshed.find((section) => section.name === 'skill-content')).toBe(sections[3]);
    expect(refreshed.find((section) => section.name === 'safety-anchor')).toBe(sections[5]);
  });

  it('restores full computer guidance when the selected model supports it', () => {
    const structured = refreshModelPromptSections(sections, profile, {
      supportsTools: true, computerUseTier: 'structured', windows: false, customIdentity: false,
    });
    const full = refreshModelPromptSections(structured, profile, {
      supportsTools: true, computerUseTier: 'full', windows: false, customIdentity: false,
    });
    expect(full.find((section) => section.name === 'computer-use')?.text).toContain('Coordinate system');
    expect(full.find((section) => section.name === 'computer-use')?.text).not.toContain('current model cannot see images');
    expect(full.filter((section) => section.name === 'family-notes')).toHaveLength(1);
  });

  it('preserves a configured agent identity', () => {
    const identity: PromptSection = { name: 'identity', text: 'Configured agent identity', cacheable: true };
    const result = refreshModelPromptSections([identity, ...sections], profile, {
      supportsTools: true, computerUseTier: 'full', windows: true, customIdentity: true,
    });
    expect(result.find((section) => section.name === 'identity')).toBe(identity);
    expect(result.find((section) => section.name === 'planning')?.text).toContain('PowerShell');
  });
});
