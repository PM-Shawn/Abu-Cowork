
export interface ComposerFileAttachmentLike {
  id: string;
  path?: string;
  token?: string;
  name: string;
  expiresAt?: number;
  readScope?: 'workspace';
}

function attachmentKeys(file: ComposerFileAttachmentLike): string[] {
  return [file.token, file.path].filter((value): value is string => Boolean(value));
}

export function mergeFileAttachments<T extends ComposerFileAttachmentLike>(
  existingFiles: T[],
  incomingFiles: T[],
): { files: T[]; capped: boolean; dropped: T[] } {
  const existing = new Set(existingFiles.flatMap(attachmentKeys));
  const files = [...existingFiles];
  const dropped: T[] = [];
  const capped = false;
  for (const file of incomingFiles) {
    if (attachmentKeys(file).some((key) => existing.has(key))) continue;
    attachmentKeys(file).forEach((key) => existing.add(key));
    files.push(file);
  }
  return { files, capped, dropped };
}
