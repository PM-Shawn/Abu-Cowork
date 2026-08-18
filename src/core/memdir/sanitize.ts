/**
 * Memory secret hygiene — redact credential-shaped text before it is
 * persisted into a memory file.
 *
 * Why this exists: memories are replayed into future prompts verbatim — the
 * index section rides in the system prompt and relevant memories ride in the
 * per-turn context tail — so a key stored once is sent to the LLM provider on
 * every later turn. contentGuard already BLOCKS dangerous content at
 * writeMemory, but blocking loses the whole memory; credentials deserve a
 * gentler failure mode (redact the secret, keep the knowledge) and its
 * generic pattern only matched quoted values, missing real-world bare writes
 * like `API Key:tp-xxxx…`. This module redacts instead of rejecting and
 * covers the bare/contextual form, reusing shareRedactor's vendor patterns
 * (already battle-tested on the share-export path).
 */

import { redactCredentials } from '../session/shareRedactor';

export interface MemorySanitizeResult {
  text: string;
  /** Human-readable labels of what was redacted (e.g. 'openai-key'). */
  redactions: string[];
}

/**
 * Contextual credential pattern for bare (unquoted) values: a key-ish word —
 * English or Chinese — followed by a separator (ASCII or full-width : / =)
 * and a plausible secret token. The value must contain at least one digit AND
 * one letter (rules out prose) and be ≥12 chars; both lookaheads are bounded
 * to the value charset so a digit AFTER the value (e.g. `token:intro,2`) can
 * never turn plain prose into a "credential". The keyword+separator prefix is
 * preserved; only the value is replaced, so the memory still says WHERE the
 * key lived.
 *
 * Deliberately requires the keyword context — a bare high-entropy string with
 * no "key/token/密钥" nearby is more likely a hash/id worth keeping.
 *
 * Related scanners (kept separate on purpose, know they exist before adding
 * patterns): shareRedactor.RULES (vendor-prefixed shapes, reused above),
 * safety/contentGuard THREAT_PATTERNS (blocks, runs AFTER this redaction),
 * diagnostic/scrub.ts (diagnostic-bundle scrubbing).
 *
 * ⚠️ When adding/widening a pattern here or in shareRedactor.RULES, bump
 * SWEEP_MARKER in ./secretSweep.ts so already-written files get re-swept.
 */
const CONTEXTUAL_CREDENTIAL_RE =
  /((?:api[ _-]?key|access[ _-]?key|secret[ _-]?key|auth[ _-]?token|api[ _-]?token|token|secret|password|密钥|秘钥|凭证|令牌)\s*[:：=＝]\s*)(?!\[REDACTED)((?=[A-Za-z0-9_.+/-]*\d)(?=[A-Za-z0-9_.+/-]*[A-Za-z])[A-Za-z0-9_.+/-]{12,})/gi;

/**
 * Redact credential-shaped substrings from memory text. Idempotent:
 * `[REDACTED:*]` placeholders never re-match.
 */
export function sanitizeMemoryText(input: string): MemorySanitizeResult {
  if (!input) return { text: input, redactions: [] };

  const vendor = redactCredentials(input);
  const redactions = vendor.samples.map(s => s.kind as string);

  // `.replace()` with a /g/ regex always scans from index 0 and leaves
  // lastIndex at 0 — compare-and-swap avoids the stateful `.test()` footgun.
  const text = vendor.text.replace(CONTEXTUAL_CREDENTIAL_RE, '$1[REDACTED:credential]');
  if (text !== vendor.text) redactions.push('credential');

  return { text, redactions };
}

/**
 * Sanitize the writable fields of a memory. Returns the (possibly) redacted
 * fields plus the union of redaction labels, so callers can tell the model —
 * or the user — that a secret was scrubbed.
 */
export function sanitizeMemoryFields(fields: {
  name: string;
  description: string;
  content: string;
}): { name: string; description: string; content: string; redactions: string[] } {
  const name = sanitizeMemoryText(fields.name);
  const description = sanitizeMemoryText(fields.description);
  const content = sanitizeMemoryText(fields.content);
  return {
    name: name.text,
    description: description.text,
    content: content.text,
    redactions: [...new Set([...name.redactions, ...description.redactions, ...content.redactions])],
  };
}
