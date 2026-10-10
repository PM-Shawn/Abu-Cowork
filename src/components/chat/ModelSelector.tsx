import { memo, useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import type { ModelInfo, ProviderInstance } from '@/types';
import { refreshManagedProvider } from '@/core/llm/managedProviderRefresh';
import { resolveModelVision } from '@/core/llm/resolveModelDeclared';
import { applyModelPick } from './modelPick';

const GROUP_TITLE = 'px-2 py-1 text-ui-sm font-medium text-label-tertiary';

/** Single model row */
function ModelRow({
  model,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
  canSeeImages,
  dim = false,
}: {
  model: ModelInfo;
  isActive: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  canSeeImages: boolean;
  dim?: boolean;
}) {
  const { t } = useI18n();
  const name = model.label || model.id;
  const selected = isActive && !dim;
  // The row holds the favorite button, and a button cannot sit inside a button.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      // With the "can see images" mark, a screen reader reads "model name, can see images", so the
      // two pieces do not run into one word. The name is given on the row itself, which keeps the
      // favorite button inside the row out of the row's name.
      aria-label={canSeeImages ? format(t.chat.modelRowCanSeeImages, { model: name }) : name}
      className={cn(
        'group/row flex h-7 items-center gap-1 rounded-control px-2 text-ui text-label outline-none hover:bg-fill-hover focus-visible:ring-2 focus-visible:ring-focus',
        selected && 'bg-fill-selected',
        dim && 'text-label-secondary',
      )}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {canSeeImages && <Tag>{t.chat.modelCanSeeImages}</Tag>}
      {selected && <Icon icon={AppIcons.done} size="sm" />}
      <IconButton
        size="sm"
        icon={AppIcons.favorite}
        label="Favorite"
        aria-pressed={isFavorite}
        // A favorite is the user's own mark, shown by the filled star alone.
        pressedFill={false}
        className={cn(isFavorite ? '[&_svg]:fill-current' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100')}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      />
    </div>
  );
}

export const ModelSelector = memo(function ModelSelector({ open, onOpenChange, trigger }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
}) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  // Only the open conversation's id and model: the picker must not re-render while a reply streams.
  const activeConversationId = useChatStore((s) => (
    s.activeConversationId && s.conversations[s.activeConversationId] ? s.activeConversationId : null
  ));
  const conversationModel = useChatStore((s) => (
    s.activeConversationId ? s.conversations[s.activeConversationId]?.model : undefined
  ));
  const setConversationModel = useChatStore((s) => s.setConversationModel);
  // When a conversation is open, the picker reflects/edits ITS model (falling back to the new-conversation default for legacy unpinned conversations).
  const effectiveActiveModel = conversationModel ?? activeModel;
  const recentModels = useSettingsStore((s) => s.recentModels);
  const favoriteModels = useSettingsStore((s) => s.favoriteModels);
  const selectModel = useSettingsStore((s) => s.selectModel);
  const touchRecentModel = useSettingsStore((s) => s.touchRecentModel);
  const toggleFavorite = useSettingsStore((s) => s.toggleFavorite);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);

  const [query, setQuery] = useState('');

  // Reset search when opening
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  // A managed provider's list can change on the owning system's side at any
  // time (a model granted or revoked), so every open asks for a fresh one.
  useEffect(() => {
    if (!open) return;
    for (const p of useSettingsStore.getState().providers) {
      if (p.source === 'managed') void refreshManagedProvider(p.id);
    }
  }, [open]);

  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled && p.models.length > 0),
    [providers]
  );

  const isModelActive = useCallback(
    (providerId: string, modelId: string) =>
      effectiveActiveModel.providerId === providerId && effectiveActiveModel.modelId === modelId,
    [effectiveActiveModel]
  );

  const isModelFavorite = useCallback(
    (providerId: string, modelId: string) =>
      favoriteModels.some((f) => f.providerId === providerId && f.modelId === modelId),
    [favoriteModels]
  );

  const lowerQuery = query.toLowerCase().trim();

  /** Check if a model matches the search query */
  const matchesQuery = useCallback(
    (model: ModelInfo, provider: ProviderInstance) => {
      if (!lowerQuery) return true;
      return (
        model.label.toLowerCase().includes(lowerQuery) ||
        model.id.toLowerCase().includes(lowerQuery) ||
        provider.name.toLowerCase().includes(lowerQuery)
      );
    },
    [lowerQuery]
  );

  /** Resolve an ActiveModel to its provider + model, filtering by query */
  const resolveModel = useCallback(
    (am: { providerId: string; modelId: string }) => {
      const provider = enabledProviders.find((p) => p.id === am.providerId);
      if (!provider) return null;
      const model = provider.models.find((m) => m.id === am.modelId);
      if (!model) return null;
      if (!matchesQuery(model, provider)) return null;
      return { provider, model };
    },
    [enabledProviders, matchesQuery]
  );

  const handleSelect = useCallback(
    (providerId: string, modelId: string) => {
      // Inside a conversation the pick is scoped to it; on the new-task page it
      // sets the default for new conversations (issue #545, see modelPick.ts).
      applyModelPick(
        { activeConversationId, providerId, modelId },
        { selectModel, touchRecentModel, setConversationModel },
      );
      onOpenChange(false);
    },
    [selectModel, touchRecentModel, setConversationModel, activeConversationId, onOpenChange]
  );

  const handleToggleFavorite = useCallback(
    (providerId: string, modelId: string) => {
      toggleFavorite(providerId, modelId);
    },
    [toggleFavorite]
  );

  // Resolved favorites and recents
  const resolvedFavorites = useMemo(
    () => favoriteModels.map(resolveModel).filter(Boolean) as { provider: ProviderInstance; model: ModelInfo }[],
    [favoriteModels, resolveModel]
  );

  const resolvedRecents = useMemo(
    () => recentModels.map(resolveModel).filter(Boolean) as { provider: ProviderInstance; model: ModelInfo }[],
    [recentModels, resolveModel]
  );

  // Filtered providers with their matching models
  const filteredProviders = useMemo(
    () =>
      enabledProviders
        .map((provider) => ({
          provider,
          models: provider.models.filter((m) => matchesQuery(m, provider)),
        }))
        .filter((g) => g.models.length > 0),
    [enabledProviders, matchesQuery]
  );

  // Managed providers that have no list to show yet: still pulling it, or the
  // pull failed. They keep a one-line place in the panel so the user can tell
  // the organization's models exist. One confirmed to grant nothing is left out.
  const pendingManagedProviders = useMemo(
    () => (lowerQuery
      ? []
      : providers.filter((p) => p.source === 'managed' && p.enabled && p.models.length === 0 && p.status !== 'verified')),
    [providers, lowerQuery]
  );

  const hasNoProviders = enabledProviders.length === 0 && pendingManagedProviders.length === 0;
  const showsManagedGroup = pendingManagedProviders.length > 0
    || filteredProviders.some((g) => g.provider.source === 'managed');
  const firstOwnGroupId = showsManagedGroup
    ? filteredProviders.find((g) => g.provider.source !== 'managed')?.provider.id
    : undefined;
  const searchLabel = t.common.search + '...';

  return (
    <Popover open={open} onOpenChange={onOpenChange} side="top" align="end" trigger={trigger}>
      <TextField
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={searchLabel}
        placeholder={searchLabel}
      />

      {hasNoProviders ? (
        /* No providers message */
        <div className="p-4 text-center">
          <p className="text-ui text-label-secondary">{t.settings.noProviders}</p>
          <p className="mt-1 text-ui-sm text-label-tertiary">{t.settings.noProvidersHint}</p>
          <Button
            variant="plain"
            size="sm"
            className="mt-2"
            onClick={() => {
              onOpenChange(false);
              openSystemSettings('ai-services');
            }}
          >
            {t.settings.noProvidersAction}
          </Button>
        </div>
      ) : (
        /* Model list */
        <div className="mt-2 max-h-80 overflow-y-auto">
          {/* Favorites section */}
          {resolvedFavorites.length > 0 && (
            <div className="mb-1">
              <div className={cn('flex items-center gap-1', GROUP_TITLE)}>
                <Icon icon={AppIcons.favorite} size="sm" />
                <span>Favorites</span>
              </div>
              {resolvedFavorites.map(({ provider, model }) => (
                <ModelRow
                  key={`fav-${provider.id}-${model.id}`}
                  model={model}
                  isActive={isModelActive(provider.id, model.id)}
                  isFavorite={true}
                  onSelect={() => handleSelect(provider.id, model.id)}
                  onToggleFavorite={() => handleToggleFavorite(provider.id, model.id)}
                  canSeeImages={resolveModelVision(provider, model.id)}
                />
              ))}
            </div>
          )}

          {/* Recent section */}
          {resolvedRecents.length > 0 && (
            <div className="mb-1">
              <div className={cn('flex items-center gap-1', GROUP_TITLE)}>
                <Icon icon={AppIcons.clock} size="sm" />
                <span>Recent</span>
              </div>
              {resolvedRecents.map(({ provider, model }) => (
                <ModelRow
                  key={`recent-${provider.id}-${model.id}`}
                  model={model}
                  isActive={false}
                  isFavorite={isModelFavorite(provider.id, model.id)}
                  onSelect={() => handleSelect(provider.id, model.id)}
                  onToggleFavorite={() => handleToggleFavorite(provider.id, model.id)}
                  canSeeImages={resolveModelVision(provider, model.id)}
                  dim
                />
              ))}
            </div>
          )}

          {/* Divider between special sections and main list */}
          {(resolvedFavorites.length > 0 || resolvedRecents.length > 0) && filteredProviders.length > 0 && (
            <div className="mx-2 my-1 border-t border-separator" />
          )}

          {pendingManagedProviders.map((provider) => (
            <div key={provider.id} className="mb-1">
              <div className={cn(GROUP_TITLE, 'text-label-secondary')}>{provider.name}</div>
              <div className="px-2 py-1 text-ui-sm text-label-tertiary">
                {provider.status === 'failed'
                  ? format(t.chat.managedProviderUnreachable, { org: provider.name })
                  : t.chat.managedModelsSyncing}
              </div>
            </div>
          ))}

          {/* Main list grouped by provider */}
          {filteredProviders.map(({ provider, models }) => (
            <div key={provider.id} className="mb-1">
              {provider.id === firstOwnGroupId && (
                <div className={GROUP_TITLE}>{t.chat.myModels}</div>
              )}
              <div className={cn(GROUP_TITLE, provider.source === 'managed' && 'text-label-secondary')}>
                {provider.name}
              </div>
              {models.map((model) => (
                <ModelRow
                  key={`${provider.id}-${model.id}`}
                  model={model}
                  isActive={isModelActive(provider.id, model.id)}
                  isFavorite={isModelFavorite(provider.id, model.id)}
                  onSelect={() => handleSelect(provider.id, model.id)}
                  onToggleFavorite={() => handleToggleFavorite(provider.id, model.id)}
                  canSeeImages={resolveModelVision(provider, model.id)}
                />
              ))}
            </div>
          ))}

          {/* No results */}
          {filteredProviders.length === 0 && pendingManagedProviders.length === 0 && resolvedFavorites.length === 0 && resolvedRecents.length === 0 && (
            <div className="px-2 py-4 text-center text-ui-sm text-label-tertiary">
              No models found
            </div>
          )}
        </div>
      )}
    </Popover>
  );
});
