import { useState, useCallback, useLayoutEffect, useSyncExternalStore } from 'react';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import type { Message, ImageAttachment } from '@/types';
import { useAutoScroll } from '@/hooks/useAutoScroll';
import { runAgentLoop, getPendingCommandConfirmation, resolveCommandConfirmation, subscribeToCommandConfirmation, getPendingFilePermission, resolveFilePermission, subscribeToFilePermission, getPendingWorkspaceRequest, resolveWorkspaceRequest, subscribeToWorkspaceRequest } from '@/core/agent/agentLoop';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { PermissionDuration } from '@/stores/permissionStore';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import MessageGroup from './MessageGroup';
import ChatInput from './ChatInput';
import ScenarioGuide from './ScenarioGuide';
import PermissionDialog from '@/components/common/PermissionDialog';
import CommandConfirmDialog from '@/components/common/CommandConfirmDialog';
import { ChevronDown, Settings } from 'lucide-react';
import abuAvatar from '@/assets/abu-avatar.png';
import IMInfoBar from './IMInfoBar';

/**
 * Groups messages by loopId for rendering.
 * Messages with the same loopId are grouped together and rendered as one visual block.
 * Messages without loopId (legacy) are each treated as their own group.
 */
function groupMessagesByLoop(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  let currentGroup: Message[] = [];
  let currentLoopId: string | undefined | null = null;

  for (const msg of messages) {
    const msgLoopId = msg.loopId;

    // If loopId changes, or message has no loopId (undefined !== undefined should start new group)
    if (!msgLoopId || msgLoopId !== currentLoopId) {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [msg];
      currentLoopId = msgLoopId;
    } else {
      // Same loopId - add to current group
      currentGroup.push(msg);
    }
  }

  // Don't forget the last group
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

export default function ChatView() {
  const activeConv = useActiveConversation();
  const { createConversation } = useChatStore();
  const messages = activeConv?.messages ?? [];
  const { t } = useI18n();

  // Subscribe to command confirmation state using useSyncExternalStore
  const commandConfirmRequest = useSyncExternalStore(
    subscribeToCommandConfirmation,
    getPendingCommandConfirmation
  );

  // Subscribe to file permission requests using useSyncExternalStore
  const filePermissionRequest = useSyncExternalStore(
    subscribeToFilePermission,
    getPendingFilePermission
  );

  // Subscribe to workspace request state
  const workspaceRequest = useSyncExternalStore(
    subscribeToWorkspaceRequest,
    getPendingWorkspaceRequest
  );

  const handleCommandConfirm = () => {
    resolveCommandConfirmation(true);
  };

  const handleCommandCancel = () => {
    resolveCommandConfirmation(false);
  };

  const handleFilePermissionAllow = (duration: PermissionDuration) => {
    if (filePermissionRequest) {
      const capabilities: ('read' | 'write' | 'execute')[] =
        filePermissionRequest.capability === 'write'
          ? ['read', 'write', 'execute']
          : ['read'];
      resolveFilePermission(true, filePermissionRequest.path, capabilities, duration);
    }
  };

  const handleFilePermissionDeny = () => {
    resolveFilePermission(false);
  };

  const handleWorkspaceSelect = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: workspaceRequest?.suggestedPath || undefined,
      });
      if (selected && typeof selected === 'string') {
        // Set workspace globally
        useWorkspaceStore.getState().setWorkspace(selected);
        resolveWorkspaceRequest(selected);
      } else {
        resolveWorkspaceRequest(null);
      }
    } catch {
      resolveWorkspaceRequest(null);
    }
  };

  // Directly authorize the suggested path without opening file picker
  const handleWorkspaceAuthorize = () => {
    if (workspaceRequest?.suggestedPath) {
      useWorkspaceStore.getState().setWorkspace(workspaceRequest.suggestedPath);
      resolveWorkspaceRequest(workspaceRequest.suggestedPath);
    }
  };

  const handleWorkspaceDeny = () => {
    resolveWorkspaceRequest(null);
  };

  const isFollowing = activeConv?.status === 'running';
  const { containerRef, isAtBottom, scrollToBottom, resetToBottom } = useAutoScroll({ following: isFollowing });

  // Scroll to bottom when switching conversations.
  // useLayoutEffect runs after DOM commit but before paint,
  // so the user never sees the wrong scroll position.
  const activeConvId = activeConv?.id;
  useLayoutEffect(() => {
    if (activeConvId) {
      scrollToBottom();
    }
  }, [activeConvId, scrollToBottom]);

  const handleSend = async (text: string, images?: ImageAttachment[], workspacePath?: string | null) => {
    // Block sending if API key is not configured
    const currentApiKey = useSettingsStore.getState().apiKey;
    if (!currentApiKey?.trim()) {
      useSettingsStore.getState().openSystemSettings('ai-services');
      return;
    }

    let convId = activeConv?.id;
    const isNewConversation = !convId;
    if (!convId) {
      convId = createConversation(workspacePath);
    }
    // Auto-collapse sidebar when sending first message in a new conversation
    if (isNewConversation && !useSettingsStore.getState().sidebarCollapsed) {
      useSettingsStore.getState().toggleSidebar();
    }
    // Re-enable auto-scroll when user sends a message.
    // Don't scroll immediately — let MutationObserver scroll after the new message renders.
    resetToBottom();
    await runAgentLoop(convId, text, { images });
  };


  // Welcome screen - new conversation state (activeConversationId is null)
  const apiKey = useSettingsStore((s) => s.apiKey);
  const needsSetup = !apiKey?.trim();

  // Scenario guide state — lifted here so ChatInput can receive the custom placeholder
  const [scenarioPlaceholder, setScenarioPlaceholder] = useState<string | null>(null);
  const [guideVisible, setGuideVisible] = useState(true);

  const handleSelectPrompt = useCallback((prompt: string) => {
    // Fill the prompt into the input via pendingInput
    useChatStore.getState().setPendingInput(prompt);
  }, []);

  const handleScenarioChange = useCallback((placeholder: string | null) => {
    setScenarioPlaceholder(placeholder);
  }, []);

  // Hide guide when user starts typing (called from ChatInput)
  const handleWelcomeInputChange = useCallback((hasText: boolean) => {
    setGuideVisible(!hasText);
  }, []);

  if (!activeConv) {
    return (
      <div className="flex flex-col h-full bg-[#faf9f5]">
        <div className="flex-1 flex flex-col items-center justify-center px-8 py-12">
          <div className="w-full max-w-2xl">
            {/* Title */}
            <div className="text-center mb-8">
              {/* Mascot */}
              <div className="w-20 h-20 mx-auto mb-4 rounded-full overflow-hidden">
                <img src={abuAvatar} alt="Abu" className="w-full h-full object-cover" />
              </div>

              {/* Slogan */}
              <h1 className="text-[28px] font-semibold text-[#29261b] leading-tight mb-2">
                {t.chat.welcomeTitle}
              </h1>
              <p className="text-[15px] text-[#656358]">
                {t.chat.welcomeSubtitle}
              </p>
            </div>

            {/* First-run setup prompt */}
            {needsSetup && (
              <div className="mb-6 mx-auto max-w-md">
                <div className="rounded-xl border border-[#e8e6df] bg-white/80 px-5 py-4 text-center shadow-sm">
                  <p className="text-[15px] font-medium text-[#29261b] mb-1">
                    {t.chat.setupRequired}
                  </p>
                  <p className="text-[13px] text-[#656358] mb-3">
                    {t.chat.setupRequiredDesc}
                  </p>
                  <button
                    onClick={() => useSettingsStore.getState().openSystemSettings('ai-services')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#D97706] text-white text-[13px] font-medium hover:bg-[#B45309] transition-colors"
                  >
                    <Settings className="h-3.5 w-3.5" />
                    {t.chat.setupButton}
                  </button>
                </div>
              </div>
            )}

            {/* Main input */}
            <div>
              <ChatInput
                variant="welcome"
                onSend={handleSend}
                scenarioPlaceholder={scenarioPlaceholder}
                onInputChange={handleWelcomeInputChange}
              />
            </div>

            {/* Scenario Guide */}
            <ScenarioGuide
              onSelectPrompt={handleSelectPrompt}
              onScenarioChange={handleScenarioChange}
              visible={guideVisible}
            />
          </div>
        </div>
      </div>
    );
  }

  // Chat view with messages
  // Group messages by loopId for unified rendering
  const messageGroups = groupMessagesByLoop(messages);

  return (
    <div className="flex flex-col h-full min-h-0 min-w-0 bg-[#faf9f5]">
      {/* Command Confirmation Dialog — only show if it belongs to this conversation */}
      {commandConfirmRequest && commandConfirmRequest.conversationId === activeConvId && (
        <CommandConfirmDialog
          request={commandConfirmRequest.info}
          onConfirm={handleCommandConfirm}
          onCancel={handleCommandCancel}
        />
      )}

      {/* File Permission Dialog — only show if it belongs to this conversation */}
      {filePermissionRequest && filePermissionRequest.conversationId === activeConvId && (
        <PermissionDialog
          request={{
            type: filePermissionRequest.capability === 'write' ? 'file-write' : 'file-read',
            path: filePermissionRequest.path,
          }}
          onAllow={handleFilePermissionAllow}
          onDeny={handleFilePermissionDeny}
        />
      )}

      {/* Workspace Selection Dialog — only show if it belongs to this conversation */}
      {workspaceRequest && workspaceRequest.conversationId === activeConvId && (
        <PermissionDialog
          request={{
            type: 'folder-select',
            reason: workspaceRequest.reason,
            path: workspaceRequest.suggestedPath,
          }}
          onAllow={() => {}}
          onChooseFolder={handleWorkspaceSelect}
          onAuthorize={handleWorkspaceAuthorize}
          onDeny={handleWorkspaceDeny}
        />
      )}

      {/* IM Channel Info Bar — show for IM conversations */}
      {activeConv.imPlatform && <IMInfoBar conversation={activeConv} />}

      {/* Messages Area */}
      <div className="relative flex-1 min-h-0 overflow-y-auto" ref={containerRef}>
        <div className="w-full max-w-3xl mx-auto px-6 md:px-10 pt-5 pb-16 overflow-hidden">
          <div className="space-y-5">
            {messageGroups.map((group) => (
              <MessageGroup key={group[0].id} messages={group} />
            ))}

            {/* Typing indicator - brief flash before assistant message is created */}
            {activeConv?.status === 'running' && messages.every((m) => m.role === 'user') && (
              <div className="flex items-center gap-3 pl-9 py-1">
                <div className="flex items-center gap-1">
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[#d97757]/60" />
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[#d97757]/60" />
                  <span className="typing-dot w-1.5 h-1.5 rounded-full bg-[#d97757]/60" />
                </div>
                <span className="text-[13px] text-[#656358]">{t.chat.thinking}</span>
              </div>
            )}
          </div>

          {/* Bottom sentinel — keeps a sliver of space after last message */}
          <div className="h-px w-full" />
        </div>

        {/* Scroll-to-bottom button */}
        {!isAtBottom && (
          <button
            onClick={scrollToBottom}
            className="sticky bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/90 border border-[#706b5730] shadow-md text-[13px] text-[#656358] hover:text-[#29261b] hover:bg-white transition-all backdrop-blur-sm"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            <span>{t.chat.scrollToBottom}</span>
          </button>
        )}
      </div>

      {/* Bottom Input */}
      <div className="shrink-0 px-6 md:px-10 pb-4 pt-1.5 bg-[#faf9f5]">
        <div className="max-w-3xl mx-auto">
          <ChatInput variant="chat" onSend={handleSend} />
          <p className="text-center text-[11px] text-[#656358]/70 mt-1.5">
            {t.chat.disclaimer}
          </p>
        </div>
      </div>
    </div>
  );
}
