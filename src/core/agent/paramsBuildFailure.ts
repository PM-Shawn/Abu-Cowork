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
 */
import { getI18n } from '../../i18n';
import { sanitizeUntrustedLlmErrorText } from '../llm/adapter';

export function paramsBuildDisplayMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'EnterpriseLlmUnavailableError') {
    return getI18n().chat.gatewayUnreachable;
  }
  return sanitizeUntrustedLlmErrorText(
    err instanceof Error ? err.message : String(err),
    getI18n().chat.errorEmptyBody,
  );
}
