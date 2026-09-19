export type BrowserPermissionResource = 'browse' | 'upload' | 'script';
export type BrowserDefaultDecision = 'allow' | 'ask' | 'deny';
export type BrowserSiteOverride = 'inherit' | BrowserDefaultDecision;
export interface BrowserPermissionDefaultInput {
  defaults: Record<BrowserPermissionResource, BrowserDefaultDecision>;
  resource: BrowserPermissionResource;
  siteOverride?: BrowserSiteOverride;
  siteBlocked: boolean;
}
export interface BrowserPermissionDefaultResult {
  decision: BrowserDefaultDecision;
  source: 'site-block' | 'site' | 'default';
}
/** User configuration only. This is not the final authorization decision. */
export function resolveBrowserPermissionDefault(
  input: BrowserPermissionDefaultInput,
): BrowserPermissionDefaultResult {
  if (input.siteBlocked) return { decision: 'deny', source: 'site-block' };
  if (input.siteOverride !== undefined && input.siteOverride !== 'inherit') {
    return { decision: input.siteOverride, source: 'site' };
  }
  return { decision: input.defaults[input.resource], source: 'default' };
}
