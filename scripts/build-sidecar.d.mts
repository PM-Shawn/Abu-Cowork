/**
 * Declarations for `build-sidecar.mjs`'s exported shim maps, its two esbuild
 * plugins and the resolution options they belong with.
 *
 * The build script is plain JavaScript, so a TypeScript consumer
 * (`sidecar/src/shims/shimSurfaceCoverage.test.ts`, which pins the shim
 * surface guard to this map, and
 * `sidecar/src/conversationWriterBundle.contract.test.ts`, which runs its own
 * build with the same plugins and options) would otherwise import it as `any`
 * and fail `noImplicitAny`. The script's build entry point is not meant to be
 * imported.
 */
import type { Plugin } from 'esbuild';

/** A `src/**` module redirected to a sidecar-local shim. Both are absolute paths. */
export interface SidecarShimTarget {
  real: string;
  shim: string;
}

/** A bare node_modules package redirected to a sidecar-local shim. */
export interface SidecarBareShimTarget {
  specifier: string;
  shim: string;
}

export const SHIM_TARGETS: SidecarShimTarget[];
export const BARE_SPECIFIER_SHIMS: SidecarBareShimTarget[];

/** `alias` and `define` of the sidecar build. */
export const SIDECAR_BUILD_RESOLUTION: {
  alias: Record<string, string>;
  define: Record<string, string>;
};

/** Redirects the shimmed modules to their sidecar-local replacement. */
export const shimPlugin: Plugin;
/** Fails the build when the import graph reaches `@tauri-apps/*`, `src/stores/**` or `src/components/**`. */
export const bundleGraphGuardPlugin: Plugin;
