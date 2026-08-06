import { create } from 'zustand'
import type {
  EnterpriseBinding,
  EnterpriseConfigSnapshot,
  EnterpriseMode,
} from '@/core/enterprise/types'

type EnterpriseStore = {
  mode: EnterpriseMode
  initialized: boolean
  init: () => Promise<void>
  bind: (binding: EnterpriseBinding) => Promise<void>
  updateBinding: (patch: Partial<EnterpriseBinding>) => Promise<void>
  unbind: () => Promise<void>
  setConfig: (config: EnterpriseConfigSnapshot) => void
  setOffline: (reason: string) => void
}

/**
 * OSS placeholder for the private client module. It deliberately exposes only
 * personal-mode defaults so public builds can compile the shared host without
 * shipping any enterprise implementation.
 */
export const useEnterpriseStore = create<EnterpriseStore>((set) => ({
  mode: { kind: 'personal' },
  initialized: true,
  async init() {},
  async bind() {},
  async updateBinding() {},
  async unbind() { set({ mode: { kind: 'personal' } }) },
  setConfig() {},
  setOffline() {},
}))

export async function initEnterpriseModules(): Promise<void> {}
export async function activateEnterpriseRuntime(): Promise<void> {}

export function isEnterprise(): boolean { return false }
export function getBinding(): EnterpriseBinding | null { return null }

export interface ResolvedEnterpriseLlm {
  baseUrl: string
  apiKey: string
}

export class EnterpriseLlmUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnterpriseLlmUnavailableError'
  }
}

export function resolveEnterpriseLlm(): ResolvedEnterpriseLlm | null { return null }
export function isEnterpriseLlmEnforced(): boolean { return false }
export function canCallEnterpriseLlm(): boolean { return false }

/** Mirror of the enterprise resolver's trace metadata (never produced in OSS). */
export interface EnterpriseTraceMetadata {
  trace_user_id: string
  abu_org_id: string
  abu_dept_id?: string
  provider_kind: 'enterprise-gateway'
  provider_id: string
  [key: string]: string | undefined
}

export function getEnterpriseTraceMetadata(): EnterpriseTraceMetadata | null { return null }

export function resolveEffectiveLlmCreds(
  personalApiKey: string,
  personalBaseUrl: string | undefined,
): { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean; traceMetadata?: EnterpriseTraceMetadata } {
  return {
    apiKey: personalApiKey,
    baseUrl: personalBaseUrl,
    forceOpenAiCompatible: false,
  }
}

export type ClientEnterpriseModule = 'skills' | 'mcp' | 'kb'
export interface EnterpriseEntitlementSnapshot {
  mode: 'personal' | 'enterprise' | 'offline'
  licenseStatus: string | null
  licenseExpiresAt: string | null
  modules: string[]
}

export const FAIL_CLOSED_ENTERPRISE_ENTITLEMENT: EnterpriseEntitlementSnapshot = {
  mode: 'personal',
  licenseStatus: null,
  licenseExpiresAt: null,
  modules: [],
}

export function snapshotEnterpriseEntitlement(_mode: EnterpriseMode): EnterpriseEntitlementSnapshot {
  return FAIL_CLOSED_ENTERPRISE_ENTITLEMENT
}

export function isEnterpriseEntitlementActive(
  _snapshot: EnterpriseEntitlementSnapshot,
  _module: ClientEnterpriseModule,
  _now?: number,
): boolean { return false }
export function isEnterpriseModuleActive(_module: ClientEnterpriseModule): boolean { return false }
export function useEnterpriseModuleActive(_module: ClientEnterpriseModule): boolean { return false }

export interface ToolCheckResult {
  decision: 'allow' | 'deny' | 'confirm'
  reason?: string
}

const ALLOW: ToolCheckResult = { decision: 'allow' }
export function getCurrentPolicy(): null { return null }
export function checkTool(_policy: unknown, _tool: string, _inputSummary: string): ToolCheckResult { return ALLOW }
export function checkSkill(_policy: unknown, _skillName: string): ToolCheckResult { return ALLOW }
export function checkMcp(_policy: unknown, _registryId: string): ToolCheckResult { return ALLOW }
export function checkFilePath(_policy: unknown, _path: string): ToolCheckResult { return ALLOW }
export function showPolicyConfirm(_message: string): Promise<boolean> { return Promise.resolve(true) }

export function useEnterpriseModels(): string[] | null { return null }
export interface PendingEnroll {
  serverUrl: string
  enrollmentToken?: string
}

export function useDeepLinkEnroll(): {
  pendingEnroll: PendingEnroll | null
  dismissEnroll: () => void
} {
  return { pendingEnroll: null, dismissEnroll() {} }
}

export function BindToEnterpriseFlow(_props: {
  onDone: () => void
  onCancel: () => void
  initialServerUrl?: string
}): null { return null }
export function PolicyConfirmModal(): null { return null }
export function EnterpriseLlmBadge(): null { return null }
