import type { MarketplaceItem } from '@/types/marketplace';
import { Download, Check, Loader2, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Toggle } from '@/components/ui/toggle';

interface MarketplaceCardProps {
  item: MarketplaceItem;
  isInstalled: boolean;
  isInstalling: boolean;
  onInstall: () => void;
  onUninstall?: () => void;
  isEnabled?: boolean;
  onToggleEnabled?: () => void;
  onClick?: () => void;
}

export default function MarketplaceCard({
  item,
  isInstalled,
  isInstalling,
  onInstall,
  onUninstall,
  isEnabled = true,
  onToggleEnabled,
  onClick,
}: MarketplaceCardProps) {
  const { t } = useI18n();

  return (
    <div
      className={cn(
        'group relative flex flex-col justify-between p-3 rounded-lg border transition-colors min-h-[88px]',
        !isEnabled && isInstalled
          ? 'border-[var(--abu-border)]/40 bg-[var(--abu-bg-muted)]/50 opacity-60'
          : 'border-[var(--abu-border)]/60 hover:border-[var(--abu-border-hover)] hover:bg-[var(--abu-bg-muted)]/50',
        onClick && 'cursor-pointer'
      )}
      onClick={onClick}
    >
      <div className="min-w-0 pr-6">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-[var(--abu-text-primary)]">{item.name}</span>
          <span className="text-[10px] px-1.5 py-0.5 bg-[var(--abu-bg-active)] text-[var(--abu-text-tertiary)] rounded">
            {item.category}
          </span>
        </div>
        <p className="text-xs text-[var(--abu-text-tertiary)] mt-1 line-clamp-2">{item.description}</p>
      </div>
      <div className="flex items-center justify-between mt-2">
        <div className="flex items-center gap-2">
          <p className="text-[10px] text-[var(--abu-text-muted)]">by {item.author}</p>
          {isInstalled && onToggleEnabled && (
            <Toggle checked={isEnabled} onChange={onToggleEnabled} />
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); if (!isInstalled) onInstall(); }}
            disabled={isInstalled || isInstalling}
            className={cn(
              'flex items-center justify-center gap-1.5 w-[68px] py-1 rounded-md text-xs font-medium transition-colors',
              isInstalled
                ? 'bg-green-50 text-green-600 cursor-default'
                : isInstalling
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-muted)] cursor-wait'
                  : 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)]'
            )}
          >
            {isInstalling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>{t.toolbox.installing}</span>
              </>
            ) : isInstalled ? (
              <>
                <Check className="h-3.5 w-3.5" />
                <span>{t.toolbox.installed}</span>
              </>
            ) : (
              <>
                <Download className="h-3.5 w-3.5" />
                <span>{t.toolbox.install}</span>
              </>
            )}
          </button>
          {isInstalled && onUninstall && (
            <button
              onClick={(e) => { e.stopPropagation(); onUninstall(); }}
              className="absolute right-1 bottom-1 p-1 text-[var(--abu-text-muted)] hover:text-red-500 hover:bg-red-50 rounded transition-colors opacity-0 group-hover:opacity-100"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
