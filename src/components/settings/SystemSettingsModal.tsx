import { useEffect } from 'react';
import { useSettingsStore, type SystemSettingsTab } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { AppIcons } from '@/components/ds/icons';
import { NavItem } from '@/components/ds/nav-item';
import { ScrollArea } from '@/components/ds/scroll-area';
import { Separator } from '@/components/ds/separator';
import { AccountSection, AIServicesSection, AboutSection, SandboxSection, GeneralSection, CapabilitiesSection, IMChannelSection } from './sections';
import FeedbackSection from './sections/FeedbackSection';
import AuthorSection from './sections/AuthorSection';
import PersonalMemorySection from './sections/PersonalMemorySection';
import SoulSection from './sections/SoulSection';
import DiagnosticSection from './sections/DiagnosticSection';
import UsageSection from './sections/UsageSection';
import EnterpriseSection from './sections/EnterpriseSection';
import LabsSection from './sections/LabsSection';
import PetSection from './sections/PetSection';
import VoiceInputSection from './sections/VoiceInputSection';
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
  // ① account + system/app config · ② models & usage · ③ personalization ·
  // ④ channels · ⑤ support (about/feedback/diagnostic last, by convention).
  // Theme & language also live in 通用 but are surfaced in the account popover.
  type NavEntry = { id: SystemSettingsTab; label: string; icon: (typeof AppIcons)[keyof typeof AppIcons] };
  const navGroups: NavEntry[][] = [
    // ① 账号与系统 / 应用设置 — identity is the first conventional destination
    [
      { id: 'account', label: t.account.title, icon: AppIcons.account },
      { id: 'general', label: t.settings.general, icon: AppIcons.preferences },
      { id: 'capabilities', label: t.settings.capabilityOverview, icon: AppIcons.capabilities },
      { id: 'voice-input', label: t.voiceInput.title, icon: AppIcons.microphone },
      { id: 'sandbox', label: t.settings.sandbox, icon: AppIcons.security },
      { id: 'labs', label: t.settings.labs, icon: AppIcons.labs },
    ],
    // ② 模型与用量
    [
      { id: 'ai-services', label: t.settings.aiServices, icon: AppIcons.models },
      { id: 'usage', label: t.usage.title, icon: AppIcons.chart },
    ],
    // ③ 个性化 — 桌宠 sits with memory/soul (only when unlocked in Labs)
    [
      { id: 'personal-memory', label: t.sidebar.personalMemory, icon: AppIcons.memory },
      { id: 'soul', label: t.soul.title, icon: AppIcons.soul },
      ...(petUnlocked
        ? [{ id: 'pet' as SystemSettingsTab, label: t.settings.petEnable, icon: AppIcons.pet }]
        : []),
    ],
    // ④ 接入 — IM channels stands on its own
    [
      { id: 'im-channels', label: t.imChannel.title, icon: AppIcons.imChannels },
    ],
    // ⑤ 支持 — enterprise mode is an enterprise-build-only trailing entry,
    // hidden in OSS builds (bind flow / business modules aren't public product).
    [
      { id: 'diagnostic', label: t.diagnostic.title, icon: AppIcons.diagnostic },
      { id: 'feedback', label: t.about.feedback, icon: AppIcons.feedback },
      { id: 'about', label: t.common.version, icon: AppIcons.info },
      { id: 'author', label: t.author.title, icon: AppIcons.account },
      ...(IS_ENTERPRISE_BUILD
        ? [{ id: 'enterprise' as SystemSettingsTab, label: t.settings.enterpriseMode, icon: AppIcons.enterprise }]
        : []),
    ],
  ];

  const renderContent = () => {
    switch (activeSystemTab) {
      case 'account':
        return <AccountSection />;
      case 'general':
        return <GeneralSection />;
      case 'capabilities':
        return <CapabilitiesSection />;
      case 'labs':
        return <LabsSection />;
      case 'voice-input':
        return <VoiceInputSection />;
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
      case 'author':
        return <AuthorSection />;
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
    <div className="flex h-full min-h-0">
      <nav aria-label={t.settings.title} className="w-56 shrink-0 overflow-y-auto border-r border-separator p-3">
        {navGroups.map((group, groupIndex) => (
          <div key={groupIndex}>
            {groupIndex > 0 && <Separator className="my-2" />}
            <div className="space-y-1">
              {group.map((item) => (
                <NavItem
                  key={item.id}
                  label={item.label}
                  icon={item.icon}
                  selected={activeSystemTab === item.id}
                  onClick={() => setActiveSystemTab(item.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <ScrollArea className="min-w-0 flex-1">
        <div className="p-6">{renderContent()}</div>
      </ScrollArea>
    </div>
  );
}
