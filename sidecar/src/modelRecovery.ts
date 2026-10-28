import type { ModelRecoveryPort, RunModelBinding } from '@/core/agent/ports/modelRecovery';
import { sendRequest } from './rpcClient';

/** Credentials arrive through the trusted shell response for this run. */
export function createModelRecoveryPort(
  runId: string,
  apply: (binding: RunModelBinding) => void,
  initialRevision = 0,
): ModelRecoveryPort {
  let revision = initialRevision;
  return {
    async waitForSelection(reason) {
      const response = await sendRequest('model.recovery.wait', { runId, expectedRevision: revision, reason });
      if (response === null) return null;
      const binding = response as RunModelBinding;
      if (!binding || binding.revision !== revision + 1 || typeof binding.model?.modelId !== 'string'
        || typeof binding.model?.providerId !== 'string' || !binding.settingsSnapshot
        || typeof binding.resolvedCreds?.apiKey !== 'string' || !binding.capabilities) {
        throw new Error('Invalid model recovery binding');
      }
      apply(binding);
      revision = binding.revision;
      return binding;
    },
  };
}
