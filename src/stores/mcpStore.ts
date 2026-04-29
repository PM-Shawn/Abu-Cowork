/**
 * MCP Store - State management for MCP server connections
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { mcpManager, type MCPServerConfig } from '../core/mcp/client';

export interface MCPToolInfo {
  name: string;
  description?: string;
}

export interface MCPServerEntry {
  config: MCPServerConfig;
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting';
  tools: MCPToolInfo[];
  error?: string;
  lastConnectedAt?: number;
}

interface MCPState {
  /** All configured MCP servers */
  servers: Record<string, MCPServerEntry>;
  /** Is currently loading/refreshing status */
  isLoading: boolean;
}

interface MCPActions {
  /** Add a new server configuration */
  addServer: (config: MCPServerConfig) => void;
  /** Remove a server configuration */
  removeServer: (name: string) => void;
  /** Update server configuration */
  updateServer: (name: string, config: Partial<MCPServerConfig>) => void;
  /** Connect to a server */
  connectServer: (name: string) => Promise<void>;
  /** Disconnect from a server */
  disconnectServer: (name: string) => Promise<void>;
  /** Clear the stored error/status for a server (e.g. after a successful test) */
  clearServerError: (name: string) => void;
  /** Refresh all server statuses */
  refreshStatus: () => Promise<void>;
  /** Sync state from mcpManager */
  syncFromManager: () => void;
  /** Toggle server enabled state */
  toggleServerEnabled: (name: string) => void;
  /** Connect all enabled servers */
  connectAllEnabled: () => Promise<void>;
}

export type MCPStore = MCPState & MCPActions;

export const useMCPStore = create<MCPStore>()(
  persist(
    immer((set, get) => ({
      servers: {},
      isLoading: false,

      addServer: (config) => {
        set((state) => {
          state.servers[config.name] = {
            config: { ...config, enabled: config.enabled ?? true },
            status: 'disconnected',
            tools: [],
          };
        });
      },

      removeServer: (name) => {
        const entry = get().servers[name];
        if (entry?.status === 'connected') {
          mcpManager.disconnectServer(name).catch(console.error);
        }
        set((state) => {
          delete state.servers[name];
        });
      },

      updateServer: (name, config) => {
        set((state) => {
          const entry = state.servers[name];
          if (entry) {
            entry.config = { ...entry.config, ...config };
          }
        });
      },

      connectServer: async (name) => {
        const entry = get().servers[name];
        if (!entry) return;

        set((state) => {
          state.servers[name].status = 'connecting';
          state.servers[name].error = undefined;
        });

        try {
          await mcpManager.connectServer(entry.config);
          const toolDetails = mcpManager.getServerToolDetails(name);
          set((state) => {
            state.servers[name].status = 'connected';
            state.servers[name].tools = toolDetails;
            state.servers[name].lastConnectedAt = Date.now();
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          set((state) => {
            state.servers[name].status = 'error';
            state.servers[name].error = errorMsg;
          });
        }
      },

      disconnectServer: async (name) => {
        await mcpManager.disconnectServer(name);
        set((state) => {
          if (state.servers[name]) {
            state.servers[name].status = 'disconnected';
            state.servers[name].tools = [];
          }
        });
      },

      clearServerError: (name) => {
        set((state) => {
          const entry = state.servers[name];
          if (entry && entry.status === 'error') {
            entry.status = 'disconnected';
            entry.error = undefined;
          }
        });
      },

      refreshStatus: async () => {
        set((state) => {
          state.isLoading = true;
        });

        const statuses = mcpManager.getStatus();
        const connectedNames = new Set(statuses.map((s) => s.name));

        set((state) => {
          for (const name of Object.keys(state.servers)) {
            if (connectedNames.has(name)) {
              state.servers[name].status = 'connected';
              state.servers[name].tools = mcpManager.getServerToolDetails(name);
            } else if (state.servers[name].status === 'connected') {
              state.servers[name].status = 'disconnected';
              state.servers[name].tools = [];
            }
          }
          state.isLoading = false;
        });
      },

      syncFromManager: () => {
        const statuses = mcpManager.getStatus();
        const connectedNames = new Set(statuses.map((s) => s.name));

        set((state) => {
          for (const name of Object.keys(state.servers)) {
            if (connectedNames.has(name)) {
              state.servers[name].status = 'connected';
              state.servers[name].tools = mcpManager.getServerToolDetails(name);
            } else if (state.servers[name].status === 'connected') {
              state.servers[name].status = 'disconnected';
              state.servers[name].tools = [];
            }
          }
        });
      },

      toggleServerEnabled: (name) => {
        set((state) => {
          const entry = state.servers[name];
          if (entry) {
            entry.config.enabled = !entry.config.enabled;
          }
        });
      },

      connectAllEnabled: async () => {
        const servers = get().servers;
        const enabledServers = Object.values(servers).filter(
          (s) => s.config.enabled && s.status === 'disconnected'
        );

        await Promise.all(
          enabledServers.map((s) => get().connectServer(s.config.name))
        );
      },
    })),
    {
      name: 'abu-mcp-store',
      version: 1,
      // Only persist server configs, not runtime status
      partialize: (state) => ({
        servers: Object.fromEntries(
          Object.entries(state.servers).map(([name, entry]) => [
            name,
            {
              config: entry.config,
              status: 'disconnected' as const,
              tools: [],
            },
          ])
        ),
      }),
    }
  )
);

// Subscribe to mcpManager changes
let unsubscribe: (() => void) | null = null;

export function initMCPStoreSync() {
  if (unsubscribe) return;
  unsubscribe = mcpManager.subscribe(() => {
    useMCPStore.getState().syncFromManager();
  });
  // Auto-connect all enabled MCP servers on startup
  useMCPStore.getState().connectAllEnabled().catch((err) => {
    console.warn('[MCP] Auto-connect failed:', err);
  });
}

export function cleanupMCPStoreSync() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  mcpManager.disconnectAll().catch(console.error);
}

// --- Selector Hooks ---

export function useConnectedServers() {
  return useMCPStore((s) =>
    Object.values(s.servers).filter((e) => e.status === 'connected')
  );
}

export function useEnabledServers() {
  return useMCPStore((s) =>
    Object.values(s.servers).filter((e) => e.config.enabled)
  );
}

export function useServerCount() {
  return useMCPStore((s) => ({
    total: Object.keys(s.servers).length,
    connected: Object.values(s.servers).filter((e) => e.status === 'connected').length,
    enabled: Object.values(s.servers).filter((e) => e.config.enabled).length,
  }));
}
