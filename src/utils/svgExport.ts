/**
 * SVG/PNG export utilities for visual code blocks.
 *
 * Uses Tauri's native dialog + fs APIs for downloads (blob URL downloads
 * don't work in Tauri WebView). Clipboard image copy falls back to
 * auto-download if ClipboardItem is not supported.
 */

// ---------------------------------------------------------------------------
// SVG → PNG conversion via Canvas
// ---------------------------------------------------------------------------

const MAX_CANVAS_DIM = 4096;

function parseSvgDimensions(svgString: string): { width: number; height: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svg = doc.documentElement;

  // Try explicit width/height attributes (skip percentages)
  const rawW = svg.getAttribute('width') || '';
  const rawH = svg.getAttribute('height') || '';
  let width = rawW.includes('%') ? 0 : parseFloat(rawW) || 0;
  let height = rawH.includes('%') ? 0 : parseFloat(rawH) || 0;

  // Fall back to viewBox
  if (!width || !height) {
    const viewBox = svg.getAttribute('viewBox');
    if (viewBox) {
      const parts = viewBox.split(/[\s,]+/).map(Number);
      if (parts.length === 4) {
        width = width || parts[2];
        height = height || parts[3];
      }
    }
  }

  // Fall back to style attribute
  if (!width || !height) {
    const style = svg.getAttribute('style') || '';
    const wMatch = style.match(/max-width:\s*([\d.]+)px/);
    const hMatch = style.match(/(?:^|;)\s*height:\s*([\d.]+)px/);
    if (wMatch) width = width || parseFloat(wMatch[1]);
    if (hMatch) height = height || parseFloat(hMatch[1]);
  }

  // Last resort: render temporarily to get actual size
  if (!width || !height) {
    const tmp = document.createElement('div');
    tmp.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
    tmp.innerHTML = svgString;
    document.body.appendChild(tmp);
    const svgEl = tmp.querySelector('svg');
    if (svgEl) {
      const rect = svgEl.getBoundingClientRect();
      width = width || rect.width;
      height = height || rect.height;
    }
    document.body.removeChild(tmp);
  }

  return { width: width || 800, height: height || 600 };
}

function ensureXmlns(svgString: string): string {
  if (svgString.includes('xmlns=')) return svgString;
  return svgString.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

export function svgToPngBlob(svgString: string, scale = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const normalized = ensureXmlns(svgString);
    const { width, height } = parseSvgDimensions(normalized);
    const cw = Math.min(width * scale, MAX_CANVAS_DIM);
    const ch = Math.min(height * scale, MAX_CANVAS_DIM);

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return reject(new Error('Canvas 2D context unavailable'));

    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('toBlob returned null')),
        'image/png',
      );
    };
    img.onerror = () => reject(new Error('Failed to load SVG as image'));

    // Use data URI (same-origin) instead of Blob URL — Blob URLs are cross-origin
    // in WebKit and taint the canvas, making toBlob() throw SecurityError.
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(normalized);
  });
}

// ---------------------------------------------------------------------------
// Tauri-native save (dialog + fs)
// ---------------------------------------------------------------------------

async function tauriSaveFile(
  data: Uint8Array | string,
  defaultName: string,
  filterName: string,
  filterExt: string,
) {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const filePath = await save({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: [filterExt] }],
  });
  if (!filePath) return; // user cancelled

  if (typeof data === 'string') {
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(filePath, data);
  } else {
    const { writeFile } = await import('@tauri-apps/plugin-fs');
    await writeFile(filePath, data);
  }
}

// ---------------------------------------------------------------------------
// Clipboard operations
// ---------------------------------------------------------------------------

export async function copySvgToClipboard(svgString: string): Promise<void> {
  await navigator.clipboard.writeText(svgString);
}

export async function copyPngToClipboard(svgString: string): Promise<void> {
  const blob = await svgToPngBlob(svgString);

  // Try browser clipboard API first
  if (typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return;
    } catch {
      // Fall through to Tauri save
    }
  }

  // Fallback: save as file via Tauri dialog
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await tauriSaveFile(bytes, `image-${Date.now().toString(36)}.png`, 'PNG Image', 'png');
}

// ---------------------------------------------------------------------------
// Download operations
// ---------------------------------------------------------------------------

export async function downloadSvg(svgString: string, filename: string): Promise<void> {
  const name = filename.replace(/\.\w+$/, '') + '.svg';
  await tauriSaveFile(ensureXmlns(svgString), name, 'SVG Image', 'svg');
}

export async function downloadPng(svgString: string, filename: string): Promise<void> {
  const blob = await svgToPngBlob(svgString);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const name = filename.replace(/\.\w+$/, '') + '.png';
  await tauriSaveFile(bytes, name, 'PNG Image', 'png');
}
