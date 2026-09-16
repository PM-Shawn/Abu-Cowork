import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The package name is bound permanently on the first `plugin_prepare`
// (electron/pluginAuthorWorker.cjs). There is no rename path, so the only
// place a wrong name can still be stopped is the authoring skill's own
// instructions — assert the wording that makes the model ask first.
const SKILL = readFileSync(
  fileURLToPath(new URL('../../../builtin-skills/abu-plugin-builder/SKILL.md', import.meta.url)),
  'utf8',
);
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
});
