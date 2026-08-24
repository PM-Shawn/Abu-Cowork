import { describe, expect, it, vi } from 'vitest';
import {
  ActiveToolResultAdmission,
  canonicalizeActiveToolResultContent,
} from './activeToolResultContent';

function image(data: string) {
  return [{
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: 'image/png', data },
  }];
}

describe('active tool-result admission', () => {
  it('rejects malformed runtime envelopes before they enter an active owner', () => {
    expect(canonicalizeActiveToolResultContent({ type: 'text', text: 'not-an-array' })).toBeUndefined();
    expect(canonicalizeActiveToolResultContent([{
      type: 'image',
      source: { type: 'base64', media_type: `image/${'x'.repeat(9 * 1024 * 1024)}`, data: 'AAAA' },
    }])).toBeUndefined();
    expect(canonicalizeActiveToolResultContent([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'not base64!\u0000' },
    }])).toBeUndefined();
  });

  it('keeps the newest screenshots within a deterministic whole-run hard bound', () => {
    const admission = new ActiveToolResultAdmission({
      maxBytes: 1024,
      maxImages: 2,
      maxBlocks: 2,
      maxBlockBytes: 512,
    });
    const released = vi.fn();
    const retained: Array<{ data: string; live: boolean }> = [];

    for (let index = 0; index < 100; index++) {
      const data = index.toString(36).padStart(4, 'A');
      const token = admission.admit(image(data));
      const content = admission.get(token);
      expect(content?.[0]?.type).toBe('image');
      const owner = { data, live: true };
      retained.push(owner);
      admission.bindRelease(token, () => {
        owner.live = false;
        released(index);
      });
    }

    expect(admission.diagnostics()).toMatchObject({ images: 2, blocks: 2, entries: 2 });
    expect(admission.diagnostics().bytes).toBeLessThanOrEqual(1024);
    expect(retained.filter((owner) => owner.live).map((owner) => owner.data)).toEqual([
      (98).toString(36).padStart(4, 'A'),
      (99).toString(36).padStart(4, 'A'),
    ]);
    expect(released).toHaveBeenCalledTimes(98);
  });

  it('invokes a late-bound owner immediately when parallel admission already evicted it', () => {
    const admission = new ActiveToolResultAdmission({
      maxBytes: 1024,
      maxImages: 1,
      maxBlocks: 1,
      maxBlockBytes: 512,
    });
    const first = admission.admit(image('YQ=='));
    admission.admit(image('Yg=='));
    const release = vi.fn();

    expect(admission.get(first)).toBeUndefined();
    admission.bindRelease(first, release);
    expect(release).toHaveBeenCalledOnce();
  });

  it('retires a replaced owner immediately without leaving duplicate budget', () => {
    const admission = new ActiveToolResultAdmission();
    const first = admission.admit(image('YQ=='));
    const release = vi.fn();
    admission.bindRelease(first, release);

    admission.release(first);

    expect(release).toHaveBeenCalledOnce();
    expect(admission.get(first)).toBeUndefined();
    expect(admission.diagnostics()).toEqual({ bytes: 0, images: 0, blocks: 0, entries: 0 });
    admission.release(first);
    expect(release).toHaveBeenCalledOnce();
  });
});
