/**
 * UI-side state for the plugin system.
 *
 * Two halves with deliberately different lifetimes:
 *
 * - `marketplaces` is **persisted**. It is only the user's list of local
 *   marketplace directories — a pointer, not a cache. Entries are re-read from
 *   disk on every browse so a marketplace the user updated (git pull) is never
 *   served stale from localStorage.
 * - `installed` is **not persisted**. `~/.abu/plugin-packages/installed.json`
 *   is the single source of truth for what is installed; mirroring it into
 *   localStorage would create a second truth that can disagree with disk after
 *   a manual edit, a failed uninstall, or a profile copy.
 *
 * ## The security-critical part
 *
 * Every path that changes the installed set MUST end with
 * `setPluginServerNames(await pluginMcpServerNames(home))`.
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
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { installPlugin } from '@/core/plugin/installer';
import { uninstallPlugin } from '@/core/plugin/uninstaller';
import { readInstalled, upsertInstalled, type InstalledPlugin } from '@/core/plugin/installedStore';
import { BUILTIN_MARKET_NAME } from '@/core/plugin/builtinMarket';
import { registerPluginServers, deregisterPluginServers, type McpStoreOps } from '@/core/plugin/pluginMcpBridge';
import { useMCPStore } from '@/stores/mcpStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { copyPluginDir, removePluginDir } from '@/core/plugin/fsOps';
import { fetchRemotePluginSource } from '@/core/plugin/remoteFetch';
import { pluginMcpServerNames } from '@/core/plugin/skillRoots';
import { setPluginServerNames } from '@/core/permissions/pluginToolPolicy';
import { ENTERPRISE_MARKET_NAME } from '@/core/plugin/enterpriseMarket';
import { parsePluginKey } from '@/core/plugin/paths';
import type { MarketplaceEntry } from '@/core/plugin/marketplace';

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
  loading: boolean;
  error: string | null;
}

interface PluginActions {
  /** Add (or replace, by name) a marketplace pointer. */
  addMarketplace: (name: string, dir: string) => void;
  removeMarketplace: (name: string) => void;
  /** Inject/refresh the always-present built-in market at a resolved dir. */
  ensureBuiltinMarketplace: (dir: string) => void;
  /** Re-read installed.json and re-arm the MCP approval gate. */
  refreshInstalled: (home: string) => Promise<void>;
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const usePluginStore = create<PluginStore>()(
  persist(
    (set, get) => ({
      marketplaces: [],
      installed: [],
      knownMcpServerNames: [],
      updateAvailableKeys: [],
      loading: false,
      error: null,

      addMarketplace: (name, dir) => {
        // The enterprise market name is reserved for the organization-managed
        // catalog installed through the private module — a user-added market
        // must never be able to claim that identity.
        if (name === ENTERPRISE_MARKET_NAME) {
          throw new Error(`reserved marketplace name: ${ENTERPRISE_MARKET_NAME}`);
        }
        // The built-in name is reserved; a user market must not be able to
        // shadow the official one out of the picker.
        if (name === BUILTIN_MARKET_NAME) return;
        set((state) => {
          const rest = state.marketplaces.filter((m) => m.name !== name);
          const builtin = state.marketplaces.filter((m) => m.builtin);
          const users = rest.filter((m) => !m.builtin);
          return { marketplaces: [...builtin, ...users, { name, dir }] };
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
        set((state) => ({ marketplaces: state.marketplaces.filter((m) => m.name !== name) }));
      },

      refreshInstalled: async (home) => {
        const installed = await readInstalled(home);
        set({ installed });
        // Security-critical, not bookkeeping — see the module doc. Kept here
        // (rather than duplicated in install/uninstall) so every mutation path
        // that ends in a refresh re-arms the approval gate for free.
        const serverNames = await pluginMcpServerNames(home);
        set({ knownMcpServerNames: serverNames });
        setPluginServerNames(serverNames);
        // Re-scan skills so a plugin's skills appear immediately, without an
        // app restart. Plugin skills live under ~/.abu/plugin-packages, which
        // the registry fs-watcher does NOT observe (it watches ~/.abu/skills
        // and ~/.abu/agents only), so nothing else triggers this discovery.
        await useDiscoveryStore.getState().refresh().catch(() => undefined);
      },

      install: async (req) => {
        set({ loading: true, error: null });
        try {
          const { record, mcpServers } = await installPlugin({
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
              mcpServers.map((s) => [s.name, { command: s.command, args: s.args, url: s.url }]),
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
          return persistedRecord;
        } catch (error) {
          set({ error: messageOf(error) });
          throw error;
        } finally {
          set({ loading: false });
        }
      },

      uninstall: async (home, key) => {
        set({ loading: true, error: null });
        try {
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
        } catch (error) {
          set({ error: messageOf(error) });
          throw error;
        } finally {
          set({ loading: false });
        }
      },

      update: async (req) => {
        // Uninstall first; if it throws, install never runs and the old
        // version stays intact (no half-updated state).
        await get().uninstall(req.home, req.key);
        return get().install({
          home: req.home,
          marketplaceName: req.marketplaceName,
          marketplaceDir: req.marketplaceDir,
          entry: req.entry,
          checksum: req.checksum,
        });
      },

      clearError: () => set({ error: null }),

      setUpdateAvailableKeys: (keys, scope) => {
        const isOrg = (k: string) => parsePluginKey(k)?.marketplace === ENTERPRISE_MARKET_NAME;
        const kept = get().updateAvailableKeys.filter((k) => (scope === 'organization' ? !isOrg(k) : isOrg(k)));
        const next = [...new Set([...kept, ...keys.filter((k) => (scope === 'organization') === isOrg(k))])].sort();
        set({ updateAvailableKeys: next });
      },
    }),
    {
      name: 'abu-plugins',
      version: 2,
      // Marketplace pointers + the approval-gate server names survive a reload.
      // `installed` is re-derived from disk on mount.
      partialize: (state) => ({
        marketplaces: state.marketplaces.filter((m) => !m.builtin),
        knownMcpServerNames: state.knownMcpServerNames,
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
        if (state) setPluginServerNames(state.knownMcpServerNames ?? []);
      },
    },
  ),
);
