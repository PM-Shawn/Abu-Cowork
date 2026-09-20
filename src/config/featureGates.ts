/**
 * Compile-time build gates.
 *
 * These are build-target constants, NOT user preferences — do not confuse them
 * with the Labs (experimental features) system in `src/core/labs`, which is for
 * user-facing opt-in toggles. Todos + Inbox moved to Labs ('todos-inbox').
 */

// Injected at build time by vite.config.ts / vitest.config.ts `define`.
declare const __ENTERPRISE_BUILD__: boolean;

/**
 * True only in enterprise builds (`ABU_BUILD_TARGET=enterprise`). The
 * enterprise-mode UI (the "企业模式" System Settings entry + bind flow) is
 * protocol-layer code that lives in OSS by the open-core design, but it must
 * not be *surfaced* to OSS users — gate its visibility on this. The real
 * enterprise business modules are swapped in via the @enterprise-modules alias
 * in that build; see CLAUDE.md "Enterprise 代码隔离".
 */
export const IS_ENTERPRISE_BUILD: boolean = __ENTERPRISE_BUILD__;

/**
 * Personal accounts are not finished, so every surface that offers a personal
 * sign-in stays hidden: the sidebar sign-in row, the account settings page and
 * the personal button inside the account dialog. Enterprise sign-in has its own
 * gate above and ships on its own. Turn this on in the release that finishes
 * personal accounts; the code behind it is complete and tested.
 */
export const IS_PERSONAL_ACCOUNT_ENABLED: boolean = false;
