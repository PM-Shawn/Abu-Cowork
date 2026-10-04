/**
 * The ONE display message for a dispatch-time params-build failure (#549).
 *
 * Both dispatchers need it — `agentLoopRunner.ts` for the main loop and
 * `subagentRunner.ts` for a delegated run — and `agentLoopRunner.ts` already
 * imports `toSerializableTool` from `subagentRunner.ts`, so importing the
 * helper the other way round would close an import cycle between the two
 * largest modules in `core/agent`. It lives here instead, so there is still
 * exactly one copy of the logic and no cycle.
 *
 * `EnterpriseLlmUnavailableError` is matched by `name`, not `instanceof`: the
 * class lives behind the `@enterprise-modules` alias and the OSS build ships a
 * stub, so the identity is not stable across builds — the name is.
 * `LedgerHistoryPointError` (`core/session/ledgerHistoryPoint.ts`) is matched
 * the same way, so this module stays free of the conversation store's module
 * graph for the sake of one string comparison.
 */
import { getI18n } from '../../i18n';
import { sanitizeUntrustedLlmErrorText } from '../llm/adapter';

export function paramsBuildDisplayMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'EnterpriseLlmUnavailableError') {
    return getI18n().chat.gatewayUnreachable;
  }
  // The ledger could not be brought level with what the user sees, so this run
  // has the same answer as a history the sidecar could not read.
  if (err instanceof Error && err.name === 'LedgerHistoryPointError') {
    return getI18n().chat.historyUnavailable;
  }
  return sanitizeUntrustedLlmErrorText(
    err instanceof Error ? err.message : String(err),
    getI18n().chat.errorEmptyBody,
  );
}
