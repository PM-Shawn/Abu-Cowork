import { Button } from '@/components/ds/button';
import { InlineMessage } from '@/components/ds/inline-message';
import { readManagedProviderPersonalFallback } from '@/core/llm/managedProviderRefresh';
import { format, useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import { findPersonalFallbackModel } from '@/utils/settingsSelectors';
import { applyModelPick } from './modelPick';

/**
 * Sits above the composer while the managed provider it runs on cannot be
 * reached. Names the organization and offers the user's own model; the switch
 * happens only on the click — the organization's channel is the one that is
 * billed, so nothing moves the user off it silently.
 */
export function ManagedProviderOfflineBar({
  provider,
  conversationId,
}: {
  provider: Pick<ProviderInstance, 'id' | 'name'>;
  conversationId: string | null;
}) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const selectModel = useSettingsStore((s) => s.selectModel);
  const touchRecentModel = useSettingsStore((s) => s.touchRecentModel);
  const setConversationModel = useChatStore((s) => s.setConversationModel);
  const fallback = findPersonalFallbackModel({ providers }, readManagedProviderPersonalFallback(provider.id));

  return (
    <div data-testid="managed-provider-offline" className="mb-2">
      <InlineMessage
        tone="warning"
        action={fallback && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => applyModelPick(
              { activeConversationId: conversationId, ...fallback },
              { selectModel, touchRecentModel, setConversationModel },
            )}
          >
            {t.chat.useMyOwnModel}
          </Button>
        )}
      >
        <span className="block truncate">{format(t.chat.managedProviderUnreachable, { org: provider.name })}</span>
      </InlineMessage>
    </div>
  );
}
