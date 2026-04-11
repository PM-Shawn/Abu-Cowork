"use strict";
(() => {
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
      slices.map((dataUrl) => loadImage(dataUrl))
    );
    const imgWidth = images[0].naturalWidth;
    const imgHeight = images[0].naturalHeight;
    const scaleX = imgWidth / viewportWidth;
    const scaleY = imgHeight / viewportHeight;
    canvas.width = imgWidth;
    canvas.height = Math.round(totalHeight * scaleY);
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
    return canvas.toDataURL("image/png");
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
