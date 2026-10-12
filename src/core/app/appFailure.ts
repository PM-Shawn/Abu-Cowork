import { redactFailureText } from '@/core/diagnostic/scrub';

/**
 * Where the reason of a failed app operation goes. The user reads a sentence
 * of the place that failed (what did not happen, and what to do); the text the
 * host or a parser gave goes to the console, redacted, and into nothing the
 * page renders.
 */
export function reportAppFailure(operation: string, error: unknown): void {
  console.warn(`[app] ${operation} failed:`, redactFailureText(error instanceof Error ? error.message : String(error)));
}
