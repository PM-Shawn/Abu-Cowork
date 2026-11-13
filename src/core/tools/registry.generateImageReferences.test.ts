import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMigratedBrowserSettings } from '@/test/migratedBrowserSettings';
import { useChatStore } from '../../stores/chatStore';
import { canonicalizeElectronPathForPolicy } from '../../utils/electronHost';
import { registerBuiltinTools } from './builtins';
import { checkToolApproval } from './registry';
import { authorizeWorkspace, revokeWorkspace } from './pathSafety';

vi.mock('../../utils/electronHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/electronHost')>()),
  canonicalizeElectronPathForPolicy: vi.fn().mockResolvedValue(null),
}));

// A local reference image is a file read: it must pass the same path, grant and
// scope checks as read_file before its bytes are encoded and uploaded.
describe('generate_image reference images go through the file read check', () => {
  const ws = '/Users/testuser/Projects/image-refs';
  const outside = '/Users/testuser/Private/passport.png';

  beforeEach(() => {
    registerBuiltinTools();
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    setMigratedBrowserSettings({ permissionMode: 'standard' });
    vi.mocked(canonicalizeElectronPathForPolicy).mockImplementation(async (candidate) => String(candidate));
    authorizeWorkspace(ws, ['read', 'write']);
  });

  afterEach(() => {
    revokeWorkspace(ws);
    vi.mocked(canonicalizeElectronPathForPolicy).mockReset().mockResolvedValue(null);
  });

  it('refuses an unauthorised local image without asking when prompts are unavailable', async () => {
    const permission = vi.fn(async () => true);
    const decision = await checkToolApproval(
      'generate_image',
      { prompt: 'restyle', reference_images: [outside], save_path: `${ws}/out.png` },
      { allowPermissionPrompts: false },
      undefined,
      permission,
    );
    expect(decision.decision).toBe('deny');
    expect(permission).not.toHaveBeenCalled();
  });

  it('asks for read permission on the outside image, and refuses when the user declines', async () => {
    const permission = vi.fn(async () => false);
    const decision = await checkToolApproval(
      'generate_image',
      { prompt: 'restyle', reference_images: [`${ws}/ok.png`, outside], save_path: `${ws}/out.png` },
      {},
      undefined,
      permission,
    );
    expect(decision.decision).toBe('deny');
    expect(permission).toHaveBeenCalledTimes(1);
    expect(permission).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('Private'), capability: 'read', toolName: 'generate_image' }),
      undefined,
    );
  });

  it('allows an image inside the authorized workspace without asking', async () => {
    const permission = vi.fn(async () => false);
    const decision = await checkToolApproval(
      'generate_image',
      { prompt: 'restyle', reference_images: [`${ws}/ok.png`], save_path: `${ws}/out.png` },
      {},
      undefined,
      permission,
    );
    expect(decision.decision).toBe('allow');
    expect(permission).not.toHaveBeenCalled();
  });

  it('does not treat URLs or inline data as local files', async () => {
    const permission = vi.fn(async () => false);
    const decision = await checkToolApproval(
      'generate_image',
      { prompt: 'restyle', reference_images: ['https://example.com/a.png', 'data:image/png;base64,AAAA'], save_path: `${ws}/out.png` },
      {},
      undefined,
      permission,
    );
    expect(decision.decision).toBe('allow');
    expect(permission).not.toHaveBeenCalled();
  });

  it('refuses a relative reference path like read_file does', async () => {
    const decision = await checkToolApproval(
      'generate_image',
      { prompt: 'restyle', reference_images: ['photo.png'], save_path: `${ws}/out.png` },
      {},
      undefined,
      vi.fn(async () => true),
    );
    expect(decision.decision).toBe('deny');
  });
});
