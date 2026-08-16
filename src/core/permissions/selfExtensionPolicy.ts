/**
 * Self-extension consequence classification.
 *
 * Abu lets the agent grow its own capabilities — create subagents, install MCP
 * servers, rewrite its persona. That is a real product strength, but all three
 * write durable state that shapes every later turn, and the model can be
 * steered by whatever it just read (a web page, a document, a tool result).
 * Without a gate, one injected instruction buys a persistent foothold: an MCP
 * server that spawns processes, a subagent with an attacker-authored system
 * prompt, or a rewritten persona that survives into every future conversation.
 *
 * Skills already got this treatment (draft queue + content guard + audited
 * history). These three took the same kind of write with none of it.
 *
 * Unlike browser automation there is no per-conversation grant: these are rare,
 * deliberate acts, so each one is worth its own confirmation.
 */

import { TOOL_NAMES } from '../tools/toolNames';

/** manage_mcp_server actions that add a server (and therefore spawn processes or reach a URL). */
const MCP_INSTALLING_ACTIONS = new Set(['install', 'add_custom', 'ensure']);

export interface SelfExtensionAction {
  /** Short, human-readable description of what is about to be written. */
  summary: string;
}

/**
 * Classify a tool call that would extend the agent's own capabilities.
 * Returns null when the call does not write durable capability state.
 */
export function classifySelfExtension(
  name: string,
  input: Record<string, unknown>,
): SelfExtensionAction | null {
  if (name === TOOL_NAMES.SAVE_AGENT) {
    const agentName = typeof input.name === 'string' ? input.name : '';
    return { summary: agentName ? `save_agent: ${agentName}` : 'save_agent' };
  }

  if (name === TOOL_NAMES.UPDATE_SOUL) {
    return { summary: 'update_soul' };
  }

  if (name === TOOL_NAMES.MANAGE_MCP_SERVER) {
    const action = typeof input.action === 'string' ? input.action : '';
    if (!MCP_INSTALLING_ACTIONS.has(action)) return null;
    const target = typeof input.name === 'string' && input.name
      ? input.name
      : typeof input.query === 'string' ? input.query : '';
    return { summary: target ? `manage_mcp_server (${action}): ${target}` : `manage_mcp_server (${action})` };
  }

  return null;
}
