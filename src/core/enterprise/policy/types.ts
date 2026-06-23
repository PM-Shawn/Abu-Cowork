// src/core/enterprise/policy/types.ts
// Client-side mirror of the effective policy snapshot returned by heartbeat.

export interface EffectivePolicy {
  toolBlacklist: Array<{ tool: string; inputPattern?: string }>
  toolRequireConfirmation: Array<{ tool: string; inputPattern?: string; reason?: string }>
  skillBlacklist: string[]
  mcpBlacklist: string[]
  filePathAllowlist: string[]
  filePathBlocklist: string[]
}
