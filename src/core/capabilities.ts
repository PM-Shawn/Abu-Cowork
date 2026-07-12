import { PROVIDER_CONFIGS } from '@/stores/settingsStore';
import type { LLMProvider, BuiltinSearchMethod, ProviderCapabilities } from '@/types';

/** Check if provider has built-in web search capability */
export function providerSupportsWebSearch(provider: LLMProvider): boolean {
  return !!PROVIDER_CONFIGS[provider]?.capabilities?.webSearch;
}

/** Check if provider has built-in image generation capability */
export function providerSupportsImageGen(provider: LLMProvider): boolean {
  return !!PROVIDER_CONFIGS[provider]?.capabilities?.imageGen;
}

/**
 * Get the built-in search config if the provider INSTANCE supports it and user
 * preference is enabled. Reads the instance's actual capabilities (which vary
 * per config plan, e.g. anthropic-format Coding/Agent plans have no builtin
 * webSearch) rather than the static top-level provider family capabilities —
 * otherwise an anthropic-format instance could get an OpenAI-shaped web_search
 * tool injected into an Anthropic request, causing a 400.
 * Returns undefined if the instance doesn't support builtin search or user turned it off.
 */
export function getBuiltinSearchConfig(capabilities: ProviderCapabilities | undefined, userPref: boolean): BuiltinSearchMethod | undefined {
  if (!userPref) return undefined;
  return capabilities?.webSearch;
}
