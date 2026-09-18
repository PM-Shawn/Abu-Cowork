/**
 * The versioned hello between the shell and its sidecar, and the names of the
 * capabilities a sidecar can announce.
 *
 * Right after it spawns the sidecar the shell sends `handshake`; the answer
 * carries the sidecar's protocol version and a capability list. The shell
 * treats the sidecar as usable only after a well-formed answer on the same
 * protocol version (`sidecarManager.ts`), and picks the form of a request from
 * the capability list.
 *
 * Which of the two moves: anything a peer can ignore is announced as a
 * capability and leaves `SIDECAR_PROTOCOL_VERSION` where it is. The number
 * changes only for a change an older peer cannot ignore, and the shell then
 * accepts equality alone. Both tiers ship in one package, so a mismatch means
 * a broken install rather than a version to negotiate, and the shell ends it
 * the way it ends any other unusable sidecar.
 *
 * Pure and import-free: the renderer and the sidecar bundle this same file.
 */
export const SIDECAR_PROTOCOL_VERSION = 2;
export const SIDECAR_HANDSHAKE_METHOD = 'handshake';

/** `agent.start` may name a ledger watermark in place of carrying the messages. */
export const CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER = 'agent.start.history-from-ledger';

/** Every capability this build's sidecar can announce; `sidecar/src/handshake.ts` decides per process which of them it does. */
export const SIDECAR_CAPABILITIES: readonly string[] = [CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER];

const MAX_VERSION_CHARS = 64;
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_CHARS = 128;

export interface SidecarHandshakeParams {
  protocolVersion: number;
  shellVersion: string;
}

export interface SidecarHandshakeResult {
  protocolVersion: number;
  sidecarVersion: string;
  capabilities: string[];
}

export type SidecarHandshakeErrorCode = 'handshake_malformed' | 'protocol_incompatible';

export class SidecarHandshakeError extends Error {
  readonly code: SidecarHandshakeErrorCode;

  constructor(code: SidecarHandshakeErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'SidecarHandshakeError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isVersionText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_VERSION_CHARS;
}

export function parseSidecarHandshakeParams(value: unknown): SidecarHandshakeParams {
  if (!isRecord(value) || !Number.isSafeInteger(value.protocolVersion) || !isVersionText(value.shellVersion)) {
    throw new SidecarHandshakeError(
      'handshake_malformed',
      'params must be { protocolVersion: integer, shellVersion: string }',
    );
  }
  return { protocolVersion: value.protocolVersion as number, shellVersion: value.shellVersion };
}

export function parseSidecarHandshakeResult(value: unknown): SidecarHandshakeResult {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value.protocolVersion)
    || !isVersionText(value.sidecarVersion)
    || !Array.isArray(value.capabilities)
    || value.capabilities.length > MAX_CAPABILITIES
    || !value.capabilities.every(
      (entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= MAX_CAPABILITY_CHARS,
    )
  ) {
    throw new SidecarHandshakeError(
      'handshake_malformed',
      'result must be { protocolVersion, sidecarVersion, capabilities: string[] }',
    );
  }
  if (value.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
    throw new SidecarHandshakeError(
      'protocol_incompatible',
      `shell speaks ${SIDECAR_PROTOCOL_VERSION}, sidecar speaks ${String(value.protocolVersion)}`,
    );
  }
  return {
    protocolVersion: value.protocolVersion as number,
    sidecarVersion: value.sidecarVersion,
    capabilities: [...(value.capabilities as string[])],
  };
}
