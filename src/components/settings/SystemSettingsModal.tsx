import { useEffect } from 'react';
import { useSettingsStore, type SystemSettingsTab } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Settings2, Info, Shield, SlidersHorizontal, MessageCircle, Radio, Brain, Heart, Activity, BarChart3, Building2, FlaskConical, PawPrint } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AIServicesSection, AboutSection, SandboxSection, GeneralSection, IMChannelSection } from './sections';
import FeedbackSection from './sections/FeedbackSection';
import PersonalMemorySection from './sections/PersonalMemorySection';
import SoulSection from './sections/SoulSection';
import DiagnosticSection from './sections/DiagnosticSection';
import UsageSection from './sections/UsageSection';
import EnterpriseSection from './sections/EnterpriseSection';
import LabsSection from './sections/LabsSection';
import PetSection from './sections/PetSection';
import { IS_ENTERPRISE_BUILD } from '@/config/featureGates';
import { useLabsFlag } from '@/core/labs/resolve';
import { LABS_PET } from '@/core/labs/registry';

export default function SystemSettingsView() {
  const {
    activeSystemTab,
    setActiveSystemTab,
  } = useSettingsStore();
  const { t } = useI18n();
  const petUnlocked = useLabsFlag(LABS_PET);

  // If the user is on the 桌宠 tab when it gets locked (pet unlock turned off in
  // Labs), fall back to a stable tab so the pane isn't blank.
  useEffect(() => {
    if (activeSystemTab === 'pet' && !petUnlocked) {
      setActiveSystemTab('labs');
    }
  }, [activeSystemTab, petUnlocked, setActiveSystemTab]);

  // Nav is chunked into intent-based clusters, separated by thin dividers with
  // no group titles (mirrors TRAE / WorkBuddy settings). Order top→bottom:
  // ① system/app config · ② models & usage · ③ personalization ·
  // ④ channels · ⑤ support (about/feedback/diagnostic last, by convention).
  // Theme & language also live in 通用 but are surfaced in the account popover.
  type NavItem = { id: SystemSettingsTab; label: string; icon: typeof Settings2 };
  const navGroups: NavItem[][] = [
    // ① 系统 / 应用设置 — 沙盒 folded in here, not its own cluster
    [
      { id: 'general', label: t.settings.general, icon: SlidersHorizontal },
      { id: 'sandbox', label: t.settings.sandbox, icon: Shield },
      { id: 'labs', label: t.settings.labs, icon: FlaskConical },
    ],
    // ② 模型与用量
    [
      { id: 'ai-services', label: t.settings.aiServices, icon: Settings2 },
      { id: 'usage', label: t.usage.title, icon: BarChart3 },
    ],
    // ③ 个性化 — 桌宠 sits with memory/soul (only when unlocked in Labs)
    [
      { id: 'personal-memory', label: t.sidebar.personalMemory, icon: Brain },
      { id: 'soul', label: t.soul.title, icon: Heart },
      ...(petUnlocked
        ? [{ id: 'pet' as SystemSettingsTab, label: t.settings.petEnable, icon: PawPrint }]
        : []),
    ],
    // ④ 接入 — IM channels stands on its own
    [
      { id: 'im-channels', label: t.imChannel.title, icon: Radio },
    ],
    // ⑤ 支持 — enterprise mode is an enterprise-build-only trailing entry,
    // hidden in OSS builds (bind flow / business modules aren't public product).
    [
      { id: 'diagnostic', label: t.diagnostic.title, icon: Activity },
      { id: 'feedback', label: t.about.feedback, icon: MessageCircle },
      { id: 'about', label: t.common.version, icon: Info },
      ...(IS_ENTERPRISE_BUILD
        ? [{ id: 'enterprise' as SystemSettingsTab, label: t.settings.enterpriseMode, icon: Building2 }]
        : []),
    ],
  ];

  const renderContent = () => {
    switch (activeSystemTab) {
      case 'general':
        return <GeneralSection />;
      case 'labs':
        return <LabsSection />;
      case 'ai-services':
        return <AIServicesSection />;
      case 'sandbox':
        return <SandboxSection />;
      case 'im-channels':
        return <IMChannelSection />;
      case 'personal-memory':
        return <PersonalMemorySection />;
      case 'soul':
        return <SoulSection />;
      case 'usage':
        return <UsageSection />;
      case 'diagnostic':
        return <DiagnosticSection />;
      case 'about':
        return <AboutSection />;
      case 'feedback':
        return <FeedbackSection />;
      case 'pet':
        // Guard the one-frame window before the fallback effect fires: never
        // render the pet pane (with its enable toggle) while locked.
        return petUnlocked ? <PetSection /> : null;
      case 'enterprise':
        return IS_ENTERPRISE_BUILD ? <EnterpriseSection /> : <GeneralSection />;
      default:
        return <GeneralSection />;
    }
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      {/* Body - Left/Right Layout */}
      <div className="flex-1 flex min-h-0">
        {/* Left Navigation — recessed canvas bg to match the main-window sidebar */}
        <nav className="w-[224px] shrink-0 border-r border-[var(--abu-border)] bg-[var(--abu-bg-canvas)] py-4 px-3 overflow-y-auto overlay-scroll">
          {navGroups.map((group, groupIndex) => (
            <div key={groupIndex}>
              {groupIndex > 0 && (
                <div className="mx-2 my-2 h-px bg-[var(--abu-border)]" />
              )}
              <div className="space-y-1">
                {group.map((item) => {
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
            </div>
          ))}
        </nav>

        {/* Right Content */}
        <div className="flex-1 overflow-y-auto overlay-scroll p-6">
          {renderContent()}
        </div>
      </div>

    </div>
  );
}
