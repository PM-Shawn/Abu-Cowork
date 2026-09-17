import { useEffect } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  ensureSidecarStatusProjection,
  isConversationWaitingForSidecar,
  useSidecarStatusStore,
} from '@/stores/sidecarStatusStore';

/**
 * Above the composer (#549): 「连接中断，正在恢复…」 while the sidecar restarts;
 * 「正在启动…」 while this conversation's send waits for the agent sidecar's cold
 * start, and 「后台服务已停止」 + 「重新连接」 after the supervisor gave up.
 * Renders nothing otherwise.
 *
 * These are the run-progress states that deliberately do NOT appear under the
 * user's message (existing MessageBubble ruling) — only actionable failures do.
 */
export default function SidecarStatusStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const status = useSidecarStatusStore((s) => s.status);
  const waiting = useSidecarStatusStore((s) => isConversationWaitingForSidecar(s, conversationId));
  const reconnect = useSidecarStatusStore((s) => s.reconnect);

  // The store is seeded 'stopped' and only mirrors the supervisor once the
  // projection is attached; without this the strip would claim the background
  // service had stopped on a perfectly healthy launch. Idempotent.
  useEffect(() => {
    ensureSidecarStatusProjection();
  }, []);

  if (status === 'failed') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-danger)]">
        <span className="truncate">{t.chat.sidecarStopped}</span>
        <Button variant="ghost" size="xs" onClick={reconnect}>
          <RefreshCw className="h-3 w-3" />
          {t.chat.sidecarReconnect}
        </Button>
      </div>
    );
  }

  if (status === 'restarting') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-tertiary)]">
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        <span className="truncate">{t.chat.runRecovering}</span>
      </div>
    );
  }

  // 「正在启动…」 belongs to the conversation that is actually blocked on the
  // cold start, not to every open conversation.
  if (!waiting) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-tertiary)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
      <span className="truncate">{t.chat.runStartingSidecar}</span>
    </div>
  );
}
