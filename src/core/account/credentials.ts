import { deleteSecret, getSecret, SECRET_KEYS, setSecret } from '@/utils/secretStore';

export type AccountKind = 'personal' | 'enterprise';

export interface AccountCredentials {
  serverUrl: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  kind: AccountKind;
}

export const ACCOUNT_CREDENTIALS_SECRET_KEY = SECRET_KEYS.accountCredentials;

function isCredentials(value: unknown): value is AccountCredentials {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.serverUrl === 'string' && row.serverUrl.length > 0 &&
    typeof row.accessToken === 'string' && row.accessToken.length > 0 &&
    typeof row.refreshToken === 'string' && row.refreshToken.length > 0 &&
    typeof row.userId === 'string' && row.userId.length > 0 &&
    (row.kind === 'personal' || row.kind === 'enterprise')
  );
}

export async function loadAccountCredentials(): Promise<AccountCredentials | null> {
  const stored = await getSecret(ACCOUNT_CREDENTIALS_SECRET_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    return isCredentials(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveAccountCredentials(credentials: AccountCredentials): Promise<void> {
  if (!isCredentials(credentials)) throw new Error('invalid_account_credentials');
  const serialized = JSON.stringify(credentials);
  try {
    await setSecret(ACCOUNT_CREDENTIALS_SECRET_KEY, serialized);
    const confirmed = await getSecret(ACCOUNT_CREDENTIALS_SECRET_KEY);
    if (confirmed !== serialized) throw new Error('account_credentials_not_confirmed');
  } catch (error) {
    // Never leave an unconfirmed credential that could reappear after restart.
    await deleteSecret(ACCOUNT_CREDENTIALS_SECRET_KEY).catch(() => undefined);
    throw error;
  }
}

export async function clearAccountCredentials(): Promise<void> {
  await deleteSecret(ACCOUNT_CREDENTIALS_SECRET_KEY);
  const confirmed = await getSecret(ACCOUNT_CREDENTIALS_SECRET_KEY);
  if (confirmed !== null) throw new Error('account_credentials_delete_not_confirmed');
}
