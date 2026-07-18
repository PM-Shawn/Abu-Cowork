// src/components/enterprise/BrandSlot.tsx
import type { ComponentType } from 'react'
import type { BrandSlotProps } from '@/core/enterprise/mounts-registry'
import { registerEnterpriseMount } from '@/core/enterprise/mounts-registry'

function BrandSlot({ binding, config, size = 'sm' }: BrandSlotProps) {
  if (!binding) return null
  const name = config?.brand.name || binding.orgName || 'Enterprise'
  const logo = config?.brand.logoUrl ?? null
  const px = size === 'lg' ? 'h-8 w-8 text-body' : size === 'md' ? 'h-6 w-6 text-body' : 'h-5 w-5 text-minor'
  return (
    <div className="flex items-center gap-2 text-neutral-200">
      {logo
        ? <img src={logo} alt="" className={`${px} rounded`} />
        : <span className={`${px} grid place-items-center rounded bg-[var(--abu-clay-20)] text-[var(--abu-clay)]`}>🏢</span>}
      <span className="font-medium truncate">{name}</span>
    </div>
  )
}

registerEnterpriseMount('brandSlot', BrandSlot as ComponentType<BrandSlotProps>)

export default BrandSlot
