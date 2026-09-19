/**
 * The sender side of the `history_unavailable` wire contract: a rejected
 * `agent.start` leaves this process as the JSON-RPC error line the shell
 * parses, carrying the shared payload and nothing else.
 */
import { describe, expect, it, vi } from 'vitest';
import { HISTORY_UNAVAILABLE_CONTRACT_FIXTURE } from '@/core/ipc/__contractFixtures__/historyUnavailableFixture';
import { parseHistoryUnavailableError } from '@/core/ipc/historyUnavailable';
import { LedgerWatermarkError } from '@/core/session/ledgerReader';

vi.mock('@/core/agent/agentLoop', () => ({ runAgentLoop: vi.fn() }));
vi.mock('./rpcClient', () => ({
  sendRequest: vi.fn(),
  sendNotification: vi.fn(),
  setPreRequestFlush: vi.fn(),
}));
vi.mock('./runtimeTrace', () => ({
  traceSidecarRuntimeEvent: vi.fn(),
  sidecarRuntimeErrorType: (error: unknown) => (error instanceof Error ? error.name.toLowerCase() : typeof error),
}));
vi.mock('./localTools', () => ({
  hasLocalTool: vi.fn(),
  isLocalToolReadOnly: vi.fn(),
  executeLocalTool: vi.fn(),
}));

const loadMessagesMock = vi.hoisted(() => vi.fn());
vi.mock('./shims/conversationStorageRun', () => ({
  loadMessages: (...a: unknown[]) => loadMessagesMock(...a),
}));

import { errorFromCaught } from './protocol';
import { buildAgentRunPayloadDigest, handleAgentStart } from './agentLoopHost';

describe('history_unavailable wire contract — sidecar', () => {
  it('rejects with the shared payload, unchanged by a JSON round trip', async () => {
    loadMessagesMock.mockRejectedValue(new LedgerWatermarkError('watermark_beyond_file', 4096, 1024));
    const body = {
      runId: 'contract-run',
      clientMessageId: 'msg-contract-run',
      conversationId: 'conv-contract',
      userMessage: 'hello',
      options: { prePersistedUserMessageId: 'msg-contract-run' },
      orchestration: { route: { type: 'chat', cleanInput: 'hello' }, systemPromptSections: [] },
      conversationSnapshot: { id: 'conv-contract', title: 'T', messages: [], createdAt: 0, updatedAt: 0, status: 'idle' },
      settingsSnapshot: { activeModel: { providerId: 'p', modelId: 'm' } },
      resolvedCreds: { apiKey: 'sk-test', baseUrl: undefined, forceOpenAiCompatible: false },
      toolList: [],
      locale: 'zh-CN',
      history: { source: 'ledger', ledgerWatermark: 4096 },
    };
    let thrown: unknown;
    try {
      await handleAgentStart({ ...body, payloadDigest: buildAgentRunPayloadDigest(body) });
    } catch (err) {
      thrown = err;
    }
    const onTheWire = JSON.parse(JSON.stringify(errorFromCaught(7, thrown)));
    expect(onTheWire.error.code).toBe(-32010);
    expect(onTheWire.error.message).toBe('history_unavailable');
    expect(onTheWire.error.data).toEqual(HISTORY_UNAVAILABLE_CONTRACT_FIXTURE);
    expect(parseHistoryUnavailableError(onTheWire.error)).toEqual(HISTORY_UNAVAILABLE_CONTRACT_FIXTURE);
  });
});
