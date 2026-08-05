import { beforeEach, describe, expect, it } from 'vitest'
import { mcpManager } from './client'
import { useEnterpriseStore } from '@/stores/enterpriseStore'

beforeEach(() => {
  useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true })
})

describe('enterprise MCP entitlement', () => {
  it('blocks direct calls from a stale enterprise connection without a live authorized session', async () => {
    await expect(mcpManager.callTool('enterprise__stale-server', 'echo', {}))
      .rejects.toThrow('not authorized')
  })

  it('does not apply the enterprise gate to personal MCP servers', async () => {
    await expect(mcpManager.callTool('personal-server', 'echo', {}))
      .rejects.toThrow('not connected')
  })
})
