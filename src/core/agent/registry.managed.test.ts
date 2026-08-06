import { describe, expect, it } from 'vitest'
import { AgentRegistry } from './registry'
import type { SubagentDefinition } from '@/types'

function definition(ready = true): SubagentDefinition {
  return {
    name: 'org-reviewer',
    description: 'Organization reviewer',
    systemPrompt: 'Review the supplied material.',
    filePath: '__managed__:enterprise:agent-1:version-1',
    managed: {
      source: 'enterprise', id: 'agent-1', version: '1', readOnly: true, ready,
    },
  }
}

describe('managed Agent registry', () => {
  it('keeps managed definitions in memory and fails closed through the source guard', () => {
    const registry = new AgentRegistry()
    let active = false
    registry.registerManagedSource('enterprise', () => active)
    registry.replaceManagedAgents('enterprise', [definition()])

    expect(registry.getAgent('org-reviewer')).toBeUndefined()
    active = true
    expect(registry.getAgent('org-reviewer')?.systemPrompt).toContain('Review')
    expect(registry.getAvailableAgents().map(item => item.name)).toContain('org-reviewer')
    active = false
    expect(registry.getAvailableAgents()).toEqual([])
  })

  it('does not expose an Agent whose declared dependencies are unavailable', () => {
    const registry = new AgentRegistry()
    registry.registerManagedSource('enterprise', () => true)
    registry.replaceManagedAgents('enterprise', [definition(false)])
    expect(registry.getAgent('org-reviewer')).toBeUndefined()
  })

  it('keeps a local Agent authoritative when a managed source reuses its name', () => {
    const registry = new AgentRegistry()
    registry.registerManagedSource('enterprise', () => true)
    const internals = registry as unknown as { agents: Map<string, SubagentDefinition> }
    internals.agents.set('org-reviewer', { ...definition(), managed: undefined, filePath: '/tmp/AGENT.md', systemPrompt: 'Local prompt.' })
    registry.replaceManagedAgents('enterprise', [definition()])
    expect(registry.hasLocal('org-reviewer')).toBe(true)
    expect(registry.getAgent('org-reviewer')?.systemPrompt).toBe('Local prompt.')
    expect(registry.getAvailableAgents().filter(item => item.name === 'org-reviewer')).toHaveLength(1)
  })
})
