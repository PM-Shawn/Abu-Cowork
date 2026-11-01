import type { ImageAspectRatio, ImageComment, ImageEditDraft, ImageEditTool, ImageMarkup, ImagePoint, ImageRegionStroke } from '@/types/media';

export const IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = ['1:1', '3:4', '4:3', '9:16', '16:9'];

/** Only a complete generated line is replaced; all user-authored text stays intact. */
export function setImageAspectRatioPrompt(prompt: string, ratio: ImageAspectRatio, template: string): string {
  const generated = new Set(IMAGE_ASPECT_RATIOS.map((value) => template.replace('{ratio}', value)));
  const lines = prompt.split('\n').filter((line) => !generated.has(line));
  if (lines.length === 1 && lines[0] === '') lines.pop();
  return [...lines, template.replace('{ratio}', ratio)].join('\n');
}

export function canSendImageDraft(draft: Pick<ImageEditDraft, 'prompt' | 'comments'>): boolean {
  return Boolean(draft.prompt.trim() || draft.comments.some((comment) => comment.text.trim()));
}

export interface ImageViewTransform {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  zoom: number;
  rotation: number;
}

/** Convert the pointer through the inverse viewing transform into source coordinates. */
export function imagePointFromClient(client: ImagePoint, view: ImageViewTransform): ImagePoint | null {
  if (![client.x, client.y, view.centerX, view.centerY, view.width, view.height, view.zoom, view.rotation].every(Number.isFinite)
    || view.width <= 0 || view.height <= 0 || view.zoom <= 0) {
    throw new Error('Invalid image view transform');
  }
  const radians = -view.rotation * Math.PI / 180;
  const dx = (client.x - view.centerX) / view.zoom;
  const dy = (client.y - view.centerY) / view.zoom;
  const x = (dx * Math.cos(radians) - dy * Math.sin(radians)) / view.width + 0.5;
  const y = (dx * Math.sin(radians) + dy * Math.cos(radians)) / view.height + 0.5;
  const tolerance = 1e-10;
  if (x < -tolerance || x > 1 + tolerance || y < -tolerance || y > 1 + tolerance) return null;
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

type LayerName = 'comments' | 'markup' | 'region';
type LayerItem = ImageComment | ImageMarkup | ImageRegionStroke;

export type ImageDraftChange = {
  layer: LayerName;
  before: ImageComment[] | ImageMarkup[] | ImageRegionStroke[];
  after: ImageComment[] | ImageMarkup[] | ImageRegionStroke[];
};

export interface ImageDraftHistory {
  past: ImageDraftChange[];
  future: ImageDraftChange[];
}

/** History shares immutable drawing objects and never copies a raster canvas. */
export function changeImageLayer<K extends LayerName>(
  draft: ImageEditDraft,
  history: ImageDraftHistory,
  layer: K,
  after: ImageEditDraft[K],
): { draft: ImageEditDraft; history: ImageDraftHistory } {
  return {
    draft: { ...draft, [layer]: after },
    history: { past: [...history.past, { layer, before: draft[layer], after }], future: [] },
  };
}

function applyLayer(draft: ImageEditDraft, layer: LayerName, items: LayerItem[]): ImageEditDraft {
  return { ...draft, [layer]: items };
}

export function travelImageHistory(
  draft: ImageEditDraft,
  history: ImageDraftHistory,
  direction: 'undo' | 'redo',
): { draft: ImageEditDraft; history: ImageDraftHistory } {
  const from = direction === 'undo' ? history.past : history.future;
  const change = from.at(-1);
  if (!change) return { draft, history };
  return {
    draft: applyLayer(draft, change.layer, direction === 'undo' ? change.before : change.after),
    history: direction === 'undo'
      ? { past: history.past.slice(0, -1), future: [...history.future, change] }
      : { past: [...history.past, change], future: history.future.slice(0, -1) },
  };
}

export function selectImageTool(draft: ImageEditDraft, activeTool: ImageEditTool): ImageEditDraft {
  return { ...draft, activeTool };
}
