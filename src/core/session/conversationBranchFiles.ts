import type { Message, ToolCall, ToolCallForContext } from '@/types';
import type { ExecutionStepSnapshot } from '@/types/execution';
import type { OutputManifest, SnapshotEntry } from './outputSnapshots';
import { readToolResultFileReference, rewriteToolResultFileNote } from './toolResultFileReference';

export interface BranchFileCopy {
  sourceArea: 'conversation' | 'legacy' | 'inline';
  sourceRelPath: string;
  targetRelPath: string;
  inline?: { data: string; mediaType: string };
  missing?: true;
}

export interface BranchFilePlan {
  messages: Message[];
  manifest: OutputManifest;
  files: BranchFileCopy[];
}

export function assertBranchRelativePath(value: string): void {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || value.includes(':')
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid branch file reference');
  }
}

/** Produces only conversation-owned copies. The host supplies the trusted directory names. */
export function buildConversationBranchFilePlan(options: {
  sourceConversationId: string;
  childConversationId: string;
  sourceDirectory: string;
  childDirectory: string;
  messages: readonly Message[];
  messageIdMap: ReadonlyMap<string, string>;
  entries: readonly SnapshotEntry[];
}): BranchFilePlan {
  const messages = structuredClone(options.messages) as Message[];
  const files: BranchFileCopy[] = [];
  const bySource = new Map<string, BranchFileCopy>();
  const manifest: OutputManifest = { version: 1, entries: Object.create(null) };
  const sourceDir = options.sourceDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  const childDir = options.childDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  const toolIds = new Set(messages.flatMap(message => [...(message.toolCalls ?? []), ...(message.toolCallsForContext ?? [])].map(call => call.id)));
  const selected = options.entries.filter(entry => entry.source === 'user-upload'
    ? options.messageIdMap.has(entry.refId) : toolIds.has(entry.refId) || options.messageIdMap.has(entry.refId));
  const latestByPath = new Map(options.entries.filter(entry => entry.snapshotRelPath).map(entry => [entry.snapshotRelPath, entry]));
  const entryFiles = new Map<SnapshotEntry, BranchFileCopy>();
  const mappedCalls = new WeakSet<ToolCall | ToolCallForContext>();
  const mappedImages = new WeakSet<object>();

  function copy(sourceRelPath: string, sourceArea: BranchFileCopy['sourceArea'] = 'conversation', inline?: BranchFileCopy['inline'], missing = false): BranchFileCopy {
    assertBranchRelativePath(sourceRelPath);
    if (!sourceRelPath.startsWith('outputs/') && !/^results\/[A-Za-z0-9_-]+\.txt$/.test(sourceRelPath)) {
      throw new Error('Unsupported branch file reference');
    }
    const key = `${sourceArea}:${sourceRelPath}:${missing}`;
    const previous = bySource.get(key);
    if (previous) {
      if (inline && previous.inline && inline.data !== previous.inline.data) throw new Error('Conflicting branch attachment bytes');
      if (inline) previous.inline = inline;
      return previous;
    }
    const number = files.length + 1;
    const targetRelPath = sourceRelPath.startsWith('results/')
      ? `results/branch-${number}.txt`
      : `outputs/inherited/${number}/${sourceRelPath.split('/').at(-1)}`;
    const file: BranchFileCopy = { sourceArea, sourceRelPath, targetRelPath, ...(inline ? { inline } : {}), ...(missing ? { missing: true } : {}) };
    bySource.set(key, file);
    files.push(file);
    return file;
  }

  for (const entry of selected) {
    if (typeof entry.refId !== 'string' || typeof entry.basename !== 'string' || !Number.isFinite(entry.size) || entry.size < 0) {
      throw new Error('Invalid branch attachment metadata');
    }
    const latest = latestByPath.get(entry.snapshotRelPath);
    const missing = !!entry.missing || !!(latest && latest !== entry && (latest.refId !== entry.refId || latest.captureId !== entry.captureId));
    const file = entry.snapshotRelPath ? copy(`outputs/${entry.snapshotRelPath}`, 'conversation', undefined, missing) : undefined;
    if (file) entryFiles.set(entry, file);
    const copied: SnapshotEntry = {
      ...entry,
      refId: options.messageIdMap.get(entry.refId) ?? entry.refId,
      snapshotRelPath: file?.targetRelPath.slice('outputs/'.length) ?? '',
      inheritedFromBranch: true,
      ...(entry.originalPath.replace(/\\/g, '/').startsWith(`${sourceDir}/outputs/`) ? { inheritedManagedPath: true } : {}),
    };
    const existing = manifest.entries[copied.originalPath];
    if (existing && existing.snapshotRelPath !== copied.snapshotRelPath) {
      const key = `branch-copy://${options.childConversationId}/${Object.keys(manifest.entries).length}`;
      manifest.entries[key] = { ...existing, originalPath: key };
    }
    manifest.entries[copied.originalPath] = copied;
  }

  function mapResult(call: ToolCall | ToolCallForContext): void {
    if (mappedCalls.has(call)) return;
    mappedCalls.add(call);
    const reference = call.fullResultRef ?? (call.result ? readToolResultFileReference(call.result, options.sourceConversationId) : undefined);
    if (reference) {
      if (!/^results\/[A-Za-z0-9_-]+\.txt$/.test(reference.relPath)) throw new Error('Invalid full tool result reference');
      const file = copy(reference.relPath, reference.legacy ? 'legacy' : 'conversation', undefined, reference.missing);
      call.fullResultRef = { relPath: file.targetRelPath, ...(reference.missing ? { missing: true } : {}) };
      if (call.result !== undefined) call.result = rewriteToolResultFileNote(call.result, `${childDir}/${file.targetRelPath}`, !!reference.missing);
    }
    for (const [blockIndex, block] of (call.resultContent ?? []).entries()) {
      if (block.type === 'image' && (block.outputRef || block.source.data)) {
        if (mappedImages.has(block)) continue;
        mappedImages.add(block);
        const sourceRelPath = block.outputRef?.relPath ?? `images/inline-${encodeURIComponent(call.id ?? `context-${files.length + 1}`)}-${blockIndex}.image`;
        const latest = latestByPath.get(sourceRelPath);
        const independent = latest?.inheritedFromBranch && latest.refKind === 'branch-attachment' && latest.refId === '';
        const superseded = !block.source.data && !!latest && (!!latest.missing || (!independent && latest.refId !== call.id));
        const file = copy(`outputs/${sourceRelPath}`, block.outputRef ? 'conversation' : 'inline', block.source.data
          ? { data: block.source.data, mediaType: block.source.media_type } : undefined, superseded);
        block.outputRef = { ...block.outputRef, relPath: file.targetRelPath.slice('outputs/'.length) };
      }
    }
  }
  function mapSteps(steps: ExecutionStepSnapshot[]): void {
    for (const step of steps) {
      for (const block of step.detailBlocks ?? []) {
        if (!block.content) continue;
        const reference = readToolResultFileReference(block.content, options.sourceConversationId);
        if (reference) {
          const file = copy(reference.relPath, reference.legacy ? 'legacy' : 'conversation');
          block.content = rewriteToolResultFileNote(block.content, `${childDir}/${file.targetRelPath}`, false);
        }
      }
      mapSteps(step.childSteps ?? []);
    }
  }
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'document' && block.originConversationId) block.originConversationId = options.childConversationId;
        if (block.type !== 'image') continue;
        if (mappedImages.has(block)) continue;
        mappedImages.add(block);
        const normalized = block.filePath?.replace(/\\/g, '/');
        const owned = normalized?.startsWith(`${sourceDir}/outputs/`) ? normalized.slice(sourceDir.length + 1) : undefined;
        const upload = selected.filter(entry => entry.source === 'user-upload'
          && options.messageIdMap.get(entry.refId) === message.id && entry.originalPath.replace(/\\/g, '/') === normalized).at(-1);
        const relative = owned ?? (upload?.snapshotRelPath ? `outputs/${upload.snapshotRelPath}` : undefined);
        const prior = upload ? entryFiles.get(upload) : undefined;
        const ownedEntry = owned ? latestByPath.get(owned.slice('outputs/'.length)) : undefined;
        const missing = !block.source.data && (!relative || !!prior?.missing || !!ownedEntry?.missing
          || (ownedEntry?.source === 'user-upload' && options.messageIdMap.get(ownedEntry.refId) !== message.id));
        const file = prior && !block.source.data && !owned ? prior
          : copy(relative ?? `outputs/images/${message.id}-${files.length + 1}.image`, relative ? 'conversation' : 'inline', block.source.data
            ? { data: block.source.data, mediaType: block.source.media_type } : undefined, missing);
        block.filePath = `${childDir}/${file.targetRelPath}`;
      }
    }
    for (const call of message.toolCalls ?? []) mapResult(call);
    for (const call of message.toolCallsForContext ?? []) mapResult(call);
    mapSteps(message.executionSteps ?? []);
  }
  for (const file of files) {
    if (!file.targetRelPath.startsWith('outputs/')) continue;
    const relative = file.targetRelPath.slice('outputs/'.length);
    if (Object.values(manifest.entries).some(entry => entry.snapshotRelPath === relative)) continue;
    const originalPath = `${childDir}/${file.targetRelPath}`;
    manifest.entries[originalPath] = {
      originalPath, basename: file.sourceRelPath.split('/').at(-1)!, snapshotRelPath: relative,
      size: 0, originalMtime: 0, snapshottedAt: 0, source: 'tool-output', refId: '', refKind: 'branch-attachment',
      inheritedFromBranch: true,
    };
  }
  return { messages, manifest, files };
}

/** Missing files are recorded before copying starts; a later read failure must throw. */
export function markBranchFilesMissing(plan: BranchFilePlan, childDirectory: string, missing: ReadonlySet<string>): void {
  const childDir = childDirectory.replace(/\\/g, '/').replace(/\/$/, '');
  const childId = childDir.slice(childDir.lastIndexOf('/') + 1);
  for (const entry of Object.values(plan.manifest.entries)) {
    if (missing.has(`outputs/${entry.snapshotRelPath}`)) entry.missing = true;
  }
  function markResult(call: ToolCall | ToolCallForContext): void {
    if (call.fullResultRef && missing.has(call.fullResultRef.relPath)) {
      call.fullResultRef.missing = true;
      if (call.result !== undefined) call.result = rewriteToolResultFileNote(call.result, `${childDir}/${call.fullResultRef.relPath}`, true);
    }
  }
  function markSteps(steps: ExecutionStepSnapshot[]): void {
    for (const step of steps) {
      for (const block of step.detailBlocks ?? []) {
        if (!block.content) continue;
        const reference = readToolResultFileReference(block.content, childId);
        if (reference && missing.has(reference.relPath)) block.content = rewriteToolResultFileNote(block.content, '', true);
      }
      markSteps(step.childSteps ?? []);
    }
  }
  for (const message of plan.messages) {
    for (const call of message.toolCalls ?? []) markResult(call);
    for (const call of message.toolCallsForContext ?? []) markResult(call);
    markSteps(message.executionSteps ?? []);
  }
}
