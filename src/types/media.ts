import { z } from 'zod';

const identifier = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positiveInteger = z.number().int().positive();
const coordinate = z.number().finite().min(0).max(1);

export const mediaFileRefSchema = z.object({
  originalPath: z.string().min(1).max(32768),
  captureId: identifier.optional(),
  contentDigest: digest.optional(),
}).strict();

export const mediaArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  conversationId: identifier,
  messageId: identifier,
  kind: z.enum(['image', 'video']),
  mimeType: z.string().regex(/^(image|video)\/[a-z0-9.+-]+$/),
  fileRef: mediaFileRefSchema,
  byteLength: positiveInteger,
  groupId: identifier,
  order: z.number().int().nonnegative(),
  width: positiveInteger.optional(),
  height: positiveInteger.optional(),
  duration: z.number().finite().nonnegative().optional(),
  parentArtifactId: identifier.optional(),
  editRequestId: identifier.optional(),
}).strict().refine((artifact) => artifact.mimeType.startsWith(`${artifact.kind}/`), {
  message: 'Media kind and MIME type must agree',
});

export const imagePointSchema = z.object({ x: coordinate, y: coordinate }).strict();
export const imageCommentSchema = z.object({
  id: identifier,
  point: imagePointSchema,
  text: z.string(),
}).strict();

const drawing = {
  id: identifier,
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  width: z.number().finite().positive().max(1),
};

export const imageMarkupSchema = z.discriminatedUnion('kind', [
  z.object({ ...drawing, kind: z.literal('pen'), points: z.array(imagePointSchema).min(1) }).strict(),
  z.object({ ...drawing, kind: z.literal('arrow'), start: imagePointSchema, end: imagePointSchema }).strict(),
  z.object({ ...drawing, kind: z.literal('rectangle'), start: imagePointSchema, end: imagePointSchema }).strict(),
  z.object({ ...drawing, kind: z.literal('text'), point: imagePointSchema, text: z.string() }).strict(),
]);

export const imageRegionStrokeSchema = z.object({
  id: identifier,
  erase: z.boolean(),
  width: z.number().finite().positive().max(1),
  points: z.array(imagePointSchema).min(1),
}).strict();

export const imageEditAttachmentSchema = z.object({
  kind: z.enum(['source', 'mask', 'markup', 'reference']),
  fileRef: mediaFileRefSchema,
  mimeType: z.literal('image/png'),
  width: positiveInteger,
  height: positiveInteger,
  byteLength: positiveInteger,
}).strict();

export const imageEditRequestSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  scope: identifier,
  conversationId: identifier,
  messageId: identifier,
  sourceArtifactId: identifier,
  sourceCaptureId: identifier,
  sourceDigest: digest,
  prompt: z.string(),
  comments: z.array(imageCommentSchema),
  markup: z.array(imageMarkupSchema),
  region: z.array(imageRegionStrokeSchema),
  attachmentRefs: z.array(imageEditAttachmentSchema).min(1).max(4),
  backendId: identifier,
  capabilityVersion: identifier,
  retryOf: identifier.optional(),
}).strict().superRefine((request, context) => {
  if (!request.prompt.trim() && !request.comments.some((comment) => comment.text.trim())) {
    context.addIssue({ code: 'custom', message: 'An image edit requires text or a written comment' });
  }
  const sources = request.attachmentRefs.filter((attachment) => attachment.kind === 'source');
  if (sources.length !== 1 || sources[0].fileRef.captureId !== request.sourceCaptureId
    || sources[0].fileRef.contentDigest !== request.sourceDigest) {
    context.addIssue({ code: 'custom', message: 'The edit source must match its controlled capture' });
  }
  const kinds = request.attachmentRefs.map((attachment) => attachment.kind);
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate image edit attachments' });
  }
  if (kinds.includes('mask') && kinds.includes('markup')) {
    context.addIssue({ code: 'custom', message: 'A masked edit carries markup in its reference image' });
  }
});

export type MediaFileRef = z.infer<typeof mediaFileRefSchema>;
export type MediaArtifact = z.infer<typeof mediaArtifactSchema>;
export type ImagePoint = z.infer<typeof imagePointSchema>;
export type ImageComment = z.infer<typeof imageCommentSchema>;
export type ImageMarkup = z.infer<typeof imageMarkupSchema>;
export type ImageRegionStroke = z.infer<typeof imageRegionStrokeSchema>;
export type ImageEditAttachment = z.infer<typeof imageEditAttachmentSchema>;
export type ImageEditRequest = z.infer<typeof imageEditRequestSchema>;
export type ImageEditTool = 'prompt' | 'comments' | 'markup' | 'region';
export type ImageAspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9';

export interface ImageEditDraft {
  scope: string;
  conversationId: string;
  sourceArtifactId: string;
  sourceCaptureId: string;
  sourceDigest: string;
  source: ImageEditAttachment;
  activeTool: ImageEditTool;
  prompt: string;
  comments: ImageComment[];
  markup: ImageMarkup[];
  region: ImageRegionStroke[];
}

export const imageEditSubmissionSchema = z.object({
  id: identifier, messageId: identifier, scope: identifier, conversationId: identifier,
  sourceArtifactId: identifier, sourceCaptureId: identifier, sourceDigest: digest,
  source: imageEditAttachmentSchema, activeTool: z.enum(['prompt', 'comments', 'markup', 'region']),
  prompt: z.string(), comments: z.array(imageCommentSchema), markup: z.array(imageMarkupSchema), region: z.array(imageRegionStrokeSchema),
}).strict();

export type MediaGenerationState = 'prepared' | 'submitting' | 'running' | 'saving'
  | 'completed' | 'failed' | 'unknown' | 'cancelled' | 'save_failed';

export const mediaJobSchema = z.object({
  schemaVersion: z.literal(1),
  id: identifier,
  requestId: identifier,
  scope: identifier,
  conversationId: identifier,
  attempt: positiveInteger,
  generationState: z.enum(['prepared', 'submitting', 'running', 'saving', 'completed', 'failed', 'unknown', 'cancelled', 'save_failed']),
  waitState: z.enum(['waiting', 'detached']),
  sequence: z.number().int().nonnegative(),
  outputArtifactIds: z.array(identifier),
  error: z.string().optional(),
}).strict();

export type MediaJob = z.infer<typeof mediaJobSchema>;

export interface MediaJobRecord {
  request: ImageEditRequest;
  job: MediaJob;
  artifacts: MediaArtifact[];
}

export interface MessageMedia {
  mediaArtifacts?: MediaArtifact[];
  imageEditRequest?: ImageEditRequest;
}

/** Apply the same validation and deep copy at live and persisted boundaries. */
export function parseMessageMedia(
  message: MessageMedia & { id: string },
  conversationId?: string,
): MessageMedia {
  const media: MessageMedia = {};
  if (message.mediaArtifacts !== undefined) {
    media.mediaArtifacts = z.array(mediaArtifactSchema).parse(message.mediaArtifacts);
    const ids = new Set<string>();
    for (const artifact of media.mediaArtifacts) {
      if (artifact.messageId !== message.id || (conversationId && artifact.conversationId !== conversationId)) {
        throw new Error('Media artifact belongs to another message or conversation');
      }
      if (ids.has(artifact.id)) throw new Error('Duplicate media artifact');
      ids.add(artifact.id);
    }
  }
  if (message.imageEditRequest !== undefined) {
    media.imageEditRequest = imageEditRequestSchema.parse(message.imageEditRequest);
    if (media.imageEditRequest.messageId !== message.id
      || (conversationId && media.imageEditRequest.conversationId !== conversationId)) {
      throw new Error('Image edit request belongs to another message or conversation');
    }
  }
  return media;
}
