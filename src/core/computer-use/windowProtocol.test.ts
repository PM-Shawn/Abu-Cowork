import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { isWindows } from '@/utils/platform';
import {
  captureComputerUseTurnTarget,
  listComputerUseWindows,
  parseComputerUseSessionResponse,
} from '@/core/computer-use/windowProtocol';

vi.mock('@/utils/electronHost', () => ({ hasElectronCommandHost: vi.fn(() => true) }));
vi.mock('@/utils/platform', () => ({ isWindows: vi.fn(() => true) }));

describe('Windows Computer Use window protocol', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(hasElectronCommandHost).mockReturnValue(true);
    vi.mocked(isWindows).mockReturnValue(true);
  });

  it('accepts an authorized Windows session only when it contains an opaque WindowRef', () => {
    expect(parseComputerUseSessionResponse({
      status: 'authorized',
      token: 'session-token',
      target: {
        window_ref: 'wr-opaque',
        app_name: 'Word',
        bundle_id: 'winword.exe',
        process_id: 42,
        relation: 'root',
      },
      classification: 'ordinary',
      expires_at: 1234,
    })).toMatchObject({ status: 'authorized', target: { window_ref: 'wr-opaque' } });

    expect(() => parseComputerUseSessionResponse({
      status: 'authorized',
      token: 'session-token',
      target: {
        window_ref: null,
        app_name: 'Word',
        bundle_id: 'winword.exe',
        process_id: 42,
        relation: 'root',
      },
      classification: 'ordinary',
      expires_at: 1234,
    })).toThrow(/window_ref/);
  });

  it('preserves a structured target error for model recovery', () => {
    expect(parseComputerUseSessionResponse({
      status: 'target-error',
      error: {
        code: 'target-ambiguous',
        recoverable: true,
        next_action: 'select-target',
        candidates: [
          { window_ref: 'wr-a', app_name: 'Word', title: 'One', relation: 'root' },
          { window_ref: 'wr-b', app_name: 'Word', title: 'Two', relation: 'root' },
        ],
      },
    })).toEqual({
      status: 'target-error',
      error: {
        code: 'target-ambiguous',
        recoverable: true,
        next_action: 'select-target',
        candidates: [
          { window_ref: 'wr-a', app_name: 'Word', title: 'One', relation: 'root' },
          { window_ref: 'wr-b', app_name: 'Word', title: 'Two', relation: 'root' },
        ],
      },
    });
  });

  it('captures the foreground-turn target with the exact conversation and loop IDs', async () => {
    vi.mocked(invoke).mockResolvedValue({ captured: true });

    await expect(captureComputerUseTurnTarget('conversation-1', 'run-1'))
      .resolves.toEqual({ captured: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('computer_use_capture_turn_target', {
      conversationId: 'conversation-1',
      loopId: 'run-1',
      interactionMode: 'foreground',
    });
  });

  it('treats turn-target capture as best effort', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('native helper unavailable'));

    await expect(captureComputerUseTurnTarget('conversation-1', 'run-1'))
      .resolves.toEqual({ captured: false });
  });

  it('lists and validates explicit app window candidates without exposing native IDs', async () => {
    vi.mocked(invoke).mockResolvedValue({
      status: 'candidates',
      candidates: [
        { window_ref: 'wr-a', app_name: 'Word', title: 'Document 1', relation: 'root' },
        { window_ref: 'wr-b', app_name: 'Word', title: 'Document 2', relation: 'root' },
      ],
    });

    await expect(listComputerUseWindows('conversation-1', 'run-1', 'Word'))
      .resolves.toMatchObject({ status: 'candidates', candidates: [{ window_ref: 'wr-a' }, { window_ref: 'wr-b' }] });
    expect(invoke).toHaveBeenCalledExactlyOnceWith('computer_use_list_windows', {
      conversationId: 'conversation-1',
      loopId: 'run-1',
      interactionMode: 'foreground',
      app: 'Word',
    });

    vi.mocked(invoke).mockResolvedValue({
      status: 'candidates',
      candidates: [{ window_ref: 'hwnd:0x100', app_name: 'Word', relation: 'root' }],
    });
    await expect(listComputerUseWindows('conversation-1', 'run-1', 'Word'))
      .rejects.toThrow(/candidate/);
  });

  it('keeps the legacy non-Windows target path compatible with a null WindowRef', () => {
    vi.mocked(isWindows).mockReturnValue(false);

    expect(parseComputerUseSessionResponse({
      status: 'authorized',
      token: 'legacy-token',
      target: {
        window_ref: null,
        app_name: 'Notes',
        bundle_id: 'com.apple.Notes',
        process_id: 7,
        relation: 'root',
      },
      classification: 'ordinary',
      expires_at: 1234,
    })).toMatchObject({ status: 'authorized', target: { window_ref: null } });
  });
});
