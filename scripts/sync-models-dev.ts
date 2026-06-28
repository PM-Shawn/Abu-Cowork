import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_ALLOWLIST, type ModelsDevApi } from '../src/core/llm/model-data/schema';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = resolve(HERE, '../src/core/llm/model-data/vendor/models-dev.snapshot.json');
const SOURCE_URL = 'https://models.dev/api.json';

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: { id: string; fields: string[] }[];
}

export function diffSnapshots(oldApi: ModelsDevApi, newApi: ModelsDevApi): SnapshotDiff {
  const flat = (api: ModelsDevApi) => {
    const m = new Map<string, { context?: number; output?: number; input?: number }>();
    for (const [pid, p] of Object.entries(api)) {
      for (const [mid, model] of Object.entries(p.models ?? {})) {
        m.set(`${pid}/${mid}`, { context: model.limit?.context, output: model.limit?.output, input: model.cost?.input });
      }
    }
    return m;
  };
  const a = flat(oldApi), b = flat(newApi);
  const added = [...b.keys()].filter(k => !a.has(k)).sort();
  const removed = [...a.keys()].filter(k => !b.has(k)).sort();
  const changed: SnapshotDiff['changed'] = [];
  for (const [k, nv] of b) {
    const ov = a.get(k);
    if (!ov) continue;
    const fields: string[] = [];
    if (ov.context !== nv.context) fields.push(`context: ${ov.context}→${nv.context}`);
    if (ov.output !== nv.output) fields.push(`output: ${ov.output}→${nv.output}`);
    if (ov.input !== nv.input) fields.push(`input: ${ov.input}→${nv.input}`);
    if (fields.length) changed.push({ id: k, fields });
  }
  return { added, removed, changed: changed.sort((x, y) => x.id.localeCompare(y.id)) };
}

function filterApi(full: ModelsDevApi): ModelsDevApi {
  const out: ModelsDevApi = {};
  for (const pid of PROVIDER_ALLOWLIST) if (full[pid]) out[pid] = full[pid];
  return out;
}

async function main() {
  const write = process.argv.includes('--write');
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
  const next = filterApi(await res.json() as ModelsDevApi);
  const prev: ModelsDevApi = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : {};
  const d = diffSnapshots(prev, next);

  console.log(`\nmodels.dev sync — ${PROVIDER_ALLOWLIST.length} providers`);
  console.log(`  added (${d.added.length}): ${d.added.join(', ') || '—'}`);
  console.log(`  removed (${d.removed.length}): ${d.removed.join(', ') || '—'}`);
  console.log(`  changed (${d.changed.length}):`);
  for (const c of d.changed) console.log(`    ${c.id}: ${c.fields.join('; ')}`);

  if (write) {
    mkdirSync(dirname(SNAPSHOT), { recursive: true });
    writeFileSync(SNAPSHOT, JSON.stringify(next, null, 2) + '\n');
    console.log(`\n✓ snapshot written: ${SNAPSHOT}`);
    console.log('  Next: run `npm run gen:models` and review the generated diff.');
  } else {
    console.log('\n(dry run — re-run with --write to update the snapshot)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
