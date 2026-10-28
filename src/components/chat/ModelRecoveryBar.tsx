import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ds/button';
import { InlineMessage } from '@/components/ds/inline-message';
import { getPendingModelRecovery, selectRecoveryModel, subscribeModelRecovery } from '@/core/agent/modelRecovery';
import { useI18n } from '@/i18n';
import { ModelSelector } from './ModelSelector';

export function ModelRecoveryBar({ conversationId }: { conversationId: string }) {
  const request = useSyncExternalStore(subscribeModelRecovery, () => getPendingModelRecovery(conversationId));
  if (!request) return null;
  return <ModelRecoveryChoice key={request.id} request={request} />;
}

function ModelRecoveryChoice({ request }: { request: NonNullable<ReturnType<typeof getPendingModelRecovery>> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <InlineMessage tone="warning" action={
      <ModelSelector
        open={open}
        onOpenChange={setOpen}
        selectedModel={request.model}
        onSelect={(model) => {
          const error = selectRecoveryModel(request.id, model);
          if (error === 'unavailable') return t.chat.modelRecoveryUnavailable;
          if (error === 'credentials-required') return t.chat.modelRecoveryCredentials;
          if (error === 'incompatible') return t.chat.modelRecoveryIncompatible;
          if (error === 'ended') return t.chat.modelRecoveryEnded;
          return null;
        }}
        trigger={<Button variant="secondary" size="sm">{t.chat.modelRecoveryAction}</Button>}
      />
    }>
      {request.agentName && <span>{request.agentName} · </span>}
      {request.reason === 'quota' ? t.chat.modelRecoveryQuota : t.chat.modelRecoveryContext}
    </InlineMessage>
  );
}
