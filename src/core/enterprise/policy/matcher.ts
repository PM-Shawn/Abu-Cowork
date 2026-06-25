// src/core/enterprise/policy/matcher.ts
// Pure functions that check whether a tool/skill/mcp/path call is allowed
// under the current EffectivePolicy snapshot.
import type { EffectivePolicy } from './types'

/** Convert a simple glob pattern (* = any chars) to a RegExp. */
function globToRegex(pat: string): RegExp {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp('^' + esc, 'i')
}

export interface ToolCheckResult {
  decision: 'allow' | 'deny' | 'confirm'
  reason?: string
}

/**
 * Check whether calling `tool` with `inputSummary` is allowed.
 * Blacklist entries take priority over require-confirmation entries.
 */
export function checkTool(
  policy: EffectivePolicy | null,
  tool: string,
  inputSummary: string,
): ToolCheckResult {
  if (!policy) return { decision: 'allow' }

  for (const entry of policy.toolBlacklist) {
    if (entry.tool !== tool) continue
    if (!entry.inputPattern || globToRegex(entry.inputPattern).test(inputSummary)) {
      return {
        decision: 'deny',
        reason: `tool '${tool}' blocked by policy${entry.inputPattern ? ` (pattern: ${entry.inputPattern})` : ''}`,
      }
    }
  }

  for (const entry of policy.toolRequireConfirmation) {
    if (entry.tool !== tool) continue
    if (!entry.inputPattern || globToRegex(entry.inputPattern).test(inputSummary)) {
      return {
        decision: 'confirm',
        reason: entry.reason ?? `tool '${tool}' requires confirmation by policy`,
      }
    }
  }

  return { decision: 'allow' }
}

/** Check whether a skill (by name) may be installed or invoked. */
export function checkSkill(
  policy: EffectivePolicy | null,
  skillName: string,
): ToolCheckResult {
  if (!policy) return { decision: 'allow' }
  if (policy.skillBlacklist.includes(skillName)) {
    return { decision: 'deny', reason: `skill '${skillName}' blocked by policy` }
  }
  return { decision: 'allow' }
}

/** Check whether an MCP server (by registry id) may be connected. */
export function checkMcp(
  policy: EffectivePolicy | null,
  registryId: string,
): ToolCheckResult {
  if (!policy) return { decision: 'allow' }
  if (policy.mcpBlacklist.includes(registryId)) {
    return { decision: 'deny', reason: `MCP '${registryId}' blocked by policy` }
  }
  return { decision: 'allow' }
}

/**
 * Check whether a file path may be accessed.
 * Blocklist is checked first; if an allowlist is set, anything outside it is denied.
 */
export function checkFilePath(
  policy: EffectivePolicy | null,
  path: string,
): ToolCheckResult {
  if (!policy) return { decision: 'allow' }

  // Blocklist — substring prefix match OR glob pattern
  for (const blocked of policy.filePathBlocklist) {
    if (path.startsWith(blocked) || globToRegex(blocked).test(path)) {
      return { decision: 'deny', reason: `path '${path}' blocked by policy (rule: ${blocked})` }
    }
  }

  // Allowlist — if non-empty, paths outside it are denied
  if (policy.filePathAllowlist.length > 0) {
    const ok = policy.filePathAllowlist.some(
      (allowed) => path.startsWith(allowed) || globToRegex(allowed).test(path),
    )
    if (!ok) return { decision: 'deny', reason: `path '${path}' not in allowlist` }
  }

  return { decision: 'allow' }
}
