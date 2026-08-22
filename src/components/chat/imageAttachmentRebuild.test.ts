/**
 * Unit tests for rebuildImageAttachments — the shared pure function that turns
 * a persisted user message's image blocks back into ImageAttachments for every
 * re-dispatch path (retry, edit-resend, regenerate).
 */
import { describe, it, expect } from 'vitest';
import { rebuildImageAttachments } from './imageAttachmentRebuild';
import type { MessageContent } from '@/types';

const imgBlock = (over: Partial<Extract<MessageContent, { type: 'image' }>> = {}): MessageContent => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'BASE64' },
  ...over,
});

describe('rebuildImageAttachments', () => {
  it('plain string content → no images', () => {
    expect(rebuildImageAttachments('hello', 'retry')).toBeUndefined();
  });

  it('multimodal content without image blocks → no images', () => {
    expect(rebuildImageAttachments([{ type: 'text', text: 'hi' }], 'retry')).toBeUndefined();
  });

  it('carries base64 + mediaType and namespaces ids by prefix', () => {
    const [att] = rebuildImageAttachments([imgBlock(), { type: 'text', text: 'look' }], 'retry')!;
    expect(att).toMatchObject({ id: 'retry-0', data: 'BASE64', mediaType: 'image/png' });
  });

  // Regression (v0.41.0 验收): after an app restart the persisted block has
  // source.data === '' (stripped on disk) and only filePath left. The rebuilt
  // attachment used to drop filePath, so retry dispatched an empty image —
  // model answered "图片没能加载出来" and the thumbnail was blank. The snapshot
  // path must ride along so send-path rehydration and the thumbnail's
  // resolveFileSource fallback can recover the pixels.
  it('data-stripped block: attachment carries filePath', () => {
    const stripped = imgBlock({
      source: { type: 'base64', media_type: 'image/png', data: '' },
      filePath: '/outputs/images/2026-08-20_0.png',
    });
    const [att] = rebuildImageAttachments([stripped], 'retry')!;
    expect(att.filePath).toBe('/outputs/images/2026-08-20_0.png');
    expect(att.data).toBe('');
  });

  it('carries filePath alongside fresh data on a same-session retry (snapshot reuse)', () => {
    const [att] = rebuildImageAttachments([imgBlock({ filePath: '/outputs/images/a.png' })], 'retry')!;
    expect(att.filePath).toBe('/outputs/images/a.png');
    expect(att.data).toBe('BASE64');
  });

  it('block without filePath → attachment has no filePath key', () => {
    const [att] = rebuildImageAttachments([imgBlock()], 'retry')!;
    expect('filePath' in att).toBe(false);
  });

  it('still carries the admission resize record', () => {
    const resized = { fromWidth: 2940, fromHeight: 1846, toWidth: 2000, toHeight: 1256 };
    const [att] = rebuildImageAttachments([imgBlock({ resized })], 'retry')!;
    expect(att.resized).toEqual(resized);
  });
});
