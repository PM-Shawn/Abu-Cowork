/**
 * Cost Tracker — calculates LLM API costs per model.
 *
 * Maintains pricing tables for known models and computes costs
 * from token usage data. Costs are accumulated per conversation
 * and per day for display in the StatusBar.
 *
 * Unknown models (e.g., Ollama local) return 0 cost.
 */

// ════════════════════════════════════════════════════════════
// Pricing (USD per million tokens)
// ════════════════════════════════════════════════════════════

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Pricing table: model prefix → pricing.
 * Uses prefix matching so we don't need to list every dated variant.
 * Prices in USD per million tokens.
 */
const MODEL_PRICING: [string, ModelPricing][] = [
  // Claude 4.x / 4.5 / 4.6
  ['claude-opus-4',   { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ['claude-sonnet-4', { input: 3,  output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ['claude-haiku-4',  { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1.0 }],
  // Claude 3.5
  ['claude-3-5-sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ['claude-3-5-haiku',  { input: 0.8, output: 4, cacheRead: 0.08, cacheCreation: 1.0 }],
  // Claude 3
  ['claude-3-opus',   { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 }],
  ['claude-3-sonnet', { input: 3,  output: 15, cacheRead: 0.3, cacheCreation: 3.75 }],
  ['claude-3-haiku',  { input: 0.25, output: 1.25, cacheRead: 0.03, cacheCreation: 0.3 }],
  // GPT-4o (OpenAI-compatible)
  ['gpt-4o',          { input: 2.5, output: 10, cacheRead: 1.25, cacheCreation: 2.5 }],
  ['gpt-4o-mini',     { input: 0.15, output: 0.6, cacheRead: 0.075, cacheCreation: 0.15 }],
  ['gpt-4-turbo',     { input: 10, output: 30, cacheRead: 5, cacheCreation: 10 }],
  // DeepSeek
  ['deepseek-chat',   { input: 0.27, output: 1.1, cacheRead: 0.07, cacheCreation: 0.27 }],
  ['deepseek-reasoner', { input: 0.55, output: 2.19, cacheRead: 0.14, cacheCreation: 0.55 }],
];

function findPricing(model: string): ModelPricing | null {
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of MODEL_PRICING) {
    if (lower.startsWith(prefix)) return pricing;
  }
  return null;
}

// ════════════════════════════════════════════════════════════
// Cost calculation
// ════════════════════════════════════════════════════════════

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Calculate the cost (USD) for a single LLM turn.
 * Returns 0 for unknown models (Ollama, local, etc.).
 */
export function calculateTurnCost(model: string, usage: TokenUsage): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;

  // inputTokens = uncached input tokens (Anthropic already excludes cache tokens;
  // OpenAI-compatible providers typically don't report cache fields at all).
  const inputCost = (usage.inputTokens ?? 0) * pricing.input / 1_000_000;
  const outputCost = (usage.outputTokens ?? 0) * pricing.output / 1_000_000;
  const cacheReadCost = (usage.cacheReadInputTokens ?? 0) * pricing.cacheRead / 1_000_000;
  const cacheCreationCost = (usage.cacheCreationInputTokens ?? 0) * pricing.cacheCreation / 1_000_000;

  return Math.max(0, inputCost + outputCost + cacheReadCost + cacheCreationCost);
}

/**
 * Format a cost value for display.
 * - < $0.01: "$0.001" (3 decimal places)
 * - < $1: "$0.08" (2 decimal places)
 * - >= $1: "$1.23" (2 decimal places)
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '$0';
  if (cost < 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// ════════════════════════════════════════════════════════════
// Session accumulator
// ════════════════════════════════════════════════════════════

/** Per-conversation accumulated cost */
const conversationCosts = new Map<string, number>();

/** Today's total cost */
let dailyCost = 0;
let dailyCostDate = new Date().toISOString().slice(0, 10);

/**
 * Record a turn's cost for a conversation.
 */
export function recordTurnCost(
  conversationId: string,
  model: string,
  usage: TokenUsage,
): number {
  const cost = calculateTurnCost(model, usage);
  if (cost <= 0) return 0;

  // Accumulate per conversation
  const prev = conversationCosts.get(conversationId) ?? 0;
  conversationCosts.set(conversationId, prev + cost);

  // Accumulate daily (reset if date changed)
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyCostDate) {
    dailyCost = 0;
    dailyCostDate = today;
  }
  dailyCost += cost;

  return cost;
}

/**
 * Get the accumulated cost for a conversation.
 */
export function getConversationCost(conversationId: string): number {
  return conversationCosts.get(conversationId) ?? 0;
}

/**
 * Get today's accumulated cost across all conversations.
 */
export function getDailyCost(): number {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyCostDate) {
    dailyCost = 0;
    dailyCostDate = today;
  }
  return dailyCost;
}

/**
 * Clear cost tracking for a conversation (e.g., on delete).
 */
export function clearConversationCost(conversationId: string): void {
  conversationCosts.delete(conversationId);
}
