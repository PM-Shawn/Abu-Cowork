import type { ActiveModel } from '../../types/provider';
import { LLMError } from '../llm/adapter';

/** Exhausted retries can offer the user a model selection. */
export function isFailoverWorthyError(error: unknown): error is LLMError {
  return error instanceof LLMError && (error.code === 'quota_exceeded' || error.code === 'rate_limit');
}

export function failoverModelLabel(model: ActiveModel): string {
  return `${model.providerId}/${model.modelId}`;
}
