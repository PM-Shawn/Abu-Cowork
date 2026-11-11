import { describe, it, expect } from 'vitest';
import { PICTURE_ZOOM_NOTE, pictureCaption } from './imageCaption';

describe('pictureCaption', () => {
  it('names the file, its own size and the size shown, on one line', () => {
    expect(pictureCaption({ fileName: 'photo.png', original: { w: 4000, h: 3000 }, shown: { w: 1280, h: 960 } }))
      .toBe('Image: photo.png (4000×3000 px), shown at 1280×960 px.');
  });

  it('adds the zoom sentence for a plain read, still on one line', () => {
    const caption = pictureCaption({ fileName: 'photo.png', original: { w: 640, h: 480 }, shown: { w: 640, h: 480 }, zoomNote: true });
    expect(caption).toBe(`Image: photo.png (640×480 px), shown at 640×480 px. ${PICTURE_ZOOM_NOTE}`);
    expect(caption).not.toContain('\n');
  });

  it('says what part a view shows', () => {
    expect(pictureCaption({ fileName: 'scan.png', original: { w: 4000, h: 3000 }, shown: { w: 1600, h: 1200 }, where: 'region x 0.5–1, y 0.5–1' }))
      .toBe('Image: scan.png (4000×3000 px): region x 0.5–1, y 0.5–1, shown at 1600×1200 px.');
  });

  it('leaves out a size it does not know', () => {
    expect(pictureCaption({ fileName: 'odd.webp', original: null, shown: null })).toBe('Image: odd.webp.');
    expect(pictureCaption({ fileName: 'odd.webp', original: null, shown: { w: 10, h: 20 } })).toBe('Image: odd.webp, shown at 10×20 px.');
  });
});
