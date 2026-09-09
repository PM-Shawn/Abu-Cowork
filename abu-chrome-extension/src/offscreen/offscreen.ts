/**
 * Offscreen Document — handles canvas stitching for full-page screenshots.
 *
 * MV3 service workers have no DOM/Canvas access, so we use an offscreen
 * document to composite viewport slices into a single full-page image.
 */

import { canvasLimitRefusal } from './canvasLimits.js';

interface StitchRequest {
  type: 'stitch';
  slices: string[];       // base64 data URLs of each viewport capture
  viewportWidth: number;
  viewportHeight: number;
  totalHeight: number;
  lastSliceHeight: number; // actual visible height of the last slice
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'stitch') {
    stitchSlices(message as StitchRequest)
      .then((dataUrl) => sendResponse({ success: true, data: dataUrl }))
      .catch((err) => sendResponse({ success: false, error: String(err) }));
    return true; // async response
  }
});

async function stitchSlices(req: StitchRequest): Promise<string> {
  const { slices, viewportWidth, viewportHeight, totalHeight, lastSliceHeight } = req;

  const canvas = document.createElement('canvas');
  // Use device pixel ratio of 1 for the output — input images are already at screen DPR
  canvas.width = viewportWidth;
  canvas.height = totalHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  // Load all images in parallel
  const images = await Promise.all(
    slices.map((dataUrl) => loadImage(dataUrl))
  );

  // The actual pixel dimensions come from the captured images (which include devicePixelRatio)
  const imgWidth = images[0].naturalWidth;
  const imgHeight = images[0].naturalHeight;
  const _scaleX = imgWidth / viewportWidth;
  const scaleY = imgHeight / viewportHeight;

  // Resize canvas to actual pixel dimensions
  const targetWidth = imgWidth;
  const targetHeight = Math.round(totalHeight * scaleY);

  // Refuse BEFORE drawing. Past Chrome's ceilings a canvas keeps no pixels but
  // reports no error either — `toDataURL()` just answers `"data:,"`, which
  // used to travel all the way back to the model as a successful screenshot.
  // Failing here turns a silently corrupt image into a sentence the caller can
  // act on.
  const refusal = canvasLimitRefusal(targetWidth, targetHeight);
  if (refusal) throw new Error(refusal);

  canvas.width = targetWidth;
  canvas.height = targetHeight;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const yOffset = i * imgHeight;

    if (i === images.length - 1 && lastSliceHeight < viewportHeight) {
      // Last slice: only draw the visible portion (crop from bottom)
      const srcHeight = Math.round(lastSliceHeight * scaleY);
      const srcY = img.naturalHeight - srcHeight;
      ctx.drawImage(
        img,
        0, srcY, img.naturalWidth, srcHeight,
        0, yOffset, img.naturalWidth, srcHeight
      );
    } else {
      ctx.drawImage(img, 0, yOffset);
    }
  }

  const dataUrl = canvas.toDataURL('image/png');
  // Belt and braces: the size check above is the reason this should never
  // trip, but the failure it guards against is invisible, so the encoded
  // result is checked rather than assumed. Anything that is not a PNG data URL
  // is a failure however it arose, and must not be returned as an image.
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(
      `Stitched image failed to encode (${targetWidth}x${targetHeight}); the browser returned no `
      + 'pixel data. Use screenshot for the visible area instead.',
    );
  }
  return dataUrl;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image slice'));
    img.src = dataUrl;
  });
}
