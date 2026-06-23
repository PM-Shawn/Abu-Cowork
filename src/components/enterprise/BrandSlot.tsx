// src/components/enterprise/BrandSlot.tsx
import type { ComponentType } from 'react'
import type { BrandSlotProps } from '@/core/enterprise/mounts'
import { registerEnterpriseMount } from '@/core/enterprise/mounts'

function BrandSlot({ binding, config, size = 'sm' }: BrandSlotProps) {
  if (!binding) return null
  const name = config?.brand.name || binding.orgName || 'Enterprise'
  const logo = config?.brand.logoUrl ?? null
  const px = size === 'lg' ? 'h-8 w-8 text-base' : size === 'md' ? 'h-6 w-6 text-sm' : 'h-5 w-5 text-xs'
  return (
    <div className="flex items-center gap-2 text-neutral-200">
      {logo
        ? <img src={logo} alt="" className={`${px} rounded`} />
        : <span className={`${px} grid place-items-center rounded bg-orange-500/20 text-orange-400`}>🏢</span>}
      <span className="font-medium truncate">{name}</span>
    </div>
  )
}

registerEnterpriseMount('brandSlot', BrandSlot as ComponentType<BrandSlotProps>)

export default BrandSlot
