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
  accessToken: string                   // 90d bearer (from device flow)
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
}

export type EnterpriseMode =
  | { kind: 'personal' }                                       // 没绑定，纯个人模式
  | { kind: 'enterprise', binding: EnterpriseBinding, config: EnterpriseConfigSnapshot | null }
  | { kind: 'offline', binding: EnterpriseBinding, lastConfig: EnterpriseConfigSnapshot | null, reason: string }
