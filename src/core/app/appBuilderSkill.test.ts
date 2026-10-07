import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAppFile } from '../../../electron/shared/appSpec.mjs';
import { parseTeamFile } from '../../../electron/shared/pluginSpec.mjs';

const skillFile = (name: string) => readFileSync(
  fileURLToPath(new URL(`../../../builtin-skills/abu-app-builder/${name}`, import.meta.url)),
  'utf8',
);
const SKILL = skillFile('SKILL.md');
// Backticks are Markdown formatting around tool and field names; the
// instruction has to read the same with or without them.
const PROSE = SKILL.replace(/`/g, '');

/** The first ```json block after `heading`; a Windows checkout ends its lines with CRLF. */
function example(file: string, heading: string): unknown {
  const block = /```json\r?\n([\s\S]*?)\r?\n```/.exec(skillFile(file).split(heading)[1]!)![1]!;
  return JSON.parse(block);
}

describe('abu-app-builder SKILL.md', () => {
  it('keeps the draft in the conversation folder and leaves creating to the preview card', () => {
    expect(PROSE).toMatch(/only inside the current conversation folder/i);
    expect(PROSE).toMatch(/nothing is created until the user confirms the preview card/i);
    expect(PROSE).toMatch(/never add the app yourself/i);
  });

  it('asks app_prepare for the user\'s own experts and teams before writing', () => {
    expect(PROSE).toMatch(/before writing anything, call app_prepare/i);
    expect(PROSE).toContain('yours');
  });

  it('prefers what the user already has over new experts and teams', () => {
    const order = ['mine:<name>', 'builtin:<name>', 'plugin:<plugin>/<id>', 'Only when none of these fits'].map((text) => PROSE.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('points at the reference files and the template count', () => {
    for (const reference of ['references/app-config.md', 'references/teams.md', 'references/builtin-catalog.md']) {
      expect(PROSE).toContain(reference);
      expect(() => skillFile(reference)).not.toThrow();
    }
    expect(PROSE).toMatch(/read_skill_file/);
    expect(PROSE).toMatch(/3–6 templates/);
    expect(PROSE).toMatch(/allowedOrigins/);
    expect(PROSE).toMatch(/status: "ready"/);
  });
});

// The model copies the examples; one that fails validation teaches it to write
// drafts that fail too.
describe('abu-app-builder reference examples', () => {
  it('the app example is a valid created app', () => {
    expect(() => parseAppFile(example('references/app-config.md', '## Example'), { source: 'created' })).not.toThrow();
  });

  it('the team example is a valid draft team', () => {
    expect(() => parseTeamFile(example('references/teams.md', '## Example'), 'weekly-review', { agentNames: ['周报整理员'] })).not.toThrow();
  });
});
