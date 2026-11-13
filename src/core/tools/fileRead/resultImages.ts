import type { ToolResultContent } from '@/types';
import { imageLabelBlock } from '@/core/llm/toolResultImageCaptions';
import type { ProbeImage } from './documentProbe';

/**
 * One picture of a read_file result, introduced by its label.
 *
 * The label is the one-line text block `imageLabelBlock` writes, placed right
 * before the image (core/llm/toolResultImageCaptions.ts holds the convention:
 * the message normalizer reads it back as `PreparedImage.label`, and the
 * serializers that re-send tool images in a separate message put it beside
 * the image, so the model knows which page or picture it is looking at).
 */
export function labeledImage(label: string, image: ProbeImage): ToolResultContent[] {
  return [
    imageLabelBlock(label),
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } },
  ];
}

/** A text-only result stays a string; one with pictures becomes blocks, the text first. */
export function withImages(text: string, images: readonly ToolResultContent[]): string | ToolResultContent[] {
  return images.length ? [{ type: 'text', text }, ...images] : text;
}
