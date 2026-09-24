/**
 * The app policy an organization sets for its employees (technical plan §5):
 * which app Abu opens in, and whether the employee may leave it.
 *
 * The public build forwards to `src/enterprise-modules-stub`, which answers
 * with the personal-mode defaults — no default app, free to switch. The
 * enterprise build answers from the signed `EnterpriseConfigSnapshot`
 * (`defaultAppId`, `allowExitDefaultApp`) and calls `enterApp` itself once the
 * employee has signed in; the apps the organization provides reach the
 * switcher through `appRegistry.registerAppSource`.
 */
export { useEnterpriseAppPolicy } from '@enterprise-modules';
export type { EnterpriseAppPolicy } from '@enterprise-modules';
