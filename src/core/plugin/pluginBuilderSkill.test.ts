import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TEAMS } from '@/core/team/builtinTeams';
import { BUILTIN_AGENT_NAMES } from '../../../electron/shared/pluginAgentFormat.mjs';

// The package name is bound permanently on the first `plugin_prepare`
// (electron/pluginAuthorWorker.cjs). There is no rename path, so the only
// place a wrong name can still be stopped is the authoring skill's own
// instructions — assert the wording that makes the model ask first.
const skillFile = (name: string) => readFileSync(
  fileURLToPath(new URL(`../../../builtin-skills/abu-plugin-builder/${name}`, import.meta.url)),
  'utf8',
);
const SKILL = skillFile('SKILL.md');
// Backticks are Markdown formatting around tool and field names; the
// instruction has to read the same with or without them.
const PROSE = SKILL.replace(/`/g, '');

describe('abu-plugin-builder SKILL.md', () => {
  it('asks the user to confirm the package name before the first preparation', () => {
    expect(PROSE).toMatch(/before the first plugin_prepare/i);
    expect(PROSE).toMatch(/state the exact package name/i);
    expect(PROSE).toMatch(/wait for the user's confirmation/i);
  });

  it('says plainly that the name cannot be changed afterwards, and why', () => {
    expect(PROSE).toContain('cannot be changed afterwards');
    expect(PROSE).toContain('install key, package path and marketplace identity');
  });

  it('forbids proposing a rename on later edits', () => {
    expect(PROSE).toMatch(/on later edits never propose a rename/i);
  });

  it('points team writing at the team and catalog references', () => {
    for (const reference of ['references/teams.md', 'references/builtin-catalog.md']) {
      expect(PROSE).toContain(reference);
      expect(() => skillFile(reference)).not.toThrow();
    }
    expect(PROSE).toMatch(/read_skill_file/);
    expect(PROSE).toMatch(/minAbuVersion/);
  });
});

// The catalog is what the model copies names from; a stale line there becomes
// a `builtin:` reference the installer refuses. Pin both builders' copies to
// the runtime lists.
describe.each(['abu-plugin-builder', 'abu-app-builder'])('%s references/builtin-catalog.md', (skill) => {
  const CATALOG = readFileSync(
    fileURLToPath(new URL(`../../../builtin-skills/${skill}/references/builtin-catalog.md`, import.meta.url)),
    'utf8',
  );

  it('lists exactly the built-in experts a package may reference', () => {
    const section = CATALOG.split('## Built-in experts')[1]!.split('## Built-in teams')[0]!;
    const listed = [...section.matchAll(/`([^`]+)`/g)].map(match => match[1]);
    expect(listed).toEqual(BUILTIN_AGENT_NAMES.filter(name => name !== 'abu'));
  });

  it('lists every built-in team with its id, name, leader and members', () => {
    const rows = [...CATALOG.matchAll(/^\| `(builtin-team:[a-z-]+)` \| (.+?) \| (.+?) \| (.+?) \|$/gm)]
      .map(match => ({ id: match[1], name: match[2], leader: match[3], members: match[4].split('、') }));
    const expected = BUILTIN_TEAMS.map(team => ({
      id: team.id,
      name: team.name,
      leader: team.leaderRoleId.replace(/^builtin:/, ''),
      members: team.memberRoleIds.filter(roleId => roleId !== team.leaderRoleId).map(roleId => roleId.replace(/^builtin:/, '')),
    }));
    expect(rows).toEqual(expected);
  });
});
