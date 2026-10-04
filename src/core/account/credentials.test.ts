import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSecret, getSecret, setSecret } from '@/utils/secretStore';
import {
  ACCOUNT_CREDENTIALS_SECRET_KEY,
  clearAccountCredentials,
  loadAccountCredentials,
  saveAccountCredentials,
} from '@/core/account/credentials';

vi.mock('@/utils/secretStore', async () => {
  const actual = await vi.importActual<typeof import('@/utils/secretStore')>('@/utils/secretStore');
  return { ...actual, deleteSecret: vi.fn(), getSecret: vi.fn(), setSecret: vi.fn() };
});

const CREDENTIALS = {
  serverUrl: 'https://accounts.example.com',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  userId: 'user-1',
  kind: 'personal',
} as const;

describe('account credentials', () => {
  beforeEach(() => {
    vi.mocked(deleteSecret).mockReset();
    vi.mocked(deleteSecret).mockResolvedValue(undefined);
    vi.mocked(getSecret).mockReset();
    vi.mocked(getSecret).mockResolvedValue(null);
    vi.mocked(setSecret).mockReset();
    vi.mocked(setSecret).mockResolvedValue(undefined);
  });

  it('stores the complete credential only through the existing secret IPC wrapper', async () => {
    vi.mocked(getSecret).mockResolvedValue(JSON.stringify(CREDENTIALS));
    await saveAccountCredentials(CREDENTIALS);
    expect(setSecret).toHaveBeenCalledWith(ACCOUNT_CREDENTIALS_SECRET_KEY, JSON.stringify(CREDENTIALS));
    expect(getSecret).toHaveBeenCalledWith(ACCOUNT_CREDENTIALS_SECRET_KEY);
  });

  it('loads a valid secret and rejects malformed plaintext', async () => {
    vi.mocked(getSecret)
      .mockResolvedValueOnce(JSON.stringify(CREDENTIALS))
      .mockResolvedValueOnce('{"accessToken":"partial"}');
    await expect(loadAccountCredentials()).resolves.toEqual(CREDENTIALS);
    await expect(loadAccountCredentials()).resolves.toBeNull();
  });

  it('removes an unconfirmed write before reporting failure', async () => {
    vi.mocked(getSecret).mockResolvedValue(null);
    await expect(saveAccountCredentials(CREDENTIALS)).rejects.toThrow('account_credentials_not_confirmed');
    expect(deleteSecret).toHaveBeenCalledWith(ACCOUNT_CREDENTIALS_SECRET_KEY);
  });

  it('deletes the account secret through the existing channel', async () => {
    await clearAccountCredentials();
    expect(deleteSecret).toHaveBeenCalledWith(ACCOUNT_CREDENTIALS_SECRET_KEY);
    expect(getSecret).toHaveBeenCalledWith(ACCOUNT_CREDENTIALS_SECRET_KEY);
  });
});
