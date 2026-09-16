import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const linkedomOutfile = path.join(root, 'dist', 'linkedomWorker.iife.js');

mkdirSync(path.join(root, 'dist'), { recursive: true });
copyFileSync(
  path.join(root, 'src', 'queryJsWorker.mjs'),
  path.join(root, 'dist', 'queryJsWorker.mjs'),
);

await build({
  entryPoints: [path.join(root, 'node_modules', 'linkedom', 'worker.js')],
  outfile: linkedomOutfile,
  bundle: true,
  format: 'iife',
  globalName: 'LinkeDOM',
  target: 'es2022',
  legalComments: 'none',
  logLevel: 'silent',
});
