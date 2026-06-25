// abu-opensource/src/enterprise-modules-stub/index.ts
/**
 * OSS stub for the enterprise plugin overlay.
 * Real implementation lives in the private @abu/enterprise-modules package.
 *
 * In OSS builds, this stub is what gets imported. Enterprise builds replace
 * it via Vite alias (@enterprise-modules → ../Abu-enterprise-modules/src).
 */

export async function initEnterpriseModules(): Promise<void> {
  // OSS noop. Enterprise mode UI is only mounted in enterprise builds.
  // (Brand badge / device-flow bind / policy confirm modal, etc. are part of
  //  the protocol layer in Abu-opensource and do NOT depend on this stub.)
}
