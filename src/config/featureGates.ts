/**
 * Temporary, compile-time feature gates.
 *
 * These hide not-yet-released features whose code already lives in the tree.
 * They are a stopgap until the Labs / experimental-features system exists — once
 * that lands, replace the constant reads with a Labs flag lookup (so users can
 * opt in) rather than deleting the gate.
 *
 * NOTE: this is deliberately NOT a persisted setting. Flipping the value (or
 * wiring it to Labs) is the only way to surface the feature — there is no
 * user-facing toggle yet by design.
 */

/**
 * Todos + Inbox (sidebar tabs, the "Add to Todos" chat action, and the
 * create_todo agent tool). Hidden for the v0.24 OSS release; the data stores
 * (`abu-todos` / `abu-inbox`) stay intact so nothing is lost when it ships.
 * Slated to become a Labs resident — see project-experimental-features-toggle.
 */
export const SHOW_TODOS_INBOX = false;

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
