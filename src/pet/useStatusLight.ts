/**
 * Pet status subscription (Phase B/C).
 *
 * Listens to 'pet-status-update' events emitted by petStatusBridge in the
 * main window. On mount, emits 'pet-resync-request' so the main window
 * re-broadcasts the current status (handles the case where main emitted
 * before the pet window was open).
 *
 * Phase C: the payload carries the featured conversation (id/title/summary)
 * driving the status, powering the Activity Notification Tray bubble.
 */

import { useEffect, useState } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
// Single source of truth for the wire types — re-exported so pet-window
// components can import them from here without pulling in the heavy bridge
// module (these are type-only, erased at build).
import type { PetStatus, PetStatusPayload } from '@/core/pet/petStatusBridge';

export type { PetStatus, PetStatusPayload };

const IDLE_PAYLOAD: PetStatusPayload = {
  status: 'idle',
  conversationId: null,
  title: null,
  summary: null,
};

/**
 * Full status payload (status + featured conversation). For the bare
 * status, read `.status`.
 */
export function usePetStatus(): PetStatusPayload {
  const [payload, setPayload] = useState<PetStatusPayload>(IDLE_PAYLOAD);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen<PetStatusPayload>('pet-status-update', ({ payload }) => {
      setPayload(payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    // Ask main window for the current status on mount.
    emit('pet-resync-request').catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return payload;
}
