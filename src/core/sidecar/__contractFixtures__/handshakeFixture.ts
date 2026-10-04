import { APP_VERSION } from '@/utils/version';

/** The handshake exchange both tiers pin: the shell's request and the sidecar's answer. */
export const HANDSHAKE_REQUEST_CONTRACT_FIXTURE = {
  protocolVersion: 2,
  shellVersion: APP_VERSION,
} as const;

export const HANDSHAKE_RESULT_CONTRACT_FIXTURE = {
  protocolVersion: 2,
  sidecarVersion: APP_VERSION,
  capabilities: ['agent.start.history-from-ledger'],
};
