export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export function generateAttachmentId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}
