import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import type { ImageEditRequest, MediaArtifact } from '@/types/media';
import { imageEditRequestSchema, mediaArtifactSchema } from '@/types/media';
import { projectLedger } from '@/core/session/ledgerReader';
import { serializeLedgerPut, stripForDisk } from '@/core/session/ledgerLineSerializer';

const digest = 'a'.repeat(64);
const artifact: MediaArtifact = {
  schemaVersion: 1, id: 'image-1', conversationId: 'conversation-1', messageId: 'message-1',
  kind: 'image', mimeType: 'image/png', byteLength: 1024, groupId: 'group-1', order: 0,
  fileRef: { originalPath: '/workspace/coffee.png', captureId: 'capture-1', contentDigest: digest },
  width: 1024, height: 1024,
};
const request: ImageEditRequest = {
  schemaVersion: 1, id: 'request-1', scope: 'local', conversationId: 'conversation-1',
  messageId: 'message-1', sourceArtifactId: 'image-1', sourceCaptureId: 'capture-1', sourceDigest: digest,
  prompt: 'Keep the coffee package.', comments: [{ id: 'comment-1', point: { x: 0.5, y: 0.4 }, text: 'Keep this label.' }],
  markup: [{ kind: 'arrow', id: 'arrow-1', color: '#ff0000', width: 0.01, start: { x: 0.2, y: 0.4 }, end: { x: 0.5, y: 0.4 } }],
  region: [{ id: 'region-1', erase: false, width: 0.1, points: [{ x: 0.1, y: 0.1 }] }],
  attachmentRefs: [
    { kind: 'source', fileRef: artifact.fileRef, mimeType: 'image/png', width: 1024, height: 1024, byteLength: 1024 },
    { kind: 'mask', fileRef: { originalPath: '/outputs/mask.png' }, mimeType: 'image/png', width: 1024, height: 1024, byteLength: 256 },
    { kind: 'reference', fileRef: { originalPath: '/outputs/reference.png' }, mimeType: 'image/png', width: 1024, height: 1024, byteLength: 2048 },
  ],
  backendId: 'openai-image', capabilityVersion: 'openai-images-edit-v1',
};
const options = { findToolResultImageSnapshot: () => null };
const message: Message = { id: 'message-1', role: 'user', content: request.prompt, timestamp: 1, imageEditRequest: request };

describe('media message records', () => {
  it('replays an edit with all layers and its immutable source', () => {
    const ledgerText = serializeLedgerPut('conversation-1', message, undefined, options);
    expect(projectLedger({ ledgerText }).messages[0].imageEditRequest).toEqual(request);
    const snapshotText = JSON.stringify({ messages: [message] });
    expect(projectLedger({ ledgerText: '', snapshotText }).messages[0].imageEditRequest).toEqual(request);
  });

  it('keeps old messages readable and media results ordered', () => {
    const legacy: Message = { id: 'old', role: 'assistant', content: 'Ready', timestamp: 0 };
    const result: Message = { ...message, role: 'assistant', imageEditRequest: undefined, mediaArtifacts: [artifact] };
    const ledgerText = [legacy, result, result].map((entry) => serializeLedgerPut('conversation-1', entry, undefined, options)).join('');
    expect(projectLedger({ ledgerText }).messages).toEqual([legacy, result]);
  });

  it('copies every editable layer before persistence', () => {
    const projected = stripForDisk(message, 'conversation-1', options);
    projected.imageEditRequest!.comments[0].text = 'Changed';
    projected.imageEditRequest!.region[0].points[0].x = 0.9;
    projected.imageEditRequest!.attachmentRefs[0].fileRef.originalPath = '/other.png';
    expect(request.comments[0].text).toBe('Keep this label.');
    expect(request.region[0].points[0].x).toBe(0.1);
    expect(request.attachmentRefs[0].fileRef.originalPath).toBe('/workspace/coffee.png');
  });

  it('rejects a request whose source attachment names a different capture', () => {
    expect(() => imageEditRequestSchema.parse({ ...request, sourceCaptureId: 'another-capture' })).toThrow('controlled capture');
  });

  it('accepts written comments alone and refuses a drawing without instructions', () => {
    expect(imageEditRequestSchema.parse({ ...request, prompt: '' }).comments).toHaveLength(1);
    expect(() => imageEditRequestSchema.parse({ ...request, prompt: ' ', comments: [] })).toThrow('requires text');
  });

  it('rejects hidden payload fields, invalid dimensions and coordinates', () => {
    expect(() => mediaArtifactSchema.parse({ ...artifact, data: 'image bytes' })).toThrow();
    expect(() => mediaArtifactSchema.parse({ ...artifact, width: 0 })).toThrow();
    expect(() => mediaArtifactSchema.parse({ ...artifact, kind: 'video' })).toThrow('MIME');
    expect(() => imageEditRequestSchema.parse({ ...request, comments: [{ ...request.comments[0], point: { x: 1.1, y: 0 } }] })).toThrow();
  });

  it('validates the same ownership and input shape on write and replay', () => {
    const wrong = { ...message, imageEditRequest: { ...request, messageId: 'another-message' } };
    expect(() => stripForDisk(wrong, 'conversation-1', options)).toThrow('another message');
    expect(() => projectLedger({ ledgerText: JSON.stringify(wrong) })).toThrow('another message');
    expect(() => stripForDisk(message, 'another-conversation', options)).toThrow('another message');
  });

  it('refuses duplicate artifacts and mutually exclusive service attachments', () => {
    expect(() => stripForDisk({ ...message, mediaArtifacts: [artifact, artifact] }, 'conversation-1', options)).toThrow('Duplicate media');
    expect(() => imageEditRequestSchema.parse({
      ...request, attachmentRefs: [...request.attachmentRefs, { ...request.attachmentRefs[2], kind: 'markup' }],
    })).toThrow('reference image');
  });
});
