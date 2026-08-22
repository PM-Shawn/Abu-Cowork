/**
 * Overlay ↔ window-drag-region Regression Guard
 *
 * Background: the Windows chrome paints two 36px rows whose empty space is a
 * `-webkit-app-region: drag` lane, so the top 72px band of the window moves the
 * window. `-webkit-app-region` is resolved by the OS as a *geometry union* and
 * ignores z-index entirely: an overlay painted above a drag lane does NOT take
 * the lane's place. Windows keeps hit-testing that rectangle as HTCAPTION, turns
 * the press into a window move, and the click never reaches the renderer.
 *
 * The reported symptom: the system-settings dialog's close button lands inside
 * that band whenever the viewport is shorter than ~960 CSS px (every Windows
 * laptop at 125%/150% display scaling), so clicking X did nothing. Toasts,
 * portaled dropdowns, and any other layer that overlaps the band die the same
 * way — the button is not broken, its clicks are being eaten.
 *
 * The fix this test guards: every layer that paints above the chrome declares
 * `data-electron-no-drag` on its root, which `src/styles/index.css` (and the
 * identical main-process `insertCSS` in `electron/windowChrome.cjs`) turns into
 * `-webkit-app-region: no-drag !important` for the root AND every descendant.
 * That subtracts the overlay's rectangle from the lane, so the OS hands the
 * clicks back to the page.
 *
 * Relying on DOM ancestry instead is not safe: `<main>` carries the marker, so
 * overlays rendered inside it inherit no-drag by accident, but anything rendered
 * at the App root, from the sidebar, or through `createPortal` escapes that
 * subtree and silently regresses. The marker is therefore required on EVERY
 * overlay root, including the ones that happen to sit under `<main>` today.
 *
 * `src/components/window/` is exempt: it owns the chrome and is the one place
 * allowed to declare drag lanes.
 *
 * Scope note: this scanner recognises overlays by their Tailwind classes. A
 * floating layer positioned through an inline `style` object (a portaled
 * dropdown, a selection toolbar) is invisible to it, and is safe only while it
 * paints above a marked full-window scrim — which subtracts the whole viewport
 * and therefore covers anything drawn on top of it. A floating layer with no
 * scrim beneath it must carry the marker itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '..');
const CHROME_DIR = path.join(SRC_DIR, 'components', 'window');
const MARKER = 'data-electron-no-drag';

function listComponentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listComponentFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.')) continue;
    out.push(full);
  }
  return out.sort();
}

/**
 * Read one JSX opening tag from its `<` to the matching `>`, tracking quotes and
 * brace depth so a `>` inside an arrow-function attribute cannot end it early.
 */
function readOpeningTag(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (char === '>' && depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  return null;
}

/** Every class token of the tag's className, including `cn(...)` branches. */
function classTokens(tag: string): string[] {
  const at = tag.indexOf('className');
  if (at === -1) return [];
  const tokens: string[] = [];
  for (const match of tag.slice(at).matchAll(/['"`]([^'"`]*)['"`]/g)) {
    tokens.push(...match[1].split(/\s+/).filter(Boolean));
  }
  return tokens;
}

interface OverlayRoot {
  line: number;
  tag: string;
  marked: boolean;
}

/**
 * An overlay root is a fixed-position layer that can cover the chrome: either a
 * full-window scrim (`fixed inset-0`) or a stack anchored to the top edge
 * (`fixed top-* z-*`, e.g. the toast container).
 */
function findOverlayRoots(source: string): OverlayRoot[] {
  const roots: OverlayRoot[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '<') continue;
    if (!/[a-zA-Z]/.test(source[i + 1] ?? '')) continue;
    const tag = readOpeningTag(source, i);
    if (!tag) continue;
    const tokens = classTokens(tag);
    if (!tokens.includes('fixed')) continue;
    const coversWindow = tokens.includes('inset-0');
    const anchoredToTop = tokens.some((t) => t.startsWith('top-'))
      && tokens.some((t) => t.startsWith('z-'));
    if (!coversWindow && !anchoredToTop) continue;
    roots.push({
      line: source.slice(0, i).split('\n').length,
      tag,
      marked: tag.includes(MARKER),
    });
  }
  return roots;
}

describe('overlay layers opt out of the OS drag lanes', () => {
  const files = listComponentFiles(path.join(SRC_DIR, 'components'))
    .filter((file) => !file.startsWith(CHROME_DIR));

  it('finds the overlay roots it is meant to guard', () => {
    // A scanner that silently matches nothing would pass every assertion below.
    const total = files.reduce(
      (sum, file) => sum + findOverlayRoots(fs.readFileSync(file, 'utf8')).length,
      0,
    );
    expect(total).toBeGreaterThan(30);
  });

  it('marks every fixed overlay root with data-electron-no-drag', () => {
    const unmarked: string[] = [];
    for (const file of files) {
      for (const root of findOverlayRoots(fs.readFileSync(file, 'utf8'))) {
        if (root.marked) continue;
        const relative = path.relative(SRC_DIR, file);
        unmarked.push(`${relative}:${root.line}  ${root.tag.replace(/\s+/g, ' ').slice(0, 100)}`);
      }
    }
    expect(
      unmarked,
      `These overlays paint above the window chrome without opting out of the OS drag lanes.\n`
      + `On Windows every click inside the top 72px band is swallowed as a window move.\n`
      + `Add \`${MARKER}\` to each overlay root:\n${unmarked.join('\n')}`,
    ).toEqual([]);
  });

  it('marks the exact layers behind the reported dead-click reports', () => {
    // Pinned by name so a refactor that drops the marker fails with the symptom
    // spelled out, not just as one line in the generic list above.
    const reported = [
      'components/settings/SystemSettingsDialog.tsx', // close button ate clicks at 125%/150%
      'components/settings/CapabilitySetupDialog.tsx', // same centred geometry
      'components/common/ToastContainer.tsx', // sits at top-4, fully inside the band
    ];
    for (const relative of reported) {
      const source = fs.readFileSync(path.join(SRC_DIR, relative), 'utf8');
      const roots = findOverlayRoots(source);
      expect(roots.length, `${relative} should still declare an overlay root`).toBeGreaterThan(0);
      expect(roots.every((root) => root.marked), `${relative} lost its ${MARKER} marker`).toBe(true);
    }
  });
});

describe('the stylesheet turns the marker into a no-drag region', () => {
  const css = fs.readFileSync(path.join(SRC_DIR, 'styles', 'index.css'), 'utf8');

  it('applies no-drag to marked roots and all of their descendants', () => {
    // The descendant selector is what makes a single marker on the scrim enough
    // to hand every button inside the dialog back to the renderer.
    expect(css).toMatch(
      /\[data-electron-no-drag\],\s*\[data-electron-no-drag\] \*\s*\{[^}]*-webkit-app-region:\s*no-drag !important/,
    );
  });


  it('covers portaled popper layers that have no ancestor to inherit from', () => {
    expect(css).toMatch(
      /\[data-radix-popper-content-wrapper\],\s*\[data-radix-popper-content-wrapper\] \*\s*\{[^}]*-webkit-app-region:\s*no-drag !important/,
    );
  });
});
