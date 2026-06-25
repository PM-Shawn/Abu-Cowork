/**
 * structuredOutput — pure helpers for structured (JSON) sub-agent results.
 *
 * These utilities are provider-portable: they work by instructing the sub-agent
 * via a natural-language suffix appended to the task prompt, then extracting
 * and lightly validating the JSON object from the sub-agent's text response.
 * No forced-tool or model-specific features required.
 */

/**
 * Build a Chinese instruction suffix to append to a task prompt.
 * Tells the sub-agent to emit exactly one JSON object matching the given schema,
 * without markdown fences or explanatory prose.
 */
export function buildSchemaInstruction(schema: Record<string, unknown>): string {
  return (
    '\n\n【输出要求】完成后，只输出一个 JSON 对象，严格匹配以下 JSON Schema，' +
    '不要输出任何解释性文字、不要用 markdown 代码块包裹：\n' +
    JSON.stringify(schema)
  );
}

/**
 * Robustly extract a single JSON object from model output text.
 *
 * Strategy:
 * 1. Strip a leading/trailing ```json…``` or ```…``` fence if present.
 * 2. Find the first `{` and the last `}` in the (possibly stripped) text.
 * 3. JSON.parse that substring.
 * 4. Return the parsed value only if it is a non-null plain object.
 *    Arrays, primitives, and parse errors all return null (never throws).
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  let source = text.trim();

  // Strip markdown code fence (```json … ``` or ``` … ```)
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m.exec(source);
  if (fenceMatch) {
    source = fenceMatch[1].trim();
  }

  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  const candidate = source.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Light validation: check that every key listed in `schema.required` exists
 * as an own property in `data`. No deep type checking is performed.
 *
 * Returns `{ ok: true }` when all required keys are present (or when there is
 * no `required` array in the schema). Returns `{ ok: false, missing: [...] }`
 * when one or more keys are absent.
 */
export function validateStructured(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): { ok: true } | { ok: false; missing: string[] } {
  const required = schema.required;
  if (!Array.isArray(required)) return { ok: true };

  const missing: string[] = [];
  for (const key of required) {
    if (typeof key === 'string' && !Object.prototype.hasOwnProperty.call(data, key)) {
      missing.push(key);
    }
  }

  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}
