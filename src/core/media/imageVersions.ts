import type { Message } from '@/types';
import type { MediaFileRef } from '@/types/media';
import { collectPresentedFiles } from '@/utils/presentedFiles';
import { mediaMimeType } from './mediaTypes';

export const imageVersionKey = (file: MediaFileRef) => `${file.originalPath}\0${file.captureId ?? file.contentDigest ?? ''}`;

export function imageVersions(messages: Message[], current: MediaFileRef) {
  const requests = messages.flatMap(message => message.imageEditRequest ? [message.imageEditRequest] : []);
  const artifacts = messages.flatMap(message => message.mediaArtifacts ?? []).filter(artifact => artifact.kind === 'image');
  const paths = new Set([current.originalPath]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const artifact of artifacts) {
      const request = requests.find(item => item.id === artifact.editRequestId);
      const source = request?.attachmentRefs.find(item => item.kind === 'source');
      const parent = artifacts.find(item => item.id === request?.sourceArtifactId);
      if (!source) continue;
      const relatedPaths = [source.fileRef.originalPath, artifact.fileRef.originalPath, ...(parent ? [parent.fileRef.originalPath] : [])];
      if (!relatedPaths.some(value => paths.has(value))) continue;
      for (const value of relatedPaths) {
        if (!paths.has(value)) { paths.add(value); changed = true; }
      }
    }
  }
  const versions = new Map<string, MediaFileRef>();
  const add = (file: MediaFileRef) => versions.set(imageVersionKey(file), file);
  for (const request of requests) {
    const source = request.attachmentRefs.find(item => item.kind === 'source');
    if (source && paths.has(source.fileRef.originalPath)) add(source.fileRef);
    for (const artifact of artifacts.filter(item => item.editRequestId === request.id)) {
      if (paths.has(artifact.fileRef.originalPath)) add(artifact.fileRef);
    }
  }
  if (!versions.size) {
    for (const message of messages) {
      const files = [...(message.mediaArtifacts ?? []).filter(item => item.kind === 'image').map(item => item.fileRef),
        ...collectPresentedFiles(message.toolCalls ?? []).filter(item => mediaMimeType(item.path)?.startsWith('image/')).map(item => ({ originalPath: item.path }))];
      if (files.some(file => file.originalPath === current.originalPath)) files.forEach(add);
    }
  }
  if (!versions.has(imageVersionKey(current))) add(current);
  const artifact = artifacts.find(item => item.fileRef.originalPath === current.originalPath);
  const parent = requests.find(item => item.id === artifact?.editRequestId)?.attachmentRefs.find(item => item.kind === 'source')?.fileRef;
  return { versions: [...versions.values()], parent };
}
