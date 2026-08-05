import { describe, expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])
const refreshEnterpriseSession = vi.hoisted(() => vi.fn(async () => { order.push('refresh') }))
const startHeartbeat = vi.hoisted(() => vi.fn(() => { order.push('heartbeat') }))
const initEnterpriseModules = vi.hoisted(() => vi.fn(async () => { order.push('modules') }))

vi.mock('../heartbeat', () => ({ refreshEnterpriseSession, startHeartbeat }))
vi.mock('@enterprise-modules', () => ({ initEnterpriseModules }))

import { activateEnterpriseRuntime } from '../runtime'

describe('activateEnterpriseRuntime', () => {
  it('revalidates the server session before starting local enterprise modules', async () => {
    await activateEnterpriseRuntime()

    expect(order).toEqual(['refresh', 'modules', 'heartbeat'])
    expect(startHeartbeat).toHaveBeenCalledWith({ immediate: false })
  })
})
