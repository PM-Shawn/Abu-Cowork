/**
 * `handshake` — the first request the shell sends after it spawns this
 * process. The answer names this build's protocol version and capabilities;
 * whether the two sides are compatible is the shell's decision
 * (`src/core/sidecar/sidecarManager.ts`), so a shell on another protocol
 * version still gets a well-formed answer.
 *
 * Support switch: a sidecar started with `ABU_AGENT_START_PROTOCOL=1` leaves
 * `agent.start.history-from-ledger` out of its answer. The main process spawns
 * this process with its own environment (`mcpSpawn` in
 * `electron/mcpBridge.cjs`), which is how the variable gets here. Any value
 * other than the exact string `1` announces everything.
 */
import { APP_VERSION } from '@/utils/version';
import {
  CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER,
  SIDECAR_CAPABILITIES,
  SIDECAR_PROTOCOL_VERSION,
  SidecarHandshakeError,
  parseSidecarHandshakeParams,
  type SidecarHandshakeResult,
} from '@/core/sidecar/sidecarProtocol';
import { RpcError } from './protocol';
import { traceSidecarRuntimeEvent } from './runtimeTrace';

export const AGENT_START_PROTOCOL_ENV = 'ABU_AGENT_START_PROTOCOL';

/** What a sidecar started with `env` announces: every capability of the build, minus the ledger history one when the switch is set. */
export function sidecarCapabilitiesFor(env: Readonly<Record<string, string | undefined>>): string[] {
  const carriesMessages = env[AGENT_START_PROTOCOL_ENV] === '1';
  return SIDECAR_CAPABILITIES.filter(
    (capability) => !(carriesMessages && capability === CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER),
  );
}

export function handleHandshake(
  rawParams: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): SidecarHandshakeResult {
  let shellProtocolVersion: number;
  try {
    shellProtocolVersion = parseSidecarHandshakeParams(rawParams).protocolVersion;
  } catch (err) {
    // Typed conversion: malformed params are the caller's fault, reported as such.
    if (err instanceof SidecarHandshakeError) throw new RpcError(-32602, `Invalid params: ${err.message}`);
    throw err;
  }
  const capabilities = sidecarCapabilitiesFor(env);
  traceSidecarRuntimeEvent('sidecar.handshake_answered', {
    method: 'handshake',
    stage: capabilities.includes(CAPABILITY_AGENT_START_HISTORY_FROM_LEDGER)
      ? 'history_from_ledger'
      : 'history_on_the_wire',
    reason: `shell_protocol_${shellProtocolVersion}`,
  });
  return { protocolVersion: SIDECAR_PROTOCOL_VERSION, sidecarVersion: APP_VERSION, capabilities };
}
