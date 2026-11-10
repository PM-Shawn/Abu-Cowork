/**
 * The acceptance check against real files rather than hand-built headers: the
 * check that leaves out data that is no picture must never leave out a real
 * picture, in any variant encoders write (progressive and CMYK JPEG, Exif-first
 * JPEG, 16-bit and interlaced PNG, animated GIF and WebP, lossless WebP).
 */
import { describe, expect, it } from 'vitest';
import { formatNote, judgeImage, notPictureNote, oversizeNote } from './imageAcceptance';
import { NOT_PICTURE_SAMPLES, SENDABLE_SAMPLES, UNSENDABLE_SAMPLES } from './__fixtures__/pictureSamples';

const LABELS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

describe('judgeImage on real files', () => {
  describe.each(SENDABLE_SAMPLES)('$made ($name)', ({ mediaType, w, h, data }) => {
    it('is sent under its own type, whatever it is labelled', () => {
      for (const label of LABELS) {
        expect(judgeImage(label, data, 8000)).toEqual({ kind: 'send', mediaType });
      }
    });

    it('is measured from its header', () => {
      expect(judgeImage(mediaType, data, Math.max(w, h))).toEqual({ kind: 'send', mediaType });
      expect(judgeImage(mediaType, data, Math.max(w, h) - 1))
        .toEqual({ kind: 'leave-out', note: oversizeNote(w, h, Math.max(w, h) - 1), size: { w, h } });
    });

    it('is sent when its base64 is broken into lines', () => {
      const wrapped = data.replace(/(.{76})/g, '$1\r\n');
      expect(judgeImage(mediaType, wrapped, 8000)).toEqual({ kind: 'send', mediaType });
    });
  });

  it.each(UNSENDABLE_SAMPLES)('leaves out a $format picture labelled as one the route takes', ({ mediaType, format, data }) => {
    expect(judgeImage('image/png', data, 8000)).toEqual({ kind: 'leave-out', note: formatNote(mediaType), format });
  });

  it.each(NOT_PICTURE_SAMPLES)('leaves out a $name file labelled as a picture, saying what it holds', ({ what, data }) => {
    for (const label of LABELS) {
      expect(judgeImage(label, data, 8000)).toEqual({ kind: 'leave-out', note: notPictureNote(what), notPicture: what });
    }
  });
});
