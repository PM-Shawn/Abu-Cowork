import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserScreenshotSave } from './browserScreenshotSave';
import { revokeWorkspace, createAuthorizationScope, disposeAuthorizationScope, authorizeWorkspace, checkWritePath } from './pathSafety';
import { canonicalizeElectronPathForPolicy } from '@/utils/electronHost';
import type { ToolResult } from '@/types';

const boundary = vi.hoisted(() => ({ invoke: vi.fn(), canonicalPath: '', exists: false,
  ensureParent: async (): Promise<void> => {}, write: async (): Promise<void> => {} }));
vi.mock('@/utils/electronHost', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/electronHost')>(),
  invokeElectronFileOperation: boundary.invoke,
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

const destination = { path: '/app/browser-downloads/task/run/screenshots/one.png', appDataRoot: '/app',
  taskDirectory: '/app/browser-downloads/task/run/screenshots', taskRelativeDirectory: 'browser-downloads/task/run/screenshots' };
const captured: ToolResult = [{ type: 'image', source: { type: 'base64', media_type: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1EAAAAASUVORK5CYII=' } }];

beforeEach(() => {
  vi.mocked(canonicalizeElectronPathForPolicy).mockReset().mockResolvedValue(null);
  boundary.canonicalPath = destination.path;
  boundary.exists = false;
  boundary.ensureParent = async () => {};
  boundary.write = async () => {};
  boundary.invoke.mockReset().mockImplementation(async (action: string, args: Record<string, unknown>) => {
    if (action === 'open') return { session: 'native-session' };
    if (action === 'observe') return { reference: args.path === '/app' ? 'root' : 'target', path: args.path,
      canonicalPath: args.path === '/app' ? '/app' : boundary.canonicalPath,
      exists: args.path === '/app' || boundary.exists, isDirectory: args.path === '/app', isSymlink: false };
    if (action === 'ensure-parent') await boundary.ensureParent();
    if (action === 'write') await boundary.write();
    return undefined;
  });
});

describe('browser screenshot file operation', () => {
  it('writes through the prepared reference and returns localized file information', async () => {
    const save = new BrowserScreenshotSave(destination, { supportsVision: false });
    try {
      await save.prepare();
      expect(save.ownTaskDirectory).toBe(true);
      const authorize = vi.fn(async () => {});
      const result = await save.save(captured, authorize);
      expect(result).toContain(destination.path);
      expect(result).toContain('cannot view images');
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(boundary.invoke).toHaveBeenCalledWith('write', expect.objectContaining({ session: 'native-session', reference: 'target', bytes: expect.any(Array) }));
      await expect(save.save(captured, authorize)).rejects.toThrow('already used');
    } finally { await save.dispose(); }
  });

  it('requires ordinary permission when a task directory resolves outside the app directory', async () => {
    boundary.canonicalPath = '/external/one.png';
    const save = new BrowserScreenshotSave(destination);
    try { await save.prepare(); expect(save.ownTaskDirectory).toBe(false); }
    finally { await save.dispose(); }
  });

  it('refuses a destination occupied after preparation', async () => {
    boundary.exists = true;
    const save = new BrowserScreenshotSave(destination);
    try { await expect(save.prepare()).rejects.toThrow('destination changed'); }
    finally { await save.dispose(); }
    expect(boundary.invoke.mock.calls.some(([action]) => action === 'write')).toBe(false);
  });

  it('releases the native session immediately when stopped during a queued write', async () => {
    const controller = new AbortController();
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    boundary.write = () => { entered(); return new Promise<void>(resolve => { finish = resolve; }); };
    const save = new BrowserScreenshotSave(destination, { abortSignal: controller.signal });
    await save.prepare();
    const writing = save.save(captured, async () => {});
    const rejected = expect(writing).rejects.toThrow('operation has ended');
    await started;
    controller.abort();
    await Promise.resolve();
    expect(boundary.invoke).toHaveBeenCalledWith('release', { session: 'native-session' });
    finish();
    await rejected;
    await save.dispose();
    expect(boundary.invoke.mock.calls.filter(([action]) => action === 'release')).toHaveLength(1);
  });

  it('refuses writes after a folder grant is revoked while parents are prepared', async () => {
    boundary.canonicalPath = '/external/one.png';
    const save = new BrowserScreenshotSave({ ...destination, path: '/external/one.png' });
    try {
      await save.prepare();
      save.watchAuthorization(() => undefined);
      boundary.ensureParent = async () => { revokeWorkspace('/external'); };
      await expect(save.save(captured, async () => {})).rejects.toThrow('operation has ended');
      expect(boundary.invoke.mock.calls.some(([action]) => action === 'write')).toBe(false);
    } finally { await save.dispose(); }
  });

  it('releases file references when the task authorization scope ends', async () => {
    const scope = createAuthorizationScope();
    boundary.canonicalPath = '/external/one.png';
    const save = new BrowserScreenshotSave({ ...destination, path: '/external/one.png' });
    try {
      await save.prepare();
      save.watchAuthorization(() => scope);
      disposeAuthorizationScope(scope);
      await expect(save.save(captured, async () => {})).rejects.toThrow('operation has ended');
    } finally { await save.dispose(); }
  });

  it('releases a queued write when its canonical folder grant is revoked through an alias', async () => {
    vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async path => path === '/alias' ? '/external' : path);
    authorizeWorkspace('/alias');
    expect((await checkWritePath('/external/one.png')).allowed).toBe(true);
    boundary.canonicalPath = '/external/one.png';
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    boundary.write = () => { entered(); return new Promise<void>(resolve => { finish = resolve; }); };
    const save = new BrowserScreenshotSave({ ...destination, path: '/external/one.png' });
    await save.prepare();
    save.watchAuthorization(() => undefined);
    const writing = save.save(captured, async () => {});
    const rejected = expect(writing).rejects.toThrow('operation has ended');
    await started;
    revokeWorkspace('/alias');
    await Promise.resolve();
    expect(boundary.invoke).toHaveBeenCalledWith('release', { session: 'native-session' });
    finish();
    await rejected;
    await save.dispose();
  });
});
