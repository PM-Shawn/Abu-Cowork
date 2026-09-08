"use strict";
(() => {
  // src/offscreen/canvasLimits.ts
  var MAX_CANVAS_SIDE = 65535;
  var MAX_CANVAS_AREA = 16384 * 16384;
  function canvasLimitRefusal(width, height) {
    if (height > MAX_CANVAS_SIDE) {
      return `Page is too tall to capture as one image: the stitched canvas would be ${height} pixels high and the browser stops keeping pixels past ${MAX_CANVAS_SIDE}. Use screenshot for the visible area, or scroll and capture the part you need.`;
    }
    if (width > MAX_CANVAS_SIDE) {
      return `Page is too wide to capture as one image: the stitched canvas would be ${width} pixels wide and the browser stops keeping pixels past ${MAX_CANVAS_SIDE}. Use screenshot for the visible area instead.`;
    }
    if (width * height > MAX_CANVAS_AREA) {
      return `Page is too large to capture as one image: the stitched canvas would be ${width}x${height} (${width * height} pixels) and the browser stops keeping pixels past ${MAX_CANVAS_AREA}. Use screenshot for the visible area, or capture the page in sections.`;
    }
    return null;
  }

  // src/offscreen/offscreen.ts
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "stitch") {
      stitchSlices(message).then((dataUrl) => sendResponse({ success: true, data: dataUrl })).catch((err) => sendResponse({ success: false, error: String(err) }));
      return true;
    }
  });
  async function stitchSlices(req) {
    const { slices, viewportWidth, viewportHeight, totalHeight, lastSliceHeight } = req;
    const canvas = document.createElement("canvas");
    canvas.width = viewportWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get canvas context");
    const images = await Promise.all(
      slices.map((dataUrl2) => loadImage(dataUrl2))
    );
    const imgWidth = images[0].naturalWidth;
    const imgHeight = images[0].naturalHeight;
    const _scaleX = imgWidth / viewportWidth;
    const scaleY = imgHeight / viewportHeight;
    const targetWidth = imgWidth;
    const targetHeight = Math.round(totalHeight * scaleY);
    const refusal = canvasLimitRefusal(targetWidth, targetHeight);
    if (refusal) throw new Error(refusal);
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const yOffset = i * imgHeight;
      if (i === images.length - 1 && lastSliceHeight < viewportHeight) {
        const srcHeight = Math.round(lastSliceHeight * scaleY);
        const srcY = img.naturalHeight - srcHeight;
        ctx.drawImage(
          img,
          0,
          srcY,
          img.naturalWidth,
          srcHeight,
          0,
          yOffset,
          img.naturalWidth,
          srcHeight
        );
      } else {
        ctx.drawImage(img, 0, yOffset);
      }
    }
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      throw new Error(
        `Stitched image failed to encode (${targetWidth}x${targetHeight}); the browser returned no pixel data. Use screenshot for the visible area instead.`
      );
    }
    return dataUrl;
  }
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load image slice"));
      img.src = dataUrl;
    });
  }
})();
//# sourceMappingURL=offscreen.js.map
