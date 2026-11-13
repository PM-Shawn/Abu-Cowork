import { describe, it, expect } from 'vitest';
import { CHARS_OMITTED_LINE, LINES_OMITTED_LINE, charsOmittedMarker, linesOmittedMarker } from './truncation';

describe('omission markers', () => {
  it('are whole lines the step view can recognize, with their counts', () => {
    expect(LINES_OMITTED_LINE.exec(linesOmittedMarker(12))?.[1]).toBe('12');
    expect(CHARS_OMITTED_LINE.exec(charsOmittedMarker(3456))?.[1]).toBe('3456');
  });
});
