import { useState, useMemo } from 'react';
import { Search } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Input } from '@/components/ui/input';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import CategoryNav from './CategoryNav';
import ExpertCard from './ExpertCard';
import ExpertDetailModal from './ExpertDetailModal';
import { expertTemplates } from '@/data/marketplace/agents';
import { expertsEnUS } from '@/data/experts/expertsI18n';
import type { MarketplaceItem } from '@/types/marketplace';

export default function ExpertsCenter() {
  const { t, locale } = useI18n();
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedExpert, setSelectedExpert] = useState<MarketplaceItem | null>(null);

  const closeExperts = useSettingsStore((s) => s.closeExperts);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const setPendingExpert = useChatStore((s) => s.setPendingExpert);

  const localizedExperts = useMemo<MarketplaceItem[]>(() => {
    if (locale !== 'en-US') return expertTemplates;
    return expertTemplates.map((e) => {
      const overrides = expertsEnUS[e.id];
      return overrides ? { ...e, ...overrides } : e;
    });
  }, [locale]);

  const filteredExperts = useMemo(() => {
    let result = localizedExperts;

    if (selectedCategory !== 'all') {
      result = result.filter((e) => e.category === selectedCategory);
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((e) => {
        // Build cross-locale haystack: current locale fields + opposite locale overrides
        const enOverride = expertsEnUS[e.id];
        const parts = [
          e.name,
          e.description,
          ...(e.tags ?? []),
          enOverride?.name ?? '',
          enOverride?.description ?? '',
          ...(enOverride?.tags ?? []),
        ];
        return parts.some((p) => p.toLowerCase().includes(q));
      });
    }

    return result;
  }, [localizedExperts, selectedCategory, searchQuery]);

  const handleStartChat = (expertId: string, promptText?: string) => {
    const registryName = expertTemplates.find((e) => e.id === expertId)?.name ?? expertId;
    const input = promptText ? `@${registryName} ${promptText}` : `@${registryName} `;
    startNewConversation();
    setPendingInput(input);
    setPendingExpert(expertId);
    closeExperts();
  };

  return (
    <div className="h-full overflow-auto bg-[var(--abu-bg-base)]">
      <div className="max-w-6xl mx-auto px-8 py-8">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold text-[var(--abu-text-primary)]">
              {t.experts.title}
            </h1>
            <p className="mt-0.5 text-sm text-[var(--abu-text-tertiary)]">
              {t.experts.subtitle}
            </p>
          </div>

          <div className="relative w-60 shrink-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-muted)] pointer-events-none" />
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.experts.searchPlaceholder}
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* Category Nav */}
        <div className="mb-6">
          <CategoryNav selected={selectedCategory} onSelect={setSelectedCategory} />
        </div>

        {/* Expert Grid */}
        {filteredExperts.length > 0 ? (
          <div className="grid grid-cols-4 gap-4 xl:grid-cols-5 lg:grid-cols-3 sm:grid-cols-2">
            {filteredExperts.map((expert) => (
              <ExpertCard
                key={expert.id}
                expert={expert}
                onClick={setSelectedExpert}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--abu-border)] bg-[var(--abu-bg-subtle)] px-6 py-16 text-center text-sm text-[var(--abu-text-tertiary)]">
            {t.experts.comingSoon}
          </div>
        )}
      </div>

      {/* Detail Modal */}
      <ExpertDetailModal
        expert={selectedExpert}
        onClose={() => setSelectedExpert(null)}
        onStartChat={handleStartChat}
      />
    </div>
  );
}
