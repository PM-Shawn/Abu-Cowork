import type { PixelSize } from '@/utils/imageHeaderSize';

/**
 * The one caption of a picture read_file shows, for a plain read (fileTools.ts)
 * and for a region or rotate view (imageView.ts). It is the picture's label
 * (core/llm/toolResultImageCaptions.ts): one line that names the file (not the
 * path, which the model already has), the picture's own pixel size, the size it
 * is shown at, and, for a plain read, the one sentence that says a small part
 * can be looked at closer. The size is what tells the model that detail may
 * be lost: a badge that is 40 px wide in a 4000 px photo is not legible in
 * the 1280 px copy it sees, and without the sentence it never asks to zoom.
 */

/** The sentence a plain read adds: a picture is not final until its small parts were looked at. */
export const PICTURE_ZOOM_NOTE = 'Small text or detail can be looked at closer: call read_file again with region (fractions 0–1 from the top-left corner).';

/** `Image: name (W×H px): where, shown at w×h px. zoom note`; each part is left out when unknown. */
export function pictureCaption(opts: {
  fileName: string;
  original: PixelSize | null;
  shown: PixelSize | null;
  /** What part of the picture a view shows. */
  where?: string;
  /** A plain read says how to look closer; a view already is a closer look. */
  zoomNote?: boolean;
}): string {
  const { original, shown } = opts;
  const head = `Image: ${opts.fileName}${original ? ` (${original.w}×${original.h} px)` : ''}`
    + `${opts.where ? `: ${opts.where}` : ''}${shown ? `, shown at ${shown.w}×${shown.h} px` : ''}.`;
  return opts.zoomNote ? `${head} ${PICTURE_ZOOM_NOTE}` : head;
}
