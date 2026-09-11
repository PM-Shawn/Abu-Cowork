import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import { authorizeWorkspace, revokeWorkspace } from '../core/tools/pathSafety';

export type PermissionDuration = 'once' | 'session' | '24h' | 'always';

function workspaceCapabilities(
  capabilities: PermissionGrant['capabilities'],
): ('read' | 'write')[] {
  return capabilities.filter((capability): capability is 'read' | 'write' => (
    capability === 'read' || capability === 'write'
  ));
}

export interface PermissionGrant {
  path: string;
  grantedAt: number;
  expiresAt: number | null;  // null = never expires
  capabilities: ('read' | 'write' | 'execute')[];
  duration: PermissionDuration;
}

/**
 * Calculate expiration time based on duration
 */
function calculateExpiresAt(duration: PermissionDuration): number | null {
  const now = Date.now();
  switch (duration) {
    case 'once':
    case 'session':
      return null; // Handled differently (session grants not persisted)
    case '24h':
      return now + 24 * 60 * 60 * 1000; // 24 hours from now
    case 'always':
      return null; // Never expires
    default:
      return null;
  }
}

/**
 * Clean up expired grants
 */
function cleanupExpiredGrants(grants: Record<string, PermissionGrant>): Record<string, PermissionGrant> {
  const now = Date.now();
  const valid: Record<string, PermissionGrant> = {};
  for (const [path, grant] of Object.entries(grants)) {
    // Keep if no expiration or not yet expired
    if (!grant.expiresAt || grant.expiresAt > now) {
      valid[path] = grant;
    }
  }
  return valid;
}

interface PermissionState {
  // Persisted grants (always)
  persistedGrants: Record<string, PermissionGrant>;
  // Session-only grants (once) - not persisted
  sessionGrants: Record<string, PermissionGrant>;
  pendingRequest: {
    type: 'workspace' | 'shell' | 'file-write';
    path?: string;
    resolve?: (granted: boolean) => void;
  } | null;
}

interface PermissionActions {
  requestPermission: (type: 'workspace' | 'shell' | 'file-write', path?: string) => Promise<boolean>;
  grantPermission: (path: string, capabilities: ('read' | 'write' | 'execute')[], duration: PermissionDuration) => void;
  revokePermission: (path: string) => void;
  hasPermission: (path: string, capability: 'read' | 'write' | 'execute') => boolean;
  resolvePending: (granted: boolean) => void;
  clearSessionGrants: () => void;
  cleanupExpired: () => void;
}

export type PermissionStore = PermissionState & PermissionActions;

export const usePermissionStore = create<PermissionStore>()(
  persist(
    immer((set, get) => ({
      persistedGrants: {},
      sessionGrants: {},
      pendingRequest: null,

      requestPermission: (type, path) => {
        return new Promise((resolve) => {
          // Check if already granted
          if (path && get().hasPermission(path, type === 'workspace' ? 'read' : type === 'file-write' ? 'write' : 'execute')) {
            resolve(true);
            return;
          }

          set((state) => {
            state.pendingRequest = { type, path, resolve };
          });
        });
      },

      grantPermission: (path, capabilities, duration) => {
        // Normalize path: backslashes → forward slashes, collapse multiple slashes, remove trailing slash
        const normalizedPath = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
        const grant: PermissionGrant = {
          path: normalizedPath,
          grantedAt: Date.now(),
          expiresAt: calculateExpiresAt(duration),
          capabilities,
          duration,
        };

        // Sync only file capabilities to pathSafety. Falling back to
        // authorizeWorkspace's read+write default would widen a read-only UI
        // approval into write authority; execute is not a path capability.
        const pathCapabilities = workspaceCapabilities(capabilities);
        if (pathCapabilities.length > 0) {
          authorizeWorkspace(normalizedPath, pathCapabilities);
        }

        set((state) => {
          // 'always' and '24h' are persisted
          if (duration === 'always' || duration === '24h') {
            state.persistedGrants[normalizedPath] = grant;
          } else {
            // 'once' and 'session' are session-only
            state.sessionGrants[normalizedPath] = grant;
          }
        });
      },

      revokePermission: (path) => {
        // Sync to pathSafety's authorizedWorkspaces
        revokeWorkspace(path);

        set((state) => {
          delete state.persistedGrants[path];
          delete state.sessionGrants[path];
        });
      },

      hasPermission: (path, capability) => {
        const { persistedGrants, sessionGrants } = get();
        // Clean up expired grants before checking
        const validPersistedGrants = cleanupExpiredGrants(persistedGrants);
        const allGrants = { ...validPersistedGrants, ...sessionGrants };

        // Normalize path: backslashes → forward slashes, collapse multiple slashes, remove trailing slash
        const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');

        // Check exact match
        if (allGrants[normalized]?.capabilities.includes(capability)) {
          return true;
        }

        // Check parent directories
        for (const grantPath of Object.keys(allGrants)) {
          const normalizedGrant = grantPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
          if (normalized.startsWith(normalizedGrant + '/') && allGrants[grantPath].capabilities.includes(capability)) {
            return true;
          }
        }

        return false;
      },

      resolvePending: (granted) => {
        const { pendingRequest } = get();
        if (pendingRequest?.resolve) {
          pendingRequest.resolve(granted);
        }
        set((state) => {
          state.pendingRequest = null;
        });
      },

      clearSessionGrants: () => {
        set((state) => {
          state.sessionGrants = {};
        });
      },

      cleanupExpired: () => {
        set((state) => {
          state.persistedGrants = cleanupExpiredGrants(state.persistedGrants);
        });
      },
    })),
    {
      name: 'abu-permissions',
      version: 1,
      // Only persist the persistedGrants, not sessionGrants or pendingRequest
      partialize: (state) => ({
        persistedGrants: state.persistedGrants,
      }),
      // Clean up expired grants on rehydration and sync to pathSafety
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.persistedGrants = cleanupExpiredGrants(state.persistedGrants);
          // Sync all valid persisted grants to pathSafety's authorizedWorkspaces
          for (const grant of Object.values(state.persistedGrants)) {
            const pathCapabilities = workspaceCapabilities(grant.capabilities);
            if (pathCapabilities.length > 0) {
              authorizeWorkspace(grant.path, pathCapabilities);
            }
          }
        }
      },
    }
  )
);
