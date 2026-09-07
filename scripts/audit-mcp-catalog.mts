/**
 * Audit the connector catalog against the npm registry.
 *
 * `BUILTIN_REGISTRY` (src/core/agent/mcpDiscovery.ts) is the single source of
 * truth for every connector a user can install from 「扩展 › 连接 › 市场」 and
 * every one the agent can install through `manage_mcp_server`. Its entries name
 * npm packages, and npm packages get unpublished, archived and superseded
 * without anything in this repo changing — a catalog row can rot into an
 * install that 404s while all tests stay green. This script asks the registry
 * what is actually there.
 *
 *   npx tsx scripts/audit-mcp-catalog.mts
 *
 * It hits the real network, so it is a manual/periodic check and is
 * deliberately NOT wired into `npm run verify` or `npm test`. Exit code is 1
 * when any package 404s (a broken catalog row), 0 otherwise — a `deprecated`
 * package still installs and runs, so it is reported, not failed on.
 *
 * NOTE on how the catalog is read: `mcpDiscovery.ts` cannot be imported under
 * tsx. Its transitive imports reach `@enterprise-modules`, a build-time Vite
 * alias with no Node resolution, plus the Tauri APIs and the browser-only MCP
 * store. Stubbing that graph would be a bigger, more fragile fixture than the
 * thing being audited, so the registry's `name`/`args` are parsed out of the
 * source text instead. The parse is pinned by the assertion below: if the
 * literal's shape ever changes, this fails loudly rather than auditing a
 * partial catalog.
 */

import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(here, '../src/core/agent/mcpDiscovery.ts');

/** Entries the source declares, as `name` + the npm package its args install. */
function readCatalog(): { name: string; pkg: string | null }[] {
  const source = readFileSync(SOURCE, 'utf-8');
  const start = source.indexOf('export const BUILTIN_REGISTRY');
  if (start < 0) throw new Error(`BUILTIN_REGISTRY not found in ${SOURCE}`);
  const end = source.indexOf('\n];', start);
  if (end < 0) throw new Error(`BUILTIN_REGISTRY literal is not terminated in ${SOURCE}`);
  const body = source.slice(start, end);

  const entries: { name: string; pkg: string | null }[] = [];
  // One block per `{ name: '...', ... args: [...], ... }` entry.
  const blocks = body.split(/\n {2}\{\n/).slice(1);
  for (const block of blocks) {
    const name = /name: '([^']+)'/.exec(block)?.[1];
    if (!name) continue;
    const argsText = /args: \[([^\]]*)\]/.exec(block)?.[1] ?? '';
    const args = [...argsText.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const afterFlag = args.indexOf('-y') + 1;
    const spec = afterFlag > 0 ? args[afterFlag] : undefined;
    entries.push({ name, pkg: spec ? stripTag(spec) : null });
  }
  return entries;
}

/** `@playwright/mcp@latest` → `@playwright/mcp`; `foo-mcp@1.2.3` → `foo-mcp`. */
function stripTag(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

type Status = 'ok' | 'deprecated' | '404';

async function inspect(pkg: string): Promise<{ status: Status; version: string }> {
  try {
    const { stdout } = await execFileAsync('npm', ['view', pkg, 'version', 'deprecated', '--json']);
    const parsed: unknown = JSON.parse(stdout);
    // npm returns a bare string when only `version` is present, an object when
    // `deprecated` is set too.
    if (typeof parsed === 'string') return { status: 'ok', version: parsed };
    const record = parsed as { version?: string; deprecated?: string };
    return {
      status: record.deprecated ? 'deprecated' : 'ok',
      version: record.version ?? '?',
    };
  } catch (err) {
    const text = err instanceof Error ? `${err.message}` : String(err);
    if (text.includes('E404') || text.includes('404 Not Found')) {
      return { status: '404', version: '-' };
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const catalog = readCatalog();
  if (catalog.length === 0) throw new Error('Parsed zero catalog entries — the registry literal changed shape.');

  const rows = await Promise.all(catalog.map(async (entry) => {
    if (!entry.pkg) return { ...entry, pkg: '(host-resolved)', status: 'ok' as Status, version: '-' };
    const { status, version } = await inspect(entry.pkg);
    return { ...entry, status, version };
  }));

  const widths = {
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    pkg: Math.max(7, ...rows.map((r) => r.pkg.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
  };
  const line = (name: string, pkg: string, status: string, version: string) =>
    `${name.padEnd(widths.name)} | ${pkg.padEnd(widths.pkg)} | ${status.padEnd(widths.status)} | ${version}`;

  console.log(line('name', 'package', 'status', 'version'));
  console.log(line('-'.repeat(widths.name), '-'.repeat(widths.pkg), '-'.repeat(widths.status), '-------'));
  for (const row of rows) console.log(line(row.name, row.pkg, row.status, row.version));

  const missing = rows.filter((r) => r.status === '404');
  const deprecated = rows.filter((r) => r.status === 'deprecated');
  console.log(`\n${rows.length} entries · ${missing.length} 404 · ${deprecated.length} deprecated`);
  if (missing.length > 0) {
    console.error(`Broken catalog rows: ${missing.map((r) => r.name).join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
