/**
 * IM Channel Store — Phase 2: manage IM channel connections and sessions
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type {
  IMChannel,
  IMChannelStatus,
  IMSession,
  IMCapabilityLevel,
} from '../types/imChannel';
import type { IMPlatform } from '../types/trigger';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

// ── Store types ──

interface IMChannelState {
  channels: Record<string, IMChannel>;
  /** Active sessions (runtime only, not persisted) */
  sessions: Record<string, IMSession>;
}

interface IMChannelActions {
  // Channel CRUD
  addChannel(data: {
    platform: IMPlatform;
    name: string;
    appId: string;
    appSecret: string;
    capability?: IMCapabilityLevel;
    allowedUsers?: string[];
    workspacePaths?: string[];
    sessionTimeoutMinutes?: number;
  }): string;
  updateChannel(id: string, data: Partial<Pick<IMChannel, 'name' | 'appId' | 'appSecret' | 'capability' | 'responseMode' | 'allowedUsers' | 'workspacePaths' | 'sessionTimeoutMinutes' | 'maxRoundsPerSession' | 'enabled'>>): void;
  removeChannel(id: string): void;
  setChannelStatus(id: string, status: IMChannelStatus, error?: string): void;

  // Session management
  upsertSession(key: string, session: Omit<IMSession, 'key'>): void;
  removeSession(key: string): void;
  touchSession(key: string): void;
  incrementSessionRound(key: string): void;
  clearExpiredSessions(): void;

  // Queries
  getChannelsByPlatform(platform: IMPlatform): IMChannel[];
  getActiveChannels(): IMChannel[];
  getSessionsByChannel(channelId: string): IMSession[];
}

export type IMChannelStore = IMChannelState & IMChannelActions;

export const useIMChannelStore = create<IMChannelStore>()(
  persist(
    immer((set, get) => ({
      channels: {},
      sessions: {},

      // ── Channel CRUD ──

      addChannel(data) {
        const id = generateId();
        const now = Date.now();
        set((state) => {
          state.channels[id] = {
            id,
            platform: data.platform,
            name: data.name,
            appId: data.appId,
            appSecret: data.appSecret,
            capability: data.capability ?? 'safe_tools',
            responseMode: 'mention_only',
            allowedUsers: data.allowedUsers ?? [],
            workspacePaths: data.workspacePaths ?? [],
            sessionTimeoutMinutes: data.sessionTimeoutMinutes ?? 30,
            maxRoundsPerSession: 50,
            enabled: true,
            status: 'disconnected',
            createdAt: now,
            updatedAt: now,
          };
        });
        return id;
      },

      updateChannel(id, data) {
        set((state) => {
          const channel = state.channels[id];
          if (!channel) return;
          // Guard: ensure enabled is always a boolean (never undefined)
          if ('enabled' in data && typeof data.enabled !== 'boolean') return;
          Object.assign(channel, data);
          channel.updatedAt = Date.now();
        });
      },

      removeChannel(id) {
        set((state) => {
          delete state.channels[id];
          // Also remove all sessions for this channel
          for (const [key, session] of Object.entries(state.sessions)) {
            if (session.channelId === id) {
              delete state.sessions[key];
            }
          }
        });
      },

      setChannelStatus(id, status, error) {
        set((state) => {
          const channel = state.channels[id];
          if (!channel) return;
          channel.status = status;
          channel.lastError = error;
        });
      },

      // ── Session management ──

      upsertSession(key, session) {
        set((state) => {
          state.sessions[key] = { ...session, key };
        });
      },

      removeSession(key) {
        set((state) => {
          delete state.sessions[key];
        });
      },

      touchSession(key) {
        set((state) => {
          const session = state.sessions[key];
          if (session) {
            session.lastActiveAt = Date.now();
          }
        });
      },

      incrementSessionRound(key) {
        set((state) => {
          const session = state.sessions[key];
          if (session) {
            session.messageCount++;
            session.lastActiveAt = Date.now();
          }
        });
      },

      clearExpiredSessions() {
        const now = Date.now();
        set((state) => {
          for (const [key, session] of Object.entries(state.sessions)) {
            const channel = state.channels[session.channelId];
            const timeoutMs = (channel?.sessionTimeoutMinutes ?? 30) * 60 * 1000;
            if (now - session.lastActiveAt > timeoutMs) {
              delete state.sessions[key];
            }
          }
        });
      },

      // ── Queries ──

      getChannelsByPlatform(platform) {
        return Object.values(get().channels).filter((c) => c.platform === platform);
      },

      getActiveChannels() {
        return Object.values(get().channels).filter((c) => c.enabled);
      },

      getSessionsByChannel(channelId) {
        return Object.values(get().sessions).filter((s) => s.channelId === channelId);
      },
    })),
    {
      name: 'abu-im-channel',
      version: 1,
      partialize: (state) => ({
        // Only persist channels, not runtime sessions
        channels: state.channels,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Reset all channel statuses to disconnected on reload
        for (const channel of Object.values(state.channels)) {
          channel.status = 'disconnected';
          channel.lastError = undefined;
          // Fix: repair enabled field if corrupted to undefined (from prior Toggle bug)
          if (channel.enabled === undefined) channel.enabled = false;
        }
        // Clear sessions (runtime only)
        state.sessions = {};
      },
    }
  )
);
