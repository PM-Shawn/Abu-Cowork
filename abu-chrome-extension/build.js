import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const isWatch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
const version = pkg.version;

const entryPoints = [
  { in: 'src/background/index.ts', out: 'background' },
  { in: 'src/content/index.ts', out: 'content' },
  { in: 'src/popup/popup.ts', out: 'popup' },
  { in: 'src/offscreen/offscreen.ts', out: 'offscreen' },
];

const buildOptions = {
  entryPoints: entryPoints.map(e => ({ in: e.in, out: e.out })),
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  target: 'chrome120',
  sourcemap: true,
  minify: false,
  define: {
    '__VERSION__': JSON.stringify(version),
  },
};

// Copy static files to dist
mkdirSync('dist', { recursive: true });

// Copy manifest with synced version from package.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf-8'));
manifest.version = version;
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));

// Copy popup HTML with version replacement
let popupHtml = readFileSync('src/popup/index.html', 'utf-8');
popupHtml = popupHtml.replace('__VERSION__', version);
writeFileSync('dist/popup.html', popupHtml);

// Copy offscreen HTML
cpSync('src/offscreen/offscreen.html', 'dist/offscreen.html');

try { cpSync('icons', 'dist/icons', { recursive: true }); } catch { /* no icons yet */ }

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log(`Build complete → dist/ (v${version})`);
}
