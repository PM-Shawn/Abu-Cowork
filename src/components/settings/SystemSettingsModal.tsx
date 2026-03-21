import { useSettingsStore, type SystemSettingsTab } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Settings2, Info, Shield, Check, SlidersHorizontal, MessageCircle, Radio, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AIServicesSection, AboutSection, SandboxSection, GeneralSection, IMChannelSection } from './sections';
import FeedbackSection from './sections/FeedbackSection';
import PersonalMemorySection from './sections/PersonalMemorySection';

export default function SystemSettingsView() {
  const {
    activeSystemTab,
    setActiveSystemTab,
  } = useSettingsStore();
  const { t } = useI18n();

  const navItems: { id: SystemSettingsTab; label: string; icon: typeof Settings2 }[] = [
    { id: 'ai-services', label: t.settings.aiServices, icon: Settings2 },
    { id: 'im-channels', label: t.imChannel.title, icon: Radio },
    { id: 'personal-memory', label: t.sidebar.personalMemory, icon: Brain },
    { id: 'sandbox', label: t.settings.sandbox, icon: Shield },
    { id: 'general', label: t.settings.general, icon: SlidersHorizontal },
    { id: 'feedback', label: t.about.feedback, icon: MessageCircle },
    { id: 'about', label: t.common.version, icon: Info },
  ];

  const renderContent = () => {
    switch (activeSystemTab) {
      case 'general':
        return <GeneralSection />;
      case 'ai-services':
        return <AIServicesSection />;
      case 'sandbox':
        return <SandboxSection />;
      case 'im-channels':
        return <IMChannelSection />;
      case 'personal-memory':
        return <PersonalMemorySection />;
      case 'about':
        return <AboutSection />;
      case 'feedback':
        return <FeedbackSection />;
      default:
        return <GeneralSection />;
    }
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      {/* Header */}
      <div className="shrink-0 flex items-center px-6 py-4 border-b border-[var(--abu-border)]">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-[var(--abu-clay-bg)] flex items-center justify-center">
            <Settings2 className="h-4 w-4 text-[var(--abu-clay)]" />
          </div>
          <h2 className="text-lg font-semibold text-[var(--abu-text-primary)]">{t.settings.title}</h2>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-[var(--abu-text-muted)]">
          <Check className="h-3 w-3 text-green-500" />
          <span>{t.settings.autoSaved}</span>
        </div>
      </div>

      {/* Body - Left/Right Layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left Navigation */}
        <nav className="w-[180px] shrink-0 border-r border-[var(--abu-border)] py-4 px-3">
          <div className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeSystemTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSystemTab(item.id)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left',
                    isActive
                      ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                      : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
                  )}
                >
                  <Icon className={cn(
                    'h-4 w-4 shrink-0',
                    isActive ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)]'
                  )} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>

        {/* Right Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {renderContent()}
        </div>
      </div>

    </div>
  );
}
