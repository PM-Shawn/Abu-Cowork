/**
 * Declarations for `build-sidecar.mjs`'s two exported shim maps.
 *
 * The build script is plain JavaScript, so a TypeScript consumer
 * (`sidecar/src/shims/shimSurfaceCoverage.test.ts`, which pins the shim
 * surface guard to this map) would otherwise import it as `any` and fail
 * `noImplicitAny`. Only the data exports are declared — the script's build
 * entry point is not meant to be imported.
 */

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
