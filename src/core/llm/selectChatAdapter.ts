/**
 * Adapter selector — chooses between the sidecar-backed transport
 * (`SidecarLLMAdapter`) and the local in-process adapters (`ClaudeAdapter` /
 * `OpenAICompatibleAdapter`) per chat() call, based on whether the sidecar
 * is confirmed healthy right now.
 *
 * This is the ONLY thing agentLoop.ts / subagentLoop.ts should call to
 * obtain an LLMAdapter going forward (P1-1) — see those files' call sites,
 * which used to instantiate ClaudeAdapter/OpenAICompatibleAdapter directly.
 * The kind-choosing condition (enterprise-gateway / apiFormat check) is
 * unchanged at the call sites; only the instantiation step routes through
 * here.
 */

import type { LLMAdapter, ChatOptions, AdapterKind } from './adapter';
import { ClaudeAdapter } from './claude';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { SidecarLLMAdapter } from './sidecarAdapter';
import { getSidecarStatus } from '../sidecar/sidecarManager';
import { createLogger } from '../logging/logger';
import type { Message, StreamEvent } from '../../types';

const logger = createLogger('llm-transport');

export type { AdapterKind } from './adapter';

function createLocalAdapter(kind: AdapterKind): LLMAdapter {
  return kind === 'claude' ? new ClaudeAdapter() : new OpenAICompatibleAdapter();
}

/**
 * Wraps any LLMAdapter with first-token latency instrumentation. Logs
 * `{ path, firstEventMs }` once per chat() call, at info level, tag
 * 'llm-transport'. Applied identically to BOTH the sidecar and local paths
 * so the numbers are directly comparable — this is the data source for this
 * phase's quantitative acceptance check (first-token latency delta between
 * sidecar and local < 30ms), which the orchestrator measures afterwards
 * against a real provider.
 */
function withFirstTokenInstrumentation(adapter: LLMAdapter, path: 'sidecar' | 'local'): LLMAdapter {
  return {
    async chat(messages: Message[], options: ChatOptions, onEvent: (event: StreamEvent) => void): Promise<void> {
      const chatStart = Date.now();
      let firstEventLogged = false;
      const wrappedOnEvent = (event: StreamEvent): void => {
        if (!firstEventLogged) {
          firstEventLogged = true;
          logger.info('first event received', { path, firstEventMs: Date.now() - chatStart });
        }
        onEvent(event);
      };
      return adapter.chat(messages, options, wrappedOnEvent);
    },
  };
}

/**
 * Select the LLMAdapter implementation for one chat() call.
 *
 * Routes through the sidecar only when it is confirmed `'running'` right
 * now — 'stopped' / 'starting' / 'restarting' / 'failed' all fall back to
 * the local in-process adapter rather than risk queuing a chat() call
 * behind a not-yet-ready or crash-looping process (the sidecar has no
 * request queue; `sidecarManager.request()` would just time out or, with
 * `timeoutMs: 0` as `llm.chat` uses, hang until the process either starts
 * responding or closes and rejects all pending requests).
 */
export function selectChatAdapter(kind: AdapterKind): LLMAdapter {
  const sidecarStatus = getSidecarStatus();
  const sidecarRunning = sidecarStatus === 'running';
  const path: 'sidecar' | 'local' = sidecarRunning ? 'sidecar' : 'local';
  logger.debug('adapter path selected', { kind, path, sidecarStatus });
  const adapter = sidecarRunning ? new SidecarLLMAdapter(kind) : createLocalAdapter(kind);
  return withFirstTokenInstrumentation(adapter, path);
}
