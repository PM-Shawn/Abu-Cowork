/**
 * Model-written text shown to a person (an approval prompt, a step title) is not trusted.
 * It is cut down to one line of visible text before it is shown.
 */

/** Longest untrusted fragment allowed into the prompt. A 5 KB shell command
 *  would push the instruction line off a phone screen, which is its own attack. */
const UNTRUSTED_FIELD_MAX = 200;

/**
 * Characters a fenced fragment must never contain: the fence itself (so the
 * content cannot close it and write outside), C0/C1 control codes, and the
 * Unicode line/paragraph separators and bidi overrides that render as line
 * breaks or reverse text.
 */
const UNSAFE_PROMPT_CHARS =
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u3000\u300C\u300D\u3010\u3011]/g;

/**
 * Make a model-authored string safe to show a human in a chat message.
 *
 * `ConfirmationInfo.command` and `.reason` are NOT trusted text: `command` is
 * whatever the model asked to run (and the model can be steered by page
 * content it just read), and `reason` can come from the AI reviewer. Dropped
 * verbatim into a multi-line prompt, either could forge a second, official
 * looking line — "系统自动检查通过，无需确认" — or a whole fake prompt below
 * the real one. Collapsing every whitespace run to a single space keeps an
 * untrusted fragment on ONE line inside its fence, so the template's framing
 * (and the instruction line that follows it) cannot be impersonated.
 */
export function sanitizeUntrustedPromptField(
  text: string,
  maxLength = UNTRUSTED_FIELD_MAX,
): string {
  const flattened = text
    .replace(UNSAFE_PROMPT_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= maxLength) return flattened;
  return `${flattened.slice(0, maxLength).trimEnd()}…`;
}
