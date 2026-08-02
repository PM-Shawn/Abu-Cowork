/**
 * Sidecar-local replacement for `src/core/llm/selectChatAdapter.ts`.
 *
 * The real module picks between `SidecarLLMAdapter` (routes through the
 * sidecar over JSON-RPC) and a local adapter, based on
 * `sidecarManager.getSidecarStatus()` — none of which makes sense from
 * INSIDE the sidecar process itself (there's no second hop to take; we
 * already ARE the sidecar, and `sidecarManager.ts` isn't even part of this
 * bundle). This shim just constructs the real local adapter directly —
 * mirrors `llmHost.ts`'s own `createAdapter()` exactly (same two classes,
 * same kind switch), since that's the sidecar's existing, already-proven
 * pattern for the same decision.
 */
import type { LLMAdapter, AdapterKind } from '@/core/llm/adapter';
import { ClaudeAdapter } from '@/core/llm/claude';
import { OpenAICompatibleAdapter } from '@/core/llm/openai-compatible';

export function selectChatAdapter(kind: AdapterKind): LLMAdapter {
  return kind === 'claude' ? new ClaudeAdapter() : new OpenAICompatibleAdapter();
}
