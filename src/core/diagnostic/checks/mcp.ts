/**
 * MCP check — read live status from `mcpStore` (the same source of truth
 * the customize panel renders). No probing, no extra connect attempts —
 * the store already maintains current state continuously.
 */

import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { getI18n } from '@/i18n';
import type { CheckResult } from '../types';

export function runMcpChecks(): CheckResult[] {
  const t = getI18n();
  const servers: MCPServerEntry[] = Object.values(useMCPStore.getState().servers);
  const enabled = servers.filter((s) => s.config.enabled);

  if (enabled.length === 0) {
    return [{
      id: 'mcp:none',
      category: 'mcp',
      name: t.diagnostic.mcpNone,
      status: 'skipped',
      metric: t.diagnostic.mcpNoneHint,
      checkedAt: Date.now(),
      durationMs: 0,
    }];
  }

  return enabled.map((srv) => {
    const ok = srv.status === 'connected';
    const failed = srv.status === 'error';
    return {
      id: `mcp:${srv.config.name}`,
      category: 'mcp',
      name: srv.config.name,
      status: ok ? 'passed' : failed ? 'failed' : 'warning',
      metric: ok && srv.tools ? t.diagnostic.mcpToolCount.replace('{n}', String(srv.tools.length)) : srv.status,
      errorMessage: failed ? srv.error : undefined,
      errorDetail: failed ? srv.error : undefined,
      suggestedAction: failed ? {
        type: 'open-toolbox',
        target: 'mcp',
        label: t.diagnostic.actionOpenToolbox,
      } : undefined,
      checkedAt: Date.now(),
      durationMs: 0,
    };
  });
}
