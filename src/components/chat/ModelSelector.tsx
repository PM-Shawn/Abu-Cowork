import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Globe, Wrench, Brain, Eye, Image, Search, Star, Clock, BookOpen } from 'lucide-react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import type { ModelCapability, ModelInfo, ProviderInstance } from '@/types';
import { useEnterpriseModels } from '@/core/enterprise/useEnterpriseModels';
import { useEnterpriseStore } from '@/stores/enterpriseStore';

interface ModelSelectorProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/** Capability icon mapping */
export function CapabilityBadge({ cap, size = 'sm' }: { cap: ModelCapability; size?: 'sm' | 'xs' }) {
  const cls = size === 'xs' ? 'h-2.5 w-2.5' : 'h-3 w-3';
  const muted = `${cls} text-[var(--abu-text-muted)] opacity-70`;
  switch (cap) {
    case 'thinking':
      return <Brain className={muted} />;
    case 'vision':
      return <Eye className={muted} />;
    case 'long_context':
      return <BookOpen className={muted} />;
    case 'web_search':
      return <Globe className={muted} />;
    case 'tool_use':
      return <Wrench className={muted} />;
    case 'image_gen':
      return <Image className={muted} />;
    default:
      return null;
  }
}

/** Collect effective capabilities for a model, merging provider-level caps */
function getEffectiveCaps(model: ModelInfo, provider: ProviderInstance): ModelCapability[] {
  const caps = new Set<ModelCapability>(model.capabilities ?? []);
  if (provider.capabilities?.webSearch) caps.add('web_search');
  if (provider.capabilities?.imageGen) caps.add('image_gen');
  return Array.from(caps);
}

/** Single model row */
function ModelRow({
  model,
  provider,
  isActive,
  isFavorite,
  onSelect,
  onToggleFavorite,
  dim = false,
}: {
  model: ModelInfo;
  provider: ProviderInstance;
  isActive: boolean;
  isFavorite: boolean;
  onSelect: () => void;
  onToggleFavorite: () => void;
  dim?: boolean;
}) {
  const caps = getEffectiveCaps(model, provider);

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'flex items-center w-full px-3 py-1.5 text-left text-sm rounded-md transition-colors cursor-pointer',
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
          isFavorite ? 'text-amber-500' : 'text-[var(--abu-text-muted)] opacity-0 group-hover/row:opacity-100'
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
      >
        <Star className={cn('h-3 w-3', isFavorite && 'fill-current')} />
      </button>

      {caps.length > 0 && (
        <span className="flex items-center gap-0.5 shrink-0">
          {caps.map((cap) => (
            <CapabilityBadge key={cap} cap={cap} />
          ))}
        </span>
      )}
    </div>
  );
}

export function ModelSelector({ open, onClose, anchorRef }: ModelSelectorProps) {
  const { t } = useI18n();
  const providers = useSettingsStore((s) => s.providers);
  const activeModel = useSettingsStore((s) => s.activeModel);
  const recentModels = useSettingsStore((s) => s.recentModels);
  const favoriteModels = useSettingsStore((s) => s.favoriteModels);
  const selectModel = useSettingsStore((s) => s.selectModel);
  const toggleFavorite = useSettingsStore((s) => s.toggleFavorite);
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);

  // Enterprise mode: model list is scoped to gateway's /v1/models allow list.
  const isEnterprise = useEnterpriseStore(s => s.mode.kind !== 'personal');
  const enterpriseModels = useEnterpriseModels();

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
      activeModel.providerId === providerId && activeModel.modelId === modelId,
    [activeModel]
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
      selectModel(providerId, modelId);
      onClose();
    },
    [selectModel, onClose]
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

  if (!open) return null;

  // Enterprise mode: replace the personal provider list with the gateway model list.
  if (isEnterprise) {
    const gwModels = enterpriseModels ?? []
    const filtered = lowerQuery
      ? gwModels.filter(id => id.toLowerCase().includes(lowerQuery))
      : gwModels
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
        <div className="p-2 border-b border-[var(--abu-border)]">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.common.search + '...'}
              className="h-7 pl-7 pr-2 text-xs bg-transparent border-none focus:ring-0"
            />
          </div>
        </div>
        <div className="overflow-y-auto max-h-80">
          <div className="p-1">
            {enterpriseModels === null ? (
              <div className="px-3 py-4 text-center text-xs text-[var(--abu-text-muted)]">
                加载企业模型列表中...
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-xs text-[var(--abu-text-muted)]">
                {lowerQuery ? '未找到匹配的模型' : '暂无可用模型'}
              </div>
            ) : (
              <div className="mb-1">
                <div className="px-3 py-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-orange-400">
                    企业网关
                  </span>
                </div>
                {filtered.map(modelId => {
                  const isActive = activeModel.modelId === modelId
                  return (
                    <button
                      key={modelId}
                      onClick={() => { selectModel('enterprise-gateway', modelId); onClose(); }}
                      className={cn(
                        'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-left',
                        'text-xs transition-colors',
                        isActive
                          ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                          : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'
                      )}
                    >
                      {isActive
                        ? <Check className="h-3 w-3 text-[var(--abu-clay)] shrink-0" />
                        : <span className="h-3 w-3 shrink-0" />
                      }
                      <span className="truncate">{modelId}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  const hasNoProviders = enabledProviders.length === 0;

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
            className="h-7 pl-7 pr-2 text-xs bg-transparent border-none focus:ring-0"
          />
        </div>
      </div>

      {hasNoProviders ? (
        /* No providers message */
        <div className="p-4 text-center">
          <p className="text-sm text-[var(--abu-text-tertiary)]">{t.settings.noProviders}</p>
          <p className="text-xs text-[var(--abu-text-muted)] mt-1">{t.settings.noProvidersHint}</p>
          <button
            className="mt-2 text-xs text-[var(--abu-clay)] hover:underline"
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
                  <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--abu-text-muted)]">
                    Favorites
                  </span>
                </div>
                {resolvedFavorites.map(({ provider, model }) => (
                  <div key={`fav-${provider.id}-${model.id}`} className="group/row">
                    <ModelRow
                      model={model}
                      provider={provider}
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
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--abu-text-muted)]">
                    Recent
                  </span>
                </div>
                {resolvedRecents.map(({ provider, model }) => (
                  <div key={`recent-${provider.id}-${model.id}`} className="group/row">
                    <ModelRow
                      model={model}
                      provider={provider}
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

            {/* Main list grouped by provider */}
            {filteredProviders.map(({ provider, models }) => (
              <div key={provider.id} className="mb-1">
                <div className="px-3 py-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--abu-text-muted)]">
                    {provider.name}
                  </span>
                </div>
                {models.map((model) => (
                  <div key={`${provider.id}-${model.id}`} className="group/row">
                    <ModelRow
                      model={model}
                      provider={provider}
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
            {filteredProviders.length === 0 && resolvedFavorites.length === 0 && resolvedRecents.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-[var(--abu-text-muted)]">
                No models found
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
