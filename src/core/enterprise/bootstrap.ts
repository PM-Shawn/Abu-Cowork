// src/core/enterprise/bootstrap.ts
// Unauthenticated bootstrap fetch — GET /api/client/v1/bootstrap
// Defines BootstrapDTO and fetchBootstrap; types are local to avoid conflicts with types.ts.

// ---- Types ----------------------------------------------------------------

export interface BootstrapBranding {
  name: string
  logoUrl: string | null
  primaryColor: string | null
}

export interface BootstrapSso {
  provider: string        // 'feishu' | 'dingtalk' | 'azure' | 'keycloak' | 'okta' | 'generic'
  buttonLabel: string
}

export interface BootstrapAuth {
  methods: string[]       // 'password' | 'magic_link' | 'sso'
  sso?: BootstrapSso      // present only when methods includes 'sso'
}

export interface BootstrapRegistration {
  mode: string            // 'invite' | 'domain' | 'open_approval'
  domainAllowlist: string[]
}

/** Response shape for GET /api/client/v1/bootstrap (§5 of SDK_SPEC). */
export interface BootstrapDTO {
  instanceName: string
  branding: BootstrapBranding
  auth: BootstrapAuth
  registration: BootstrapRegistration
  minClientVersion: string
  configVersion: string
}

// ---- Error ----------------------------------------------------------------

/** Thrown when the bootstrap endpoint returns a non-2xx status. */
export class EnterpriseBootstrapError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`Bootstrap failed with HTTP ${status}`)
    this.name = 'EnterpriseBootstrapError'
    this.status = status
    this.body = body
  }
}

// ---- Fetch ----------------------------------------------------------------

/**
 * Fetch the bootstrap configuration from an enterprise server.
 * No authentication required — this is the discovery endpoint (§5).
 *
 * @param serverUrl  Base URL of the enterprise console, e.g. "https://abu.acme.com"
 * @throws {EnterpriseBootstrapError}  On non-2xx HTTP response.
 * @throws {TypeError}                 On network-level failure.
 */
export async function fetchBootstrap(serverUrl: string): Promise<BootstrapDTO> {
  const base = serverUrl.replace(/\/$/, '')
  const res = await fetch(`${base}/api/client/v1/bootstrap`)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new EnterpriseBootstrapError(res.status, body)
  }
  return body as BootstrapDTO
}
