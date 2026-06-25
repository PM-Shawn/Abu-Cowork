// src/core/enterprise/mounts.tsx
// MountPoint component — kept in its own file so React Fast Refresh only sees
// component exports here. Registry functions and types live in mounts-registry.ts.

import type { ComponentType, ReactNode } from 'react'
import type { EnterpriseMounts } from './mounts-registry'
import { getEnterpriseMount } from './mounts-registry'

/** Convenience: render a component by mount key with props. */
export function MountPoint<K extends keyof EnterpriseMounts>({ slot, ...props }: { slot: K } & Record<string, unknown>): ReactNode {
  const Impl = getEnterpriseMount(slot) as ComponentType<Record<string, unknown>> | undefined
  return Impl ? <Impl {...props} /> : null
}
