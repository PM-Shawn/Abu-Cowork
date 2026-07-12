// src/core/enterprise/types.ts

export interface EnterpriseBinding {
  serverUrl: string                     // e.g. https://abu.acme.com
  orgId: string
  orgName: string
  userId: string
  userName: string
  userEmail: string
  deptId: string | null
  roleId: string | null
  /**
   * Short-lived access token (JWT, 15 min TTL in new bindings).
   * Legacy bindings created before O4 may carry a 90-day opaque token here;
   * those will NOT have a `refreshToken` field and cannot be auto-refreshed.
   */
  accessToken: string
  /**
   * ISO 8601 expiry of the current access token.
   * Absent in legacy (pre-O4) bindings — those are tolerated but cannot be proactively refreshed.
   */
  accessExpiresAt?: string
  /**
   * Opaque refresh token (rotation-based, 14-day idle / 90-day absolute TTL).
   * Absent in legacy (pre-O4) bindings created with the old 90-day single-token flow.
   * When absent: auto-refresh is disabled; the binding is used as-is until it naturally expires.
   */
  refreshToken?: string
  boundAt: string                       // ISO 8601
  // === Plan 2.C: LLM gateway ===
  llmEndpoint: string | null            // e.g. 'https://abu.acme.com/litellm'
  llmVirtualKey: string | null          // raw virtual key, only persisted client-side
  llmKeyExpiresAt: string | null        // ISO 8601
}

export interface EnterpriseBrand {
  name: string
  logoUrl: string | null
  primaryColor: string | null
}

export interface EnterpriseConfigSnapshot {
  brand: EnterpriseBrand
  defaultSoul: string | null            // recommended; not enforced in V1
  policyDefaults: Record<string, unknown>
  modules: string[]                     // ['core'] in V1; ['core','kb','agent-market'] later
  licenseStatus: 'valid' | 'expired' | 'missing' | 'invalid_signature' | 'malformed'
  serverTime: string
  fetchedAt: number                     // local ms timestamp for freshness checks
  /** ETag / configVersion value from GET /session; used as If-None-Match on the next poll. */
  configVersion?: string
  /** policy.telemetryEnabled from GET /session; controls whether telemetry is sent to the instance. */
  telemetryEnabled?: boolean
}

export type EnterpriseMode =
  | { kind: 'personal' }                                       // 没绑定，纯个人模式
  | { kind: 'enterprise', binding: EnterpriseBinding, config: EnterpriseConfigSnapshot | null }
  | { kind: 'offline', binding: EnterpriseBinding, lastConfig: EnterpriseConfigSnapshot | null, reason: string }
