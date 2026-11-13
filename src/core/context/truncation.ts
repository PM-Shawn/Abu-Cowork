/**
 * The omission lines a cut result carries. `toolResultSpill.ts` is the one
 * place that cuts a tool result (and saves the whole text to a file); the
 * step view folds the lines written here.
 */

/** The line older saved results carry where lines were dropped; nothing writes it now, the step view still reads it. */
export function linesOmittedMarker(count: number): string {
  return `[... ${count} lines omitted ...]`;
}

/** The line written where characters were dropped from the middle. */
export function charsOmittedMarker(count: number): string {
  return `[... ${count} characters omitted ...]`;
}

/** A whole line written by `linesOmittedMarker`, its count captured. */
export const LINES_OMITTED_LINE = /^\[\.\.\. (\d+) lines omitted \.\.\.\]$/;
/** A whole line written by `charsOmittedMarker`, its count captured. */
export const CHARS_OMITTED_LINE = /^\[\.\.\. (\d+) characters omitted \.\.\.\]$/;
