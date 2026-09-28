import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMarket } from './validate-plugin-market.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostVersion = '0.51.0';

describe('validate-plugin-market', () => {
  it('passes the official market and the example market', async () => {
    const official = await checkMarket(path.join(repoRoot, 'builtin-plugin-market'), { hostVersion });
    expect(official.failures.map(String)).toEqual([]);
    expect(official.checked.map(entry => entry.name)).toContain('abu-prd-doctor');

    const examples = await checkMarket(path.join(repoRoot, 'examples', 'plugin-market'), { hostVersion });
    expect(examples.failures.map(String)).toEqual([]);
    expect(examples.checked).toEqual([expect.objectContaining({ name: 'abu-example-shop-ops', providesApp: true })]);
  });

  it('names the failing field for every broken fixture entry', async () => {
    const result = await checkMarket(path.join(repoRoot, 'tests', 'fixtures', 'plugin-market-broken'), { hostVersion });
    const byEntry = new Map<string, string[]>();
    for (const failure of result.failures) byEntry.set(failure.entry, [...(byEntry.get(failure.entry) ?? []), failure.field ?? '']);
    expect(byEntry.get('broken-run-ref')).toContain('app.home.modes.items[0].scenes[0].run.team');
    expect(byEntry.get('app-without-flag')).toEqual(expect.arrayContaining(['providesApp', 'version']));
    expect(byEntry.get('missing-min-version')).toEqual(['minAbuVersion']);
    // The scan reads a package by the rules the renderer installs it by, so a
    // name or a connector map the installer would refuse is refused here and
    // the market never lists a package nobody can install.
    expect(byEntry.get('unsafe-skill-name')).toEqual(['skills/tools']);
    expect(byEntry.get('bad-mcp-shape')).toEqual(['mcpServers']);
  });

  it('reports a package that needs a newer Abu', async () => {
    const result = await checkMarket(path.join(repoRoot, 'examples', 'plugin-market'), { hostVersion: '0.50.0' });
    expect(result.failures.map(failure => failure.field)).toEqual(['minAbuVersion']);
  });
});
