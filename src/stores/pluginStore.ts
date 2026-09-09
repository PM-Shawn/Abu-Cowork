import { finishPluginConfiguration, sweepPluginConfigurations } from '@/core/plugin/configuration';
import { preparePluginSnapshot, releasePluginSnapshot } from '@/core/plugin/snapshotBridge';
import { useChatStore } from './chatStore';
import { pluginOwnerForSkill } from '@/core/plugin/activationPolicy';
import { skillLoader } from '@/core/skill/loader';
import { agentRegistry } from '@/core/agent/registry';
import { format, getI18n } from '@/i18n';
/**
 * UI-side state for the plugin system.
 *
 * State with deliberately different lifetimes:
 *
 * - `marketplaces` is **persisted**. It is only the user's list of local
 *   marketplace directories — a pointer, not a cache. Entries are re-read from
 *   disk on every browse so a marketplace the user updated (git pull) is never
 *   served stale from localStorage.
 * - `installed` is **not persisted**. `~/.abu/plugin-packages/installed.json`
 *   is the single source of truth for what is installed; mirroring it into
 *   localStorage would create a second truth that can disagree with disk after
 *   a manual edit, a failed uninstall, or a profile copy.
 * - `activationByKey` persists the independent master preference and the last
 *   verified capability ownership snapshot. Runtime admission stays protected
 *   while discovery/installed records are loading or unreadable; successful
 *   reconciliation refreshes ownership without rewriting child preferences.
 *
 * ## The security-critical part
 *
 * Every path that changes the installed set MUST end with
 * `setPluginServerNames(mcpServerNamesOf(installed))`, where `installed` came
 * from a read that is KNOWN to have succeeded.
 *
 * `pluginToolPolicy` keeps that name set in a module-level variable because
 * `registry.ts` classifies tools on a synchronous hot path. Nothing re-reads
 * it from disk on its own. So if an install does not refresh it, the freshly
 * installed plugin's MCP tools fall through to
 * `decideConsequentialTool`'s `if (consequence !== 'state-changing') return 'allow'`
 * and execute third-party code with **no approval prompt at all**. Symmetrically,
 * an uninstall that does not refresh leaves a stale name (and its live
 * conversation grant) that a same-named plugin could later ride.
 *
 * That refresh is centralised in `refreshInstalled`, which install/uninstall
 * both delegate to, so a future action cannot forget it by adding a new code
 * path — and it is pinned by tests in pluginStore.test.ts.
 *
 * The same reasoning runs the other way for FAILED reads: `installed.json`
 * being unreadable looks identical to "nothing is installed" if you only have
 * a list, and acting on that would empty the gate — for the session and, since
 * the names are persisted, for the next launch too. So `refreshInstalled`
 * takes the discriminated `readInstalledResult` and writes nothing at all when
 * the read failed. The gate only ever moves on evidence.
 */

import { homeDir } from '@tauri-apps/api/path';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { installPlugin, validatePreparedInstall, prepareInstallRecord } from '@/core/plugin/installer';
import { uninstallPlugin } from '@/core/plugin/uninstaller';
import { readInstalledResult, upsertInstalled, type InstalledPlugin } from '@/core/plugin/installedStore';
import { BUILTIN_MARKET_NAME } from '@/core/plugin/builtinMarket';
import { registerPluginServers, deregisterPluginServers, type McpStoreOps } from '@/core/plugin/pluginMcpBridge';
import { useMCPStore } from '@/stores/mcpStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { publishPluginActivation, reconcilePluginActivation, sanitizePluginActivations, pluginOwnerForMcp, type PluginActivations } from '@/core/plugin/activationPolicy';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { copyPluginDir, removePluginDir } from '@/core/plugin/fsOps';
import { fetchRemotePluginSource } from '@/core/plugin/remoteFetch';
import { mcpServerNamesOf } from '@/core/plugin/skillRoots';
import { expandHome, loadMarketplaceFromDir } from '@/core/plugin/loadMarketplace';
import { installedByEntryName, updateAvailableKeysFor } from '@/core/plugin/updateCheck';
import { setPluginServerNames } from '@/core/permissions/pluginToolPolicy';
import { ENTERPRISE_MARKET_NAME } from '@/core/plugin/enterpriseMarket';
import { parsePluginKey } from '@/core/plugin/paths';
import type { MarketplaceEntry } from '@/core/plugin/marketplace';
import { hasPluginOperationHost, beginPluginOperation, commitPluginOperation, recoverPluginOperation, pluginOperationStatus,
  acknowledgePluginOperation, runPluginOperation, type PluginOperationResult, type PluginRuntimeSnapshot } from '@/core/plugin/operationBridge';
import { runtimeAfterInstall } from '@/core/plugin/runtimeTransition';
import { acquirePluginChange } from '@/core/plugin/runtimeLease';

let applyingPluginRuntime = false;

/** A marketplace directory the user added. `dir` is absolute (tilde expanded). */
export interface MarketplaceRef {
  name: string;
  dir: string;
  /**
   * The Abu official market that ships with the app. Injected at runtime (its
   * dir is a resolved resource path), never persisted, and not user-removable.
   */
  builtin?: boolean;
}

export interface InstallRequest {
  pluginConfiguration?: string;
  enableMcp?: boolean;
  preparedToken?: string;
  home: string;
  marketplaceName: string;
  marketplaceDir: string;
  entry: Pick<MarketplaceEntry, 'name' | 'source'>;
  /** Content hash of the verified artifact, carried through to the install record. */
  checksum?: string;
}

/** Install request plus the installed key to replace. */
export interface UpdateRequest extends InstallRequest {
  key: string;
}

interface PluginState {
  activationByKey: PluginActivations;
  activationReady: boolean;
  recoveryError: string | null;
  /** Persisted: local marketplace directories the user added. */
  marketplaces: MarketplaceRef[];
  /** Runtime mirror of installed.json — never persisted (see module doc). */
  installed: InstalledPlugin[];
  /**
   * MCP server names contributed by installed plugins, **persisted**.
   *
   * Not a cache of convenience — it closes a boot-time hole. The approval gate
   * lives in a module-level Set that starts empty, and `installed.json` can
   * only be read asynchronously. Between app start and the first successful
   * `refreshInstalled`, `classifyPluginTool` would answer `null` for every
   * plugin tool, i.e. exactly the silent-execution gap this whole module
   * exists to close. Persisted names are rehydrated synchronously from
   * localStorage, so the gate is armed before the first tool call.
   *
   * Drift is safe in one direction only, and this is that direction: a stale
   * extra name over-gates (one needless prompt), a missing name under-gates
   * (silent third-party execution). `refreshInstalled` reconciles from disk.
   */
  knownMcpServerNames: string[];
  /**
   * Keys (`pluginKey(name, marketplace)`) of installs with a newer version
   * available, split by scope (personal marketplace vs. the enterprise
   * catalog) via {@link setUpdateAvailableKeys}. **Not persisted** —
   * unlike `knownMcpServerNames` this drives a UI badge, not a security
   * gate, and staleness across reloads (a plugin updated by someone else
   * while the app was closed) is the correct default rather than a bug to
   * work around: the next browse/sync recomputes it from scratch.
   */
  updateAvailableKeys: string[];
  /**
   * `updateAvailableKeys.length`, kept as a field rather than derived in each
   * consumer so the two badges (sidebar 「扩展」 entry, 插件 tab label) can
   * subscribe to a primitive instead of re-rendering on every array identity
   * change. Every write goes through {@link updateKeysPatch}, which is the
   * only way the two can be set — so they cannot drift apart.
   */
  updateAvailableCount: number;
  loading: boolean;
  error: string | null;
}

interface PluginActions {
  setPluginEnabled: (key: string, enabled: boolean) => Promise<void>;
  /** Add (or replace, by name) a marketplace pointer. */
  addMarketplace: (name: string, dir: string) => void;
  removeMarketplace: (name: string) => void;
  /** Inject/refresh the always-present built-in market at a resolved dir. */
  ensureBuiltinMarketplace: (dir: string) => void;
  /**
   * Re-read installed.json and re-arm the MCP approval gate.
   *
   * A read failure is a no-op, not an empty result — see the module doc.
   * `skipDiscovery` is for the one caller that has just triggered a discovery
   * scan of its own (app start); every other caller wants the default.
   */
  refreshInstalled: (home: string, options?: { skipDiscovery?: boolean; strict?: boolean }) => Promise<void>;
  install: (req: InstallRequest) => Promise<InstalledPlugin>;
  uninstall: (home: string, key: string) => Promise<void>;
  /**
   * Replace an installed plugin with a newer version: uninstall the old
   * (removes its version dir + deregisters its MCP servers) then install the
   * new. A plugin server re-registers DISABLED, so a new version's connector
   * requires fresh consent — reasonable when its command may have changed.
   */
  update: (req: UpdateRequest) => Promise<InstalledPlugin>;
  clearError: () => void;
  /**
   * Replace the update-available keys for one scope, leaving the other
   * scope's keys untouched. A private enterprise sync calls this with
   * `'organization'`; the marketplace browser calls it with `'personal'`.
   * De-duped and sorted so the sidebar badge and Plugins-tab count read a
   * stable, order-independent list.
   */
  setUpdateAvailableKeys: (keys: string[], scope: 'personal' | 'organization') => void;
  /**
   * Rescan every added (personal) marketplace and replace the personal-scope
   * update flags with the union across all of them.
   *
   * Reads each market the same way the browser does (`loadMarketplaceFromDir`
   * + `installedByEntryName`), so the badge count and the market's own
   * 「更新」 rows can never disagree. No new network traffic: a local market
   * is a directory read, and a git one was already cloned when it was added.
   * There is no timer either — it runs at app start, when the market panel
   * opens, and after an install/uninstall.
   */
  recomputeUpdates: (home: string) => Promise<void>;
}

export type PluginStore = PluginState & PluginActions;

/**
 * Adapt the MCP store to the small surface the plugin bridge needs. Read at
 * call time so it always reflects the live store.
 */
function getMcpStoreOps(): McpStoreOps {
  return {
    has: (name) => name in useMCPStore.getState().servers,
    addServer: (config) => useMCPStore.getState().addServer(config),
    removeServer: (name) => useMCPStore.getState().removeServer(name),
  };
}

/**
 * The only way to write the update flags: keys and their count in one patch,
 * so a badge can never show a stale number for a list that has changed.
 */
function updateKeysPatch(keys: string[]): { updateAvailableKeys: string[]; updateAvailableCount: number } {
  return { updateAvailableKeys: keys, updateAvailableCount: keys.length };
}

/**
 * Generation counter for `recomputeUpdates`. Two scans can overlap (the market
 * panel mounting while an install's scan is still reading marketplaces off
 * disk); without this the slower one would land last and overwrite the fresher
 * result. Monotonic and module-level on purpose — it needs no reset between
 * tests, since only "am I still the newest call" is ever asked.
 */
let recomputeSeq = 0;
// A replacement retains the old master intent without briefly enabling a new
// version during the install refresh. Full update rollback is a separate seam.
const updatingActivation = new Map<string, boolean>();
const managedChanges = new Set<string>();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const usePluginStore = create<PluginStore>()(
  persist(
    (set, get) => ({
      activationByKey: {},
      activationReady: false,
      recoveryError: null,
      marketplaces: [],
      installed: [],
      knownMcpServerNames: [],
      updateAvailableKeys: [],
      updateAvailableCount: 0,
      loading: false,
      error: null,

      addMarketplace: (name, dir) => {
        // The enterprise market name is reserved for the organization-managed
        // catalog installed through the private module — a user-added market
        // must never be able to claim that identity.
        if (name === ENTERPRISE_MARKET_NAME || name.startsWith('author-')) {
          throw new Error(`reserved marketplace name: ${ENTERPRISE_MARKET_NAME}`);
        }
        // The built-in name is reserved; a user market must not be able to
        // shadow the official one out of the picker.
        if (name === BUILTIN_MARKET_NAME) return;
        set((state) => {
          const existing = state.marketplaces.find(m => m.name === name);
          if (existing) {
            if (existing.dir !== dir) throw new Error(getI18n().toolbox.pluginsMarketplaceNameConflict);
            return {};
          }
          if (state.marketplaces.some(m => m.dir === dir)) throw new Error(getI18n().toolbox.pluginsMarketplaceIdentityChanged);
          return { marketplaces: [...state.marketplaces, { name, dir }] };
        });
      },

      ensureBuiltinMarketplace: (dir) => {
        set((state) => {
          const others = state.marketplaces.filter((m) => m.name !== BUILTIN_MARKET_NAME);
          // Built-in leads the list so it is the market users land on first.
          return {
            marketplaces: [{ name: BUILTIN_MARKET_NAME, dir, builtin: true }, ...others],
          };
        });
      },

      removeMarketplace: (name) => {
        if (name === BUILTIN_MARKET_NAME) return; // the official market stays
        set((state) => ({
          marketplaces: state.marketplaces.filter((m) => m.name !== name),
          // A removed market can no longer be browsed, so its update flags
          // would otherwise sit in the badge count forever.
          ...updateKeysPatch(
            state.updateAvailableKeys.filter((k) => parsePluginKey(k)?.marketplace !== name),
          ),
        }));
      },

      refreshInstalled: async (home, options) => {
        const pending = hasPluginOperationHost() ? await pluginOperationStatus() : null;
        if ((pending || managedChanges.size > 0) && !applyingPluginRuntime) {
          set({ activationReady: false });
          if (options?.strict) throw new Error('Plugin recovery is still pending');
          return;
        }
        if (!options?.skipDiscovery) {
          if (options?.strict) await useDiscoveryStore.getState().refresh(undefined, { strict: true });
          else await useDiscoveryStore.getState().refresh().catch(() => undefined);
        }
        const result = await readInstalledResult(home);
        if (!result.ok) {
          // Fail closed. An unreadable manifest (half-written file, EACCES, a
          // `homeDir()` pointing somewhere odd) is NOT evidence that nothing
          // is installed, and treating it as such would narrow the approval
          // gate — the one direction of drift that is unsafe (module doc) —
          // then persist that narrowed gate for the next launch. Keep the
          // previous `installed` and leave the gate exactly as it is; the next
          // successful refresh reconciles.
          if (options?.strict) throw result.error;
          console.warn('[pluginStore] installed.json unreadable — keeping the previous plugin state:', result.error);
          return;
        }
        const installed = result.plugins;
        const settings = useSettingsStore.getState();
        const activationByKey = reconcilePluginActivation(get().activationByKey, installed, home, {
          skills: skillLoader.getAvailableSkills({ includeDisabledPlugins: true }).flatMap(meta => {
            const skill = skillLoader.getSkill(meta.name, { includeDisabledPlugins: true });
            return skill ? [skill] : [];
          }),
          agents: agentRegistry.getAvailableAgents({ includeDisabledPlugins: true }).flatMap(meta => {
            const agent = agentRegistry.getAgent(meta.name, { includeDisabledPlugins: true });
            return agent ? [agent] : [];
          }),
          disabledSkills: settings.disabledSkills,
          disabledAgents: settings.disabledAgents,
          servers: useMCPStore.getState().servers,
        });
        for (const key of updatingActivation.keys()) {
          if (Object.hasOwn(activationByKey, key)) activationByKey[key].enabled = false;
        }
        // Drop update flags whose install is gone (uninstall goes through
        // here) — the badge must not keep counting a plugin that no longer
        // exists on disk.
        set((state) => ({
          installed,
          activationByKey,
          activationReady: pending === null && managedChanges.size === 0,
          ...updateKeysPatch(
            state.updateAvailableKeys.filter((k) => installed.some((p) => p.key === k)),
          ),
        }));
        // Security-critical, not bookkeeping — see the module doc. Kept here
        // (rather than duplicated in install/uninstall) so every mutation path
        // that ends in a refresh re-arms the approval gate for free. Derived
        // from the records just read rather than from a second disk read, so
        // there is exactly one read that can fail, and it is the one guarded
        // above.
        const serverNames = mcpServerNamesOf(installed);
        set({ knownMcpServerNames: serverNames });
        setPluginServerNames(serverNames);

      },

      setPluginEnabled: async (key, enabled) => {
        if (managedChanges.has(key)) throw new Error(getI18n().toolbox.pluginsChanging);
        const activation = get().activationByKey[key];
        if (!activation || activation.conflicted || !get().installed.some(p => p.key === key)) throw new Error(format(getI18n().toolbox.pluginsDisabledCapability, { name: key }));
        // Zustand subscribers publish the runtime deny gate synchronously,
        // before any asynchronous disconnect. Child preferences never change.
        set(state => ({ activationByKey: { ...state.activationByKey, [key]: { ...activation, enabled } } }));
        const owned = activation.mcpServers.filter(name => pluginOwnerForMcp(name) === key);
        const results = await Promise.allSettled(owned.map(async name => {
          const mcp = useMCPStore.getState();
          if (!mcp.servers[name]) return;
          if (!enabled) await mcp.disconnectServer(name);
          else if (mcp.servers[name].config.enabled) {
            await mcp.connectServer(name);
            const server = useMCPStore.getState().servers[name];
            if (server?.status === 'error') throw new Error(server.error || name);
          }
        }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      },

      install: async (req) => {
        if (req.preparedToken && hasPluginOperationHost()) return managedPluginChange('install', req);
        set({ loading: true, error: null });
        try {
          const { record, mcpServers } = await installPlugin({
            preparedToken: req.preparedToken,
            home: req.home,
            marketplaceName: req.marketplaceName,
            marketplaceDir: req.marketplaceDir,
            entry: req.entry,
            checksum: req.checksum,
            // `copyPluginDir` resolves to a file count; the installer's seam
            // is void, so adapt rather than widen the contract.
            copyDir: async (from, to) => {
              await copyPluginDir(from, to);
            },
            // Privileged fetch for remote (url/git-subdir) sources; the main
            // process re-validates url, sha, and destination scope.
            fetchRemote: fetchRemotePluginSource,
          });
          // A remote install planned+copied out of a sha-scoped _remote
          // staging dir; drop it now the versioned dir owns the bytes.
          if (req.entry.source.kind !== 'relative') {
            await removePluginDir(
              `${req.home}/.abu/plugin-packages/${req.marketplaceName}/${req.entry.name}/_remote`,
            ).catch(() => undefined);
          }
          // Register the plugin's MCP servers — DISABLED, so nothing runs until
          // the user turns one on in the Connectors tab (see pluginMcpBridge).
          // Specs come from the install outcome, not a second planInstall.
          //
          // Registration is done BEFORE persisting, and the record is credited
          // with only the servers it ACTUALLY created (`registered`), never a
          // user's pre-existing server of the same name that registration
          // skipped. Otherwise uninstall/update — which delete every server in
          // `contributed` — would delete the user's server. (Security review
          // blocker #1.)
          let persistedRecord = record;
          if (mcpServers.length > 0) {
            const specs = Object.fromEntries(
              mcpServers.map(({ name, ...spec }) => [name, spec]),
            );
            const { registered } = registerPluginServers(specs, getMcpStoreOps());
            if (registered.length !== record.contributed.mcpServers.length) {
              persistedRecord = {
                ...record,
                contributed: { ...record.contributed, mcpServers: registered },
              };
            }
          }
          // installPlugin only puts the package on disk and describes the
          // record; persisting it is the caller's job.
          await upsertInstalled(req.home, persistedRecord);

          await get().refreshInstalled(req.home);
          // Re-score every market: the new version usually clears this
          // plugin's own flag, and whatever else moved on disk since the last
          // scan lands in the same pass. Best-effort — a badge that failed to
          // recompute must not turn a successful install into an error.
          await get().recomputeUpdates(req.home).catch(() => undefined);
          return persistedRecord;
        } catch (error) {
          set({ error: messageOf(error) });
          throw error;
        } finally {
          set({ loading: false });
        }
      },

      uninstall: async (home, key) => {
        if (hasPluginOperationHost()) { await managedPluginChange('uninstall', { home, key }); return; }
        set({ loading: true, error: null });
        try {
          if (get().activationByKey[key]) await get().setPluginEnabled(key, false);
          const { withdrawn } = await uninstallPlugin({
            home,
            key,
            removeDir: removePluginDir,
            // A user who deleted the folder by hand should still be able to
            // clear the record instead of being stuck with a ghost entry.
            tolerateMissingDir: true,
          });
          // Withdraw its MCP servers too, so a connector never outlives its
          // plugin. By name — the plugin was only ever credited with servers
          // it created (registration refuses to overwrite existing names).
          deregisterPluginServers(withdrawn.mcpServers, getMcpStoreOps());
          await get().refreshInstalled(home);
          // `refreshInstalled` already dropped this plugin's flag; the rescan
          // is for the rest (best-effort, same reasoning as install).
          await get().recomputeUpdates(home).catch(() => undefined);
        } catch (error) {
          set({ error: messageOf(error) });
          throw error;
        } finally {
          set({ loading: false });
        }
      },

      update: async (req) => {
        if (req.preparedToken && hasPluginOperationHost()) return managedPluginChange('update', req);
        // Keep execution gated through replacement and restore the user's
        // master preference only after success. Transactional rollback is separate.
        if (req.preparedToken) await validatePreparedInstall(req);
        const enabled = get().activationByKey[req.key]?.enabled;
        if (enabled !== undefined) updatingActivation.set(req.key, enabled);
        try {
          await get().uninstall(req.home, req.key);
          const record = await get().install({
            preparedToken: req.preparedToken,
            home: req.home,
            marketplaceName: req.marketplaceName,
            marketplaceDir: req.marketplaceDir,
            entry: req.entry,
            checksum: req.checksum,
          });
          updatingActivation.delete(req.key);
          if (enabled !== undefined) await get().setPluginEnabled(req.key, enabled);
          return record;
        } finally {
          updatingActivation.delete(req.key);
        }
      },

      clearError: () => set({ error: null }),

      setUpdateAvailableKeys: (keys, scope) => {
        const isOrg = (k: string) => parsePluginKey(k)?.marketplace === ENTERPRISE_MARKET_NAME;
        const kept = get().updateAvailableKeys.filter((k) => (scope === 'organization' ? !isOrg(k) : isOrg(k)));
        const next = [...new Set([...kept, ...keys.filter((k) => (scope === 'organization') === isOrg(k))])].sort();
        set(updateKeysPatch(next));
      },

      recomputeUpdates: async (home) => {
        const seq = ++recomputeSeq;
        const { marketplaces, installed } = get();
        const keys: string[] = [];
        for (const market of marketplaces) {
          // The organization catalog is not ours to score: its versions come
          // from the private catalog-sync, which reports them by calling
          // `setUpdateAvailableKeys(keys, 'organization')` — this same setter,
          // other scope. (Enterprise slot: nothing to change here.)
          if (market.name === ENTERPRISE_MARKET_NAME) continue;
          try {
            // Dirs are stored already expanded (see MarketplaceRef), so this
            // is belt-and-braces for a hand-edited localStorage value — and it
            // is the only thing `home` is needed for.
            const marketplace = await loadMarketplaceFromDir(expandHome(market.dir, home));
            if (marketplace.name !== market.name) continue;
            keys.push(
              ...updateAvailableKeysFor(
                marketplace.plugins,
                // Keyed by the market POINTER's name, matching how
                // `installer.ts` builds installed.json keys — not the
                // manifest's own `name`, which need not match.
                installedByEntryName(installed, market.name, marketplace.renames),
                market.name,
              ),
            );
            if (hasPluginOperationHost()) {
              const byName = installedByEntryName(installed, market.name, marketplace.renames);
              for (const entry of marketplace.plugins) {
                if (seq !== recomputeSeq) return;
                const previous = byName.get(entry.name);
                if (entry.source.kind !== 'relative' || !previous?.checksum) continue;
                let token: string | undefined;
                try {
                  const snapshot = await preparePluginSnapshot({ marketplaceDir: market.dir, marketplaceName: market.name, entryName: entry.name });
                  token = snapshot.token;
                  if (snapshot.checksum !== previous.checksum) keys.push(`${entry.name}@${market.name}`);
                } catch { /* Unavailable source never authorizes an update. */ }
                finally { if (token) await releasePluginSnapshot(token).catch(() => {}); }
              }
            }
          } catch {
            // A market whose manifest is missing or malformed contributes no
            // flags. The browser surfaces that failure with a readable error
            // when the user opens it; a badge is the wrong place to report it.
          }
        }
        // A newer scan started while this one was reading disk — its result is
        // the current one, so drop ours instead of overwriting it.
        if (seq !== recomputeSeq) return;
        get().setUpdateAvailableKeys(keys, 'personal');
      },
    }),
    {
      name: 'abu-plugins',
      version: 3,
      // Marketplace pointers + the approval-gate server names survive a reload.
      // `installed` is re-derived from disk on mount.
      partialize: (state) => ({
        marketplaces: state.marketplaces.filter((m) => !m.builtin),
        knownMcpServerNames: state.knownMcpServerNames,
        activationByKey: state.activationByKey,
      }),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Partial<PluginState>;
        if (version < 1) {
          // No shipped predecessor — anything claiming to be older than v1 is
          // an unknown shape, so start from an empty list rather than trusting it.
          return { marketplaces: [], knownMcpServerNames: [] };
        }
        return {
          marketplaces: Array.isArray(state.marketplaces) ? state.marketplaces : [],
          activationByKey: sanitizePluginActivations(state.activationByKey),
          // v1 had no persisted server names. Empty is the correct v1→v2 value:
          // the first refreshInstalled fills it from disk.
          knownMcpServerNames: Array.isArray(state.knownMcpServerNames)
            ? state.knownMcpServerNames
            : [],
        };
      },
      /**
       * Arm the approval gate the moment persisted state lands, before any
       * tool call can reach `classifyPluginTool`.
       */
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.activationByKey = sanitizePluginActivations(state.activationByKey);
          state.activationReady = false;
          setPluginServerNames(state.knownMcpServerNames ?? []);
          publishPluginActivation(state.activationByKey, state.knownMcpServerNames ?? [], false);
        }
      },
    },
  ),
);

usePluginStore.subscribe(state => publishPluginActivation(state.activationByKey, state.knownMcpServerNames, state.activationReady));

/**
 * App-start bootstrap for the plugin update badge.
 *
 * Hydrating `installed` is a precondition, not a bonus: `recomputeUpdates`
 * scores marketplaces AGAINST the installed set, so a scan that runs before
 * the hydrate lands would always report zero. Opening the 插件 tab used to be
 * the earliest hydrate (see PluginsTab's module doc) — which is exactly why a
 * user who never opened it never learned an update existed.
 *
 * Recovery errors stop automatic activation. Update badge refresh is best-effort.
 * Legacy behavior: every failure here degrades to "no badge", never to a
 * broken launch. The MCP approval gate does NOT depend on this running — it is
 * armed synchronously from persisted `knownMcpServerNames` on rehydrate, and a
 * failed manifest read here leaves it untouched rather than empty.
 *
 * Recovery precedes discovery. Tests/legacy callers may supply an already-started
 * discovery promise; the Electron application always lets this routine own boot.
 */
export async function bootstrapPluginUpdates(discoveryReady?: Promise<void>): Promise<void> {
  usePluginStore.setState({ recoveryError: null, activationReady: false });
  try {
  await discoveryReady;
  const home = await homeDir();
  if (hasPluginOperationHost()) {
    const recovery = await recoverPluginOperation();
    if (recovery) { await applyPluginRuntime(recovery, home); await acknowledgePluginOperation(recovery.id); }
  }
  if (!discoveryReady || hasPluginOperationHost()) await useDiscoveryStore.getState().refresh();
  await usePluginStore.getState().refreshInstalled(home, { skipDiscovery: true });
  // Startup hydration may have deferred plugin MCP connections until ownership was known.
  await useMCPStore.getState().connectAllEnabled();
  await usePluginStore.getState().recomputeUpdates(home).catch(() => undefined);
  await cleanupPluginConfiguration();
  } catch (error) {
    usePluginStore.setState({ recoveryError: messageOf(error), activationReady: false });
    throw error;
  }
}


function capturePluginRuntime(record: InstalledPlugin | undefined, next?: InstalledPlugin): PluginRuntimeSnapshot {
  const settings = useSettingsStore.getState();
  const servers = useMCPStore.getState().servers;
  const otherOwners = new Set(usePluginStore.getState().installed
    .filter(plugin => plugin.key !== (record?.key ?? next?.key)).flatMap(plugin => plugin.contributed.mcpServers));
  const owned = new Set((record?.contributed.mcpServers ?? []).filter(name => !otherOwners.has(name)));
  return {
    enabled: record ? usePluginStore.getState().activationByKey[record.key]?.enabled === true : false,
    // Null remembers absence so rollback can remove only newly introduced names.
    servers: Object.fromEntries([...new Set([...owned, ...(next?.contributed.mcpServers ?? [])])]
      .filter(name => !otherOwners.has(name) && (owned.has(name) || !servers[name]))
      .map(name => [name, servers[name] ? structuredClone(servers[name].config) : null])),
    disabledSkills: Object.fromEntries([...new Set([...(record?.contributed.skills ?? []), ...(next?.contributed.skills ?? [])])].map(name => [name, settings.disabledSkills.includes(name)])),
    disabledAgents: Object.fromEntries([...new Set([...(record?.contributed.agents ?? []), ...(next?.contributed.agents ?? [])])].map(name => [name, settings.disabledAgents.includes(name)])),
  };
}

async function applyPluginRuntime(resolution: PluginOperationResult, home: string): Promise<void> {
  const runtime = resolution.runtime;
  if (!runtime || typeof runtime.enabled !== 'boolean' || !runtime.servers || !runtime.disabledSkills || !runtime.disabledAgents) {
    throw new Error('Plugin recovery state is invalid');
  }
  const expected = resolution.expectedRuntime;
  const assertCurrentRuntime = () => {
    if (!expected) return;
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    for (const [name, desired] of Object.entries(runtime.servers)) {
      const actual = useMCPStore.getState().servers[name]?.config ?? null;
      if (canonical(actual) !== canonical(expected.servers[name] ?? null) && canonical(actual) !== canonical(desired)) {
        throw new Error(`Plugin configuration changed during installation: ${name}. Resolve the conflicting connector before retrying recovery.`);
      }
    }
    const settings = useSettingsStore.getState();
    for (const field of ['disabledSkills', 'disabledAgents'] as const) {
      for (const [name, desired] of Object.entries(runtime[field])) {
        const actual = settings[field].includes(name);
        if (actual !== (expected[field][name] ?? false) && actual !== desired) {
          throw new Error(`Plugin preference changed during installation: ${name}`);
        }
      }
    }
  }
  assertCurrentRuntime();
  for (const [name, config] of Object.entries(runtime.servers)) {
    const mcp = useMCPStore.getState();
    if (mcp.servers[name]) await mcp.disconnectServer(name);
    // A user can edit while disconnect is pending. Check again in the same
    // synchronous turn as remove/add, before replacing any configuration.
    assertCurrentRuntime();
    if (config === null) mcp.removeServer(name);
    else {
      // Replace the complete config: merge would retain a removed URL/env.
      if (mcp.servers[name]) mcp.removeServer(name);
      mcp.addServer(config);
    }
  }
  useSettingsStore.setState(state => {
    assertCurrentRuntime();
    return {
    disabledSkills: [...state.disabledSkills.filter(name => !Object.hasOwn(runtime.disabledSkills, name)),
      ...Object.keys(runtime.disabledSkills).filter(name => runtime.disabledSkills[name])],
    disabledAgents: [...state.disabledAgents.filter(name => !Object.hasOwn(runtime.disabledAgents, name)),
      ...Object.keys(runtime.disabledAgents).filter(name => runtime.disabledAgents[name])],
  }; });
  applyingPluginRuntime = true;
  try { await usePluginStore.getState().refreshInstalled(home, { strict: true }); }
  finally { applyingPluginRuntime = false; }
  assertCurrentRuntime();
  const activation = usePluginStore.getState().activationByKey[resolution.key];
  if (resolution.installed !== undefined && Boolean(activation) !== resolution.installed) {
    throw new Error('Plugin recovery could not restore the installed activation state');
  }
  if (activation) {
    // Do not connect until durable resolution and runtime reconstruction finish.
    usePluginStore.setState(state => ({ activationByKey: { ...state.activationByKey,
      [resolution.key]: { ...activation, enabled: runtime.enabled } } }));
  }
}

async function managedPluginChange(kind: 'install' | 'update', request: InstallRequest & { key?: string }): Promise<InstalledPlugin>;
async function managedPluginChange(kind: 'uninstall', request: { home: string; key: string }): Promise<null>;
async function managedPluginChange(kind: 'install' | 'update' | 'uninstall', request: (InstallRequest & { key?: string }) | { home: string; key: string }): Promise<InstalledPlugin | null> {
  const req = 'entry' in request ? request : undefined;
  const key = request.key ?? (req ? `${req.entry.name}@${req.marketplaceName}` : '');
  if (managedChanges.size > 0) throw new Error(getI18n().toolbox.pluginsChanging);
  const release = acquirePluginChange(key);
  managedChanges.add(key);
  const previous = usePluginStore.getState().installed.find(plugin => plugin.key === key);
  const wasEnabled = usePluginStore.getState().activationByKey[key]?.enabled === true;
  usePluginStore.setState({ loading: true, error: null, activationReady: false });
  try {
    const options = req ? { ...req, requireAllContributions: true, copyDir: async (from: string, to: string) => { await copyPluginDir(from, to); }, fetchRemote: fetchRemotePluginSource } : undefined;
    const candidate = options ? await prepareInstallRecord(options) : undefined;
    if (previous && Object.values(useChatStore.getState().conversations).some(conversation =>
      conversation.status === 'running' && conversation.activeSkills?.some(name => {
        const skill = skillLoader.getSkill(name, { includeDisabledPlugins: true });
        return skill && pluginOwnerForSkill(skill.skillDir) === key;
      }))) throw new Error(getI18n().toolbox.pluginsBusy);
    const runtime = capturePluginRuntime(previous, candidate);
    // Deny new use without changing the persisted activation intent. If the
    // app exits before begin, no journal is needed to recover that intent.
    if (previous) {
      for (const name of previous.contributed.mcpServers) {
        if (pluginOwnerForMcp(name) === key && useMCPStore.getState().servers[name]) {
          await useMCPStore.getState().disconnectServer(name);
        }
      }
    }
    // Keep all discovery-triggered reconciliations denied during replacement.

    const record = await runPluginOperation({
      begin: () => beginPluginOperation({ kind, key, record: candidate, token: req?.preparedToken, expected: previous ?? null, runtime }),
      stage: async () => {
        if (!options) return { record: null, runtime: { ...runtime, enabled: false,
          servers: Object.fromEntries(Object.keys(runtime.servers).map(name => [name, null])) } };
        const outcome = await installPlugin(options);
        const permitted = outcome.mcpServers.filter(server => Object.hasOwn(runtime.servers, server.name));
        const record = { ...outcome.record, contributed: { ...outcome.record.contributed, mcpServers: permitted.map(server => server.name) } };
        return { record, runtime: runtimeAfterInstall(runtime, permitted, record.contributed.skills, record.contributed.agents, kind === 'update', req?.enableMcp === true) };
      },
      commit: (id, outcome) => commitPluginOperation(id, outcome.record, outcome.runtime),
      recover: () => recoverPluginOperation(key),
      apply: async resolution => {
        await applyPluginRuntime(resolution, request.home);
      },
      unchanged: async () => {
        managedChanges.delete(key);
        if (previous) await usePluginStore.getState().setPluginEnabled(key, runtime.enabled);
      },
    });
    managedChanges.delete(key);
    await usePluginStore.getState().refreshInstalled(request.home);
    await useMCPStore.getState().connectAllEnabled();
    await usePluginStore.getState().recomputeUpdates(request.home).catch(() => undefined);
    return record.record;
  } catch (error) {
    // Only reopen admission after a verified terminal journal state. A failed
    // recovery keeps the gate closed and its backups available for retry.
    try {
      if (await pluginOperationStatus() === null) {
        managedChanges.delete(key);
        await usePluginStore.getState().refreshInstalled(request.home);
        if (previous) await usePluginStore.getState().setPluginEnabled(key, wasEnabled);
        await useMCPStore.getState().connectAllEnabled();
      }
    } catch { /* Preserve the operation error; unresolved plugins remain denied. */ }
    usePluginStore.setState({ error: messageOf(error), ...(!usePluginStore.getState().activationReady ? { recoveryError: messageOf(error) } : {}) });
    throw error;
  } finally {
    managedChanges.delete(key);
    usePluginStore.setState({ loading: false });
    release();
    await cleanupPluginConfiguration();
  }
}

export async function cleanupPluginConfiguration(reference?: string): Promise<void> {
  finishPluginConfiguration(reference);
  await sweepPluginConfigurations(() => {
    if (managedChanges.size || !usePluginStore.getState().activationReady || usePluginStore.getState().recoveryError) return null;
    return Object.values(useMCPStore.getState().servers).flatMap(server => server.config.pluginConfiguration ? [server.config.pluginConfiguration] : []);
  }).catch(error => console.warn('[pluginStore] Deferred unused configuration cleanup:', messageOf(error)));
}
