import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus, ArrowUp, ArrowRight, Square, X, ChevronDown, Check, FileText } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { useFileDragDrop } from '@/hooks/useFileDragDrop';
import { uint8ArrayToBase64 } from '@/utils/base64';
import { getBaseName, IMAGE_MIME_MAP } from '@/utils/pathUtils';
import { isImageFile } from '@/components/chat/FileAttachment';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { getCurrentLoopContext } from '@/core/agent/agentLoop';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore, getEffectiveModel, AVAILABLE_MODELS } from '@/stores/settingsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { usePermissionStore } from '@/stores/permissionStore';
import type { PermissionDuration } from '@/stores/permissionStore';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn, generateId } from '@/lib/utils';
import type { ImageAttachment } from '@/types';
import { generateAttachmentId, readFileAsBase64, SUPPORTED_IMAGE_TYPES } from '@/utils/imageUtils';
import PermissionDialog from '@/components/common/PermissionDialog';
import FolderSelector from '@/components/common/FolderSelector';

interface ChatInputProps {
  variant: 'welcome' | 'chat';
  onSend: (message: string, images?: ImageAttachment[], workspacePath?: string | null) => void;
  disabled?: boolean;
  /** Custom placeholder from scenario guide (welcome variant only) */
  scenarioPlaceholder?: string | null;
  /** Called when input text changes (welcome variant only, for hiding guide) */
  onInputChange?: (hasText: boolean) => void;
}

interface SuggestionItem {
  name: string;
  description: string;
  trigger?: string;
}

interface FileAttachmentItem {
  id: string;
  path: string;
  name: string;
}

/** Read a local image file path into an ImageAttachment via Tauri fs */
async function readLocalImage(filePath: string): Promise<ImageAttachment> {
  const bytes = await readFile(filePath);
  const base64 = uint8ArrayToBase64(bytes);
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const mediaType = (IMAGE_MIME_MAP[ext] ?? 'image/jpeg') as ImageAttachment['mediaType'];
  return { id: generateAttachmentId(), data: base64, mediaType };
}

/** Process file paths: read images as base64, collect non-image paths as file badges */
async function processFilePaths(
  paths: string[],
  addImages: (imgs: ImageAttachment[]) => void,
  addFiles: (items: FileAttachmentItem[]) => void,
): Promise<void> {
  const imgPaths: string[] = [];
  const filePaths: string[] = [];
  for (const p of paths) {
    (isImageFile(p) ? imgPaths : filePaths).push(p);
  }
  if (imgPaths.length > 0) {
    const results = await Promise.allSettled(imgPaths.map(readLocalImage));
    const newImages: ImageAttachment[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        newImages.push(r.value);
      } else {
        filePaths.push(imgPaths[i]);
      }
    });
    if (newImages.length > 0) addImages(newImages);
  }
  if (filePaths.length > 0) {
    addFiles(filePaths.map((p) => ({ id: generateAttachmentId(), path: p, name: getBaseName(p) })));
  }
}

export default function ChatInput({ variant, onSend, disabled, scenarioPlaceholder, onInputChange }: ChatInputProps) {
  const isWelcome = variant === 'welcome';

  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachmentItem[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SuggestionItem | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<SuggestionItem | null>(null);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  // Welcome-only state (always declared for hook stability)
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [localWorkspace, setLocalWorkspace] = useState<string | null>(null);

  // Store hooks (always called)
  const cancelStreaming = useChatStore((s) => s.cancelStreaming);
  const pendingInput = useChatStore((s) => s.pendingInput);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const activeConv = useActiveConversation();
  const skills = useDiscoveryStore((s) => s.skills);
  const agents = useDiscoveryStore((s) => s.agents);
  const disabledSkills = useSettingsStore((s) => s.disabledSkills);
  const disabledAgents = useSettingsStore((s) => s.disabledAgents);
  const currentModel = useSettingsStore((s) => getEffectiveModel(s));
  const provider = useSettingsStore((s) => s.provider);
  const setModel = useSettingsStore((s) => s.setModel);
  const recentPaths = useWorkspaceStore((s) => s.recentPaths);
  const grantPermission = usePermissionStore((s) => s.grantPermission);
  const hasPermission = usePermissionStore((s) => s.hasPermission);
  const { t } = useI18n();

  // Chat-only derived state
  const isRunning = activeConv?.status === 'running';
  const isStreaming = !isWelcome && isRunning;
  const availableModels = AVAILABLE_MODELS[provider] ?? [];
  const modelDisplay = availableModels.find((m) => m.id === currentModel)?.label
    ?? (currentModel ? currentModel.split('/').pop()?.split('-').slice(0, 2).join(' ') : 'Claude');
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  // Close model picker on click outside
  useEffect(() => {
    if (!showModelPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showModelPicker]);

  // Handle pasting images from clipboard
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      if (SUPPORTED_IMAGE_TYPES.includes(item.type)) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const { data, mediaType } = await readFileAsBase64(file);
        setImages((prev) => [...prev, { id: generateAttachmentId(), data, mediaType }]);
      }
    }
  }, []);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  // Consume pending input (just set text; auto-selection handled in a later effect)
  useEffect(() => {
    if (pendingInput) {
      setText(pendingInput);
      setPendingInput(null);
      textareaRef.current?.focus();
    }
  }, [pendingInput, setPendingInput]);

  const handleStop = () => {
    if (activeConv?.id) {
      cancelStreaming(activeConv.id);
    }
  };

  // File drag & drop (always called; works for both variants)
  const { isDragging } = useFileDragDrop(async (paths) => {
    await processFilePaths(
      paths,
      (imgs) => setImages((prev) => [...prev, ...imgs]),
      (items) => setFiles((prev) => [...prev, ...items]),
    );
    textareaRef.current?.focus();
  });

  // Welcome-only: folder & permission handlers
  const handleSelectFolder = (folderPath: string) => {
    if (hasPermission(folderPath, 'read')) {
      setLocalWorkspace(folderPath);
    } else {
      setPendingFolder(folderPath);
    }
  };

  const handleClearWorkspace = () => {
    setLocalWorkspace(null);
  };

  const handleAllowPermission = (duration: PermissionDuration) => {
    if (pendingFolder) {
      grantPermission(pendingFolder, ['read', 'write', 'execute'], duration);
      setLocalWorkspace(pendingFolder);
      setPendingFolder(null);
    }
  };

  const handleDenyPermission = () => {
    setPendingFolder(null);
  };

  const disabledSkillSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);
  const disabledAgentSet = useMemo(() => new Set(disabledAgents), [disabledAgents]);

  // Suggestion type tracking: 'skill' for / prefix, 'agent' for @ prefix
  const suggestionType = useMemo((): 'skill' | 'agent' | null => {
    const trimmed = text.trim();
    if (!selectedSkill && !selectedAgent) {
      if (trimmed.startsWith('@')) return 'agent';
      if (trimmed.startsWith('/')) return 'skill';
    }
    return null;
  }, [text, selectedSkill, selectedAgent]);

  // Skill/Agent suggestions
  const suggestions = useMemo((): SuggestionItem[] => {
    const trimmed = text.trim();

    // Agent suggestions when typing @
    if (suggestionType === 'agent') {
      const query = trimmed.slice(1).toLowerCase();
      return agents
        .filter((a) => a.name !== 'abu' && !disabledAgentSet.has(a.name))
        .filter((a) => {
          if (!query) return true;
          return a.name.toLowerCase().includes(query) ||
            a.description.toLowerCase().includes(query);
        })
        .map((a) => ({
          name: a.name,
          description: a.description,
        }));
    }

    // Skill suggestions when typing /
    if (suggestionType === 'skill') {
      const query = trimmed.slice(1).toLowerCase();
      return skills
        .filter((s) => s.userInvocable !== false && !disabledSkillSet.has(s.name))
        .filter((s) => {
          if (!query) return true;
          const tagStr = (s.tags ?? []).join(' ').toLowerCase();
          return s.name.toLowerCase().includes(query) ||
            s.description.toLowerCase().includes(query) ||
            tagStr.includes(query);
        })
        .map((s) => ({
          name: s.name,
          description: s.description,
          trigger: s.trigger,
        }));
    }
    return [];
  }, [text, skills, agents, suggestionType, disabledSkillSet, disabledAgentSet]);

  // Reset dismissed state when suggestions change
  useEffect(() => {
    setSuggestionsDismissed(false);
    if (suggestionType !== null && suggestions.length > 0) setSelectedIndex(0);
  }, [suggestionType, suggestions.length]);

  // Derived: show suggestions when there are matches and not dismissed
  const showSuggestions = !suggestionsDismissed && suggestionType !== null && suggestions.length > 0;

  // Auto-select skill/agent when text exactly matches "/name " or "@name " (e.g. from "Try in chat")
  useEffect(() => {
    if (!suggestionType || selectedSkill || selectedAgent) return;
    const trimmed = text.trim();

    if (suggestionType === 'skill') {
      const skillMatch = /^\/([a-z0-9-]+)$/.exec(trimmed);
      if (skillMatch && suggestions.length === 1 && suggestions[0].name === skillMatch[1]) {
        setSelectedSkill(suggestions[0]);
        setText('');
        setSuggestionsDismissed(true);
      }
    } else if (suggestionType === 'agent') {
      const agentMatch = /^@([a-z0-9-]+)$/.exec(trimmed);
      if (agentMatch && suggestions.length === 1 && suggestions[0].name === agentMatch[1]) {
        setSelectedAgent(suggestions[0]);
        setText('');
        setSuggestionsDismissed(true);
      }
    }
  }, [text, suggestionType, suggestions, selectedSkill, selectedAgent]);

  // Auto-resize textarea
  const maxHeight = isWelcome ? 180 : 160;
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    }
  }, [text, maxHeight]);

  const applySuggestion = (item: SuggestionItem) => {
    if (suggestionType === 'agent') {
      setSelectedAgent(item);
    } else {
      setSelectedSkill(item);
    }
    setText('');
    setSuggestionsDismissed(true);
    textareaRef.current?.focus();
  };

  const removeSkill = () => {
    setSelectedSkill(null);
    textareaRef.current?.focus();
  };

  const removeAgent = () => {
    setSelectedAgent(null);
    textareaRef.current?.focus();
  };

  const resetInput = () => {
    setText('');
    setImages([]);
    setFiles([]);
    setSelectedSkill(null);
    setSelectedAgent(null);
    setSuggestionsDismissed(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && !selectedSkill && !selectedAgent && images.length === 0 && files.length === 0) || disabled) return;

    // Build file context prefix
    const fileContext = files.length > 0
      ? files.map((f) => `[Attachment: \`${f.path}\`]`).join('\n')
      : '';

    // Compose parts, then join with newline
    const bodyParts = [fileContext, trimmed].filter(Boolean).join('\n');

    let message: string;
    if (selectedAgent) {
      message = `@${selectedAgent.name}${bodyParts ? ' ' + bodyParts : ''}`;
    } else if (selectedSkill) {
      message = `/${selectedSkill.name}${bodyParts ? ' ' + bodyParts : ''}`;
    } else {
      message = bodyParts;
    }

    // Mid-task input: if agent is running, enqueue the message instead of starting a new loop
    if (isRunning && activeConv?.id && message) {
      enqueueUserInput(activeConv.id, message);
      // Also add as a user message to the UI immediately, with the current loopId
      // so it groups correctly with the ongoing assistant response
      const currentLoopId = getCurrentLoopContext()?.loopId;
      useChatStore.getState().addMessage(activeConv.id, {
        id: generateId(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        loopId: currentLoopId,
      });
      resetInput();
      return;
    }

    onSend(message, images.length > 0 ? images : undefined, isWelcome ? localWorkspace : undefined);
    resetInput();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !composingRef.current)) {
        e.preventDefault();
        applySuggestion(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
    }
    // Backspace with empty text removes selected skill or agent
    if (e.key === 'Backspace' && text === '') {
      if (selectedAgent) {
        e.preventDefault();
        removeAgent();
        return;
      }
      if (selectedSkill) {
        e.preventDefault();
        removeSkill();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composingRef.current) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleAttach = async () => {
    const selected = await open({ multiple: true, directory: false });
    if (selected) {
      const paths = Array.isArray(selected) ? selected : [selected];
      await processFilePaths(
        paths,
        (imgs) => setImages((prev) => [...prev, ...imgs]),
        (items) => setFiles((prev) => [...prev, ...items]),
      );
      textareaRef.current?.focus();
    }
  };

  const hasAttachments = images.length > 0 || files.length > 0;
  const hasContent = text.trim().length > 0 || selectedSkill !== null || selectedAgent !== null || hasAttachments;

  // Determine placeholder based on selected command or scenario
  const placeholder = disabled
    ? t.chat.inputPlaceholderBusy
    : isRunning
      ? t.chat.inputPlaceholderMidTask
      : selectedAgent
        ? selectedAgent.description
        : selectedSkill
          ? selectedSkill.description
          : (isWelcome && scenarioPlaceholder)
            ? scenarioPlaceholder
            : t.chat.inputPlaceholder;

  return (
    <>
      {/* Welcome-only: Permission Dialog */}
      {isWelcome && pendingFolder && (
        <PermissionDialog
          request={{ type: 'workspace', path: pendingFolder }}
          onAllow={handleAllowPermission}
          onDeny={handleDenyPermission}
        />
      )}

      <div className="relative">
        {/* Suggestions Popup (Skills / Agents) */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute bottom-full left-0 right-0 mb-2 bg-white rounded-xl border border-[#706b5750] shadow-lg overflow-x-hidden overflow-y-auto max-h-[320px] z-20">
            {suggestions.map((item, idx) => (
              <button
                key={item.name}
                onClick={() => applySuggestion(item)}
                className={cn(
                  'btn-ghost w-full flex flex-col gap-0.5 px-4 py-2.5 text-sm text-left',
                  idx === selectedIndex ? 'bg-[#e8e5de]' : 'hover:bg-[#f5f3ee]'
                )}
              >
                <div className="flex items-center gap-3">
                  <span className={cn(
                    'w-5 text-center font-mono text-[12px] shrink-0',
                    suggestionType === 'agent' ? 'text-blue-500' : 'text-[#656358]'
                  )}>
                    {suggestionType === 'agent' ? '@' : '/'}
                  </span>
                  <span className="font-medium text-[#29261b] text-[13px]">{item.name}</span>
                  <span className="text-[12px] text-[#656358] truncate">{item.description}</span>
                </div>
                {item.trigger && (
                  <div className="pl-8 text-[11px] text-[#656358]/70 truncate">
                    TRIGGER: {item.trigger}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {/* Input Card */}
        <div
          className={cn(
            'relative bg-white rounded-2xl border transition-all',
            !isWelcome && isDragging
              ? 'border-[#d97757] ring-2 ring-[#d97757]/20'
              : 'border-[#706b5760] focus-within:border-[#706b5790] focus-within:shadow-md shadow-sm'
          )}
        >
          {/* Chat-only: Drag overlay */}
          {!isWelcome && isDragging && (
            <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-orange-50/90 z-10">
              <span className="text-sm text-[#d97757] font-medium">{t.chat.dropFilesHere}</span>
            </div>
          )}

          {/* Attachment Strip (images + file badges) */}
          {hasAttachments && (
            <div className={cn('flex items-center gap-2 overflow-x-auto', isWelcome ? 'px-5 pt-3 pb-1' : 'px-4 pt-3 pb-1')}>
              {images.map((img) => (
                <div key={img.id} className="relative group/img shrink-0">
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt=""
                    className="w-12 h-12 rounded-lg object-cover border border-[#706b5730]"
                  />
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#29261b] text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                    title={t.chat.removeImage}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
              {files.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#f5f3ee] border border-[#706b5730] shrink-0 group/file"
                >
                  <FileText className="h-3.5 w-3.5 text-[#656358] shrink-0" />
                  <span className="text-[12px] text-[#29261b] max-w-[160px] truncate">{f.name}</span>
                  <button
                    onClick={() => removeFile(f.id)}
                    className="p-0.5 rounded hover:bg-[#e8e5de] text-[#656358] hover:text-[#29261b] transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Textarea Row with inline command prefix */}
          <div className={cn(
            'flex items-start gap-0',
            isWelcome
              ? hasAttachments ? 'px-5 pt-1 pb-1' : 'px-5 pt-4 pb-1'
              : hasAttachments ? 'px-4 pt-1 pb-1' : 'px-4 pt-3.5 pb-1'
          )}>
            {/* Inline command prefix (unified for both variants) */}
            {selectedAgent && (
              <button
                onClick={removeAgent}
                className="shrink-0 mt-[3px] mr-1.5 text-[14px] font-medium text-blue-600 hover:text-blue-800 hover:line-through transition-colors cursor-pointer"
                title={t.common.close}
              >
                @{selectedAgent.name}
              </button>
            )}
            {selectedSkill && (
              <button
                onClick={removeSkill}
                className="shrink-0 mt-[3px] mr-1.5 text-[14px] font-medium text-purple-600 hover:text-purple-800 hover:line-through transition-colors cursor-pointer"
                title={t.common.close}
              >
                /{selectedSkill.name}
              </button>
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (isWelcome && onInputChange) onInputChange(e.target.value.trim().length > 0);
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => {
                // Safari/WebKit fires compositionEnd BEFORE keydown,
                // so delay reset to let the Enter keydown still see composingRef=true
                setTimeout(() => { composingRef.current = false; }, 0);
              }}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={isWelcome ? 2 : 1}
              className={cn(
                'flex-1 bg-transparent resize-none outline-none text-[#29261b] leading-relaxed',
                isWelcome
                  ? 'min-h-[52px] max-h-[180px] text-[15px]'
                  : 'min-h-[24px] max-h-[160px] py-0.5 text-[14.5px] disabled:opacity-40'
              )}
            />
          </div>

          {/* Bottom Toolbar */}
          {isWelcome ? (
            /* Welcome variant: FolderSelector + [+] + --- + Start button */
            <div className="flex items-center gap-2 px-5 pb-3.5">
              <FolderSelector
                currentPath={localWorkspace}
                recentPaths={recentPaths}
                onSelect={handleSelectFolder}
                onClear={handleClearWorkspace}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={handleAttach}
                aria-label={t.chat.addAttachment}
                className="btn-ghost h-7 w-7 text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de] rounded-lg"
              >
                <Plus className="h-4 w-4" />
              </Button>
              <div className="flex-1" />

              <button
                onClick={handleSend}
                disabled={!hasContent}
                className={cn(
                  'btn-claude-primary flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-medium',
                  hasContent
                    ? 'bg-[#29261b] text-[#faf9f5] shadow-sm'
                    : 'bg-[#e8e5de] text-[#656358]/50 cursor-not-allowed'
                )}
              >
                <span>{t.chat.start}</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            /* Chat variant: Model label + [+] + --- + Stop/Send */
            <div className="flex items-center justify-between px-4 pb-2.5 pt-0.5">
              {/* Left Actions */}
              <div className="flex items-center gap-0.5">
                {/* Model picker dropdown */}
                <div className="relative" ref={modelPickerRef}>
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    className="btn-ghost flex items-center gap-1 px-2 py-1 text-[12px] text-[#656358] font-medium hover:text-[#29261b] hover:bg-[#e8e5de] rounded-md transition-colors"
                  >
                    {modelDisplay}
                    <ChevronDown className={cn('h-3 w-3 transition-transform', showModelPicker && 'rotate-180')} />
                  </button>
                  {showModelPicker && availableModels.length > 0 && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-56 bg-white rounded-lg border border-neutral-200 shadow-lg py-1 z-50">
                      {availableModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => {
                            setModel(m.id);
                            setShowModelPicker(false);
                          }}
                          className={cn(
                            'w-full flex items-center justify-between px-3 py-1.5 text-[12px] transition-colors text-left',
                            m.id === currentModel
                              ? 'text-[#d97757] font-medium bg-[#d97757]/5'
                              : 'text-[#29261b] hover:bg-[#f5f3ee]'
                          )}
                        >
                          <span>{m.label}</span>
                          {m.id === currentModel && <Check className="h-3.5 w-3.5 text-[#d97757]" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleAttach}
                  aria-label={t.chat.addAttachment}
                  className="btn-ghost h-7 w-7 text-[#656358] hover:text-[#29261b] hover:bg-[#e8e5de] rounded-lg"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {/* Send / Stop Button */}
              {isStreaming ? (
                <Button
                  size="icon"
                  onClick={handleStop}
                  aria-label={t.chat.stop}
                  className="btn-claude-primary h-7 w-7 rounded-lg bg-red-500 hover:bg-red-600 text-white shadow-sm"
                  title={t.chat.stop}
                >
                  <Square className="h-3 w-3" fill="currentColor" />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={!hasContent || disabled}
                  className={cn(
                    'h-7 w-7 rounded-lg transition-colors',
                    hasContent && !disabled
                      ? 'bg-[#29261b] hover:bg-[#3d3a2f] text-[#faf9f5] shadow-sm'
                      : 'bg-[#e8e5de] text-[#656358]/50 cursor-not-allowed hover:bg-[#e8e5de]'
                  )}
                >
                  <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
