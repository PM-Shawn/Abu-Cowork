import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanAgentNames, scanTeamFiles } from './pluginPackageScan.mjs';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-package-scan-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function linkDir(target: string, link: string) {
  // A junction needs no privilege on Windows; elsewhere a plain directory link.
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('pluginPackageScan', () => {
  it('reads teams/ and agents/ that the package owns', () => {
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(path.join(pkg, 'teams'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'teams', 'crew.json'), '{"name":"Crew"}');
    fs.writeFileSync(path.join(pkg, 'agents', 'writer.md'), '---\nname: writer\ndescription: writes\n---\nbody\n');

    expect(scanTeamFiles(pkg)).toEqual([{ id: 'crew', raw: { name: 'Crew' } }]);
    expect(scanAgentNames(pkg)).toEqual(['writer']);
  });

  it('does not read through a teams/ or agents/ that links outside the package', () => {
    // The installer refuses these links, so the market check must see the same
    // empty package instead of reading files it was never shipped.
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'leaked.json'), '{"secretKey":"x"}');
    fs.writeFileSync(path.join(outside, 'leaked.md'), '---\nname: leaked-agent\ndescription: x\n---\nbody\n');
    const pkg = path.join(root, 'pkg');
    fs.mkdirSync(pkg);
    linkDir(outside, path.join(pkg, 'teams'));
    linkDir(outside, path.join(pkg, 'agents'));

    expect(scanTeamFiles(pkg)).toEqual([]);
    expect(scanAgentNames(pkg)).toEqual([]);
  });
});
