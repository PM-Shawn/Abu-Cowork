import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTauriFetch } from '@/core/llm/tauriFetch';
import {
  AccountClientError,
  buildAuthorizeUrl,
  exchangeCode,
  fetchAccountProfile,
  logout,
  refresh,
  userIdFromAccessToken,
} from '@/core/account/client';

vi.mock('@/core/llm/tauriFetch', () => ({ getTauriFetch: vi.fn() }));

const TOKEN_PAIR = {
  access_token: 'header.eyJzdWIiOiJ1c2VyLTEifQ.signature',
  token_type: 'Bearer',
  expires_in: 900,
  refresh_token: 'refresh-secret',
  refresh_idle_expires_at: '2026-09-28T00:00:00Z',
  refresh_absolute_expires_at: '2026-12-13T00:00:00Z',
  family_id: 'family-1',
} as const;

describe('account client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.mocked(getTauriFetch).mockResolvedValue(fetchMock);
  });

  it('builds the fixed desktop PKCE authorize URL', () => {
    const value = buildAuthorizeUrl('https://accounts.example.com/', {
      verifier: 'verifier',
      challenge: 'challenge',
      state: 'state',
    });
    const url = new URL(value);
    expect(url.origin + url.pathname).toBe('https://accounts.example.com/client-login');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'abu-desktop',
      code_challenge: 'challenge',
      code_challenge_method: 'S256',
      state: 'state',
      redirect_uri: 'abu://auth',
    });
  });

  it('refuses an insecure non-loopback account server', () => {
    expect(() => buildAuthorizeUrl('http://accounts.example.com', {
      verifier: 'v', challenge: 'c', state: 's',
    })).toThrowError(expect.objectContaining({ code: 'invalid_server_url' }));
  });

  it('exchanges only the code and verifier and accepts future response fields', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...TOKEN_PAIR, future: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(exchangeCode('https://accounts.example.com', 'one-time-code', 'verifier')).resolves.toEqual(TOKEN_PAIR);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://accounts.example.com/api/client/v1/auth/exchange');
    expect(JSON.parse(String(init?.body))).toEqual({ code: 'one-time-code', code_verifier: 'verifier' });
  });

  it('returns a classified error without copying secrets or server prose', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_verifier',
      message: 'one-time-code verifier-secret state-secret',
    }), { status: 401 }));
    const failure = await exchangeCode(
      'https://accounts.example.com',
      'one-time-code',
      'verifier-secret',
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccountClientError);
    expect(failure).toMatchObject({ code: 'invalid_verifier', status: 401 });
    expect(String(failure)).not.toContain('one-time-code');
    expect(String(failure)).not.toContain('verifier-secret');
    expect(String(failure)).not.toContain('state-secret');
  });

  it('does not surface an untrusted server error string', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: 'one-time-code: attacker prose',
    }), { status: 400 }));
    const failure = await exchangeCode(
      'https://accounts.example.com',
      'one-time-code',
      'verifier-secret',
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'request_failed', status: 400 });
    expect(String(failure)).not.toContain('one-time-code');
  });

  it('rotates a refresh token and sends logout authentication', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(TOKEN_PAIR), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(refresh('https://accounts.example.com', 'old-refresh')).resolves.toEqual(TOKEN_PAIR);
    await expect(logout('https://accounts.example.com', 'access-secret', 'refresh-secret')).resolves.toBeUndefined();
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ refresh_token: 'old-refresh' });
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ authorization: 'Bearer access-secret' });
  });

  it('loads only the authenticated profile contract with a GET request', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      id: 'user-1',
      name: 'Ada',
      email: 'ada@example.com',
      future: 'ignored',
    }), { status: 200 }));

    await expect(fetchAccountProfile(
      'https://accounts.example.com',
      'access-secret',
    )).resolves.toEqual({ id: 'user-1', name: 'Ada', email: 'ada@example.com' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://accounts.example.com/api/client/v1/account/profile');
    expect(init).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer access-secret' },
    });
    expect(init?.body).toBeUndefined();
  });

  it.each([
    { name: 'Ada', email: null },
    { id: 'user-1', email: null },
    { id: 'user-1', name: 'Ada', email: 42 },
  ])('rejects an invalid profile response: %j', async (body) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    await expect(fetchAccountProfile(
      'https://accounts.example.com',
      'access-secret',
    )).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('derives sub for local display without treating malformed tokens as identity', () => {
    expect(userIdFromAccessToken(TOKEN_PAIR.access_token)).toBe('user-1');
    expect(userIdFromAccessToken('opaque-token')).toBeNull();
  });
});
