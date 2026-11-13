import { downloadDir, homeDir } from '@tauri-apps/api/path';
import type { ToolExecutionContext } from '@/types';
import { normalizeLexicalPath, isLocalFilePath, joinPath } from '@/utils/pathUtils';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { decodeUploadFiles } from '@/core/permissions/browserUploadFiles';
import { uploadsFile } from '@/core/permissions/browserToolPolicy';
import { parsePresentedFilesInput } from '@/core/tools/definitions/presentTools';
import { parsePatchOperations, type ResolvedPatchOperation } from '@/core/tools/definitions/patchTools';
import { freezeToolInput, requiresHostFileOperations } from '@/core/tools/operationAuthorization';
import type { FileAccessPurpose, FileOperationPlan, FileOperationTarget } from '@/core/tools/fileOperation';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { parseReferenceImages, isRemoteReference } from '@/core/tools/referenceImages';

const singlePurposes: Readonly<Record<string, FileAccessPurpose>> = {
  [TOOL_NAMES.READ_FILE]: 'read',
  [TOOL_NAMES.WRITE_FILE]: 'write',
  [TOOL_NAMES.EDIT_FILE]: 'write',
  [TOOL_NAMES.DELETE_FILE]: 'delete',
  [TOOL_NAMES.LIST_DIRECTORY]: 'list',
  [TOOL_NAMES.SEARCH_FILES]: 'traverse',
  [TOOL_NAMES.FIND_FILES]: 'traverse',
  [TOOL_NAMES.SEND_FILE]: 'read',
  [TOOL_NAMES.CHECK_OPEN_DOCUMENT]: 'read',
};

export function requiresHostFileExecution(name: string): boolean {
  return requiresHostFileOperations() && (hasToolFileTargets(name) || name === TOOL_NAMES.RUN_COMMAND);
}

export function hasToolFileTargets(name: string): boolean {
  return singlePurposes[name] !== undefined || uploadsFile(name)
    || name === TOOL_NAMES.PRESENT_FILES || name === TOOL_NAMES.PROCESS_IMAGE || name === TOOL_NAMES.GENERATE_IMAGE
    || name === TOOL_NAMES.APPLY_PATCH;
}

/** Resolve every declared target before an approval or tool body can await. */
export async function planToolFiles(
  name: string,
  original: Readonly<Record<string, unknown>>,
  context?: ToolExecutionContext,
): Promise<FileOperationPlan | null> {
  const single = singlePurposes[name];
  const upload = uploadsFile(name);
  if (!single && !upload && name !== TOOL_NAMES.PRESENT_FILES
    && name !== TOOL_NAMES.PROCESS_IMAGE && name !== TOOL_NAMES.GENERATE_IMAGE
    && name !== TOOL_NAMES.APPLY_PATCH) return null;

  const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;
  const generatedName = name === TOOL_NAMES.GENERATE_IMAGE ? `abu-image-${Date.now()}.png` : '';
  const homePath = normalizeLexicalPath(await homeDir());
  const input: Record<string, unknown> = structuredClone(original);
  const targets: FileOperationTarget[] = [];

  function target(raw: unknown, purpose: FileAccessPurpose, followFinalSymlink = true): string | undefined {
    if (typeof raw !== 'string' || !raw.trim()) return undefined;
    const inputPath = raw.trim();
    let expanded = inputPath === '~' ? homePath
      : inputPath.startsWith('~/') || inputPath.startsWith('~\\') ? joinPath(homePath, inputPath.slice(2))
      : inputPath;
    if (!isLocalFilePath(expanded) && workspacePath) expanded = joinPath(workspacePath, expanded);
    const path = normalizeLexicalPath(expanded);
    targets.push(Object.freeze({ inputPath, path, purpose, followFinalSymlink }));
    return path;
  }

  if (single) {
    const path = target(input.path, single, name !== TOOL_NAMES.DELETE_FILE);
    if (path !== undefined) input.path = path;
    if (name === TOOL_NAMES.WRITE_FILE || name === TOOL_NAMES.EDIT_FILE
      || (name === TOOL_NAMES.DELETE_FILE && (context?.reportMetadata || context?.loopId))) {
      target(original.path, 'read', name !== TOOL_NAMES.DELETE_FILE);
    }
  } else if (name === TOOL_NAMES.PRESENT_FILES) {
    input.files = parsePresentedFilesInput(input.files).map(file => ({
      ...file, path: target(file.path, 'read') ?? file.path,
    }));
  } else if (name === TOOL_NAMES.PROCESS_IMAGE) {
    const source = target(input.input_path, 'read');
    const output = target(input.output_path, 'write');
    if (source !== undefined) input.input_path = source;
    if (output !== undefined) input.output_path = output;
  } else if (name === TOOL_NAMES.GENERATE_IMAGE) {
    const output = typeof input.save_path === 'string' && input.save_path.trim()
      ? input.save_path : joinPath(workspacePath || await downloadDir(), generatedName);
    input.save_path = target(output, 'write');
    // A local reference image is read and uploaded: it is a read target like
    // read_file's, and the tool reads the pinned path, not the model's text.
    if (input.reference_images !== undefined) {
      input.reference_images = parseReferenceImages(input.reference_images)
        .map(entry => isRemoteReference(entry) ? entry : target(entry, 'read') ?? entry);
    }
  } else if (upload) {
    const paths = decodeUploadFiles(input);
    if (paths) {
      const files = paths.map(path => ({ path: target(path, 'read', false) ?? path }));
      input.files = typeof original.files === 'string' ? JSON.stringify(files) : files;
    }
  } else if (name === TOOL_NAMES.APPLY_PATCH) {
    // Every section of the patch is a target; the tool reads the resolved
    // paths back from `operations`, in the order the patch names them. A
    // patch the parser rejects declares no target and the tool reports it.
    const parsed = parsePatchOperations(typeof input.input === 'string' ? input.input : '');
    if ('operations' in parsed) {
      input.operations = parsed.operations.map((op): ResolvedPatchOperation => {
        if (op.type === 'add') return { type: op.type, path: target(op.path, 'write') ?? op.path };
        if (op.type === 'delete') {
          const path = target(op.path, 'delete', false) ?? op.path;
          target(op.path, 'read', false);
          return { type: op.type, path };
        }
        const moveTo = op.moveTo !== undefined && op.moveTo.trim() !== '' ? op.moveTo : undefined;
        const path = target(op.path, moveTo ? 'delete' : 'write', !moveTo) ?? op.path;
        target(op.path, 'read', !moveTo);
        return { type: op.type, path, ...(moveTo ? { moveTo: target(moveTo, 'write') ?? moveTo } : {}) };
      });
    }
  }

  return Object.freeze({ input: freezeToolInput(input), targets: Object.freeze(targets), homePath, workspacePath });
}

/** Pin only the tool's declared file arguments to their observed destinations. */
export function resolveToolFileInput(
  name: string,
  input: Readonly<Record<string, unknown>>,
  destinations: ReadonlyMap<string, string>,
): Readonly<Record<string, unknown>> {
  const resolved: Record<string, unknown> = structuredClone(input);
  const resolve = (path: unknown) => typeof path === 'string' ? destinations.get(path) ?? path : path;
  if (name === TOOL_NAMES.PRESENT_FILES) {
    resolved.files = parsePresentedFilesInput(input.files).map(file => ({ ...file, path: resolve(file.path) }));
  } else if (uploadsFile(name)) {
    const paths = decodeUploadFiles(input);
    if (paths) {
      const files = paths.map(path => ({ path: resolve(path) }));
      resolved.files = typeof input.files === 'string' ? JSON.stringify(files) : files;
    }
  } else if (name === TOOL_NAMES.PROCESS_IMAGE) {
    resolved.input_path = resolve(input.input_path);
    resolved.output_path = resolve(input.output_path);
  } else if (name === TOOL_NAMES.GENERATE_IMAGE) {
    resolved.save_path = resolve(input.save_path);
    if (input.reference_images !== undefined) {
      resolved.reference_images = parseReferenceImages(input.reference_images)
        .map(entry => isRemoteReference(entry) ? entry : resolve(entry));
    }
  } else if (name === TOOL_NAMES.APPLY_PATCH) {
    if (Array.isArray(input.operations)) {
      resolved.operations = (input.operations as ResolvedPatchOperation[]).map((op) => ({
        ...op, path: resolve(op.path), ...(op.moveTo !== undefined ? { moveTo: resolve(op.moveTo) } : {}),
      }));
    }
  } else if (typeof input.path === 'string') {
    resolved.path = resolve(input.path);
  }
  return freezeToolInput(resolved);
}
