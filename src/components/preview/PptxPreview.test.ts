import { describe, it, expect, vi, afterEach } from 'vitest';
import { normalizeSlideBackgrounds } from './PptxPreview';

function makeWrapper(index: number, bg?: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `pptx-preview-slide-wrapper pptx-preview-slide-wrapper-${index}`;
  if (bg !== undefined) el.style.backgroundColor = bg;
  return el;
}

describe('normalizeSlideBackgrounds', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns an inline rgb(0, 0, 0) slide background white', () => {
    const container = document.createElement('div');
    const slide = makeWrapper(0, 'rgb(0, 0, 0)');
    container.appendChild(slide);

    normalizeSlideBackgrounds(container);

    expect(slide.style.backgroundColor).toBe('#ffffff');
  });

  it('turns an empty/unset slide background white', () => {
    const container = document.createElement('div');
    const slide = makeWrapper(0);
    container.appendChild(slide);

    normalizeSlideBackgrounds(container);

    expect(slide.style.backgroundColor).toBe('#ffffff');
  });

  it('turns #000000 / #000 slide backgrounds white', () => {
    const container = document.createElement('div');
    const slideHex6 = makeWrapper(0, '#000000');
    const slideHex3 = makeWrapper(1, '#000');
    container.appendChild(slideHex6);
    container.appendChild(slideHex3);

    normalizeSlideBackgrounds(container);

    expect(slideHex6.style.backgroundColor).toBe('#ffffff');
    expect(slideHex3.style.backgroundColor).toBe('#ffffff');
  });

  it('leaves a real, non-black slide background unchanged', () => {
    const container = document.createElement('div');
    const red = makeWrapper(0, 'rgb(255, 0, 0)');
    const hex = makeWrapper(1, '#123456');
    container.appendChild(red);
    container.appendChild(hex);

    normalizeSlideBackgrounds(container);

    expect(red.style.backgroundColor).toBe('rgb(255, 0, 0)');
    expect(hex.style.backgroundColor).toBe('#123456');
  });

  it('does not touch elements that are not slide wrappers', () => {
    const container = document.createElement('div');
    const other = document.createElement('div');
    other.className = 'some-other-shape';
    other.style.backgroundColor = 'rgb(0, 0, 0)';
    container.appendChild(other);

    normalizeSlideBackgrounds(container);

    expect(other.style.backgroundColor).toBe('rgb(0, 0, 0)');
  });

  it('does not throw when zero slide wrappers match', () => {
    const container = document.createElement('div');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => normalizeSlideBackgrounds(container)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith('[PptxPreview] no slide wrappers matched for bg normalization');
  });
});
