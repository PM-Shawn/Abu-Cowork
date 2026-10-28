import type { ToolExecutionContext, ToolResult } from '@/types';
import { mcpManager } from '@/core/mcp/client';
import { FileOperationHost, type ObservedFileTarget } from '@/core/tools/fileOperationHost';
import { FileOperationDenied, type FileOperationTarget } from '@/core/tools/fileOperation';
import { base64ToUint8Array } from '@/utils/base64';
import { isLocalFilePath, joinPath, normalizeLexicalPath } from '@/utils/pathUtils';
import { format, getI18n } from '@/i18n';
import { onFileAuthorizationRevoked } from '@/core/tools/pathSafety';
import { isWindows } from '@/utils/platform';

interface ScreenshotDestination {
  path: string;
  appDataRoot: string;
  taskDirectory: string;
  taskRelativeDirectory: string;
}

export function savesBrowserScreenshot(name: string, input: Record<string, unknown>, context?: ToolExecutionContext): boolean {
  return (name === 'abu-browser__screenshot' || name === 'abu-browser__screenshot_full_page')
    && (input.saveToFile === true || input.savePath !== undefined || context?.supportsVision === false);
}

export async function prepareBrowserScreenshotDestination(
  name: string, input: Record<string, unknown>, context?: ToolExecutionContext,
): Promise<BrowserScreenshotSave> {
  const result = await mcpManager.callTool('abu-browser', name.slice('abu-browser__'.length), input, {
    conversationId: context?.conversationId, agentRunId: context?.agentRunId,
    signal: context?.abortSignal, screenshotDelivery: 'prepare',
  });
  if (typeof result !== 'string' || !result.startsWith('{')) {
    throw new FileOperationDenied('Error: screenshot destination could not be prepared');
  }
  const value: unknown = JSON.parse(result);
  if (!value || typeof value !== 'object') throw new FileOperationDenied('Error: invalid screenshot destination');
  const candidate = value as Record<string, unknown>;
  for (const key of ['path', 'appDataRoot', 'taskDirectory', 'taskRelativeDirectory']) {
    if (typeof candidate[key] !== 'string' || !candidate[key]) {
      throw new FileOperationDenied('Error: invalid screenshot destination');
    }
  }
  const destination = candidate as unknown as ScreenshotDestination;
  if (![destination.path, destination.appDataRoot, destination.taskDirectory].every(isLocalFilePath)
    || normalizeLexicalPath(joinPath(destination.appDataRoot, destination.taskRelativeDirectory))
      !== normalizeLexicalPath(destination.taskDirectory)) {
    throw new FileOperationDenied('Error: invalid screenshot destination');
  }
  return new BrowserScreenshotSave(destination, context);
}

function inside(path: string, directory: string): boolean {
  return normalizeLexicalPath(path).startsWith(`${normalizeLexicalPath(directory)}/`);
}

/** Owns the native references from authorization through exclusive creation. */
export class BrowserScreenshotSave {
  readonly target: FileOperationTarget;
  readonly root: FileOperationTarget;
  private readonly host: FileOperationHost;
  private readonly destination: ScreenshotDestination;
  private readonly context: ToolExecutionContext | undefined;
  private observed: ObservedFileTarget | undefined;
  private observedRoot: ObservedFileTarget | undefined;
  private used = false;
  private invalidated = false;
  private releasePromise: Promise<void> | undefined;
  private readonly unsubscribers: Array<() => void> = [];
  ownTaskDirectory = false;

  constructor(destination: ScreenshotDestination, context?: ToolExecutionContext) {
    this.destination = destination;
    this.context = context;
    this.target = { inputPath: destination.path, path: destination.path, purpose: 'write', followFinalSymlink: false };
    this.root = { inputPath: destination.appDataRoot, path: destination.appDataRoot, purpose: 'list', followFinalSymlink: true };
    this.host = new FileOperationHost([this.target, this.root]);
    context?.abortSignal?.addEventListener('abort', this.invalidate, { once: true });
    this.unsubscribers.push(() => context?.abortSignal?.removeEventListener('abort', this.invalidate));
    if (context?.operationOwner?.onInvalidated) this.unsubscribers.push(context.operationOwner.onInvalidated(this.invalidate));
  }

  private readonly invalidate = (): void => {
    this.invalidated = true;
    this.releasePromise ??= this.host.release();
  };

  watchAuthorization(getScopeId: () => string | undefined): void {
    this.unsubscribers.push(onFileAuthorizationRevoked(event => {
      if (this.ownTaskDirectory || event.scopeId !== getScopeId()) return;
      const normalize = (path: string) => isWindows() ? normalizeLexicalPath(path).toLowerCase() : normalizeLexicalPath(path);
      const revoked = [event.path, event.canonicalPath].filter((path): path is string => path !== undefined).map(normalize);
      if (revoked.length === 0 || [this.target.path, this.observed?.canonicalPath].some(path => path !== undefined
        && revoked.some(root => normalize(path) === root || inside(normalize(path), root)))) this.invalidate();
    }));
  }

  compareComponent(pathKind: 'lexical' | 'canonical', component: number, pattern: string): Promise<'match' | 'no-match' | 'unknown'> {
    if (!this.observed) throw new FileOperationDenied('Error: screenshot destination is unprepared');
    return this.host.compareComponent(this.observed.reference, pathKind, component, pattern);
  }

  assertActive(): void {
    if (this.invalidated || this.context?.abortSignal?.aborted || this.context?.operationOwner?.isCurrent() === false) {
      throw new FileOperationDenied('Error: screenshot operation has ended');
    }
  }

  async prepare(): Promise<void> {
    this.assertActive();
    this.observedRoot = await this.host.observe(this.root);
    this.observed = await this.host.observe(this.target);
    this.assertActive();
    if (!this.observedRoot.isDirectory || this.observed.exists || this.observed.isSymlink) {
      throw new FileOperationDenied('Error: screenshot destination changed; request a new filename');
    }
    this.ownTaskDirectory = inside(this.target.path, this.destination.taskDirectory)
      && inside(this.observed.canonicalPath, joinPath(this.observedRoot.canonicalPath, this.destination.taskRelativeDirectory));
  }

  async assertCurrent(): Promise<ObservedFileTarget> {
    this.assertActive();
    if (!this.observed || !this.observedRoot) throw new FileOperationDenied('Error: screenshot destination is unprepared');
    await this.host.validate(this.observedRoot.reference);
    await this.host.validate(this.observed.reference);
    this.assertActive();
    return this.observed;
  }

  async save(result: ToolResult, authorize: (target: ObservedFileTarget) => Promise<void>): Promise<ToolResult> {
    if (this.used) throw new FileOperationDenied('Error: screenshot destination was already used');
    const image = Array.isArray(result) ? result.find(block => block.type === 'image') : undefined;
    if (!image || image.type !== 'image' || image.source.media_type !== 'image/png') {
      throw new FileOperationDenied('Error: browser returned no PNG screenshot');
    }
    const observed = await this.assertCurrent();
    await authorize(observed);
    await this.assertCurrent();
    const bytes = base64ToUint8Array(image.source.data);
    if (!bytes.length) throw new FileOperationDenied('Error: browser returned an empty screenshot');
    this.used = true;
    await this.host.ensureParent(observed.reference);
    await authorize(observed);
    this.assertActive();
    await this.host.write(observed.reference, bytes);
    this.assertActive();
    const t = getI18n().toolResult;
    return format(t.browserScreenshotSaved, { path: observed.canonicalPath, bytes: bytes.length })
      + (this.context?.supportsVision === false ? ` ${t.browserScreenshotNoVision}` : '');
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    this.releasePromise ??= this.host.release();
    await this.releasePromise;
  }
}
