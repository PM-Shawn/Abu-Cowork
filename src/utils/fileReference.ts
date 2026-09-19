/** Legacy file-reference grammar. Paths are user data, never access grants. */
export function fileReferenceForPath(path: string): string | null {
  if (!path || /[`\r\n\0]/.test(path)) return null;
  return `[Attachment: \`${path}\`]`;
}

export function extractFileReferences(text: string): string[] {
  return text.match(/^\[Attachment: `[^`\r\n\0]+`\]$/gm) ?? [];
}

export class InvalidAttachmentPathError extends Error {
  constructor() {
    super('Attachment path cannot be represented without ambiguity');
    this.name = 'InvalidAttachmentPathError';
  }
}
