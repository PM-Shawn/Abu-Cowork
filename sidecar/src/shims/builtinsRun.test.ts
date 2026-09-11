import { beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import * as rpcClient from '../rpcClient';
import { clearAllSkillHooks, clearSkillHooksByConversation, clearSkillHooksByLoop } from './builtinsRun';

describe('builtinsRun skill-hook cleanup shim', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards the run id but not the sidecar-supplied conversation owner', () => {
    const notify = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});

    agentRunContext.run({ runId: 'main-run-1' } as AgentRunContext, () => {
      clearSkillHooksByConversation('forged-conversation');
    });

    expect(notify).toHaveBeenCalledWith('skillHooks.clearAll', { runId: 'main-run-1' });
  });

  it('keeps the legacy global-named export on the same run-scoped wire path', () => {
    const notify = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});

    agentRunContext.run({ runId: 'main-run-2' } as AgentRunContext, () => {
      clearAllSkillHooks();
    });

    expect(notify).toHaveBeenCalledWith('skillHooks.clearAll', { runId: 'main-run-2' });
  });

  it('forwards loop cleanup using only the trusted current run id', () => {
    const notify = vi.spyOn(rpcClient, 'sendNotification').mockImplementation(() => {});

    agentRunContext.run({ runId: 'main-run-3' } as AgentRunContext, () => {
      clearSkillHooksByLoop('forged-loop');
    });

    expect(notify).toHaveBeenCalledWith('skillHooks.clearAll', { runId: 'main-run-3' });
  });
});
