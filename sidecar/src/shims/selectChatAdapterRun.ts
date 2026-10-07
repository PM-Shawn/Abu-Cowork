/**
 * Sidecar-local replacement for `src/core/llm/selectChatAdapter.ts`.
 *
 * The real module picks between `SidecarLLMAdapter` (routes through the
 * sidecar over JSON-RPC) and a local adapter, based on
 * `sidecarManager.getSidecarStatus()` — none of which makes sense from
 * INSIDE the sidecar process itself (there's no second hop to take; we
 * already ARE the sidecar, and `sidecarManager.ts` isn't even part of this
 * bundle). This shim just constructs the real local adapter directly —
 * the same `createAdapterForKind` entry `llmHost.ts` uses, so both sides
 * of the sidecar agree on which class serves each `AdapterKind`.
 */
import type { LLMAdapter, AdapterKind } from '@/core/llm/adapter';
import { createAdapterForKind } from '@/core/llm/createAdapter';

export function selectChatAdapter(kind: AdapterKind): LLMAdapter {
  return createAdapterForKind(kind);
}
