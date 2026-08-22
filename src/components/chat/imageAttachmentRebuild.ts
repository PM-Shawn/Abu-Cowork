import type { ImageAttachment, Message, MessageContent } from '@/types';

/**
 * Rebuild ImageAttachments from a persisted user message's image blocks, for
 * every path that re-dispatches an existing message: retry, edit-resend, and
 * regenerate.
 *
 * Two fields must ride along with the base64, and every rebuild site must go
 * through this one function so none of them forgets:
 *
 * - `filePath`: after an app restart the persisted `source.data` is empty
 *   (stripped on disk — see stripForDisk), and the snapshot under
 *   outputs/images/ is then the only source of pixels, for the send-path
 *   rehydration and the thumbnail's resolveFileSource fallback alike.
 *   Dropping it dispatched a blank image ("图片没能加载出来").
 * - `resized`: the admission downscale record. Dropping it re-sent the
 *   downscaled image with no <image_resize_notice>, so a retried turn — often
 *   the one asking about coordinates or fine print — had the model reading a
 *   shrunken picture believing it was full size.
 *
 * `idPrefix` namespaces the rebuilt attachment ids per call site
 * (e.g. `retry` → `retry-0`).
 */
export function rebuildImageAttachments(
  content: Message['content'],
  idPrefix: string,
): ImageAttachment[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const imgBlocks = content.filter((c): c is Extract<MessageContent, { type: 'image' }> => c.type === 'image');
  if (imgBlocks.length === 0) return undefined;
  return imgBlocks.map((img, i) => ({
    id: `${idPrefix}-${i}`,
    data: img.source.data,
    mediaType: img.source.media_type,
    ...(img.resized ? { resized: img.resized } : {}),
    ...(img.filePath ? { filePath: img.filePath } : {}),
  }));
}
