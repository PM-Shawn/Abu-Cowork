'use strict';

// Test-only knobs for #549 acceptance (oversize + slow sidecar start). Read
// once by main.cjs. Honored ONLY in an unpackaged (dev / E2E) build: unlike
// ABU_E2E_APP_DATA_ROOT, ABU_PACKAGED_E2E=1 does NOT enable them, so no
// environment variable can change IPC limits or sidecar start-up of an
// installed app. Never read from the renderer.
const MCP_WRITE_LIMIT_ENV = 'ABU_E2E_MCP_WRITE_LIMIT_BYTES';
const SIDECAR_SPAWN_DELAY_ENV = 'ABU_E2E_SIDECAR_SPAWN_DELAY_MS';

function positiveInt(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readE2ETestHooks({ env, isPackaged }) {
  if (isPackaged !== false || !env) return {};
  const hooks = {};
  const limit = positiveInt(env[MCP_WRITE_LIMIT_ENV]);
  if (limit !== undefined) hooks.mcpWriteLimitBytes = limit;
  const delay = positiveInt(env[SIDECAR_SPAWN_DELAY_ENV]);
  if (delay !== undefined) hooks.sidecarSpawnDelayMs = delay;
  return hooks;
}

module.exports = { readE2ETestHooks };
