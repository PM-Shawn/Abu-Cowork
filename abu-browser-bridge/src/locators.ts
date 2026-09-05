/**
 * The validation that stands between model-authored JSON and the DOM runtime.
 *
 * Extracted from `tools.ts` so `batch.ts` can apply the SAME checks to a step
 * as the single-action tool applies to its own argument. A batch step that
 * went through a second, slightly different parser would be a way to reach the
 * page with a locator the single-action path refuses — which is exactly the
 * shape of gate bypass this module exists to prevent.
 *
 * Each `parse*` takes the raw string an MCP argument carries; each `validate*`
 * takes an already-decoded object, which is the form a batch step is in.
 */

export const LOCATOR_KEYS = ['css', 'text', 'tag', 'role', 'name', 'xpath', 'testId', 'ref'];

/**
 * Keys a `find` query accepts. Separate from `LOCATOR_KEYS` because the two
 * mean different things: a locator must identify one element, a query is
 * allowed — expected — to match several, and it accepts `label`/`placeholder`,
 * which are how a person names a form field rather than how a caller pins one
 * down.
 */
export const FIND_QUERY_KEYS = ['role', 'name', 'text', 'css', 'testId', 'label', 'placeholder'];

export const WAIT_CONDITION_TYPES = ['appear', 'disappear', 'enabled', 'textContains', 'urlContains'];

/**
 * The modifier keys `keyboard` accepts — the ONE list, read by both paths.
 *
 * `tools.ts` builds its zod enum from it and `validateKeyboardModifiers` below
 * checks a batch step against it, so the two cannot disagree. They used to:
 * the single-action tool took `z.enum(['ctrl','shift','alt','meta'])` while a
 * batch step took `requireString`, i.e. any non-empty string, which
 * `browserHost.cjs` then passed to `webContents.sendInputEvent` almost
 * verbatim. Electron's modifier set is larger than these four (`capsLock`,
 * `numLock`, `leftButtonDown`, `isAutoRepeat`, …), so a batch could send
 * modifier bits the single-action path refuses — the second-parser bypass this
 * module's header names as the thing it exists to prevent, in the one field
 * that had been left out of the extraction.
 */
export const KEYBOARD_MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;

export type KeyboardModifier = (typeof KEYBOARD_MODIFIERS)[number];

/** Validate an already-decoded `modifiers` array from a batch step. */
export function validateKeyboardModifiers(value: unknown): KeyboardModifier[] {
  if (!Array.isArray(value)) throw new Error('`modifiers` must be an array');
  return value.map((m) => {
    if (typeof m !== 'string' || !(KEYBOARD_MODIFIERS as readonly string[]).includes(m)) {
      throw new Error(`\`modifiers[]\` must be one of: ${KEYBOARD_MODIFIERS.join(', ')}`);
    }
    return m as KeyboardModifier;
  });
}

function asPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** Ensure a decoded locator names at least one known strategy. */
export function validateLocator(value: unknown): Record<string, unknown> {
  const parsed = asPlainObject(value, 'Locator');
  if (!Object.keys(parsed).some((k) => LOCATOR_KEYS.includes(k))) {
    throw new Error(`Locator must contain at least one of: ${LOCATOR_KEYS.join(', ')}`);
  }
  return parsed;
}

/** Ensure a decoded `find` query carries at least one non-empty known key. */
export function validateFindQuery(value: unknown): Record<string, unknown> {
  const parsed = asPlainObject(value, 'Find query');
  const usable = Object.entries(parsed).some(
    ([key, v]) => FIND_QUERY_KEYS.includes(key) && typeof v === 'string' && v !== '',
  );
  if (!usable) {
    throw new Error(`Find query must contain at least one non-empty: ${FIND_QUERY_KEYS.join(', ')}`);
  }
  return parsed;
}

/** Ensure a decoded wait condition names one of the supported types. */
export function validateCondition(value: unknown): Record<string, unknown> {
  const parsed = asPlainObject(value, 'Condition');
  if (!WAIT_CONDITION_TYPES.includes(parsed.type as string)) {
    throw new Error(`Condition type must be one of: ${WAIT_CONDITION_TYPES.join(', ')}`);
  }
  return parsed;
}

export function parseLocator(raw: string): Record<string, unknown> {
  return validateLocator(JSON.parse(raw));
}

export function parseFindQuery(raw: string): Record<string, unknown> {
  return validateFindQuery(JSON.parse(raw));
}

export function parseCondition(raw: string): Record<string, unknown> {
  return validateCondition(JSON.parse(raw));
}
