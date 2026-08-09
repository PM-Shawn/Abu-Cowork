/**
 * Enterprise runtime config + edition resolution for the Electron shell.
 *
 * OSS/enterprise boundary note: this is deliberately a DUMB reader — it
 * locates a JSON file, validates the minimal shape, and hands the content to
 * the renderer via __ABU_SHELL__. All enterprise semantics (auto-enroll,
 * URL locking, binding) live in the private enterprise-modules overlay;
 * an OSS renderer simply never reads the exposed value.
 *
 * Config file lookup order (first hit wins):
 *   1. ABU_ENTERPRISE_CONFIG=<path>   explicit override (dev / ops / tests)
 *   2. <resourceRoot>/abu-enterprise.json
 *        packaged: dropped in via electron-builder extraResources at
 *        per-customer packaging time; dev: repo root, gitignored
 *   3. OS managed location (MDM / admin deploys, survives app updates):
 *        macOS   /Library/Application Support/Abu/abu-enterprise.json
 *        Windows %ProgramData%\Abu\abu-enterprise.json
 *        Linux   /etc/abu/abu-enterprise.json
 *
 * Edition resolution (the "which build am I" startup parameter):
 *   ABU_EDITION > ABU_BUILD_TARGET > 'enterprise' if a config file resolved,
 *   else 'oss'. Dev scripts already export ABU_BUILD_TARGET; packaged
 *   enterprise apps normally rely on the config file's presence.
 *
 * Fail-open: a missing file is normal (OSS posture); a malformed file logs
 * one warning and is treated as absent — the shell must never crash over
 * deployment config.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_BASENAME = 'abu-enterprise.json';

/**
 * @param {NodeJS.Platform} platform
 * @param {NodeJS.ProcessEnv} env
 */
function managedConfigPath(platform, env) {
  if (platform === 'darwin') {
    return path.join('/Library/Application Support/Abu', CONFIG_BASENAME);
  }
  if (platform === 'win32') {
    const programData = env.ProgramData || 'C:\\ProgramData';
    return path.join(programData, 'Abu', CONFIG_BASENAME);
  }
  return path.join('/etc/abu', CONFIG_BASENAME);
}

/**
 * @param {string} resourceRootDir  resolved resource root (appEnv.resourceRoot(app))
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]  test injection
 * @returns {string[]} candidate paths in priority order
 */
function candidatePaths(resourceRootDir, opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const out = [];
  if (env.ABU_ENTERPRISE_CONFIG) out.push(env.ABU_ENTERPRISE_CONFIG);
  out.push(path.join(resourceRootDir, CONFIG_BASENAME));
  out.push(managedConfigPath(platform, env));
  return out;
}

/**
 * Validate + normalize the parsed JSON. Unknown keys are preserved so future
 * renderer-side consumers can ride along without a shell update.
 * @param {unknown} parsed
 * @returns {{ serverUrl?: string, lockServerUrl?: boolean, [k: string]: unknown } | null}
 */
function normalizeConfig(parsed) {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const cfg = /** @type {Record<string, unknown>} */ ({ ...parsed });
  if (cfg.serverUrl !== undefined) {
    if (typeof cfg.serverUrl !== 'string' || !/^https?:\/\//.test(cfg.serverUrl.trim())) return null;
    cfg.serverUrl = cfg.serverUrl.trim().replace(/\/$/, '');
  }
  if (cfg.lockServerUrl !== undefined && typeof cfg.lockServerUrl !== 'boolean') {
    delete cfg.lockServerUrl;
  }
  return cfg;
}

/**
 * @param {string} resourceRootDir
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [opts]
 * @returns {{ path: string, config: Record<string, unknown> } | null}
 */
function loadEnterpriseRuntimeConfig(resourceRootDir, opts = {}) {
  for (const p of candidatePaths(resourceRootDir, opts)) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue; // absent → next candidate
    }
    try {
      const config = normalizeConfig(JSON.parse(text));
      if (!config) {
        console.warn(`[enterpriseConfig] ${p} has an invalid shape — ignoring`);
        continue;
      }
      return { path: p, config };
    } catch (e) {
      console.warn(`[enterpriseConfig] failed to parse ${p}: ${/** @type {Error} */ (e).message}`);
      continue;
    }
  }
  return null;
}

/**
 * @param {{ path: string, config: Record<string, unknown> } | null} loaded
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {'enterprise' | 'oss'}
 */
function resolveEdition(loaded, env = process.env) {
  const explicit = env.ABU_EDITION || env.ABU_BUILD_TARGET;
  if (explicit === 'enterprise' || explicit === 'oss') return explicit;
  return loaded ? 'enterprise' : 'oss';
}

module.exports = {
  CONFIG_BASENAME,
  candidatePaths,
  normalizeConfig,
  loadEnterpriseRuntimeConfig,
  resolveEdition,
};
