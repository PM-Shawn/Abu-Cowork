import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, Star, Clock } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useActiveConversation, useChatStore } from '@/stores/chatStore';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import type { ModelInfo, ProviderInstance } from '@/types';
import { refreshManagedProvider } from '@/core/llm/managedProviderRefresh';
import { applyModelPick } from './modelPick';

interface ModelSelectorProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Single model row */
function ModelRow({
  model,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
  dim = false,
}: {
  model: ModelInfo;
  isActive: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  dim?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex items-center w-full px-3 py-1.5 text-left text-body rounded-md transition-colors cursor-pointer',
        'hover:bg-[var(--abu-bg-hover)]',
        isActive && !dim && 'bg-[var(--abu-bg-hover)]'
      )}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter') onSelect(); }}
    >
      <span className={cn(
        'flex-1 truncate',
        dim ? 'text-[var(--abu-text-muted)]' : 'text-[var(--abu-text-secondary)]'
      )}>
        {model.label || model.id}
      </span>

      {isActive && !dim && (
        <Check className="h-3.5 w-3.5 text-[var(--abu-clay)] shrink-0 mr-1" />
      )}

      <button
        className={cn(
          'p-0.5 rounded shrink-0 mr-1 transition-colors',
          'hover:bg-[var(--abu-bg-muted)]',
          isFavorite ? 'text-[var(--abu-warning)]' : 'text-[var(--abu-text-muted)] opacity-0 group-hover/row:opacity-100'
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Star className={cn('h-3 w-3', isFavorite && 'fill-current')} />
      </button>
    </div>
  );
}

export function ModelSelector({ open, onClose, anchorRef }: ModelSelectorProps) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const activeConv = useActiveConversation();
  const setConversationModel = useChatStore((s) => s.setConversationModel);
  // When a conversation is open, the picker reflects/edits ITS model (falling back to the new-conversation default for legacy unpinned conversations).
  const effectiveActiveModel = activeConv?.model ?? activeModel;
  const recentModels = useSettingsStore((s) => s.recentModels);
  const favoriteModels = useSettingsStore((s) => s.favoriteModels);
  const selectModel = useSettingsStore((s) => s.selectModel);
  const touchRecentModel = useSettingsStore((s) => s.touchRecentModel);
  const toggleFavorite = useSettingsStore((s) => s.toggleFavorite);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);

  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset search when opening
  useEffect(() => {
    if (open) {
      setQuery('');
      // Focus search input after mount
      requestAnimationFrame(() => {
        searchRef.current?.focus();
      });
    }
  }, [open]);

  // A managed provider's list can change on the owning system's side at any
  // time (a model granted or revoked), so every open asks for a fresh one.
  useEffect(() => {
    if (!open) return;
    for (const p of useSettingsStore.getState().providers) {
      if (p.source === 'managed') void refreshManagedProvider(p.id);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [open, onClose]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      if (
        panel &&
        !panel.contains(e.target as Node) &&
        anchor &&
        !anchor.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    // Use setTimeout to avoid catching the same click that opened the panel
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [open, onClose, anchorRef]);

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
        { activeConversationId: activeConv?.id, providerId, modelId },
        { selectModel, touchRecentModel, setConversationModel },
      );
      onClose();
    },
    [selectModel, touchRecentModel, setConversationModel, activeConv, onClose]
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

  if (!open) return null;

  const hasNoProviders = enabledProviders.length === 0 && pendingManagedProviders.length === 0;
  const showsManagedGroup = pendingManagedProviders.length > 0
    || filteredProviders.some((g) => g.provider.source === 'managed');
  const firstOwnGroupId = showsManagedGroup
    ? filteredProviders.find((g) => g.provider.source !== 'managed')?.provider.id
    : undefined;

  return (
    <div
      ref={panelRef}
      className={cn(
        'absolute bottom-full right-0 mb-1.5 z-50',
        'w-72 max-h-96 rounded-lg shadow-lg',
        'bg-[var(--abu-bg-base)] border border-[var(--abu-border)]',
        'flex flex-col overflow-hidden'
      )}
    >
      {/* Search */}
      <div className="p-2 border-b border-[var(--abu-border)]">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.common.search + '...'}
            className="h-7 pl-7 pr-2 text-minor bg-transparent border-none focus:ring-0"
          />
        </div>
      </div>

      {hasNoProviders ? (
        /* No providers message */
        <div className="p-4 text-center">
          <p className="text-body text-[var(--abu-text-tertiary)]">{t.settings.noProviders}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-1">{t.settings.noProvidersHint}</p>
          <button
            className="mt-2 text-minor text-[var(--abu-clay)] hover:underline"
            onClick={() => {
              onClose();
              openSystemSettings('ai-services');
            }}
          >
            {t.settings.noProvidersAction}
          </button>
        </div>
      ) : (
        /* Model list */
        <div className="overflow-y-auto max-h-80">
          <div className="p-1">
            {/* Favorites section */}
            {resolvedFavorites.length > 0 && (
              <div className="mb-1">
                <div className="flex items-center gap-1.5 px-3 py-1">
                  <Star className="h-3 w-3 text-[var(--abu-warning)] fill-[var(--abu-warning-solid)]" />
                  <span className="text-caption font-medium uppercase tracking-wider text-[var(--abu-text-muted)]">
                    Favorites
                  </span>
                </div>
                {resolvedFavorites.map(({ provider, model }) => (
                  <div key={`fav-${provider.id}-${model.id}`} className="group/row">
                    <ModelRow
                      model={model}
                      isActive={isModelActive(provider.id, model.id)}
                      isFavorite={true}
                      onSelect={() => handleSelect(provider.id, model.id)}
                      onToggleFavorite={() => handleToggleFavorite(provider.id, model.id)}
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Recent section */}
            {resolvedRecents.length > 0 && (
              <div className="mb-1">
                <div className="flex items-center gap-1.5 px-3 py-1">
                  <Clock className="h-3 w-3 text-[var(--abu-text-muted)]" />
                  <span className="text-caption font-medium uppercase tracking-wider text-[var(--abu-text-muted)]">
                    Recent
                  </span>
                </div>
                {resolvedRecents.map(({ provider, model }) => (
                  <div key={`recent-${provider.id}-${model.id}`} className="group/row">
                    <ModelRow
                      model={model}
                      isActive={false}
                      isFavorite={isModelFavorite(provider.id, model.id)}
                      onSelect={() => handleSelect(provider.id, model.id)}
                      onToggleFavorite={() => handleToggleFavorite(provider.id, model.id)}
                      dim
                    />
                  </div>
                ))}
              </div>
            )}

            {/* Divider between special sections and main list */}
            {(resolvedFavorites.length > 0 || resolvedRecents.length > 0) && filteredProviders.length > 0 && (
              <div className="mx-3 my-1 border-t border-[var(--abu-border)]" />
            )}

            {pendingManagedProviders.map((provider) => (
              <div key={provider.id} className="mb-1">
                <div className="px-3 py-1">
                  <span className="text-caption font-medium uppercase tracking-wider text-[var(--abu-clay)]">
                    {provider.name}
                  </span>
                </div>
                <div className="px-3 py-1.5 text-minor text-[var(--abu-text-muted)]">
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
                  <div className="px-3 pt-1.5 pb-0.5 text-caption font-medium text-[var(--abu-text-tertiary)]">
                    {t.chat.myModels}
                  </div>
                )}
                <div className="px-3 py-1">
                  <span
                    className={cn(
                      'text-caption font-medium uppercase tracking-wider',
                      provider.source === 'managed' ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)]',
                    )}
                  >
                    {provider.name}
                  </span>
                </div>
                {models.map((model) => (
                  <div key={`${provider.id}-${model.id}`} className="group/row">
                    <ModelRow
                      model={model}
                      isActive={isModelActive(provider.id, model.id)}
                      isFavorite={isModelFavorite(provider.id, model.id)}
                      onSelect={() => handleSelect(provider.id, model.id)}
                      onToggleFavorite={() => handleToggleFavorite(provider.id, model.id)}
                    />
                  </div>
                ))}
              </div>
            ))}

            {/* No results */}
            {filteredProviders.length === 0 && pendingManagedProviders.length === 0 && resolvedFavorites.length === 0 && resolvedRecents.length === 0 && (
              <div className="px-3 py-4 text-center text-minor text-[var(--abu-text-muted)]">
                No models found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
