import { describe, it, expect } from 'vitest';
import {
  captionedToolResultImages,
  imageLabel,
  imageLabelBlock,
  TOOL_RESULT_IMAGES_INTRO,
  TOOL_RESULT_SCREENSHOTS_NOTE,
  toolResultImageCaption,
} from './toolResultImageCaptions';

describe('the label convention', () => {
  it('writes a label as one bracketed line and reads it back unchanged', () => {
    const block = imageLabelBlock('Page 18 of contract.pdf, region x 0.5–1, y 0.6–1, 900×700 px');
    expect(block).toEqual({ type: 'text', text: '[Page 18 of contract.pdf, region x 0.5–1, y 0.6–1, 900×700 px]' });
    expect(imageLabel(block)).toBe('Page 18 of contract.pdf, region x 0.5–1, y 0.6–1, 900×700 px');
  });

  it('keeps a label on one line, and brackets inside it', () => {
    expect(imageLabelBlock('a\n  b').text).toBe('[a b]');
    expect(imageLabel(imageLabelBlock('Image [2] of a.docx'))).toBe('Image [2] of a.docx');
  });

  it('does not take any other text before an image for a label', () => {
    expect(imageLabel(undefined)).toBeUndefined();
    expect(imageLabel({ type: 'text', text: 'Screenshot: 1280x800 px' })).toBeUndefined();
    expect(imageLabel({ type: 'text', text: '[Manifest]\nthe rest of a result' })).toBeUndefined();
    expect(imageLabel({ type: 'text', text: '[]' })).toBeUndefined();
    expect(imageLabel({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } })).toBeUndefined();
  });

  it('does not cut a long label', () => {
    const label = `Page 3 of ${'a'.repeat(300)}.pdf`;
    expect(imageLabel(imageLabelBlock(label))).toBe(label);
  });
});

describe('captionedToolResultImages', () => {
  const call = (name: string, id: string, labels: Array<string | undefined>) => ({
    name, id, resultImages: labels.map((label) => ({ label })),
  });

  it('numbers the images of all the calls in order and names the call and the label of each', () => {
    const { images } = captionedToolResultImages([call('read_file', 'c1', ['Page 1 of a.pdf, whole page', 'Page 2 of a.pdf, whole page']), call('read_file', 'c2', ['Image: b.png (10×10 px).'])]);
    expect(images.map((entry) => entry.caption)).toEqual([
      '[Image 1 of 3, from read_file (call c1): Page 1 of a.pdf, whole page]',
      '[Image 2 of 3, from read_file (call c1): Page 2 of a.pdf, whole page]',
      '[Image 3 of 3, from read_file (call c2): Image: b.png (10×10 px).]',
    ]);
  });

  it('writes no colon for an image without a label', () => {
    expect(toolResultImageCaption({ name: 'computer', id: 'c9' }, undefined, 1, 1)).toBe('[Image 1 of 1, from computer (call c9)]');
  });

  it('introduces images that all carry a label neutrally, and any unlabeled one as a screenshot', () => {
    expect(captionedToolResultImages([call('read_file', 'c1', ['x', 'y'])]).note).toBe(TOOL_RESULT_IMAGES_INTRO);
    expect(captionedToolResultImages([call('computer', 'c1', [undefined])]).note).toBe(TOOL_RESULT_SCREENSHOTS_NOTE);
    expect(captionedToolResultImages([call('read_file', 'c1', ['x']), call('computer', 'c2', [undefined])]).note).toBe(TOOL_RESULT_SCREENSHOTS_NOTE);
  });

  it('says nothing about pictures that are not screenshots as if they were', () => {
    expect(TOOL_RESULT_IMAGES_INTRO).not.toMatch(/SCREENSHOT|MUST describe/);
  });
});
