/**
 * File-system permission check — write a short test file to each
 * scope-relevant location, then delete it. Surfaces both Tauri-scope
 * misconfiguration and OS-level (macOS TCC) denials with the same UI.
 *
 * Tested locations:
 *  - app data dir (always)
 *  - workspace root (only if a workspace is selected)
 *  - workspace `.abu/` (only if a workspace is selected) — the spot that
 *    bit us in v0.13.10 (require_literal_leading_dot)
 */

import { writeTextFile, remove, mkdir, exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { joinPath } from '@/utils/pathUtils';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { getI18n, format } from '@/i18n';
import { checkComputerUsePermissions } from '@/core/agent/computerUsePermission';
import { isMacOS } from '@/utils/platform';
import { mapPermissionsError } from '../errorMap';
import type { CheckResult } from '../types';

/**
 * Build a failed-row CheckResult from a probe error, applying friendly-error
 * mapping so users don't see raw `forbidden path: ... allow-write-text-file`
 * scope dumps in their face.
 */
function failedRow(
  id: string,
  name: string,
  rawError: string,
  durationMs: number,
): CheckResult {
  const friendly = mapPermissionsError(rawError);
  return {
    id,
    category: 'permissions',
    name,
    status: 'failed',
    errorMessage: friendly.message,
    errorDetail: rawError,
    suggestedAction: friendly.action,
    checkedAt: Date.now(),
    durationMs,
  };
}

async function probeWrite(path: string): Promise<{ ok: boolean; durationMs: number; error?: string }> {
  const start = Date.now();
  try {
    await writeTextFile(path, 'abu-diag-test');
    await remove(path).catch(() => {});
    return { ok: true, durationMs: Date.now() - start };
  } catch (e) {
    return {
      ok: false,
      durationMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function runPermissionsChecks(): Promise<CheckResult[]> {
  const t = getI18n();
  const out: CheckResult[] = [];
  const ws = useWorkspaceStore.getState().currentPath;
  const ts = Date.now();

  // Computer Use is opt-in. Once enabled, its runtime dependencies become part
  // of the overall verdict so filesystem checks alone cannot yield false green.
  if (useSettingsStore.getState().computerUseEnabled) {
    const healthStartedAt = Date.now();
    try {
      const health = await invoke<{ pong?: boolean }>('native_helper_health');
      const healthy = health?.pong === true;
      out.push({
        id: 'permissions:computer-helper',
        category: 'permissions',
        name: t.diagnostic.permComputerHelper,
        status: healthy ? 'passed' : 'failed',
        metric: healthy ? t.diagnostic.computerAvailable : t.diagnostic.computerUnavailable,
        ...(!healthy ? { errorMessage: t.diagnostic.computerHelperUnavailable } : {}),
        checkedAt: Date.now(),
        durationMs: Date.now() - healthStartedAt,
        freshness: 'fresh',
      });
    } catch (error) {
      out.push({
        id: 'permissions:computer-helper',
        category: 'permissions',
        name: t.diagnostic.permComputerHelper,
        status: 'failed',
        metric: t.diagnostic.computerUnavailable,
        errorMessage: t.diagnostic.computerHelperUnavailable,
        errorDetail: error instanceof Error ? error.message : String(error),
        checkedAt: Date.now(),
        durationMs: Date.now() - healthStartedAt,
        freshness: 'unknown',
      });
    }

    if (isMacOS()) {
      const permissionStartedAt = Date.now();
      const permissions = await checkComputerUsePermissions();
      if (!permissions) {
        out.push({
          id: 'permissions:computer-status',
          category: 'permissions',
          name: t.diagnostic.permComputerStatus,
          status: 'warning',
          errorMessage: t.diagnostic.computerPermissionUnknown,
          checkedAt: Date.now(),
          durationMs: Date.now() - permissionStartedAt,
          freshness: 'unknown',
        });
      } else {
        out.push({
          id: 'permissions:computer-ui-control',
          category: 'permissions',
          name: t.diagnostic.permComputerUiControl,
          status: permissions.uiControl ? 'passed' : 'failed',
          metric: permissions.uiControl ? t.diagnostic.computerGranted : t.diagnostic.computerMissing,
          ...(!permissions.uiControl ? {
            errorMessage: t.diagnostic.computerUiControlMissing,
            suggestedAction: {
              type: 'open-settings' as const,
              target: 'capabilities',
              label: t.diagnostic.actionOpenCapabilities,
            },
          } : {}),
          checkedAt: Date.now(),
          durationMs: Date.now() - permissionStartedAt,
          freshness: 'fresh',
        });
        out.push({
          id: 'permissions:computer-screen-read',
          category: 'permissions',
          name: t.diagnostic.permComputerScreenRead,
          // AX-only work is usable without screenshots: restricted, not broken.
          status: permissions.screenRead ? 'passed' : 'warning',
          metric: permissions.screenRead ? t.diagnostic.computerGranted : t.diagnostic.computerRestricted,
          ...(!permissions.screenRead ? {
            errorMessage: t.diagnostic.computerScreenReadMissing,
            suggestedAction: {
              type: 'open-settings' as const,
              target: 'capabilities',
              label: t.diagnostic.actionOpenCapabilities,
            },
          } : {}),
          checkedAt: Date.now(),
          durationMs: Date.now() - permissionStartedAt,
          freshness: 'fresh',
        });
      }
    }
  }

  // 1. App data dir
  try {
    const dir = await appDataDir();
    const probe = await probeWrite(joinPath(dir, `abu-diag-${ts}.tmp`));
    if (probe.ok) {
      out.push({
        id: 'permissions:app-data',
        category: 'permissions',
        name: t.diagnostic.permAppData,
        status: 'passed',
        metric: `${probe.durationMs}ms`,
        checkedAt: Date.now(),
        durationMs: probe.durationMs,
      });
    } else {
      out.push(failedRow('permissions:app-data', t.diagnostic.permAppData, probe.error ?? '', probe.durationMs));
    }
  } catch (e) {
    out.push(failedRow('permissions:app-data', t.diagnostic.permAppData, e instanceof Error ? e.message : String(e), 0));
  }

  // 2. Encrypted secret store (safeStorage / OS keychain) — write→read→delete
  // a probe entry, then report any keys that failed to decrypt at launch. A
  // broken system keychain fails every provider at once (2026-08 incident:
  // a replaced login keychain made all keys undecryptable while the app
  // itself was healthy); this row pins the blame on the OS layer instead of
  // leaving users to debug individual API keys.
  {
    const secretStart = Date.now();
    const probeKey = `diag:secret-probe-${ts}`;
    try {
      await invoke('secret_set', { key: probeKey, value: 'abu-diag-probe' });
      const readBack = await invoke<string | null>('secret_get', { key: probeKey });
      await invoke('secret_delete', { key: probeKey }).catch(() => {});
      const failedKeys = await invoke<string[]>('secret_failed_keys').catch(() => [] as string[]);
      const durationMs = Date.now() - secretStart;
      if (readBack !== 'abu-diag-probe') {
        out.push({
          id: 'permissions:secret-store',
          category: 'permissions',
          name: t.diagnostic.permSecretStore,
          status: 'failed',
          errorMessage: t.diagnostic.secretStoreRoundtripFailed,
          errorDetail: `read-back mismatch (${readBack === null ? 'null' : 'value differs'})`,
          checkedAt: Date.now(),
          durationMs,
        });
      } else if (failedKeys.length > 0) {
        out.push({
          id: 'permissions:secret-store',
          category: 'permissions',
          name: t.diagnostic.permSecretStore,
          status: 'warning',
          metric: format(t.diagnostic.secretStoreFailedKeys, { count: failedKeys.length }),
          errorMessage: t.diagnostic.secretStoreFailedKeysHint,
          checkedAt: Date.now(),
          durationMs,
        });
      } else {
        out.push({
          id: 'permissions:secret-store',
          category: 'permissions',
          name: t.diagnostic.permSecretStore,
          status: 'passed',
          metric: `${durationMs}ms`,
          checkedAt: Date.now(),
          durationMs,
        });
      }
    } catch (e) {
      // secret_set throws when safeStorage/keychain encryption is unavailable.
      out.push({
        id: 'permissions:secret-store',
        category: 'permissions',
        name: t.diagnostic.permSecretStore,
        status: 'failed',
        errorMessage: t.diagnostic.secretStoreUnavailable,
        errorDetail: e instanceof Error ? e.message : String(e),
        checkedAt: Date.now(),
        durationMs: Date.now() - secretStart,
      });
    }
  }

  // 3 + 4. Workspace tests (only if a workspace is selected)
  if (ws) {
    const wsProbe = await probeWrite(joinPath(ws, `abu-diag-${ts}.tmp`));
    if (wsProbe.ok) {
      out.push({
        id: 'permissions:workspace',
        category: 'permissions',
        name: t.diagnostic.permWorkspace,
        status: 'passed',
        metric: `${wsProbe.durationMs}ms`,
        checkedAt: Date.now(),
        durationMs: wsProbe.durationMs,
      });
    } else {
      out.push(failedRow('permissions:workspace', t.diagnostic.permWorkspace, wsProbe.error ?? '', wsProbe.durationMs));
    }

    // workspace/.abu — needs mkdir first if missing
    const abuDir = joinPath(ws, '.abu');
    let abuProbe: { ok: boolean; durationMs: number; error?: string };
    try {
      if (!(await exists(abuDir))) await mkdir(abuDir, { recursive: true });
      abuProbe = await probeWrite(joinPath(abuDir, `abu-diag-${ts}.tmp`));
    } catch (e) {
      abuProbe = { ok: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) };
    }
    if (abuProbe.ok) {
      out.push({
        id: 'permissions:workspace-abu',
        category: 'permissions',
        name: t.diagnostic.permWorkspaceAbu,
        status: 'passed',
        metric: `${abuProbe.durationMs}ms`,
        checkedAt: Date.now(),
        durationMs: abuProbe.durationMs,
      });
    } else {
      out.push(failedRow('permissions:workspace-abu', t.diagnostic.permWorkspaceAbu, abuProbe.error ?? '', abuProbe.durationMs));
    }
  } else {
    out.push({
      id: 'permissions:workspace',
      category: 'permissions',
      name: t.diagnostic.permWorkspace,
      status: 'skipped',
      metric: t.diagnostic.permWorkspaceNoSelection,
      checkedAt: Date.now(),
      durationMs: 0,
    });
  }

  return out;
}
