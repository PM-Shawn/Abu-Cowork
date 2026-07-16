/**
 * Per-vendor image size normalization (design doc §5 / P3). Centralizes the
 * "user picked a size the backend doesn't support" problem: instead of
 * forwarding it as-is and letting the API 400, each vendor gets a small
 * mapper that snaps to the nearest legal value.
 */

interface ParsedSize {
  width: number;
  height: number;
}

function parseWxH(size: string): ParsedSize | null {
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(size.trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

// --- Volcengine Seedream -----------------------------------------------

// Seedream requires >=3,686,400px (source: design doc §5 / Volcengine Ark
// docs) — well above common defaults like 1024x1024 (1,048,576px), which the
// API rejects outright with a 400. When the caller-specified size resolves
// below the threshold, scale it UP **preserving the requested aspect ratio**
// (don't collapse a 16:9 request to a square — that silently changes the shape
// the user asked for). Round each dimension up to a multiple of 8 so the
// result stays at/above the floor and uses model-friendly dimensions.
const SEEDREAM_MIN_PIXELS = 3_686_400;
const SEEDREAM_FALLBACK_SIZE = '2048x2048'; // 4,194,304px — safe square for degenerate input

export function normalizeSeedreamSize(size: string): string {
  const parsed = parseWxH(size);
  // Not a "WxH" literal — could already be a valid vendor-specific token
  // (e.g. a "2K" tier). Pass through rather than guess.
  if (!parsed) return size;
  const pixels = parsed.width * parsed.height;
  if (pixels >= SEEDREAM_MIN_PIXELS) return size;
  if (pixels <= 0) return SEEDREAM_FALLBACK_SIZE; // degenerate (e.g. 0x0)
  // Uniform scale so width*height reaches the floor; ceil-to-8 keeps it >= floor.
  const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / pixels);
  const w = Math.ceil((parsed.width * scale) / 8) * 8;
  const h = Math.ceil((parsed.height * scale) / 8) * 8;
  return `${w}x${h}`;
}

// --- OpenAI dall-e-3 / gpt-image-1 --------------------------------------

// Both models only accept a small enumerated set of sizes (source: design
// doc §5 / OpenAI Images API docs) — anything else is a 400. Snap an
// unsupported size to the closest legal one by matching aspect "shape"
// (square/landscape/portrait) rather than failing the request outright.
type SizeShape = 'square' | 'landscape' | 'portrait';
interface SizeOption {
  value: string;
  shape: SizeShape;
}

const DALL_E_3_SIZES: SizeOption[] = [
  { value: '1024x1024', shape: 'square' },
  { value: '1792x1024', shape: 'landscape' },
  { value: '1024x1792', shape: 'portrait' },
];

const GPT_IMAGE_1_SIZES: SizeOption[] = [
  { value: '1024x1024', shape: 'square' },
  { value: '1536x1024', shape: 'landscape' },
  { value: '1024x1536', shape: 'portrait' },
];

function shapeOf(width: number, height: number): SizeShape {
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.05) return 'square';
  return ratio > 1 ? 'landscape' : 'portrait';
}

function snapToOption(options: SizeOption[], size: string): string {
  if (options.some(o => o.value === size)) return size;
  const parsed = parseWxH(size);
  // Unparseable — default to the square option (index 0 by construction
  // above) rather than guessing a shape.
  if (!parsed) return options[0].value;
  const shape = shapeOf(parsed.width, parsed.height);
  return (options.find(o => o.shape === shape) ?? options[0]).value;
}

/**
 * Normalize `size` for an OpenAI-vendor request, dispatching on the model's
 * known constraint set. Unrecognized model ids (future OpenAI image models)
 * pass the size through unchanged rather than guessing a constraint we
 * haven't verified.
 */
export function normalizeOpenAiSize(model: string, size: string): string {
  if (model.startsWith('gpt-image-1')) {
    // gpt-image-1's own "let the model choose" token — not a WxH value.
    if (size === 'auto') return size;
    return snapToOption(GPT_IMAGE_1_SIZES, size);
  }
  if (model.startsWith('dall-e-3')) {
    return snapToOption(DALL_E_3_SIZES, size);
  }
  return size;
}
