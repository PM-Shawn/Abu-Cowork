/**
 * The organization-managed plugin market.
 *
 * Shape only (open-core): the public repo knows the reserved marketplace
 * name so it can (a) keep enterprise installs out of the personal list and
 * (b) refuse a user-added market of the same name. Catalog fetch, download,
 * signature verification and policy live in the private module.
 */
import type { InstalledPlugin } from './installedStore';

export const ENTERPRISE_MARKET_NAME = 'enterprise' as const;

export function isEnterpriseInstall(p: Pick<InstalledPlugin, 'marketplace'>): boolean {
  return p.marketplace === ENTERPRISE_MARKET_NAME;
}

export function partitionInstalled(installed: InstalledPlugin[]): {
  personal: InstalledPlugin[];
  organization: InstalledPlugin[];
} {
  const personal: InstalledPlugin[] = [];
  const organization: InstalledPlugin[] = [];
  for (const p of installed) (isEnterpriseInstall(p) ? organization : personal).push(p);
  return { personal, organization };
}
