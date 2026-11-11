import type { CommandOutcome, FileReadOutcome, HttpFetchOutcome } from '@/types';

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isCount(value[0]) &&
    isCount(value[1]) &&
    value[0] <= value[1]
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A `commandOutcome` value from another process or from disk; undefined when it is not one. */
export function parseCommandOutcome(value: unknown): CommandOutcome | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { exitCode, background, stdout, stderr } = record;
  // The command host reports -1 for a timeout, a signal, a spawn failure and an unavailable host.
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode)) return undefined;
  if (background !== undefined && background !== true) return undefined;
  if (stdout !== undefined && !isRange(stdout)) return undefined;
  if (stderr !== undefined && !isRange(stderr)) return undefined;
  const outcome: CommandOutcome = { exitCode };
  if (background === true) outcome.background = true;
  if (stdout !== undefined) outcome.stdout = [stdout[0], stdout[1]];
  if (stderr !== undefined) outcome.stderr = [stderr[0], stderr[1]];
  return outcome;
}

/** A `fileReadOutcome` value from another process or from disk; undefined when it is not one. */
export function parseFileReadOutcome(value: unknown): FileReadOutcome | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.kind === 'document' || record.kind === 'notice') return { kind: record.kind };
  if (record.kind !== 'text') return undefined;
  const { startLine, lineCount, totalLines, bodyStart } = record;
  if (!isCount(startLine) || startLine < 1) return undefined;
  if (!isCount(lineCount) || !isCount(totalLines) || !isCount(bodyStart)) return undefined;
  return { kind: 'text', startLine, lineCount, totalLines, bodyStart };
}

/** An `httpFetchOutcome` value from another process or from disk; undefined when it is not one. */
export function parseHttpFetchOutcome(value: unknown): HttpFetchOutcome | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const { status, statusText, body, truncated } = record;
  if (!isCount(status) || typeof statusText !== 'string') return undefined;
  if (!isRange(body) || typeof truncated !== 'boolean') return undefined;
  return { status, statusText, body: [body[0], body[1]], truncated };
}

/**
 * The outcomes of a result that `boundToolResult` has cut. Their positions
 * were recorded in the whole text, so they no longer point into what is
 * stored: run_command's sections are dropped (the step view then shows the
 * stored text), http_fetch's body is everything after its status line.
 */
export function outcomesAfterSpill<T extends { commandOutcome?: CommandOutcome; httpFetchOutcome?: HttpFetchOutcome }>(
  metadata: T | undefined,
  stored: string,
): T | undefined {
  if (!metadata) return metadata;
  const { commandOutcome: _command, httpFetchOutcome, ...rest } = metadata;
  return {
    ...rest,
    ...(httpFetchOutcome
      ? { httpFetchOutcome: { ...httpFetchOutcome, body: [httpFetchOutcome.body[0], stored.length] as [number, number], truncated: true } }
      : {}),
  } as T;
}
