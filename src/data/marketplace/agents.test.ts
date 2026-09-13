import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { agentTemplates } from './agents';
import { parseAvatarValue } from '@/core/team/avatarPresets';

/** The frontmatter block an installed template becomes on disk. */
function frontmatter(content: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  expect(match).not.toBeNull();
  return parseYaml(match![1]) as Record<string, unknown>;
}

describe('marketplace agent templates', () => {
  // Ruling 2026-09-13: the marketplace experts carry icons of their own rather
  // than the uniform robot mark. Parsing the value the way the renderer does
  // catches a raw emoji or a typo'd icon/tint coming back — either would
  // silently degrade to the default mark once installed.
  it('gives every template an icon reference the renderer understands', () => {
    expect(agentTemplates.length).toBeGreaterThan(0);
    const kinds = agentTemplates.map((template) => {
      const avatar = frontmatter(template.content ?? '').avatar;
      return [template.id, parseAvatarValue(typeof avatar === 'string' ? avatar : undefined).kind];
    });
    expect(kinds).toEqual(agentTemplates.map((template) => [template.id, 'icon']));
  });
});
