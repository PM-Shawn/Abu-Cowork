import type { ModelRecord } from './schema';
import { classifyThinking, classifyToolResultImages, classifyDocumentBlock } from './classify';

type Overrides = Record<string, Partial<ModelRecord>>;

export function mergeLayers(
  snapshot: ModelRecord[],
  volcengine: ModelRecord[],
  overrides: Overrides,
): ModelRecord[] {
  const byId = new Map<string, ModelRecord>();
  for (const r of snapshot) byId.set(r.id, { ...r });
  for (const r of volcengine) {
    const prev = byId.get(r.id);
    byId.set(r.id, { ...prev, ...r, providers: dedupe([...(prev?.providers ?? []), ...(r.providers ?? [])]) });
  }

  const out: ModelRecord[] = [];
  for (const base of byId.values()) {
    const ov = overrides[base.id] ?? {};
    const merged: ModelRecord = { ...base, ...ov };
    if (merged.thinking === undefined) {
      merged.thinking = classifyThinking({ id: merged.id, family: merged.family, reasoning: merged.reasoning });
    }
    if (merged.toolResultImages === undefined) {
      merged.toolResultImages = classifyToolResultImages(merged.id, merged.family);
    }
    if (merged.documentBlock === undefined) {
      merged.documentBlock = classifyDocumentBlock(merged.id, merged.family);
    }
    out.push(merged);
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}
