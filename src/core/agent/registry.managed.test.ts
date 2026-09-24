import { describe, expect, it } from 'vitest'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { AgentRegistry, getBuiltinAgentNames } from './registry'
import { resolveSubagentToolNames } from '@/core/agent/subagentToolRoster'
import { agentToolPolicyForRoute, resolveAgentToolNames } from '@/core/agent/agentToolPolicy'
import { parseAvatarValue } from '@/core/team/avatarPresets'
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

  // The administrator's catalog is seeded with the experts Abu ships, so the
  // shipped copy steps aside for the organization's version of that name.
  it('hands a shipped expert\'s name to the organization copy of it', () => {
    const registry = new AgentRegistry()
    registry.registerManagedSource('enterprise', () => true)
    const internals = registry as unknown as { agents: Map<string, SubagentDefinition> }
    internals.agents.set('org-reviewer', {
      ...definition(), managed: undefined, filePath: '__builtin__', systemPrompt: 'Shipped prompt.',
    })
    registry.replaceManagedAgents('enterprise', [definition()])
    expect(registry.getAgent('org-reviewer')?.systemPrompt).toBe('Review the supplied material.')
    expect(registry.getAvailableAgents().filter(item => item.name === 'org-reviewer')).toHaveLength(1)
  })

  // `abu` itself is a shipped expert the catalog does not carry, and the app
  // has no assistant without it.
  it('keeps a shipped expert the organization catalog does not carry', () => {
    const registry = new AgentRegistry()
    registry.registerManagedSource('enterprise', () => true)
    const internals = registry as unknown as { agents: Map<string, SubagentDefinition> }
    internals.agents.set('abu', {
      ...definition(), name: 'abu', managed: undefined, filePath: '__builtin__', systemPrompt: 'Shipped prompt.',
    })
    registry.replaceManagedAgents('enterprise', [definition()])
    expect(registry.getAgent('abu')?.systemPrompt).toBe('Shipped prompt.')
    expect(registry.getAvailableAgents().map(item => item.name)).toContain('abu')
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
    '办公文档专家',
    '行业调研专家',
    '网页设计师',
    '测试工程师',
    '行政助理',
    '财务助理',
    '合同审阅专家',
  ])('%s inherits runtime business tools without a job-specific boundary', (name) => {
    const agent = registry.getAgent(name)
    expect(agent).toBeDefined()
    expect(agent?.tools).toBeUndefined()
    expect(agent?.disallowedTools).toBeUndefined()
    expect(resolveSubagentToolNames(runtimeTools, agent!)).toEqual({ toolNames: businessTools })
  })

  // Pins the rule, not today's five names: a built-in expert added later with
  // a hand-written `tools:` array fails here, because inheriting the runtime
  // inventory is the default for every expert but the root agent.
  it('writes no tool boundary into any built-in expert other than the root agent', () => {
    const experts = registry.getAvailableAgents()
      .map(item => registry.getAgent(item.name)!)
      .filter(agent => agent.name !== 'abu')

    expect(experts).toHaveLength(12)
    for (const agent of experts) {
      expect({ name: agent.name, tools: agent.tools, disallowedTools: agent.disallowedTools })
        .toEqual({ name: agent.name, tools: undefined, disallowedTools: undefined })
      // Run as a delegated member: the whole runtime inventory minus the tools
      // a member may never hold.
      expect(resolveSubagentToolNames(runtimeTools, agent)).toEqual({ toolNames: businessTools })
      // The same expert routed as the main loop's agent: its role policy adds
      // no boundary of its own, so nothing is dropped.
      expect(resolveAgentToolNames(runtimeTools, agentToolPolicyForRoute({
        type: 'agent', name: agent.name, definition: agent, cleanInput: '',
      })!)).toEqual({ toolNames: runtimeTools })
    }
  })
})

describe('builtin expert skill preloads', () => {
  // A `skills:` entry is PRELOADED into the expert's system prompt at every
  // turn, not looked up on demand — so a SKILL.md that grows into a manual
  // silently taxes every conversation that expert takes part in. 5 KB is the
  // ceiling the shipped set was written against.
  it('built-in experts only preload SKILL.md files of 5 KB or less', () => {
    const registry = new AgentRegistry()
    ;(registry as unknown as { registerBuiltins: () => void }).registerBuiltins()
    const limit = 5 * 1024
    let preloads = 0
    for (const meta of registry.getAvailableAgents()) {
      const agent = registry.getAgent(meta.name)!
      for (const skill of agent.skills ?? []) {
        const size = statSync(join(process.cwd(), 'builtin-skills', skill, 'SKILL.md')).size
        expect(size, `${meta.name} preloads ${skill}`).toBeLessThanOrEqual(limit)
        preloads += 1
      }
    }
    // Guards the guard: a rename that empties every `skills:` array would make
    // the loop above pass without reading a single file.
    expect(preloads).toBeGreaterThan(0)
  })
})

describe('builtin expert avatars', () => {
  // Ruling 2026-09-13: every preset expert carries an icon of its own instead
  // of the uniform robot mark. Pinning the parse — not the literal strings —
  // catches a raw emoji or a typo'd icon/tint sneaking back in, since either
  // degrades to `default` at render time without failing anything else.
  it('gives every built-in expert but the root agent an icon reference', () => {
    const registry = new AgentRegistry()
    ;(registry as unknown as { registerBuiltins: () => void }).registerBuiltins()
    const experts = registry.getAvailableAgents()
      .map(item => registry.getAgent(item.name)!)
      .filter(agent => agent.name !== 'abu')

    expect(experts).toHaveLength(12)
    expect(experts.map(agent => [agent.name, parseAvatarValue(agent.avatar).kind])).toEqual(
      experts.map(agent => [agent.name, 'icon']),
    )
  })

  // The root agent renders its own mascot image, keyed off the name, so its
  // avatar field is deliberately not an icon reference.
  it('leaves the root agent alone', () => {
    const registry = new AgentRegistry()
    ;(registry as unknown as { registerBuiltins: () => void }).registerBuiltins()
    expect(parseAvatarValue(registry.getAgent('abu')?.avatar).kind).toBe('emoji')
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
