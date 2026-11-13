import type { ToolExecutionContext } from '@/types';
import { getBaseName } from '@/utils/pathUtils';
import { format, getI18n } from '@/i18n';
import { runDocumentProbe, tooLargeError, type RasterViewProbe } from './documentProbe';
import type { DocumentReadOutcome } from './pdfRead';
import { describeView, enlargedNote, viewRulerNote, type DocumentReadParams } from './readParams';
import { labeledImage, withImages } from './resultImages';

/** Long side of a picture view, before its rulers. */
const VIEW_SIDE = 1600;

/**
 * Part of a raster picture, cropped from the original at full resolution and
 * enlarged up to the view size, or the picture turned. A plain read of a
 * picture stays read_file's own path.
 */
export async function readImageView(
  filePath: string,
  params: DocumentReadParams,
  context?: ToolExecutionContext,
): Promise<DocumentReadOutcome> {
  const outcome = await runDocumentProbe<RasterViewProbe>(filePath, 'image-view', {
    region: params.region, rotate: params.rotate, side: VIEW_SIDE,
  }, context);
  switch (outcome.status) {
    case 'aborted':
      return { kind: 'aborted' };
    case 'unavailable':
      return { kind: 'fallback', detail: outcome.detail };
    case 'crashed':
      return { kind: 'done', result: `Error: The picture viewer stopped before finishing (${outcome.detail}). Try a smaller region.` };
    case 'failed':
      return { kind: 'done', result: format(getI18n().toolResult.fileRead.pictureUnopenable, { detail: outcome.message || outcome.error }) };
    case 'tooLarge':
      return { kind: 'done', result: tooLargeError(getBaseName(filePath), outcome.bytes, outcome.limit) };
  }
  const view = outcome.value;
  if (!view.img) return { kind: 'done', result: 'Error: The view came out too large to return; ask for a smaller region.' };
  const name = getBaseName(filePath);
  const where = describeView(view.region, view.rotate, 'whole picture');
  const enlarged = enlargedNote(view.zoom, 'picture');
  const text = `[Picture ${name} (${view.size[0]}×${view.size[1]} px): ${where}, shown at ${view.img.w}×${view.img.h} px. ${viewRulerNote('picture')}]`
    + (enlarged ? `\n${enlarged}` : '');
  return {
    kind: 'done',
    result: withImages(text, labeledImage(`${name}, ${where}, ${view.img.w}×${view.img.h} px`, view.img)),
  };
}
