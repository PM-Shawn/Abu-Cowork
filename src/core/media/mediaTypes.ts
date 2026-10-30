import { IMAGE_MIME_MAP } from '@/utils/imageMediaTypes';

export const VIDEO_MIME_MAP: Readonly<Record<string, string>> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg',
};

export function mediaMimeType(filePath: string): string | undefined {
  const extension = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_MIME_MAP[extension] ?? VIDEO_MIME_MAP[extension];
}

export function isVideoFile(filePath: string): boolean {
  return mediaMimeType(filePath)?.startsWith('video/') === true;
}
