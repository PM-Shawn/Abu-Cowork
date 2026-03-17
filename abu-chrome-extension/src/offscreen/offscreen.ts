/**
 * Offscreen Document — handles canvas stitching for full-page screenshots.
 *
 * MV3 service workers have no DOM/Canvas access, so we use an offscreen
 * document to composite viewport slices into a single full-page image.
 */

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
  canvas.width = imgWidth;
  canvas.height = Math.round(totalHeight * scaleY);

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

  return canvas.toDataURL('image/png');
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image slice'));
    img.src = dataUrl;
  });
}
