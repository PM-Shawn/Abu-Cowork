import type { ToolDefinition, ToolResult } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import {
  computeCapabilitySnapshot,
  type CapabilitySource,
  type UnavailableReason,
} from '../capabilitySnapshot';

function formatSource(ts: ReturnType<typeof getI18n>['toolResult']['capabilitySnapshot'], source: CapabilitySource): string {
  return source.kind === 'builtin' ? ts.sourceBuiltin : format(ts.sourceMcp, { server: source.server });
}

function formatReason(ts: ReturnType<typeof getI18n>['toolResult']['capabilitySnapshot'], reason: UnavailableReason): string {
  switch (reason.kind) {
    case 'labs-gated':
      return format(ts.reasonLabsGated, { experimentId: reason.experimentId });
    case 'mcp-disabled':
      return format(ts.reasonMcpDisabled, { server: reason.server });
    case 'mcp-not-connected':
      return reason.error
        ? format(ts.reasonMcpError, { server: reason.server, error: reason.error })
        : format(ts.reasonMcpNotConnected, { server: reason.server, status: reason.status });
    case 'duplicate-browser-tool':
      return format(ts.reasonDuplicateBrowser, { server: reason.server });
    case 'policy-denied':
      return format(ts.reasonPolicyDenied, { reason: reason.reason ?? '' });
  }
}

/**
 * capability_snapshot — read-only inventory of the tools actually usable in
 * this session right now, and why any tool isn't (Labs gate, MCP connection
 * status, duplicate-browser filtering, enterprise policy). See
 * capabilitySnapshot.ts for how each judgment is derived from the real
 * gating logic. Modeled after Claude Code's `/context`.
 */
export const capabilitySnapshotTool: ToolDefinition = {
  name: TOOL_NAMES.CAPABILITY_SNAPSHOT,
  description: 'Report a read-only snapshot of which tools are actually usable in this session right now, and why any tool is unavailable (Labs experiment gate, MCP server connection status, duplicate-capability filtering, enterprise policy). Use when the user asks what you can do, why a tool seems missing, or wants a capability/permission overview.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  isConcurrencySafe: true,
  async execute(): Promise<ToolResult> {
    const i18n = getI18n();
    const ts = i18n.toolResult.capabilitySnapshot;
    const snapshot = computeCapabilitySnapshot();

    const active = snapshot.entries.filter((e) => e.unavailableReasons.length === 0);
    const unavailable = snapshot.entries.filter((e) => e.unavailableReasons.length > 0);

    const modeLabel = snapshot.permissionMode === 'autonomous'
      ? ts.permissionModeAutonomous
      : snapshot.permissionMode === 'smart'
        ? ts.permissionModeSmart
        : ts.permissionModeStandard;

    const header = format(ts.header, {
      mode: modeLabel,
      computerUse: snapshot.computerUseEnabled ? ts.computerUseOn : ts.computerUseOff,
      activeCount: String(active.length),
      unavailableCount: String(unavailable.length),
    });

    const activeLines = active.map((entry) => {
      let note = '';
      if (entry.policy.decision === 'confirm') {
        note += format(ts.notePolicyConfirm, { reason: entry.policy.reason ?? '' });
      }
      if (entry.concurrencySafety === 'input-dependent') {
        note += ts.noteConcurrencyInputDependent;
      }
      if (entry.name === TOOL_NAMES.COMPUTER && !snapshot.computerUseEnabled) {
        note += ts.noteComputerUseDisabled;
      }
      return format(ts.activeLine, {
        name: entry.name,
        source: formatSource(ts, entry.source),
        note,
      });
    });

    const unavailableLines = unavailable.map((entry) => format(ts.unavailableLine, {
      name: entry.name,
      source: formatSource(ts, entry.source),
      reasons: entry.unavailableReasons.map((r) => formatReason(ts, r)).join(i18n.toolResult.listSeparator),
    }));

    return [
      header,
      '',
      ts.activeSectionLabel,
      ...(activeLines.length > 0 ? activeLines : [ts.noneUnavailable]),
      '',
      ts.unavailableSectionLabel,
      ...(unavailableLines.length > 0 ? unavailableLines : [ts.noneUnavailable]),
    ].join('\n');
  },
};
