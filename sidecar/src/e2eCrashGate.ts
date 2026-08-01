const E2E_SIDECAR_CRASH_TOKEN_ENV = 'ABU_E2E_SIDECAR_CRASH_TOKEN';

export function isAuthorizedE2ECrash(
  params: unknown,
  expectedToken = process.env[E2E_SIDECAR_CRASH_TOKEN_ENV],
): boolean {
  if (!expectedToken || typeof expectedToken !== 'string') return false;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return false;
  return (params as { token?: unknown }).token === expectedToken;
}
