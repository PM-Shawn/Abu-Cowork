import { describe, expect, it } from 'vitest'
import { AgentRegistry, getBuiltinAgentNames } from './registry'
import { resolveSubagentToolNames } from '@/core/agent/subagentToolRoster'
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

describe('builtin Agent tool boundaries', () => {
  const registry = new AgentRegistry()
  ;(registry as unknown as { registerBuiltins: () => void }).registerBuiltins()
  const businessTools = [
    'read_file', 'write_file', 'edit_file', 'list_directory', 'run_command', 'web_search',
    'abu-browser__screenshot', 'abu-browser-bridge__click', 'runtime-service__inspect',
  ]
  const runtimeTools = [...businessTools, 'delegate_to_agent', 'run_agent_batch', 'update_soul', 'ask_user_question']

  it.each([
    '高级开发工程师',
    '产品经理',
    '数据分析师',
    '公众号编辑',
    'HR 招聘官',
  ])('%s inherits runtime business tools without a job-specific boundary', (name) => {
    const agent = registry.getAgent(name)
    expect(agent).toBeDefined()
    expect(agent?.tools).toBeUndefined()
    expect(agent?.disallowedTools).toBeUndefined()
    expect(resolveSubagentToolNames(runtimeTools, agent!)).toEqual({ toolNames: businessTools })
  })
})

describe('getBuiltinAgentNames', () => {
  it('lists exactly the agents registerBuiltins registers', () => {
    // The plugin installer refuses a package agent whose name is a built-in,
    // and it reads that answer from this set instead of building a registry.
    // A built-in added to `registerBuiltins` but not to the set would leave a
    // name a package could quietly take over, so the two are pinned together.
    const registry = new AgentRegistry()
    ;(registry as unknown as { registerBuiltins: () => void }).registerBuiltins()

    expect([...getBuiltinAgentNames()].sort()).toEqual(
      registry.getAvailableAgents().map(agent => agent.name).sort(),
    )
  })
})
