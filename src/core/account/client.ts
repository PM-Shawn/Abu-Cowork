import { getTauriFetch } from '@/core/llm/tauriFetch';
import type { PkcePair } from '@/core/account/pkce';

const configuredPersonalAccountServer = import.meta.env.VITE_PERSONAL_ACCOUNT_SERVER_URL?.trim();

/**
 * Intentionally empty until the public personal-account service origin is approved.
 * Deployments may provide VITE_PERSONAL_ACCOUNT_SERVER_URL at build time.
 */
export const PERSONAL_ACCOUNT_SERVER_URL = configuredPersonalAccountServer ?? '';

export interface TokenPairResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_idle_expires_at: string;
  refresh_absolute_expires_at: string;
  family_id: string;
}

export interface AccountProfile {
  id: string;
  name: string;
  email: string | null;
}

export class AccountClientError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, status: number | null = null) {
    super(code);
    this.name = 'AccountClientError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeAccountServerUrl(server: string): string {
  const candidate = server.trim();
  if (!candidate) throw new AccountClientError('server_not_configured');

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AccountClientError('invalid_server_url');
  }

  const loopbackHttp = url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new AccountClientError('invalid_server_url');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new AccountClientError('invalid_server_url');
  }
  return url.origin;
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTokenPair(value: unknown): TokenPairResponse {
  if (!value || typeof value !== 'object') throw new AccountClientError('invalid_response');
  const body = value as Record<string, unknown>;
  const accessToken = requiredString(body.access_token);
  const refreshToken = requiredString(body.refresh_token);
  const refreshIdleExpiresAt = requiredString(body.refresh_idle_expires_at);
  const refreshAbsoluteExpiresAt = requiredString(body.refresh_absolute_expires_at);
  const familyId = requiredString(body.family_id);
  if (
    !accessToken ||
    body.token_type !== 'Bearer' ||
    typeof body.expires_in !== 'number' ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    !refreshToken ||
    !refreshIdleExpiresAt ||
    !refreshAbsoluteExpiresAt ||
    !familyId
  ) {
    throw new AccountClientError('invalid_response');
  }
  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: body.expires_in,
    refresh_token: refreshToken,
    refresh_idle_expires_at: refreshIdleExpiresAt,
    refresh_absolute_expires_at: refreshAbsoluteExpiresAt,
    family_id: familyId,
  };
}

function parseAccountProfile(value: unknown): AccountProfile {
  if (!value || typeof value !== 'object') throw new AccountClientError('invalid_response');
  const body = value as Record<string, unknown>;
  const id = requiredString(body.id);
  if (!id || typeof body.name !== 'string' || (body.email !== null && typeof body.email !== 'string')) {
    throw new AccountClientError('invalid_response');
  }
  return { id, name: body.name, email: body.email };
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, string>;
  signal?: AbortSignal;
  accessToken?: string;
}

async function request(
  server: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const { method = 'POST', body, signal, accessToken } = options;
  try {
    const fetchFn = await getTauriFetch();
    return await fetchFn(`${normalizeAccountServerUrl(server)}${path}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new AccountClientError('cancelled');
    if (error instanceof AccountClientError) throw error;
    throw new AccountClientError('network_error');
  }
}

async function parseError(response: Response): Promise<AccountClientError> {
  let code = response.status >= 500 ? 'server_error' : 'request_failed';
  try {
    const value = await response.json() as unknown;
    if (value && typeof value === 'object') {
      const serverCode = requiredString((value as Record<string, unknown>).error);
      if (serverCode && /^[a-z][a-z0-9_]{0,63}$/.test(serverCode)) code = serverCode;
    }
  } catch {
    // The status-derived code is deliberately enough; never echo a response body.
  }
  return new AccountClientError(code, response.status);
}

async function requestTokenPair(
  server: string,
  path: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<TokenPairResponse> {
  const response = await request(server, path, { body, signal });
  if (!response.ok) throw await parseError(response);
  try {
    return parseTokenPair(await response.json() as unknown);
  } catch (error) {
    if (error instanceof AccountClientError) throw error;
    throw new AccountClientError('invalid_response', response.status);
  }
}

export function buildAuthorizeUrl(server: string, pkce: PkcePair): string {
  const url = new URL('/client-login', normalizeAccountServerUrl(server));
  url.searchParams.set('client_id', 'abu-desktop');
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', pkce.state);
  url.searchParams.set('redirect_uri', 'abu://auth');
  return url.toString();
}

export async function exchangeCode(
  server: string,
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<TokenPairResponse> {
  return await requestTokenPair(
    server,
    '/api/client/v1/auth/exchange',
    { code, code_verifier: verifier },
    signal,
  );
}

export async function refresh(
  server: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenPairResponse> {
  return await requestTokenPair(
    server,
    '/api/client/v1/auth/refresh',
    { refresh_token: refreshToken },
    signal,
  );
}

export async function logout(
  server: string,
  accessToken: string,
  refreshToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await request(
    server,
    '/api/client/v1/auth/logout',
    { body: { refresh_token: refreshToken }, signal, accessToken },
  );
  if (!response.ok) throw await parseError(response);
}

export async function fetchAccountProfile(
  server: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<AccountProfile> {
  const response = await request(server, '/api/client/v1/account/profile', {
    method: 'GET',
    signal,
    accessToken,
  });
  if (!response.ok) throw await parseError(response);
  try {
    return parseAccountProfile(await response.json() as unknown);
  } catch (error) {
    if (error instanceof AccountClientError) throw error;
    throw new AccountClientError('invalid_response', response.status);
  }
}

export function userIdFromAccessToken(accessToken: string): string | null {
  // Display metadata only. The server remains the authorization authority;
  // this renderer-side decode never verifies or grants access from the JWT.
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!decoded || typeof decoded !== 'object') return null;
    return requiredString((decoded as Record<string, unknown>).sub);
  } catch {
    return null;
  }
}
