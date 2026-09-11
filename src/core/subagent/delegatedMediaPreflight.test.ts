import { describe, expect, it } from 'vitest';
import {
  base64PayloadLength,
  DELEGATED_TEXT_ONLY_IMAGE_PLACEHOLDER,
  MAX_DELEGATED_IMAGE_BASE64_BYTES,
  MAX_DELEGATED_IMAGE_COUNT,
  preflightDelegatedMedia,
} from './delegatedMediaPreflight';
import type { DelegatedUserTurn } from './delegatedUserTurn';

const caps = { vision: true, documentBlock: true };
const textOnlyCaps = { vision: false, documentBlock: false };

function turn(images: number[] = [], documents: number | number[] = 0): DelegatedUserTurn {
  const documentBytes = typeof documents === 'number' ? Array(documents).fill(3) : documents;
  return {
    schemaVersion: 1,
    origin: { conversationId: 'conv_1', loopId: 'loop_1', messageId: 'msg_1' },
    content: [
      { type: 'text', text: 'inspect these' },
      ...images.map((bytes, index) => ({
        type: 'image' as const,
        attachment: { id: `media_${index}`, sha256: 'a'.repeat(64), mediaType: 'image/png' as const, bytes },
      })),
      ...documentBytes.map((bytes, index) => ({
        type: 'document' as const,
        attachment: { id: `pdf_${index}`, sha256: 'b'.repeat(64), mediaType: 'application/pdf' as const, bytes },
      })),
    ],
  };
}

describe('delegated media preflight', () => {
  it('uses encoded base64 length rather than raw bytes', () => {
    expect(base64PayloadLength(1)).toBe(4);
    expect(base64PayloadLength(3)).toBe(4);
    expect(base64PayloadLength(4)).toBe(8);
  });

  it('accepts a vision-capable image turn', () => {
    expect(preflightDelegatedMedia(turn([3]), caps, 'claude-test')).toEqual({ kind: 'send', imageDisposition: 'send' });
  });

  it('fails closed for text-only models unless the trusted fallback is explicit', () => {
    const rejected = preflightDelegatedMedia(turn([3]), textOnlyCaps, 'text-model');
    expect(rejected).toMatchObject({ kind: 'error', diagnostic: { reason: 'vision_unsupported', outcome: 'not_sent' } });
    expect(preflightDelegatedMedia(turn([3]), textOnlyCaps, 'text-model', 'claude', 'text-only')).toMatchObject({
      kind: 'send', imageDisposition: 'text-only', diagnostic: { outcome: 'text_only', reason: 'vision_unsupported' },
    });
    expect(DELEGATED_TEXT_ONLY_IMAGE_PLACEHOLDER).not.toMatch(/base64|Bearer|\/[A-Za-z]|[A-Za-z]:\\/i);
  });

  it('fails closed for delegated documents without document capability', () => {
    expect(preflightDelegatedMedia(turn([], 1), { vision: true, documentBlock: false }, 'gpt-test')).toMatchObject({
      kind: 'error', diagnostic: { reason: 'document_unsupported' },
    });
  });

  it('fails closed for delegated documents when the actual transport is OpenAI-compatible', () => {
    expect(preflightDelegatedMedia(turn([], 1), caps, 'claude-opus-test', 'openai-compatible')).toMatchObject({
      kind: 'error', diagnostic: { reason: 'document_unsupported' },
    });
  });

  it('enforces exact image count and encoded single-image limits', () => {
    expect(preflightDelegatedMedia(turn(Array(MAX_DELEGATED_IMAGE_COUNT).fill(3)), caps, 'claude-test')).toMatchObject({ kind: 'send' });
    expect(preflightDelegatedMedia(turn(Array(MAX_DELEGATED_IMAGE_COUNT + 1).fill(3)), caps, 'claude-test')).toMatchObject({
      kind: 'error', diagnostic: { reason: 'image_count' },
    });
    const exactRaw = (MAX_DELEGATED_IMAGE_BASE64_BYTES / 4) * 3;
    expect(preflightDelegatedMedia(turn([exactRaw]), caps, 'claude-test')).toMatchObject({ kind: 'send' });
    expect(preflightDelegatedMedia(turn([exactRaw + 1]), caps, 'claude-test')).toMatchObject({
      kind: 'error', diagnostic: { reason: 'image_payload_too_large' },
    });
  });

  it('enforces the route total on encoded payload length at the exact boundary', () => {
    const exactRaw = (MAX_DELEGATED_IMAGE_BASE64_BYTES / 4) * 3;
    expect(preflightDelegatedMedia(turn([exactRaw, exactRaw, exactRaw, exactRaw]), caps, 'claude-test')).toMatchObject({ kind: 'send' });
    expect(preflightDelegatedMedia(turn([exactRaw, exactRaw, exactRaw, exactRaw, 3]), caps, 'claude-test')).toMatchObject({
      kind: 'error', diagnostic: { reason: 'image_total_too_large' },
    });
  });

  it('treats null as an invalid envelope rather than an omitted one', () => {
    expect(preflightDelegatedMedia(null, caps, 'claude-test')).toMatchObject({
      kind: 'error', diagnostic: { reason: 'invalid_turn' },
    });
  });

  it('keeps diagnostics allowlisted and free of attachment secrets', () => {
    const result = preflightDelegatedMedia(turn([3]), textOnlyCaps, '/Users/secret/Bearer token');
    expect(result).toMatchObject({ kind: 'error' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('media_0');
    expect(serialized).not.toContain('aaaaaaaa');
    expect(serialized).not.toMatch(/base64|Bearer|\/Users\/|[A-Za-z]:\\/i);
  });
});
