import type { ModelRecord, ModelsDevModel } from './schema';

export function mapModelsDevModel(m: ModelsDevModel, providerId: string): ModelRecord {
  const input = m.modalities?.input ?? [];
  const rec: ModelRecord = {
    id: m.id,
    family: m.family,
    providers: [providerId],
    label: m.name,
    vision: input.includes('image'),
    contextWindow: m.limit?.context ?? 0,
    maxOutputTokens: m.limit?.output ?? 0,
    outputCeiling: m.limit?.output ?? 0,
    reasoning: m.reasoning === true,
    pdfInput: input.includes('pdf'),
  };
  if (m.cost && (m.cost.input != null || m.cost.output != null)) {
    rec.pricing = {
      input: m.cost.input ?? 0,
      output: m.cost.output ?? 0,
      cacheRead: m.cost.cache_read ?? 0,
      cacheCreation: m.cost.cache_write ?? 0,
    };
  }
  return rec;
}
