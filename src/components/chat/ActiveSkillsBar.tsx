import { Wand2, X } from 'lucide-react';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import type { Conversation } from '@/types';

export default function ActiveSkillsBar() {
  const activeConv = useActiveConversation();
  const { t } = useI18n();
  const activeSkills = activeConv?.activeSkills;

  if (!activeSkills || activeSkills.length === 0) return null;

  const handleRemove = (skillName: string) => {
    const activeId = useChatStore.getState().activeConversationId;
    if (!activeId) return;

    useChatStore.setState((draft: { conversations: Record<string, Conversation> }) => {
      const conv = draft.conversations[activeId];
      if (conv?.activeSkills) {
        conv.activeSkills = conv.activeSkills.filter((n: string) => n !== skillName);
      }
    });
  };

  return (
    <div className="flex items-center gap-2 flex-wrap mb-1.5">
      <span className="text-[11px] text-[var(--abu-text-tertiary)] font-medium">{t.toolbox.activeSkills}</span>
      {activeSkills.map((name) => (
        <span
          key={name}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-100 text-purple-700 text-[11px] font-medium"
        >
          <Wand2 className="h-3 w-3" />
          {name}
          <button
            onClick={() => handleRemove(name)}
            className="ml-0.5 p-0.5 rounded-full hover:bg-purple-200 transition-colors"
            title={t.toolbox.activeSkillsRemove}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
    </div>
  );
}
