/**
 * Compile-time guard on every sidecar shim's public surface.
 *
 * `scripts/build-sidecar.mjs` swaps 42 `src/**` modules and 4 bare
 * `@tauri-apps/*` specifiers for the files in this directory at esbuild
 * RESOLVE time. TypeScript knows nothing about that swap — `tsconfig.
 * sidecar.json` has no matching `paths` entries — so every caller is
 * type-checked against the REAL module while the SHIM is what actually runs.
 * Nothing compared the two surfaces, and JS silently discards extra
 * arguments, so a shim that declared fewer parameters than the real export
 * dropped them at runtime with no error anywhere. That is exactly how
 * `pluginFsRun.ts`'s `writeTextFile(path, data)` swallowed
 * `{ createNew, create: false, append }` for months (PR #479).
 *
 * This file makes that a compile error. For every export present in BOTH a
 * shim and its real module it requires:
 *   - every call the REAL signature permits to be accepted by the shim
 *     (`Parameters<real>` assignable to `Parameters<shim>`), and
 *   - everything the shim RETURNS to be usable where the real return type is
 *     expected (`ReturnType<shim>` assignable to `ReturnType<real>`) — the
 *     mirror-image defect, where a caller reads a field the shim never
 *     produced and gets `undefined`.
 *
 * Enforced by `npm run typecheck:sidecar` (`tsconfig.sidecar.json` includes
 * `sidecar/src/` recursively), which `npm run verify` and CI already run. It
 * is deliberately NOT in `build-sidecar.mjs`: esbuild strips types, so a
 * build-time version would mean a second TypeScript pipeline, and
 * `build:sidecar` is not part of `verify`.
 *
 * Type-only — every import here is `import type`, so nothing is emitted and
 * `main.ts` never reaches this file; it stays out of the bundle.
 *
 * ── Why tuples, not plain function assignability ──────────────────────────
 * TypeScript's function assignability accepts a function with FEWER
 * parameters: `(p: string) => void` IS assignable to
 * `(p: string, o?: X) => void`. Comparing `Parameters<>` TUPLES does not — a
 * 3-long source tuple is not assignable to a fixed 2-long target. Verified
 * against the real defect: the tuple form flags `writeTextFile` on the
 * pre-#479 shim, the plain form does not.
 *
 * ── Reading a failure ─────────────────────────────────────────────────────
 * `Type '"writeTextFile"' does not satisfy the constraint 'never'` — the
 * quoted string is the offending EXPORT, the line names the shim. Fix the
 * shim to accept what the real signature permits (honor the option, or
 * accept it and throw — see `pluginFsRun.ts`'s "Options handling"). Add to a
 * pair's `Allow` slot only when the narrowing is genuinely impossible to
 * honor, with a comment saying why. That slot is empty today, on purpose.
 *
 * ── Adding a shim ─────────────────────────────────────────────────────────
 * Add the `import type` pair and both assertions below. You cannot forget:
 * `shimSurfaceCoverage.test.ts` fails if this file's import list and
 * `build-sidecar.mjs`'s shim map disagree.
 */
import type * as realLogger from '@/core/logging/logger';
import type * as shimLogger from './logger';
import type * as realTaskCommandInvokeRun from '@/core/tools/helpers/taskCommandInvoke';
import type * as shimTaskCommandInvokeRun from './taskCommandInvokeRun';
import type * as realCompatEvents from '@/core/observability/compatEvents';
import type * as shimCompatEvents from './compatEvents';
import type * as realTauriFetch from '@/core/llm/tauriFetch';
import type * as shimTauriFetch from './tauriFetch';
import type * as realI18nRun from '@/i18n/index';
import type * as shimI18nRun from './i18nRun';
import type * as realEnterpriseCredsRun from '@/core/enterprise/llm-resolver';
import type * as shimEnterpriseCredsRun from './enterpriseCredsRun';
import type * as realEnterpriseEntitlementRun from '@/core/enterprise/entitlement';
import type * as shimEnterpriseEntitlementRun from './enterpriseEntitlementRun';
import type * as realSelectChatAdapterRun from '@/core/llm/selectChatAdapter';
import type * as shimSelectChatAdapterRun from './selectChatAdapterRun';
import type * as realLifecycleHooksRun from '@/core/agent/lifecycleHooks';
import type * as shimLifecycleHooksRun from './lifecycleHooksRun';
import type * as realLangfuseRun from '@/core/observability/langfuse';
import type * as shimLangfuseRun from './langfuseRun';
import type * as realMemdirScan from '@/core/memdir/scan';
import type * as shimMemdirScan from './memdirScan';
import type * as realSettingsReaderRun from '@/core/agent/ports/settingsReader';
import type * as shimSettingsReaderRun from './settingsReaderRun';
import type * as realToolInvokerRun from '@/core/agent/ports/toolInvoker';
import type * as shimToolInvokerRun from './toolInvokerRun';
import type * as realCapsPortRun from '@/core/agent/ports/capsPort';
import type * as shimCapsPortRun from './capsPortRun';
import type * as realWorkspaceReaderRun from '@/core/agent/ports/workspaceReader';
import type * as shimWorkspaceReaderRun from './workspaceReaderRun';
import type * as realChatDeltaRun from '@/core/agent/ports/chatDelta';
import type * as shimChatDeltaRun from './chatDeltaRun';
import type * as realConversationReaderRun from '@/core/agent/ports/conversationReader';
import type * as shimConversationReaderRun from './conversationReaderRun';
import type * as realExecutionPortRun from '@/core/agent/ports/executionPort';
import type * as shimExecutionPortRun from './executionPortRun';
import type * as realAbortRegistryRun from '@/core/agent/ports/abortRegistry';
import type * as shimAbortRegistryRun from './abortRegistryRun';
import type * as realScratchpadPortRun from '@/core/agent/ports/scratchpadPort';
import type * as shimScratchpadPortRun from './scratchpadPortRun';
import type * as realOrchestratorRun from '@/core/agent/orchestrator';
import type * as shimOrchestratorRun from './orchestratorRun';
import type * as realEntryOrchestrationRun from '@/core/agent/entryOrchestration';
import type * as shimEntryOrchestrationRun from './entryOrchestrationRun';
import type * as realPlatformRun from '@/utils/platform';
import type * as shimPlatformRun from './platformRun';
import type * as realNotificationsRun from '@/utils/notifications';
import type * as shimNotificationsRun from './notificationsRun';
import type * as realPermissionBridgeRun from '@/core/agent/permissionBridge';
import type * as shimPermissionBridgeRun from './permissionBridgeRun';
import type * as realComputerUseStatusRun from '@/core/agent/computerUseStatus';
import type * as shimComputerUseStatusRun from './computerUseStatusRun';
import type * as realBuiltinsRun from '@/core/tools/builtins';
import type * as shimBuiltinsRun from './builtinsRun';
import type * as realConversationStorageRun from '@/core/session/conversationStorage';
import type * as shimConversationStorageRun from './conversationStorageRun';
import type * as realSubagentRunnerRun from '@/core/agent/subagentRunner';
import type * as shimSubagentRunnerRun from './subagentRunnerRun';
import type * as realMemdirExtractorRun from '@/core/memdir/extractor';
import type * as shimMemdirExtractorRun from './memdirExtractorRun';
import type * as realMemdirPaths from '@/core/memdir/paths';
import type * as shimMemdirPaths from './memdirPaths';
import type * as realUsageTrackerRun from '@/core/llm/usageTracker';
import type * as shimUsageTrackerRun from './usageTrackerRun';
import type * as realComputerToolsAxRun from '@/core/tools/definitions/computerTools';
import type * as shimComputerToolsAxRun from './computerToolsAxRun';
import type * as realConsoleTelemetryTargetRun from '@/utils/consoleTelemetryTarget';
import type * as shimConsoleTelemetryTargetRun from './consoleTelemetryTargetRun';
import type * as realSessionDirRun from '@/core/session/sessionDir';
import type * as shimSessionDirRun from './sessionDirRun';
import type * as realDelegatedMediaStoreRun from '@/core/subagent/delegatedMediaStore';
import type * as shimDelegatedMediaStoreRun from './delegatedMediaStoreRun';
import type * as realUserInputQueueRun from '@/core/agent/userInputQueue';
import type * as shimUserInputQueueRun from './userInputQueueRun';
import type * as realFsBridgeRun from '@/core/tools/fsBridge';
import type * as shimFsBridgeRun from './fsBridgeRun';
import type * as realDefaultWorkspaceRun from '@/core/agent/defaultWorkspace';
import type * as shimDefaultWorkspaceRun from './defaultWorkspaceRun';
import type * as realAiEditSnapshotsRun from '@/utils/aiEditSnapshots';
import type * as shimAiEditSnapshotsRun from './aiEditSnapshotsRun';
import type * as realAuthorizedPathsReaderRun from '@/core/agent/ports/authorizedPathsReader';
import type * as shimAuthorizedPathsReaderRun from './authorizedPathsReaderRun';
import type * as realSandboxRecoveryRun from '@/core/sandbox/recovery';
import type * as shimSandboxRecoveryRun from './sandboxRecoveryRun';
import type * as realTauriCoreInvokeRun from '@tauri-apps/api/core';
import type * as shimTauriCoreInvokeRun from './tauriCoreInvokeRun';
import type * as realPluginFsRun from '@tauri-apps/plugin-fs';
import type * as shimPluginFsRun from './pluginFsRun';
import type * as realTauriPathRun from '@tauri-apps/api/path';
import type * as shimTauriPathRun from './tauriPathRun';
import type * as realPluginOsRun from '@tauri-apps/plugin-os';
import type * as shimPluginOsRun from './pluginOsRun';


/** Any function, for `extends` tests — `never[]` keeps the check bivariance-free. */
type AnyFn = (...args: never[]) => unknown;

/**
 * Union of the export names whose SHIM refuses a call the REAL signature
 * permits — a dropped trailing parameter, or a narrowed parameter type.
 * `never` when the shim's surface is a faithful superset.
 */
type ParamDrift<Real, Shim, Allow extends string = never> = Exclude<{
  [K in Extract<keyof Shim, keyof Real>]-?: Real[K] extends AnyFn
    ? Shim[K] extends AnyFn
      ? Parameters<Real[K]> extends Parameters<Shim[K]> ? never : K
      : never
    : never;
}[Extract<keyof Shim, keyof Real>], Allow>;

/**
 * Union of the export names whose SHIM returns something narrower than the
 * real export's return type — a caller reading a field the shim never
 * produces compiles fine and gets `undefined` at runtime.
 */
type ReturnDrift<Real, Shim, Allow extends string = never> = Exclude<{
  [K in Extract<keyof Shim, keyof Real>]-?: Real[K] extends AnyFn
    ? Shim[K] extends AnyFn
      ? ReturnType<Shim[K]> extends ReturnType<Real[K]> ? never : K
      : never
    : never;
}[Extract<keyof Shim, keyof Real>], Allow>;

/** Fails to compile, naming the offending export, unless `T` is `never`. */
type NoDrift<T extends never> = T;

export type LoggerParams = NoDrift<ParamDrift<typeof realLogger, typeof shimLogger>>;
export type LoggerReturns = NoDrift<ReturnDrift<typeof realLogger, typeof shimLogger>>;

export type TaskCommandInvokeRunParams = NoDrift<ParamDrift<typeof realTaskCommandInvokeRun, typeof shimTaskCommandInvokeRun>>;
export type TaskCommandInvokeRunReturns = NoDrift<ReturnDrift<typeof realTaskCommandInvokeRun, typeof shimTaskCommandInvokeRun>>;

export type CompatEventsParams = NoDrift<ParamDrift<typeof realCompatEvents, typeof shimCompatEvents>>;
export type CompatEventsReturns = NoDrift<ReturnDrift<typeof realCompatEvents, typeof shimCompatEvents>>;

export type TauriFetchParams = NoDrift<ParamDrift<typeof realTauriFetch, typeof shimTauriFetch>>;
export type TauriFetchReturns = NoDrift<ReturnDrift<typeof realTauriFetch, typeof shimTauriFetch>>;

export type I18nRunParams = NoDrift<ParamDrift<typeof realI18nRun, typeof shimI18nRun>>;
export type I18nRunReturns = NoDrift<ReturnDrift<typeof realI18nRun, typeof shimI18nRun>>;

export type EnterpriseCredsRunParams = NoDrift<ParamDrift<typeof realEnterpriseCredsRun, typeof shimEnterpriseCredsRun>>;
export type EnterpriseCredsRunReturns = NoDrift<ReturnDrift<typeof realEnterpriseCredsRun, typeof shimEnterpriseCredsRun>>;

export type EnterpriseEntitlementRunParams = NoDrift<ParamDrift<typeof realEnterpriseEntitlementRun, typeof shimEnterpriseEntitlementRun>>;
export type EnterpriseEntitlementRunReturns = NoDrift<ReturnDrift<typeof realEnterpriseEntitlementRun, typeof shimEnterpriseEntitlementRun>>;

export type SelectChatAdapterRunParams = NoDrift<ParamDrift<typeof realSelectChatAdapterRun, typeof shimSelectChatAdapterRun>>;
export type SelectChatAdapterRunReturns = NoDrift<ReturnDrift<typeof realSelectChatAdapterRun, typeof shimSelectChatAdapterRun>>;

export type LifecycleHooksRunParams = NoDrift<ParamDrift<typeof realLifecycleHooksRun, typeof shimLifecycleHooksRun>>;
export type LifecycleHooksRunReturns = NoDrift<ReturnDrift<typeof realLifecycleHooksRun, typeof shimLifecycleHooksRun>>;

export type LangfuseRunParams = NoDrift<ParamDrift<typeof realLangfuseRun, typeof shimLangfuseRun>>;
export type LangfuseRunReturns = NoDrift<ReturnDrift<typeof realLangfuseRun, typeof shimLangfuseRun>>;

export type MemdirScanParams = NoDrift<ParamDrift<typeof realMemdirScan, typeof shimMemdirScan>>;
export type MemdirScanReturns = NoDrift<ReturnDrift<typeof realMemdirScan, typeof shimMemdirScan>>;

export type SettingsReaderRunParams = NoDrift<ParamDrift<typeof realSettingsReaderRun, typeof shimSettingsReaderRun>>;
export type SettingsReaderRunReturns = NoDrift<ReturnDrift<typeof realSettingsReaderRun, typeof shimSettingsReaderRun>>;

export type ToolInvokerRunParams = NoDrift<ParamDrift<typeof realToolInvokerRun, typeof shimToolInvokerRun>>;
export type ToolInvokerRunReturns = NoDrift<ReturnDrift<typeof realToolInvokerRun, typeof shimToolInvokerRun>>;

export type CapsPortRunParams = NoDrift<ParamDrift<typeof realCapsPortRun, typeof shimCapsPortRun>>;
export type CapsPortRunReturns = NoDrift<ReturnDrift<typeof realCapsPortRun, typeof shimCapsPortRun>>;

export type WorkspaceReaderRunParams = NoDrift<ParamDrift<typeof realWorkspaceReaderRun, typeof shimWorkspaceReaderRun>>;
export type WorkspaceReaderRunReturns = NoDrift<ReturnDrift<typeof realWorkspaceReaderRun, typeof shimWorkspaceReaderRun>>;

export type ChatDeltaRunParams = NoDrift<ParamDrift<typeof realChatDeltaRun, typeof shimChatDeltaRun>>;
export type ChatDeltaRunReturns = NoDrift<ReturnDrift<typeof realChatDeltaRun, typeof shimChatDeltaRun>>;

export type ConversationReaderRunParams = NoDrift<ParamDrift<typeof realConversationReaderRun, typeof shimConversationReaderRun>>;
export type ConversationReaderRunReturns = NoDrift<ReturnDrift<typeof realConversationReaderRun, typeof shimConversationReaderRun>>;

export type ExecutionPortRunParams = NoDrift<ParamDrift<typeof realExecutionPortRun, typeof shimExecutionPortRun>>;
export type ExecutionPortRunReturns = NoDrift<ReturnDrift<typeof realExecutionPortRun, typeof shimExecutionPortRun>>;

export type AbortRegistryRunParams = NoDrift<ParamDrift<typeof realAbortRegistryRun, typeof shimAbortRegistryRun>>;
export type AbortRegistryRunReturns = NoDrift<ReturnDrift<typeof realAbortRegistryRun, typeof shimAbortRegistryRun>>;

export type ScratchpadPortRunParams = NoDrift<ParamDrift<typeof realScratchpadPortRun, typeof shimScratchpadPortRun>>;
export type ScratchpadPortRunReturns = NoDrift<ReturnDrift<typeof realScratchpadPortRun, typeof shimScratchpadPortRun>>;

export type OrchestratorRunParams = NoDrift<ParamDrift<typeof realOrchestratorRun, typeof shimOrchestratorRun>>;
export type OrchestratorRunReturns = NoDrift<ReturnDrift<typeof realOrchestratorRun, typeof shimOrchestratorRun>>;

export type EntryOrchestrationRunParams = NoDrift<ParamDrift<typeof realEntryOrchestrationRun, typeof shimEntryOrchestrationRun>>;
export type EntryOrchestrationRunReturns = NoDrift<ReturnDrift<typeof realEntryOrchestrationRun, typeof shimEntryOrchestrationRun>>;

export type PlatformRunParams = NoDrift<ParamDrift<typeof realPlatformRun, typeof shimPlatformRun>>;
export type PlatformRunReturns = NoDrift<ReturnDrift<typeof realPlatformRun, typeof shimPlatformRun>>;

export type NotificationsRunParams = NoDrift<ParamDrift<typeof realNotificationsRun, typeof shimNotificationsRun>>;
export type NotificationsRunReturns = NoDrift<ReturnDrift<typeof realNotificationsRun, typeof shimNotificationsRun>>;

export type PermissionBridgeRunParams = NoDrift<ParamDrift<typeof realPermissionBridgeRun, typeof shimPermissionBridgeRun>>;
export type PermissionBridgeRunReturns = NoDrift<ReturnDrift<typeof realPermissionBridgeRun, typeof shimPermissionBridgeRun>>;

export type ComputerUseStatusRunParams = NoDrift<ParamDrift<typeof realComputerUseStatusRun, typeof shimComputerUseStatusRun>>;
export type ComputerUseStatusRunReturns = NoDrift<ReturnDrift<typeof realComputerUseStatusRun, typeof shimComputerUseStatusRun>>;

export type BuiltinsRunParams = NoDrift<ParamDrift<typeof realBuiltinsRun, typeof shimBuiltinsRun>>;
export type BuiltinsRunReturns = NoDrift<ReturnDrift<typeof realBuiltinsRun, typeof shimBuiltinsRun>>;

export type ConversationStorageRunParams = NoDrift<ParamDrift<typeof realConversationStorageRun, typeof shimConversationStorageRun>>;
export type ConversationStorageRunReturns = NoDrift<ReturnDrift<typeof realConversationStorageRun, typeof shimConversationStorageRun>>;

export type SubagentRunnerRunParams = NoDrift<ParamDrift<typeof realSubagentRunnerRun, typeof shimSubagentRunnerRun>>;
export type SubagentRunnerRunReturns = NoDrift<ReturnDrift<typeof realSubagentRunnerRun, typeof shimSubagentRunnerRun>>;

export type MemdirExtractorRunParams = NoDrift<ParamDrift<typeof realMemdirExtractorRun, typeof shimMemdirExtractorRun>>;
export type MemdirExtractorRunReturns = NoDrift<ReturnDrift<typeof realMemdirExtractorRun, typeof shimMemdirExtractorRun>>;

export type MemdirPathsParams = NoDrift<ParamDrift<typeof realMemdirPaths, typeof shimMemdirPaths>>;
export type MemdirPathsReturns = NoDrift<ReturnDrift<typeof realMemdirPaths, typeof shimMemdirPaths>>;

export type UsageTrackerRunParams = NoDrift<ParamDrift<typeof realUsageTrackerRun, typeof shimUsageTrackerRun>>;
export type UsageTrackerRunReturns = NoDrift<ReturnDrift<typeof realUsageTrackerRun, typeof shimUsageTrackerRun>>;

export type ComputerToolsAxRunParams = NoDrift<ParamDrift<typeof realComputerToolsAxRun, typeof shimComputerToolsAxRun>>;
export type ComputerToolsAxRunReturns = NoDrift<ReturnDrift<typeof realComputerToolsAxRun, typeof shimComputerToolsAxRun>>;

export type ConsoleTelemetryTargetRunParams = NoDrift<ParamDrift<typeof realConsoleTelemetryTargetRun, typeof shimConsoleTelemetryTargetRun>>;
export type ConsoleTelemetryTargetRunReturns = NoDrift<ReturnDrift<typeof realConsoleTelemetryTargetRun, typeof shimConsoleTelemetryTargetRun>>;

export type SessionDirRunParams = NoDrift<ParamDrift<typeof realSessionDirRun, typeof shimSessionDirRun>>;
export type SessionDirRunReturns = NoDrift<ReturnDrift<typeof realSessionDirRun, typeof shimSessionDirRun>>;

export type DelegatedMediaStoreRunParams = NoDrift<ParamDrift<typeof realDelegatedMediaStoreRun, typeof shimDelegatedMediaStoreRun>>;
export type DelegatedMediaStoreRunReturns = NoDrift<ReturnDrift<typeof realDelegatedMediaStoreRun, typeof shimDelegatedMediaStoreRun>>;

export type UserInputQueueRunParams = NoDrift<ParamDrift<typeof realUserInputQueueRun, typeof shimUserInputQueueRun>>;
export type UserInputQueueRunReturns = NoDrift<ReturnDrift<typeof realUserInputQueueRun, typeof shimUserInputQueueRun>>;

export type FsBridgeRunParams = NoDrift<ParamDrift<typeof realFsBridgeRun, typeof shimFsBridgeRun>>;
export type FsBridgeRunReturns = NoDrift<ReturnDrift<typeof realFsBridgeRun, typeof shimFsBridgeRun>>;

export type DefaultWorkspaceRunParams = NoDrift<ParamDrift<typeof realDefaultWorkspaceRun, typeof shimDefaultWorkspaceRun>>;
export type DefaultWorkspaceRunReturns = NoDrift<ReturnDrift<typeof realDefaultWorkspaceRun, typeof shimDefaultWorkspaceRun>>;

export type AiEditSnapshotsRunParams = NoDrift<ParamDrift<typeof realAiEditSnapshotsRun, typeof shimAiEditSnapshotsRun>>;
export type AiEditSnapshotsRunReturns = NoDrift<ReturnDrift<typeof realAiEditSnapshotsRun, typeof shimAiEditSnapshotsRun>>;

export type AuthorizedPathsReaderRunParams = NoDrift<ParamDrift<typeof realAuthorizedPathsReaderRun, typeof shimAuthorizedPathsReaderRun>>;
export type AuthorizedPathsReaderRunReturns = NoDrift<ReturnDrift<typeof realAuthorizedPathsReaderRun, typeof shimAuthorizedPathsReaderRun>>;

export type SandboxRecoveryRunParams = NoDrift<ParamDrift<typeof realSandboxRecoveryRun, typeof shimSandboxRecoveryRun>>;
export type SandboxRecoveryRunReturns = NoDrift<ReturnDrift<typeof realSandboxRecoveryRun, typeof shimSandboxRecoveryRun>>;

export type TauriCoreInvokeRunParams = NoDrift<ParamDrift<typeof realTauriCoreInvokeRun, typeof shimTauriCoreInvokeRun>>;
export type TauriCoreInvokeRunReturns = NoDrift<ReturnDrift<typeof realTauriCoreInvokeRun, typeof shimTauriCoreInvokeRun>>;

export type PluginFsRunParams = NoDrift<ParamDrift<typeof realPluginFsRun, typeof shimPluginFsRun>>;
export type PluginFsRunReturns = NoDrift<ReturnDrift<typeof realPluginFsRun, typeof shimPluginFsRun>>;

export type TauriPathRunParams = NoDrift<ParamDrift<typeof realTauriPathRun, typeof shimTauriPathRun>>;
export type TauriPathRunReturns = NoDrift<ReturnDrift<typeof realTauriPathRun, typeof shimTauriPathRun>>;

export type PluginOsRunParams = NoDrift<ParamDrift<typeof realPluginOsRun, typeof shimPluginOsRun>>;
export type PluginOsRunReturns = NoDrift<ReturnDrift<typeof realPluginOsRun, typeof shimPluginOsRun>>;
