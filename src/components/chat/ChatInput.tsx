import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Plus, ArrowUp, Square, X, ChevronDown, FileText, Paperclip, Users, Sparkles } from 'lucide-react';
import { ModelSelector } from '@/components/chat/ModelSelector';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import TeamAvatar from '@/components/team/TeamAvatar';
import { open } from '@tauri-apps/plugin-dialog';
import { readFile } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { useFileDragDrop } from '@/hooks/useFileDragDrop';
import { uint8ArrayToBase64 } from '@/utils/base64';
import {
  hasElectronUserAttachmentReleaseHost,
  hasElectronUserAttachmentSelectHost,
  readElectronUserAttachment,
  releaseElectronUserAttachment,
  selectElectronUserAttachments,
  type ElectronUserAttachmentToken,
} from '@/utils/electronHost';
import { getBaseName, IMAGE_MIME_MAP } from '@/utils/pathUtils';
import { isImageFile } from '@/components/chat/FileAttachment';
import { isImeComposing, insertNewlineAtCursor, resolveEnterAction } from '@/components/chat/composerKeys';
import { isMacOS } from '@/utils/platform';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { requestDispatchInput } from '@/core/agent/dispatchCancel';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { collectMemberDispatches, findRunningDispatch, parseMemberAddress } from '@/components/team/teamDispatches';
import { useChatStore, useActiveConversation } from '@/stores/chatStore';
import ContextIndicator from '@/components/chat/ContextIndicator';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { mergeFileAttachments } from '@/components/chat/composerFileAttachments';
import type { PermissionDuration } from '@/stores/permissionStore';
import { useI18n, format } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { useTeamStore } from '@/stores/teamStore';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ImageAttachment } from '@/types';
import { generateAttachmentId, SUPPORTED_IMAGE_TYPES, sniffImageMediaType, IMAGE_MAGIC_PREFIX_BYTES } from '@/utils/imageUtils';
import { fitImageToDimension } from '@/utils/imageCompress';
import { admissionMaxDimension } from '@/core/llm/imagePolicy';
import PermissionDialog from '@/components/common/PermissionDialog';
import FolderSelector from '@/components/common/FolderSelector';
import PromoteToProjectHint from '@/components/chat/PromoteToProjectHint';
import PermissionModeChip from '@/components/chat/PermissionModeChip';
import { serializeReferences } from '@/utils/referenceSerializer';
import { highlightRegistry } from '@/features/reference/highlightRegistry';
import type { ChatReference } from '@/types/chatReference';
import {
  findAgentMentionTarget,
  parseLeadingAgentCommand,
  resolveAgentMentionReplacementRange,
  type AgentMentionTarget,
  type ComposerSelection,
} from '@/components/chat/composerAgentMention';
import {
  clearComposerDraft,
  COMPOSER_DRAFT_SAVE_DELAY_MS,
  beginComposerDraftAdmission,
  getComposerDraftKey,
  getComposerDraftRuntimeState,
  getComposerDraftScopeForEnterpriseMode,
  registerComposerDraftResourceDisposer,
  readComposerDraft,
  subscribeComposerDraft,
  subscribeComposerDraftRuntime,
  tryBeginComposerDraftSend,
  updateComposerDraft,
  writeComposerDraft,
  writePersistedComposerText,
  type ComposerDraft,
  type ComposerDraftRuntimeState,
} from '@/stores/composerDraftStore';

/** Max reference chips per message — guards against prompt bloat. */
const MAX_REFERENCES = 20;
const ELECTRON_PICKER_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
/** Merge a widget-provided follow-up (window.sendPrompt) into the current
 *  composer draft: append with a newline separator when the draft is
 *  non-empty, else use the addition verbatim. Pure so the append-vs-empty
 *  behavior is unit-testable without rendering the component. */
// eslint-disable-next-line react-refresh/only-export-components
export function mergeComposerAppend(prev: string, addition: string): string {
  return prev.trim().length > 0 ? `${prev}\n${addition}` : addition;
}

/** Dedup key for the pendingReferences drain (see the effect below). Pure so
 *  the "dom-element dedupes by id, doc-selection by content" split is
 *  unit-testable without rendering the component. */
// eslint-disable-next-line react-refresh/only-export-components
export function referenceDedupeKey(r: ChatReference): string {
  return r.kind === 'dom-element' ? `dom|${r.id}` : `${r.source.path}|${r.selection.text}|${r.comment ?? ''}`;
}

/** Visible label for a reference chip: dom-element shows the readable name
 *  (`source.name`, e.g. "div#hero.card") computed by createDomElementReference
 *  instead of raw outerHTML tag soup; doc-selection keeps showing the quoted
 *  selected text. Pure so it's unit-testable without rendering. */
// eslint-disable-next-line react-refresh/only-export-components
export function referenceChipLabel(r: ChatReference): string {
  return r.kind === 'dom-element' ? r.source.name : r.selection.text;
}

/** The workspace picker belongs to the pre-task context, not the send toolbar.
 * Keep it visible while an unbound draft has a temporary folder selection so
 * the user can verify or change that choice before the first send. */
// eslint-disable-next-line react-refresh/only-export-components
export function shouldShowWorkspaceContextBar(
  variant: ChatInputProps['variant'],
  boundWorkspacePath: string | null | undefined,
): boolean {
  return variant === 'welcome' && !boundWorkspacePath;
}

interface ChatInputProps {
  variant: 'welcome' | 'chat';
  /**
   * Deliver the composed message. Resolving to `false` means the send was not
   * accepted (no API key, conversation busy) and the composer restores the
   * draft it optimistically cleared. `onAccepted` fires as soon as the message
   * is durably taken (its transcript row exists) — the composer releases its
   * pending-send lock there instead of holding it for the whole run, so a new
   * draft under the same key (welcome composer, post-run follow-up) can send
   * while the previous run is still executing.
   */
  onSend: (
    message: string,
    images?: ImageAttachment[],
    workspacePath?: string | null,
    onAccepted?: () => void,
  ) => void | Promise<boolean | void>;
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
  /** True for team entries in the @ list — picking one pins the conversation
   *  to the team (its leader runs the loop) instead of becoming an @ prefix. */
  team?: boolean;
  teamId?: string;
  /** Team emoji avatar (user-set); absent = default group mark. */
  avatar?: string;
}

interface FileAttachmentItem {
  id: string;
  path?: string;
  token?: string;
  name: string;
  expiresAt?: number;
  readScope?: 'workspace';
}

function hasComposerContent(draft: ComposerDraft): boolean {
  return draft.text.length > 0
    || draft.images.length > 0
    || draft.files.length > 0
    || draft.references.length > 0
    || draft.selectedSkill !== null
    || draft.selectedAgent !== null;
}

function mergeDraftTextForRestore(currentText: string, sentText: string): string {
  if (currentText.length === 0) return sentText;
  if (sentText.length === 0 || currentText === sentText || currentText.endsWith(`\n${sentText}`)) return currentText;
  return `${currentText}\n${sentText}`;
}

function stripExpiredTokenFiles(files: FileAttachmentItem[], now = Date.now()): {
  files: FileAttachmentItem[];
  removedFiles: FileAttachmentItem[];
} {
  const kept: FileAttachmentItem[] = [];
  const removedFiles: FileAttachmentItem[] = [];
  for (const file of files) {
    if (file.token && typeof file.expiresAt === 'number' && file.expiresAt <= now) {
      removedFiles.push(file);
      continue;
    }
    kept.push(file);
  }
  return { files: kept, removedFiles };
}

function dedupeReferencesForRestore(references: ChatReference[]): ChatReference[] {
  const seen = new Set<string>();
  const deduped: ChatReference[] = [];
  for (const reference of references) {
    const key = referenceDedupeKey(reference);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(reference);
  }
  return deduped;
}

function mergeDraftForRejectedSend(currentDraft: ComposerDraft, sentDraft: ComposerDraft): {
  draft: ComposerDraft;
  expiredFiles: FileAttachmentItem[];
} {
  const sentExpiry = stripExpiredTokenFiles(sentDraft.files);
  const cleanSentDraft: ComposerDraft = {
    ...sentDraft,
    files: sentExpiry.files,
  };
  if (!hasComposerContent(currentDraft)) {
    return { draft: cleanSentDraft, expiredFiles: sentExpiry.removedFiles };
  }

  const currentExpiry = stripExpiredTokenFiles(currentDraft.files);
  const currentWithoutExpiredTokens = {
    ...currentDraft,
    files: currentExpiry.files,
  };
  const mergedFiles = mergeFileAttachments(currentWithoutExpiredTokens.files, cleanSentDraft.files).files;
  return {
    draft: {
      text: mergeDraftTextForRestore(currentWithoutExpiredTokens.text, cleanSentDraft.text),
      images: [...currentWithoutExpiredTokens.images, ...cleanSentDraft.images],
      files: mergedFiles,
      references: dedupeReferencesForRestore([...currentWithoutExpiredTokens.references, ...cleanSentDraft.references]),
      selectedSkill: currentWithoutExpiredTokens.selectedSkill ?? cleanSentDraft.selectedSkill,
      selectedAgent: currentWithoutExpiredTokens.selectedAgent ?? cleanSentDraft.selectedAgent,
    },
    expiredFiles: [...currentExpiry.removedFiles, ...sentExpiry.removedFiles],
  };
}

/**
 * The single admission gate for composer images.
 *
 * Providers reject an image whose longest side exceeds their limit, and the
 * rejected image is already in durable history by then — every later request in
 * that session fails too, including text-only ones. Downscaling here keeps the
 * picture usable instead of letting one oversized screenshot kill the thread.
 *
 * `resized` rides along so the send path can tell the model the image it is
 * looking at is not at original scale (see `buildUserMessageContent`).
 */
async function admitImage(
  bytes: Uint8Array,
  mediaType: ImageAttachment['mediaType'],
): Promise<ImageAttachment> {
  const fitted = await fitImageToDimension({ bytes, mediaType }, admissionMaxDimension());
  return {
    id: generateAttachmentId(),
    data: uint8ArrayToBase64(fitted.bytes),
    mediaType: fitted.mediaType as ImageAttachment['mediaType'],
    ...(fitted.resized ? { resized: fitted.resized } : {}),
  };
}

/**
 * Admit a pasted file as an image when its BYTES say it is one.
 *
 * Returns null for anything that is not a sendable image, so the caller can
 * keep treating it as a plain file. Only the leading bytes are read for the
 * check — a 200MB video must not be pulled into memory just to be rejected.
 *
 * The declared `type` is still honoured as a fallback: it is the only signal
 * for a source that hands over correctly-labelled bytes we have no signature
 * for, and trusting it here keeps every case that worked before working.
 */
async function admitPastedImage(file: File): Promise<ImageAttachment | null> {
  // A pasted directory also arrives as a `File`, and reading it throws. Any
  // read failure just means "not an image we can show" — it must never take
  // the whole paste down with it, since the path branch can still badge it.
  try {
    if (file.size === 0) return null;
    const head = new Uint8Array(await file.slice(0, IMAGE_MAGIC_PREFIX_BYTES).arrayBuffer());
    const sniffed = sniffImageMediaType(head);
    const declared = SUPPORTED_IMAGE_TYPES.includes(file.type) ? file.type : null;
    const mediaType = sniffed ?? declared;
    if (!mediaType) return null;
    return await admitImage(new Uint8Array(await file.arrayBuffer()), mediaType as ImageAttachment['mediaType']);
  } catch {
    return null;
  }
}

/** Read a local image file path into an ImageAttachment via Tauri fs */
async function readLocalImage(filePath: string): Promise<ImageAttachment> {
  const bytes = await readFile(filePath);
  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const mediaType = (IMAGE_MIME_MAP[ext] ?? 'image/jpeg') as ImageAttachment['mediaType'];
  return admitImage(bytes, mediaType);
}

/** Process file paths: read images as base64, collect non-image paths as file badges */
async function processFilePaths(
  paths: string[],
  addImages: (imgs: ImageAttachment[]) => void,
  addFiles: (items: FileAttachmentItem[]) => void,
  fileMetadataForPath?: (path: string) => Pick<FileAttachmentItem, 'readScope'>,
): Promise<void> {
  const imgPaths: string[] = [];
  const filePaths: string[] = [];
  for (const p of paths) {
    if (p.toLowerCase().endsWith('.pdf')) continue;
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
    addFiles(filePaths.map((p) => ({
      id: generateAttachmentId(),
      path: p,
      name: getBaseName(p),
      ...fileMetadataForPath?.(p),
    })));
  }
}

function releaseToken(token: string | undefined): void {
  if (!token || !hasElectronUserAttachmentReleaseHost()) return;
  void releaseElectronUserAttachment({ token }).catch(() => {});
}

function releaseTokenFiles(files: FileAttachmentItem[]): void {
  const tokens = new Set(files.flatMap((file) => file.token ? [file.token] : []));
  for (const token of tokens) releaseToken(token);
}

registerComposerDraftResourceDisposer((resource) => {
  if (resource.kind === 'file-token') releaseToken(resource.token);
});

async function imageFromToken(attachment: ElectronUserAttachmentToken): Promise<ImageAttachment | null> {
  if (!SUPPORTED_IMAGE_TYPES.includes(attachment.mediaType)) return null;
  try {
    const bytes = await readElectronUserAttachment({ token: attachment.token });
    return await admitImage(bytes, attachment.mediaType as ImageAttachment['mediaType']);
  } finally {
    releaseToken(attachment.token);
  }
}

/**
 * Composer suggestion popup — grouped like Codex's composer (user feedback
 * 2026-09-01): small section headers (团队 / 队员 / 技能), names only (no
 * descriptions — too long), one scrollable list whose height is clamped to
 * the space above the composer so the top can never be clipped by the window.
 */
const SUGGESTION_MAX_HEIGHT = 320;
const SUGGESTION_TOP_MARGIN = 16;

function SuggestionPopup({ listboxId, ariaLabel, suggestions, selectedIndex, suggestionType, sectionLabels, optionId, onApply, anchorRef }: {
  listboxId: string;
  ariaLabel: string;
  suggestions: SuggestionItem[];
  selectedIndex: number;
  suggestionType: 'skill' | 'agent' | null;
  sectionLabels: { teams: string; agents: string; skills: string };
  optionId: (index: number) => string;
  onApply: (item: SuggestionItem) => void;
  /** The composer card the popup opens above. */
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  // Rendered in a portal with FIXED positioning, anchored above the composer.
  // As an absolutely-positioned child it was clipped by an overflow ancestor
  // whenever it grew past the chat area's top edge — the top ~40px (padding +
  // the first group header) simply were not painted, which read as "the card
  // is cut off" (real-machine reports 2026-09-01 and 09-03). Same remedy as
  // ui/search-select: escape the clipping tree, measure the anchor, re-measure
  // on capture-phase scroll (dialog/chat bodies scroll, not the window) and on
  // resize. Height is clamped to the space above the anchor so the popup never
  // leaves the window either.
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  // useEffect, not useLayoutEffect: when the popup is already open on the
  // composer's FIRST render (a restored draft ending in `@`), it mounts in the
  // same commit as the anchor div, and React runs a child's layout effects
  // before it attaches the parent's ref — the anchor would measure as null and
  // nothing would be rendered until a scroll/resize. Passive effects run after
  // every ref in the commit is attached. Nothing paints until `style` is set,
  // so there is no mispositioned first frame either.
  useEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        bottom: window.innerHeight - rect.top + 8,
        maxHeight: Math.max(120, Math.min(SUGGESTION_MAX_HEIGHT, rect.top - SUGGESTION_TOP_MARGIN)),
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    // The textarea auto-grows without any scroll/resize event; follow the anchor.
    const observer = typeof ResizeObserver === 'function' && anchorRef.current ? new ResizeObserver(update) : null;
    if (observer && anchorRef.current) observer.observe(anchorRef.current);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); observer?.disconnect(); };
  }, [anchorRef]);

  const teamCount = suggestions.filter((item) => item.team).length;
  const sections: Array<{ label: string; items: Array<{ item: SuggestionItem; idx: number }> }> = suggestionType === 'agent'
    ? [
        { label: sectionLabels.teams, items: suggestions.slice(0, teamCount).map((item, i) => ({ item, idx: i })) },
        { label: sectionLabels.agents, items: suggestions.slice(teamCount).map((item, i) => ({ item, idx: teamCount + i })) },
      ]
    : [{ label: sectionLabels.skills, items: suggestions.map((item, i) => ({ item, idx: i })) }];

  if (!style) return null;
  return createPortal(
    <div
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      style={style}
      // Overlays painted above the window chrome must carve themselves out of
      // the drag lane (src/styles/index.css) — this one can now overlap it.
      data-electron-no-drag
      className="bg-[var(--abu-bg-base)] rounded-xl border border-[var(--abu-border)] shadow-lg overflow-x-hidden overflow-y-auto py-1.5 z-[10001]"
    >
      {sections.filter((section) => section.items.length > 0).map((section) => (
        <div key={section.label} role="group" aria-label={section.label}>
          <div className="px-4 pt-2 pb-1 text-minor text-[var(--abu-text-tertiary)] select-none">{section.label}</div>
          {section.items.map(({ item, idx }) => (
            <button
              key={item.name}
              id={optionId(idx)}
              role="option"
              aria-selected={idx === selectedIndex}
              onClick={() => onApply(item)}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                'btn-ghost w-full flex items-center gap-3 px-4 py-2 text-body text-left',
                idx === selectedIndex ? 'bg-[var(--abu-bg-hover)]' : 'hover:bg-[var(--abu-bg-muted)]'
              )}
            >
              <span className={cn(
                'w-5 text-center font-mono text-minor shrink-0',
                suggestionType === 'agent' ? 'text-[var(--abu-info)]' : 'text-[var(--abu-text-tertiary)]'
              )}>
                {suggestionType === 'agent' ? (item.team ? <TeamAvatar avatar={item.avatar} size="xs" round className="mx-auto" /> : '@') : '/'}
              </span>
              <span className="font-medium text-[var(--abu-text-primary)] truncate">{item.name}</span>
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}

export default function ChatInput({ variant, onSend, disabled, scenarioPlaceholder, onInputChange }: ChatInputProps) {
  const isWelcome = variant === 'welcome';
  const activeConv = useActiveConversation();
  const draftScope = useEnterpriseStore((state) => getComposerDraftScopeForEnterpriseMode(state.mode));
  // An empty, already-created conversation still renders the welcome variant;
  // it must keep its own key rather than sharing the top-level welcome draft.
  const draftKey = getComposerDraftKey(activeConv?.id, draftScope);
  const suggestionListboxId = useId();
  const suggestionOptionId = useCallback(
    (index: number) => `${suggestionListboxId}-option-${index}`,
    [suggestionListboxId],
  );
  const [initialDraft] = useState(() => readComposerDraft(draftKey));
  // Context usage indicator shows only in chat variant once a conversation exists.
  const activeConvIdForIndicator = useChatStore((s) => (isWelcome ? null : s.activeConversationId));

  const [text, setText] = useState(initialDraft.text);
  const [images, setImages] = useState<ImageAttachment[]>(initialDraft.images);
  const [files, setFiles] = useState<FileAttachmentItem[]>(initialDraft.files);
  const [references, setReferences] = useState<ChatReference[]>(initialDraft.references);
  const [selectedSkill, setSelectedSkill] = useState<SuggestionItem | null>(initialDraft.selectedSkill);
  const [selectedAgent, setSelectedAgent] = useState<SuggestionItem | null>(initialDraft.selectedAgent);
  const allTeams = useTeamStore((store) => store.teams);
  const activeTeams = useMemo(() => allTeams.filter((team) => !team.archivedAt), [allTeams]);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selection, setSelection] = useState<ComposerSelection>({
    start: initialDraft.text.length,
    end: initialDraft.text.length,
  });
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const isMountedRef = useRef(false);
  const compositionResetTimerRef = useRef<number | null>(null);
  const pendingSelectionRef = useRef<ComposerSelection | null>(null);

  const currentDraftRef = useRef<ComposerDraft>(initialDraft);
  const currentDraftKeyRef = useRef(draftKey);
  const prevDraftKeyRef = useRef(draftKey);
  const restoringDraftRef = useRef(false);

  // Keep the latest committed local state available to switch/unmount
  // cleanup without reading or mutating refs during render.
  useLayoutEffect(() => {
    currentDraftRef.current = {
      text,
      images,
      files,
      references,
      selectedSkill,
      selectedAgent,
    };
  }, [files, images, references, selectedAgent, selectedSkill, text]);

  useLayoutEffect(() => {
    const pendingSelection = pendingSelectionRef.current;
    if (!pendingSelection) return;

    const textarea = textareaRef.current;
    if (!textarea) {
      pendingSelectionRef.current = null;
      return;
    }

    const start = Math.max(0, Math.min(pendingSelection.start, textarea.value.length));
    const end = Math.max(0, Math.min(pendingSelection.end, textarea.value.length));
    if (textarea.selectionStart !== start || textarea.selectionEnd !== end) {
      textarea.setSelectionRange(start, end);
    }
    pendingSelectionRef.current = null;
    setSelection((prev) => (
      prev.start === start && prev.end === end ? prev : { start, end }
    ));
  }, [text]);

  // Welcome-only state (always declared for hook stability).
  // `localWorkspace` defaults to the active conv's bound workspace (set
  // by project "+") or the current global workspace. Without this, the
  // FolderSelector always started empty even when the user had just
  // entered a project context — forcing a pointless re-pick. See below
  // effect that re-syncs when the active conv changes (e.g. user clicks
  // a different project's "+" while welcome is already mounted).
  const [pendingFolder, setPendingFolder] = useState<string | null>(null);
  const [localWorkspace, setLocalWorkspace] = useState<string | null>(() => {
    const convId = useChatStore.getState().activeConversationId;
    const conv = convId ? useChatStore.getState().conversations[convId] : null;
    return conv?.workspacePath ?? useWorkspaceStore.getState().currentPath;
  });

  // Store hooks (always called)
  const cancelStreaming = useChatStore((s) => s.cancelStreaming);
  const pendingInput = useChatStore((s) => s.pendingInput);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const pendingInputAppend = useChatStore((s) => s.pendingInputAppend);
  const appendPendingInput = useChatStore((s) => s.appendPendingInput);
  const pendingReferences = useChatStore((s) => s.pendingReferences);
  const clearPendingReferences = useChatStore((s) => s.clearPendingReferences);
  const pendingAttachmentRequests = useChatStore((s) => s.pendingAttachmentRequests);
  const clearPendingAttachments = useChatStore((s) => s.clearPendingAttachments);
  const skills = useDiscoveryStore((s) => s.skills);
  const agents = useDiscoveryStore((s) => s.agents);
  const enterBehavior = useSettingsStore((s) => s.composerEnterBehavior);
  const disabledSkills = useSettingsStore((s) => s.disabledSkills);
  const disabledAgents = useSettingsStore((s) => s.disabledAgents);
  const globalActiveModel = useSettingsStore((s) => s.activeModel);
  const providers = useSettingsStore((s) => s.providers);
  const isEnterprise = useEnterpriseStore((s) => s.mode.kind !== 'personal');
  // The model shown/edited here is the active conversation's pinned model when it
  // has one, else the global selection — keeps the picker label in sync with what
  // this specific conversation actually runs on (see per-conversation model pin).
  const effModel = activeConv?.model ?? globalActiveModel;
  const currentModel = effModel.modelId;
  const effProvider = providers.find((p) => p.id === effModel.providerId);
  const recentPaths = useWorkspaceStore((s) => s.recentPaths);
  const grantPermission = usePermissionStore((s) => s.grantPermission);
  const hasPermission = usePermissionStore((s) => s.hasPermission);
  const { t } = useI18n();
  const [draftRuntimeState, setDraftRuntimeState] = useState<ComposerDraftRuntimeState>(
    () => getComposerDraftRuntimeState(draftKey),
  );

  // Chat-only derived state
  const isRunning = activeConv?.status === 'running';
  const isAdmissionPendingForDraft = draftRuntimeState.pendingAdmissions > 0;
  const isStreaming = !isWelcome && isRunning;
  const isEnterpriseGatewayModel = isEnterprise && effModel.providerId === 'enterprise-gateway' && currentModel.length > 0;
  const hasActiveProvider = isEnterpriseGatewayModel || (!!effProvider && effProvider.enabled);
  const availableModels = effProvider?.models ?? [];
  const activeModelInfo = availableModels.find((m) => m.id === currentModel);
  const modelDisplay = !hasActiveProvider
    ? t.chat.noModelConfigured
    : isEnterpriseGatewayModel
      ? currentModel
      : (activeModelInfo?.label ?? (currentModel ? currentModel.split('/').pop()?.split('-').slice(0, 2).join(' ') : 'Claude'));
  const [showModelPicker, setShowModelPicker] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const showAttachmentAdmissionFailed = useCallback((_error?: unknown) => {
    useToastStore.getState().addToast({
      type: 'error',
      title: t.chat.attachmentAdmissionFailed,
    });
  }, [t]);

  const beginAttachmentAdmission = useCallback((key: string) => beginComposerDraftAdmission(key), []);

  const appendImagesForDraftKey = useCallback((key: string, nextImages: ImageAttachment[]) => {
    if (nextImages.length === 0) return;
    updateComposerDraft(key, (draft) => ({ ...draft, images: [...draft.images, ...nextImages] }));
  }, []);

  const appendFilesForDraftKey = useCallback((key: string, nextFiles: FileAttachmentItem[]) => {
    if (nextFiles.length === 0) return;
    updateComposerDraft(key, (draft) => {
      const result = mergeFileAttachments(draft.files, nextFiles);
      releaseTokenFiles(result.dropped);
      return { ...draft, files: result.files };
    });
  }, []);

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

  // Handle pasting from clipboard.
  //
  // Two distinct sources land here:
  //   (a) Files copied from Finder/Explorer (Cmd/Ctrl+C on a file) — we want
  //       chips identical to drag-drop, which means we need the *real OS
  //       path*. The browser ClipboardEvent never exposes that, so we ask
  //       the Rust side to read the native pasteboard (NSPasteboard /
  //       CF_HDROP) and then reuse the same processFilePaths pipeline that
  //       handles drag-drop.
  //   (b) Raw bitmaps with no backing file (screenshots taken with
  //       Cmd+Shift+Ctrl+4 on macOS, snipping-tool pastes on Windows). These
  //       have no file URL on the pasteboard, so we fall back to the
  //       getAsFile() image path.
  //
  // The preventDefault MUST run synchronously the moment we see any
  // `kind === 'file'` item — once we hit `await`, the textarea will have
  // already swallowed the default paste (which is what causes filename text
  // to leak into the input on the current build).
  //
  // IMPORTANT: getAsFile() must also be called synchronously before any await.
  // DataTransfer (ClipboardEvent.clipboardData) is only valid during
  // synchronous handler execution — after an await the browser invalidates
  // DataTransferItem objects and getAsFile() returns null (Clipboard API §3.2).
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const hasFileItem = Array.from(items).some((it) => it.kind === 'file');
    if (!hasFileItem) return; // plain text / html → let textarea handle it

    e.preventDefault();
    const admissionKey = draftKey;
    const finishAdmission = beginAttachmentAdmission(admissionKey);

    try {
      // Pre-extract File objects synchronously before the first await.
      // getAsFile() returns null on any DataTransferItem touched after an await.
      //
      // EVERY file item is captured, not just ones already labelled with a
      // supported image type: when an app copies an image, macOS puts a
      // pasteboard temp item on the clipboard whose name carries no usable
      // extension (`…/id=6571367.107158211`), and Chromium hands that to the
      // renderer as a File with an EMPTY `type`. Filtering on `type` here threw
      // the real image bytes away before anything could look at them.
      const pastedFiles: File[] = Array.from(items)
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);

      // (a) The bytes the event handed us decide what is an image — names and
      // mime labels both lie for pasteboard temp items. This also pins down the
      // media type exactly, instead of guessing it from a file extension.
      const admitted: ImageAttachment[] = [];
      const admittedNames = new Set<string>();
      const nonImageFiles: File[] = [];
      for (const file of pastedFiles) {
        const image = await admitPastedImage(file);
        if (image) {
          admitted.push(image);
          admittedNames.add(file.name);
        } else {
          nonImageFiles.push(file);
        }
      }
      appendImagesForDraftKey(admissionKey, admitted);

      // (b) Whatever was NOT an image still wants its real absolute path so the
      // badge can open/reference the actual file — that is what the OS pasteboard
      // lookup is for, and it keeps full parity with drag-drop.
      if (nonImageFiles.length === 0) return;

      let paths: string[] = [];
      try {
        paths = await invoke<string[]>('read_clipboard_file_paths');
      } catch {
        // Native command unavailable or failed — nothing more we can do here.
      }
      // An image already admitted from its bytes must not come back as a badge.
      const badgePaths = paths.filter((p) => {
        const name = getBaseName(p);
        return !admittedNames.has(name) && !name.toLowerCase().endsWith('.pdf');
      });
      if (badgePaths.length === 0) return;

      await processFilePaths(
        badgePaths,
        (imgs) => appendImagesForDraftKey(admissionKey, imgs),
        (newFiles) => appendFilesForDraftKey(admissionKey, newFiles),
      );
    } catch (error) {
      showAttachmentAdmissionFailed(error);
    } finally {
      finishAdmission();
    }
  }, [
    appendFilesForDraftKey,
    appendImagesForDraftKey,
    beginAttachmentAdmission,
    draftKey,
    showAttachmentAdmissionFailed,
  ]);

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const removed = prev.find((file) => file.id === id);
      releaseToken(removed?.token);
      const next = prev.filter((f) => f.id !== id);
      currentDraftRef.current = { ...currentDraftRef.current, files: next };
      writeComposerDraft(draftKey, currentDraftRef.current);
      return next;
    });
  }, [draftKey]);

  // Save draft & restore on conversation switch. Rich content stays in the
  // module-level session cache; plain text is also persisted for app reloads.
  const activeConvId = activeConv?.id ?? null;

  // Team chip = the conversation's team pin (welcome: the pending pin that
  // createConversation consumes). Store-derived on purpose — it survives the
  // welcome→conversation draft-key switch that resets composer-local chips.
  const pendingTeamId = useChatStore((s) => s.pendingTeamId);
  const setConversationTeamId = useChatStore((s) => s.setConversationTeamId);
  const setPendingTeamId = useChatStore((s) => s.setPendingTeamId);
  const pinnedTeamId = activeConvId ? activeConv?.teamId : pendingTeamId;
  // Selector rather than `activeTeams.find` on the per-render filtered array:
  // that form makes the React Compiler drop the component's memoization.
  const pinnedTeam = useTeamStore((store) => (
    pinnedTeamId ? store.teams.find((team) => team.id === pinnedTeamId && !team.archivedAt) ?? null : null
  ));
  const pinTeam = useCallback((teamId: string | undefined) => {
    if (activeConvId) setConversationTeamId(activeConvId, teamId);
    else setPendingTeamId(teamId);
  }, [activeConvId, setConversationTeamId, setPendingTeamId]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Welcome-only: re-sync FolderSelector to the active conv's workspace
  // whenever the conv (or its bound workspace) changes. Covers "user on
  // welcome page clicks a different project's +" — without this, the
  // FolderSelector would keep showing the previous workspace pick.
  //
  // Also subscribe to the global workspaceStore.currentPath: the
  // "create project → welcome → type" flow never touches activeConvId
  // (it stays null the whole time), but CreateProjectDialog DOES call
  // setWorkspace(finalFolder). Without the global subscription the
  // welcome input's localWorkspace would stay at its stale init value
  // and onSend would pass null to createConversation — the new conv
  // would then have no workspace, no project lookup, no auto-associate.
  const activeConvWorkspace = activeConv?.workspacePath ?? null;
  const globalWorkspace = useWorkspaceStore((s) => s.currentPath);
  const boundWorkspacePath = activeConvWorkspace ?? globalWorkspace;
  const showWorkspaceContextBar = shouldShowWorkspaceContextBar(variant, boundWorkspacePath);
  useEffect(() => {
    if (!isWelcome) return;
    const next = boundWorkspacePath;
    setLocalWorkspace(next);
  }, [activeConvId, boundWorkspacePath, isWelcome]);

  useEffect(() => {
    const previousKey = prevDraftKeyRef.current;
    if (previousKey === draftKey) return;

    // The layout effect has captured the last committed local state. At this
    // point it still belongs to the previous conversation.
    writeComposerDraft(previousKey, currentDraftRef.current);

    const draft = readComposerDraft(draftKey);
    // Reassign ownership before scheduling React state updates so an unmount
    // between this effect and the next render still flushes the right draft.
    currentDraftRef.current = draft;
    currentDraftKeyRef.current = draftKey;
    restoringDraftRef.current = true;
    setText(draft.text);
    setImages(draft.images);
    setFiles(draft.files);
    setReferences(draft.references);
    setSelectedSkill(draft.selectedSkill);
    setSelectedAgent(draft.selectedAgent);
    setSelection({ start: draft.text.length, end: draft.text.length });
    setDismissedSuggestionKey(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    prevDraftKeyRef.current = draftKey;
  }, [draftKey]);

  useEffect(() => {
    setDraftRuntimeState(getComposerDraftRuntimeState(draftKey));
    return subscribeComposerDraftRuntime(draftKey, () => {
      if (isMountedRef.current) setDraftRuntimeState(getComposerDraftRuntimeState(draftKey));
    });
  }, [draftKey]);

  useEffect(() => subscribeComposerDraft(draftKey, () => {
    if (!isMountedRef.current) return;
    const draft = readComposerDraft(draftKey);
    currentDraftRef.current = draft;
    restoringDraftRef.current = true;
    setText(draft.text);
    setSelection({ start: draft.text.length, end: draft.text.length });
    setImages(draft.images);
    setFiles(draft.files);
    setReferences(draft.references);
    setSelectedSkill(draft.selectedSkill);
    setSelectedAgent(draft.selectedAgent);
  }), [draftKey]);

  // Persist text after a short quiet period. A key switch is handled above:
  // the old draft is flushed synchronously and the first render containing
  // stale text is deliberately skipped before the restored value arrives.
  useEffect(() => {
    if (restoringDraftRef.current) {
      restoringDraftRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      writePersistedComposerText(draftKey, text);
    }, COMPOSER_DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draftKey, text]);

  // React can unmount ChatInput when moving between welcome/empty/chat
  // layouts. Flush through refs so the latest keystroke is never stranded in
  // a cancelled debounce timer.
  useEffect(() => () => {
    if (compositionResetTimerRef.current !== null) {
      window.clearTimeout(compositionResetTimerRef.current);
      compositionResetTimerRef.current = null;
    }
    writeComposerDraft(currentDraftKeyRef.current, currentDraftRef.current);
  }, []);

  useEffect(() => {
    if (isWelcome) onInputChange?.(text.trim().length > 0);
  }, [isWelcome, onInputChange, text]);

  // Consume pending input (just set text; auto-selection handled in a later effect)
  useEffect(() => {
    if (pendingInput) {
      const pendingSelection = { start: pendingInput.length, end: pendingInput.length };
      pendingSelectionRef.current = pendingSelection;
      setText(pendingInput);
      setSelection(pendingSelection);
      // React does not schedule a render when the store value equals the
      // current draft. Keep the real DOM caret in sync in that case too.
      const textarea = textareaRef.current;
      if (textarea) {
        const alreadyRendered = textarea.value === pendingInput;
        textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
        if (alreadyRendered) pendingSelectionRef.current = null;
      }
      setPendingInput(null);
      textarea?.focus();
    }
  }, [pendingInput, setPendingInput]);

  // Consume APPEND pending input (inline-widget window.sendPrompt bridge):
  // append to the current draft with a newline separator instead of
  // replacing it, so a widget follow-up never clobbers what the user was
  // typing. Empty draft → no leading newline.
  useEffect(() => {
    if (pendingInputAppend) {
      const nextText = mergeComposerAppend(text, pendingInputAppend);
      setText(nextText);
      setSelection({ start: nextText.length, end: nextText.length });
      appendPendingInput(null);
      textareaRef.current?.focus();
    }
  }, [pendingInputAppend, appendPendingInput, text]);

  // Drain references injected by the doc preview selection toolbar into local
  // state, then clear the store buffer (mirrors pendingInput consumption).
  useEffect(() => {
    if (pendingReferences.length === 0) return;
    let cappedOut = false;
    setReferences((prev) => {
      // dom-element references dedupe by their own unique `id`, not by
      // content — two structurally-identical elements (same outerHTML, same
      // page) are deliberate repeat picks and must both be kept. The
      // once-drain double-add guard still holds: `prev` already contains a
      // reference's id after its first drain, so a genuine re-delivery of
      // the same reference object is still caught. doc-selection references
      // keep the original content-based key (path+text+comment) unchanged.
      const seen = new Set(prev.map(referenceDedupeKey));
      const merged = [...prev];
      for (const r of pendingReferences) {
        const key = referenceDedupeKey(r);
        if (seen.has(key)) continue; // duplicate — skip silently
        if (merged.length >= MAX_REFERENCES) { cappedOut = true; continue; }
        seen.add(key);
        merged.push(r);
      }
      return merged;
    });
    if (cappedOut) {
      useToastStore.getState().addToast({
        type: 'warning',
        title: format(t.reference.maxReached, { max: MAX_REFERENCES }),
      });
    }
    clearPendingReferences();
  }, [pendingReferences, clearPendingReferences, t]);

  // Drain file paths injected by the workspace file tree's "Add to chat"
  // context menu into local attachment state, then clear the store buffer
  // (mirrors pendingReferences consumption above). Reuses processFilePaths
  // (image vs. file-badge routing) and the same path-based dedup used by
  // the clipboard-paste path.
  useEffect(() => {
    const requests = pendingAttachmentRequests.filter((request) => request.draftKey === draftKey);
    if (requests.length === 0) return;
    const admissionKey = draftKey;
    const finishAdmission = beginAttachmentAdmission(admissionKey);
    clearPendingAttachments(admissionKey);
    void (async () => {
      try {
        await processFilePaths(
          requests.map((request) => request.path),
          (imgs) => appendImagesForDraftKey(admissionKey, imgs),
          (newFiles) => appendFilesForDraftKey(admissionKey, newFiles),
          (path) => ({ readScope: requests.find((request) => request.path === path)?.readScope }),
        );
      } catch (error) {
        showAttachmentAdmissionFailed(error);
      } finally {
        finishAdmission();
      }
    })();
  }, [
    appendFilesForDraftKey,
    appendImagesForDraftKey,
    beginAttachmentAdmission,
    clearPendingAttachments,
    draftKey,
    pendingAttachmentRequests,
    showAttachmentAdmissionFailed,
  ]);

  const handleStop = () => {
    if (activeConv?.id) {
      cancelStreaming(activeConv.id);
    }
  };

  // File drag & drop (always called; works for both variants)
  const handleFileDrop = useCallback(async (paths: string[]) => {
    const admissionKey = draftKey;
    await processFilePaths(
      paths,
      (imgs) => appendImagesForDraftKey(admissionKey, imgs),
      (items) => appendFilesForDraftKey(admissionKey, items),
    );
    if (admissionKey === currentDraftKeyRef.current) textareaRef.current?.focus();
  }, [
    appendFilesForDraftKey,
    appendImagesForDraftKey,
    draftKey,
  ]);

  const { isDragging, dropTargetProps } = useFileDragDrop(handleFileDrop, {
    onAdmissionStart: () => beginAttachmentAdmission(draftKey),
    onAdmissionError: showAttachmentAdmissionFailed,
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

  const agentMentionTarget = useMemo((): AgentMentionTarget | null => {
    // An agent chip does not block a fresh `@` — picking again switches the chip.
    if (selectedSkill || isComposing) return null;
    // A leading slash command owns the composer suggestion surface even if
    // the command body happens to contain an inline @ token.
    if (/^\s*\/\S*/.test(text)) return null;
    if (selection.start !== selection.end) return null;

    // Treat a leading @ token as one command from the moment it is typed.
    // Its dismissal key must remain independent of later body/caret changes.
    const leadingCommand = parseLeadingAgentCommand(text);
    if (leadingCommand && selection.start > leadingCommand.range.start) return leadingCommand;

    const inlineTarget = findAgentMentionTarget(text, selection.start, selection.end);
    if (inlineTarget) return inlineTarget;
    return null;
  }, [isComposing, selectedSkill, selection.end, selection.start, text]);

  // Suggestion type tracking: 'skill' for / prefix, 'agent' for @ prefix
  const suggestionType = useMemo((): 'skill' | 'agent' | null => {
    const trimmed = text.trim();
    // `@` keeps working with an agent chip set — picking again switches the
    // chip (user report 2026-09-04: "已选择 Agent 后再输入 @ 没反应").
    if (agentMentionTarget) return 'agent';
    if (!selectedSkill && !selectedAgent && trimmed.startsWith('/')) return 'skill';
    return null;
  }, [agentMentionTarget, text, selectedSkill, selectedAgent]);

  // Skill/Agent suggestions
  const suggestions = useMemo((): SuggestionItem[] => {
    const trimmed = text.trim();

    // Agent + team suggestions when typing @. Teams come first with a kind
    // badge so 用户 can tell 团队 from 单个队员 at a glance (feedback 2026-08-31).
    if (suggestionType === 'agent') {
      const query = agentMentionTarget?.query ?? '';
      const teamItems: SuggestionItem[] = activeTeams
        .filter((team) => !query || team.name.toLowerCase().includes(query))
        .map((team) => ({ name: team.name, description: t.team.suggestionTeamHint, team: true, teamId: team.id, avatar: team.avatar }));
      return [
        ...teamItems,
        ...agents
          .filter((a) => a.name !== 'abu' && !disabledAgentSet.has(a.name))
          .filter((a) => {
            if (!query) return true;
            return a.name.toLowerCase().includes(query) ||
              a.description.toLowerCase().includes(query);
          })
          .map((a) => ({
            name: a.name,
            description: a.description,
          })),
      ];
    }

    // Skill suggestions when typing /
    if (suggestionType === 'skill') {
      const query = trimmed.slice(1).split(/\s+/)[0].toLowerCase();
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
  }, [text, skills, agents, activeTeams, suggestionType, agentMentionTarget, disabledSkillSet, disabledAgentSet, t.team.suggestionTeamHint]);

  const suggestionKey = useMemo(() => {
    if (suggestionType === 'agent') return agentMentionTarget?.key ?? null;
    if (suggestionType === 'skill') {
      const command = text.trim().split(/\s+/, 1)[0].toLowerCase();
      return `skill:${command}`;
    }
    return null;
  }, [agentMentionTarget, suggestionType, text]);

  // Reset highlighted suggestion when the active token changes.
  useEffect(() => {
    if (suggestionType !== null && suggestions.length > 0) setSelectedIndex(0);
  }, [suggestionKey, suggestionType, suggestions.length]);

  // Escape (and picking an item) suppress the popup for the token that was
  // showing, so it does not spring back while the user keeps typing that same
  // token. That suppression must end with the token: once the `@`/`/` is
  // deleted there is nothing being suppressed any more, and typing it again is
  // a fresh open (real-machine bug 2026-09-03: "删掉再打 @ 没有面板了").
  useEffect(() => {
    if (suggestionKey === null) setDismissedSuggestionKey(null);
  }, [suggestionKey]);

  // Derived: show suggestions when there are matches and not dismissed
  const showSuggestions = suggestionKey !== null &&
    dismissedSuggestionKey !== suggestionKey &&
    suggestionType !== null &&
    suggestions.length > 0;

  useLayoutEffect(() => {
    if (!showSuggestions) return;
    const option = document.getElementById(suggestionOptionId(selectedIndex));
    if (!option) return;
    if (selectedIndex === 0) {
      // The first option sits under its group header. scrollIntoView(nearest)
      // would pin the option's own top edge to the container and leave the
      // header scrolled out — which is exactly what happened when a stale
      // non-zero index from a previous open scrolled the list first (real-
      // machine report 2026-09-03: "卡片上面被截断"). Show the list top instead.
      const listbox = option.closest<HTMLElement>('[role="listbox"]');
      if (listbox) listbox.scrollTop = 0;
      return;
    }
    option.scrollIntoView({ block: 'nearest' });
    // suggestionKey: when the query changes the LIST changes while selectedIndex
    // often stays 0 — without this dep the popup keeps its old scrollTop and the
    // top rows (teams) sit out of view (real-machine bug 2026-08-31).
  }, [selectedIndex, showSuggestions, suggestionKey, suggestionOptionId]);

  // Auto-select skill/agent when text exactly matches "/name " or "@name " (e.g. from "Try in chat")
  useEffect(() => {
    if (!suggestionType || selectedSkill || selectedAgent || isComposing) return;
    const trimmed = text.trim();

    if (suggestionType === 'skill') {
      const skillMatch = /^\/([a-z0-9-]+)(?:\s+(.*))?$/.exec(trimmed);
      if (skillMatch && suggestions.length === 1 && suggestions[0].name === skillMatch[1]) {
        setSelectedSkill(suggestions[0]);
        setText(skillMatch[2] ?? '');
        setSelection({ start: (skillMatch[2] ?? '').length, end: (skillMatch[2] ?? '').length });
        setDismissedSuggestionKey(suggestionKey);
      }
    } else if (suggestionType === 'agent') {
      const leadingCommand = parseLeadingAgentCommand(text);
      if (leadingCommand &&
        suggestions.length === 1 &&
        suggestions[0].name.toLowerCase() === leadingCommand.query
      ) {
        if (suggestions[0].team) {
          pinTeam(suggestions[0].teamId);
          setSelectedAgent(null);
        } else {
          setSelectedAgent(suggestions[0]);
        }
        const remainingText = leadingCommand.body;
        setText(remainingText);
        setSelection({ start: remainingText.length, end: remainingText.length });
        setDismissedSuggestionKey(suggestionKey);
      }
    }
  }, [isComposing, text, suggestionKey, suggestionType, suggestions, selectedSkill, selectedAgent, pinTeam]);

  // Auto-resize textarea
  const maxHeight = isWelcome ? 180 : 160;
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    }
  }, [text, maxHeight]);

  const syncSelectionFromTextarea = useCallback((textarea: HTMLTextAreaElement) => {
    if (pendingSelectionRef.current) return;

    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    setSelection((prev) => (
      prev.start === start && prev.end === end ? prev : { start, end }
    ));
  }, []);

  const resolveDomAgentMentionTarget = useCallback((textarea: HTMLTextAreaElement): AgentMentionTarget | null => {
    if (/^\s*\/\S*/.test(textarea.value)) return null;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    if (start !== end) return null;

    const leadingCommand = parseLeadingAgentCommand(textarea.value);
    if (leadingCommand && start > leadingCommand.range.start) return leadingCommand;

    const inlineTarget = findAgentMentionTarget(textarea.value, start, end);
    if (inlineTarget) return inlineTarget;
    return null;
  }, []);

  const applySuggestion = (item: SuggestionItem) => {
    if (suggestionType === 'agent') {
      const textarea = textareaRef.current;
      const currentTarget = textarea ? resolveDomAgentMentionTarget(textarea) : null;
      if (!textarea || !agentMentionTarget || currentTarget?.key !== agentMentionTarget.key) {
        if (textarea) {
          setText(textarea.value);
          syncSelectionFromTextarea(textarea);
          textarea.focus();
        }
        return;
      }

      const replacementRange = resolveAgentMentionReplacementRange(currentTarget, item.name, textarea.value);
      const nextText = textarea.value.slice(0, replacementRange.start) +
        textarea.value.slice(replacementRange.end);
      const nextCaret = replacementRange.start;
      pendingSelectionRef.current = { start: nextCaret, end: nextCaret };
      if (item.team) {
        pinTeam(item.teamId);
        setSelectedAgent(null);
      } else {
        // A member chip is a one-off route for the next message; the team pin
        // (a conversation property) is left alone.
        setSelectedAgent(item);
      }
      setText(nextText);
      setSelection({ start: nextCaret, end: nextCaret });
      setDismissedSuggestionKey(currentTarget.key);
    } else {
      setSelectedSkill(item);
      setText('');
      setSelection({ start: 0, end: 0 });
      setDismissedSuggestionKey(suggestionKey);
    }
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
    const keepSelectors = activeConvId !== null;
    currentDraftRef.current = {
      text: '',
      images: [],
      files: [],
      references: [],
      selectedSkill: keepSelectors ? selectedSkill : null,
      selectedAgent: keepSelectors ? selectedAgent : null,
    };
    if (keepSelectors) {
      // Do not publish an empty draft first: this component subscribes to the
      // store and that transient notification would erase the selectors we
      // intentionally retain for an existing conversation.
      writeComposerDraft(draftKey, currentDraftRef.current);
    } else {
      clearComposerDraft(draftKey, { disposeResources: false });
    }
    setText('');
    setSelection({ start: 0, end: 0 });
    setImages([]);
    setFiles([]);
    setReferences([]);
    highlightRegistry.clear();
    // Keep selectors across messages inside an existing conversation, but
    // clear them after sending from the top-level welcome composer so that
    // returning to "new task" starts clean.
    if (!keepSelectors) {
      setSelectedSkill(null);
      setSelectedAgent(null);
    }
    setDismissedSuggestionKey(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  /**
   * Put a cleared draft back after a send that was not accepted.
   *
   * The composer clears optimistically so typing stays responsive, but the
   * dispatch result only arrives later — without this, a rejected send (no API
   * key configured, conversation busy) left the user staring at an empty box
   * with their text gone.
   */
  const restoreInput = (draft: ComposerDraft, sentDraftKey: string) => {
    // The rejection arrives asynchronously, so the user may have switched
    // conversations in the meantime. Putting the text back on screen then would
    // show conversation A's message inside conversation B. Persist it under the
    // key it was typed for and leave the visible composer alone.
    const existingDraft = sentDraftKey === currentDraftKeyRef.current
      ? currentDraftRef.current
      : readComposerDraft(sentDraftKey);
    const { draft: nextDraft, expiredFiles } = mergeDraftForRejectedSend(existingDraft, draft);
    releaseTokenFiles(expiredFiles);
    writeComposerDraft(sentDraftKey, nextDraft);
    if (sentDraftKey !== currentDraftKeyRef.current) return;
    currentDraftRef.current = nextDraft;
    setText(nextDraft.text);
    setSelection({ start: nextDraft.text.length, end: nextDraft.text.length });
    setImages(nextDraft.images);
    setFiles(nextDraft.files);
    setReferences(nextDraft.references);
    setSelectedSkill(nextDraft.selectedSkill);
    setSelectedAgent(nextDraft.selectedAgent);
    textareaRef.current?.focus();
  };

  const handleSend = () => {
    const trimmed = text.trim();
    if ((!trimmed && !selectedSkill && !selectedAgent && images.length === 0 && files.length === 0 && references.length === 0) || disabled) return;

    if (isAdmissionPendingForDraft || getComposerDraftRuntimeState(draftKey).pendingAdmissions > 0) {
      useToastStore.getState().addToast({
        type: 'info',
        title: t.chat.attachmentAdmissionPending,
      });
      return;
    }

    const unsupportedPdf = files.find((file) => (
      file.token !== undefined
      || file.name.toLowerCase().endsWith('.pdf')
      || file.path?.toLowerCase().endsWith('.pdf')
    ));
    if (unsupportedPdf) {
      useToastStore.getState().addToast({
        type: 'error',
        title: format(t.chat.unsupportedDocumentAttachment, { name: unsupportedPdf.name }),
      });
      return;
    }

    // Preserve the established path-reference contract for ordinary workspace
    // files. These are prompt context only; unlike image attachments, no file
    // bytes cross the provider boundary here.
    const fileContext = files
      .flatMap((file) => file.path ? [`[Attachment: \`${file.path}\`]`] : [])
      .join('\n');
    const referenceContext = serializeReferences(references);

    // Compose parts, then join with newline
    const bodyParts = [fileContext, referenceContext, trimmed].filter(Boolean).join('\n\n');

    let message: string;
    if (selectedAgent) {
      message = `@${selectedAgent.name}${bodyParts ? ' ' + bodyParts : ''}`;
    } else if (selectedSkill) {
      message = `/${selectedSkill.name}${bodyParts ? ' ' + bodyParts : ''}`;
    } else {
      message = bodyParts;
    }

    // Mid-task input: if agent is running, stage the message in the queue
    // strip above the composer (cancellable) instead of starting a new loop.
    // It becomes a transcript bubble only when the loop drains it.
    const hasRuntimeAttachments = images.length > 0;
    if (isRunning && hasRuntimeAttachments) {
      useToastStore.getState().addToast({
        type: 'warning',
        title: t.chat.attachmentDuringRun,
      });
      return;
    }
    if (isRunning && activeConv?.id && message) {
      // `@队员 …` while that member is working goes straight to it (block M);
      // anything else waits in the queue strip for the leader as before.
      const address = parseMemberAddress(message, selectedAgent?.name);
      const running = address
        ? findRunningDispatch(
          collectMemberDispatches({ conversationId: activeConv.id, executions: Object.values(useTaskExecutionStore.getState().executions), messages: activeConv.messages }),
          address.member,
        )
        : null;
      if (address && running) {
        requestDispatchInput(running.key, address.body);
        useToastStore.getState().addToast({ type: 'success', title: format(t.chat.memberInstructionSent, { member: running.agent }) });
        resetInput();
        return;
      }
      enqueueUserInput(activeConv.id, message);
      resetInput();
      return;
    }

    const sentDraftKey = draftKey;
    const finishPendingSend = tryBeginComposerDraftSend(sentDraftKey);
    if (!finishPendingSend) {
      // The guard is released only when the previous dispatch PROMISE settles,
      // which happens after the run's visible terminal (reply rendered,
      // status no longer 'running', send button back). An Enter in that
      // settling window misses the isRunning staging branch above, so stage it
      // here instead of dropping it: a held guard proves the previous dispatch
      // chain is still live, and that chain's final queue drain runs in the
      // same microtask turn as the guard release — a keydown can never land
      // between them, so a message staged now is always picked up.
      if (activeConv?.id && message && !hasRuntimeAttachments) {
        enqueueUserInput(activeConv.id, message);
        resetInput();
        return;
      }
      useToastStore.getState().addToast({
        type: 'info',
        title: t.chat.sendAlreadyPending,
      });
      return;
    }

    // Snapshot before the optimistic clear so a rejected send can hand the
    // draft back instead of losing it.
    const sentDraft: ComposerDraft = {
      text,
      images: [...images],
      files: [...files],
      references: [...references],
      selectedSkill,
      selectedAgent,
    };
    let sendResult: void | Promise<boolean | void>;
    try {
      sendResult = onSend(
        message,
        images.length > 0 ? images : undefined,
        isWelcome ? localWorkspace : undefined,
        // Release the lock at acceptance: once the message is in the
        // transcript it can never be handed back (see
        // shouldRestoreComposerAfterDispatch), so double-send protection is no
        // longer needed and holding on would drop sends made while the run is
        // still executing. finishPendingSend is idempotent — the .finally
        // below stays as the release path for never-accepted sends.
        () => finishPendingSend(),
      );
    } catch (error) {
      finishPendingSend();
      restoreInput(sentDraft, sentDraftKey);
      throw error;
    }
    resetInput();
    if (sendResult && typeof sendResult.then === 'function') {
      void sendResult.then(
        (accepted) => {
          if (accepted === false) {
            restoreInput(sentDraft, sentDraftKey);
          } else {
            releaseTokenFiles(sentDraft.files);
          }
        },
        // A send that throws definitely did not take the message.
        () => restoreInput(sentDraft, sentDraftKey),
      ).finally(() => {
        finishPendingSend();
      });
    } else {
      releaseTokenFiles(sentDraft.files);
      finishPendingSend();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isImeComposing(e, composingRef.current)) return;

    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(suggestions.length - 1, prev + 1));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.altKey)) {
        e.preventDefault();
        applySuggestion(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedSuggestionKey(suggestionKey);
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
    if (e.key === 'Enter') {
      const action = resolveEnterAction(e, { behavior: enterBehavior, isMac: isMacOS() });
      // 'native' means the textarea inserts the newline itself — leaving the
      // default action alone preserves the browser's caret handling and undo
      // stack, so it is deliberately the do-nothing branch.
      if (action === 'send') {
        e.preventDefault();
        handleSend();
      } else if (action === 'insert') {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (textarea) {
          const insertionPoint = textarea.selectionStart ?? text.length;
          setText(insertNewlineAtCursor(textarea));
          setSelection({ start: insertionPoint + 1, end: insertionPoint + 1 });
        }
      }
    }
  };

  const handleAttach = async () => {
    const admissionKey = draftKey;
    const finishAdmission = beginAttachmentAdmission(admissionKey);
    try {
      const selected = await open({ multiple: true, directory: false });
      if (selected) {
        const paths = Array.isArray(selected) ? selected : [selected];
        await processFilePaths(
          paths,
          (imgs) => appendImagesForDraftKey(admissionKey, imgs),
          (items) => appendFilesForDraftKey(admissionKey, items),
        );
        if (admissionKey === currentDraftKeyRef.current) textareaRef.current?.focus();
      }
    } catch (error) {
      showAttachmentAdmissionFailed(error);
    } finally {
      finishAdmission();
    }
  };

  const handleAttachElectron = async () => {
    const admissionKey = draftKey;
    const finishAdmission = beginAttachmentAdmission(admissionKey);
    try {
      const selected = await selectElectronUserAttachments({ mediaTypes: [...ELECTRON_PICKER_MEDIA_TYPES] });
      if (selected.length === 0) return;
      const imageResults = await Promise.allSettled(selected.map(imageFromToken));
      const nextImages = imageResults
        .filter((result): result is PromiseFulfilledResult<ImageAttachment> => result.status === 'fulfilled' && result.value !== null)
        .map((result) => result.value);
      appendImagesForDraftKey(admissionKey, nextImages);
      if (imageResults.some((result) => result.status === 'rejected')) showAttachmentAdmissionFailed();
      if (admissionKey === currentDraftKeyRef.current) textareaRef.current?.focus();
    } catch (error) {
      showAttachmentAdmissionFailed(error);
    } finally {
      finishAdmission();
    }
  };

  const handleAttachClick = hasElectronUserAttachmentSelectHost() ? handleAttachElectron : handleAttach;

  /** `+` menu → 队员·团队: drop an `@` at the caret so the grouped picker opens. */
  const openMentionPicker = () => {
    const textarea = textareaRef.current;
    const base = textarea?.value ?? text;
    const caret = textarea?.selectionStart ?? base.length;
    const before = base.slice(0, caret);
    const token = before.length > 0 && !/\s$/.test(before) ? ' @' : '@';
    const nextText = before + token + base.slice(caret);
    const nextCaret = before.length + token.length;
    // The menu means "pick a new one": both chips are cleared, or the mention
    // picker stays gated off (agentMentionTarget bails on a skill chip).
    setSelectedAgent(null);
    setSelectedSkill(null);
    pendingSelectionRef.current = { start: nextCaret, end: nextCaret };
    setText(nextText);
    setSelection({ start: nextCaret, end: nextCaret });
    setDismissedSuggestionKey(null);
    textarea?.focus();
  };

  /** `+` menu → 技能: make the text a `/` command so the skill picker opens. */
  const openSkillPicker = () => {
    const base = textareaRef.current?.value ?? text;
    const nextText = base.trimStart().startsWith('/') ? base : '/' + base.trimStart();
    setSelectedSkill(null);
    pendingSelectionRef.current = { start: 1, end: 1 };
    setText(nextText);
    setSelection({ start: 1, end: 1 });
    setDismissedSuggestionKey(null);
    textareaRef.current?.focus();
  };

  // Explicit handlers (not a mapped handler table): the React Compiler must
  // see that the ref-reading pickers are only called from event handlers.
  const pickAddFile = () => { setShowPlusMenu(false); handleAttachClick(); };
  const pickTeamOrMember = () => { setShowPlusMenu(false); openMentionPicker(); };
  const pickSkill = () => { setShowPlusMenu(false); openSkillPicker(); };
  const clearTeamPin = () => { pinTeam(undefined); textareaRef.current?.focus(); };
  const plusMenuItemClass = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-body text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] focus-visible:outline-none focus-visible:bg-[var(--abu-bg-hover)]';
  const plusMenuIconClass = 'h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)]';

  // WorkBuddy-style `+` menu (design §2.1): 添加文件 / 队员·团队 / 技能.
  const plusMenu = (
    <Popover open={showPlusMenu} onOpenChange={setShowPlusMenu}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t.chat.composerMenu.open}
          aria-haspopup="menu"
          data-testid="composer-plus"
          className="btn-ghost h-7 w-7 shrink-0 rounded-lg text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-48 p-1.5" role="menu" aria-label={t.chat.composerMenu.open} data-electron-no-drag>
        <button type="button" role="menuitem" data-testid="composer-menu-add-file" onClick={pickAddFile} className={plusMenuItemClass}>
          <Paperclip className={plusMenuIconClass} />
          <span className="truncate">{t.chat.composerMenu.addFile}</span>
        </button>
        <button type="button" role="menuitem" data-testid="composer-menu-team" onClick={pickTeamOrMember} className={plusMenuItemClass}>
          <Users className={plusMenuIconClass} />
          <span className="truncate">{t.chat.composerMenu.teamOrMember}</span>
        </button>
        <button type="button" role="menuitem" data-testid="composer-menu-skill" onClick={pickSkill} className={plusMenuItemClass}>
          <Sparkles className={plusMenuIconClass} />
          <span className="truncate">{t.chat.composerMenu.skill}</span>
        </button>
      </PopoverContent>
    </Popover>
  );

  // Who takes the next message: the team pin, an @agent, or a /skill. Lives in
  // the bottom row next to `+` (WorkBuddy chip bar): neutral pill with an ✕,
  // click = clear.
  const chipClass = 'group inline-flex min-w-0 max-w-[220px] shrink items-center gap-1 rounded-full px-2 py-0.5 text-minor font-medium text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors cursor-pointer';
  // Rest: kind mark + name. Hover: the mark becomes ✕ and the pill gets a background (WorkBuddy).
  const chipMarkClass = 'shrink-0 text-[var(--abu-text-tertiary)] group-hover:hidden';
  const chipCloseClass = 'hidden h-3.5 w-3.5 shrink-0 text-[var(--abu-text-tertiary)] group-hover:block';
  const composerChips = (
    <>
      {pinnedTeam && (
        <button type="button" onClick={clearTeamPin} data-testid="composer-team-chip" className={chipClass} title={t.common.close} aria-label={`👥${pinnedTeam.name}`}>
          <span aria-hidden="true" className={chipMarkClass}><TeamAvatar avatar={pinnedTeam.avatar} size="xs" round /></span>
          <X aria-hidden="true" className={chipCloseClass} />
          <span className="truncate">{pinnedTeam.name}</span>
        </button>
      )}
      {selectedAgent && (
        <button type="button" onClick={removeAgent} className={chipClass} title={t.common.close} aria-label={`@${selectedAgent.name}`}>
          <span aria-hidden="true" className={chipMarkClass}>@</span>
          <X aria-hidden="true" className={chipCloseClass} />
          <span className="truncate">{selectedAgent.name}</span>
        </button>
      )}
      {selectedSkill && (
        <button type="button" onClick={removeSkill} className={chipClass} title={t.common.close} aria-label={`/${selectedSkill.name}`}>
          <span aria-hidden="true" className={chipMarkClass}>/</span>
          <X aria-hidden="true" className={chipCloseClass} />
          <span className="truncate">{selectedSkill.name}</span>
        </button>
      )}
    </>
  );

  const hasAttachments = images.length > 0 || files.length > 0 || references.length > 0;
  const hasContent = text.trim().length > 0 || selectedSkill !== null || selectedAgent !== null || hasAttachments;

  // Send-button tooltip. With no standing hint in the composer, this is the
  // only place the shortcuts are written down, so it has to track both the
  // chosen behavior and the platform's send modifier.
  const sendTooltip = enterBehavior === 'enter'
    ? t.chat.sendTooltipEnterSends
    : format(t.chat.sendTooltipModifierSends, { modifier: isMacOS() ? '⌘' : 'Ctrl' });

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

      <div className="relative" ref={composerAnchorRef}>
        {/* Suggestions Popup (Skills / Agents) — portaled, anchored above this card */}
        {showSuggestions && suggestions.length > 0 && (
          <SuggestionPopup
            anchorRef={composerAnchorRef}
            listboxId={suggestionListboxId}
            ariaLabel={t.chat.composerSuggestions}
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            suggestionType={suggestionType}
            sectionLabels={{ teams: t.chat.suggestionSectionTeams, agents: t.chat.suggestionSectionAgents, skills: t.chat.suggestionSectionSkills }}
            optionId={suggestionOptionId}
            onApply={applySuggestion}
          />
        )}

        {/* Input Card */}
        <div
          {...dropTargetProps}
          className={cn(
            'relative bg-[var(--abu-bg-base)] rounded-2xl border transition-all',
            !isWelcome && isDragging
              ? 'border-[var(--abu-clay)] ring-2 ring-[var(--abu-clay-ring)]'
              : 'border-[var(--abu-border-subtle)] focus-within:border-[var(--abu-border-hover)]'
          )}
        >
          {/* Chat-only: Drag overlay */}
          {!isWelcome && isDragging && (
            <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[var(--abu-clay-bg)] z-10">
              <span className="text-body text-[var(--abu-clay)] font-medium">{t.chat.dropFilesHere}</span>
            </div>
          )}

          {/* Attachment Strip (images + file badges) */}
          {hasAttachments && (
            <div className={cn('flex items-center gap-2 overflow-x-auto', isWelcome ? 'pl-5 pt-3 pb-1' : 'pl-4 pt-3 pb-1')}>
              {images.map((img, index) => (
                <div key={img.id} className="relative group/img shrink-0">
                  <button
                    type="button"
                    className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay)]"
                    onClick={(event) => {
                      useImageLightboxStore.getState().open(
                        images.map((image) => ({
                          id: image.id,
                          data: image.data,
                          mediaType: image.mediaType,
                          filePath: image.filePath,
                          conversationId: activeConv?.id,
                          workspacePath: activeConv?.workspacePath,
                        })),
                        index,
                        event.currentTarget,
                      );
                    }}
                    title={t.chat.clickToViewFull}
                    aria-label={t.chat.clickToViewFull}
                  >
                    <img
                      src={`data:${img.mediaType};base64,${img.data}`}
                      alt=""
                      className="w-12 h-12 rounded-lg object-cover border border-[var(--abu-border-subtle)] hover:border-[var(--abu-border-hover)] transition-colors"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => removeImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--abu-text-primary)] text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                    title={t.chat.removeImage}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </div>
              ))}
              {files.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border-subtle)] shrink-0 group/file"
                >
                  <FileText className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
                  <span className="text-minor text-[var(--abu-text-primary)] max-w-[160px] truncate">{f.name}</span>
                  <button
                    onClick={() => removeFile(f.id)}
                    className="p-0.5 rounded hover:bg-[var(--abu-bg-hover)] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {references.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border-subtle)] shrink-0"
                  title={`${r.source.name}\n${r.selection.text}${r.comment ? `\n${r.comment}` : ''}`}
                >
                  <FileText className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" />
                  <span className="text-minor text-[var(--abu-text-primary)] max-w-[200px] truncate">
                    {/* dom-element: r.selection.text is the raw outerHTML (tag
                        soup) — show the readable label createDomElementReference
                        already computed into source.name instead (e.g.
                        "div#hero.card"). doc-selection keeps showing the quoted
                        selected text. The title tooltip below still shows the
                        fuller detail on hover. */}
                    {referenceChipLabel(r)}
                    {r.comment && <span className="text-[var(--abu-text-tertiary)]"> · {r.comment}</span>}
                  </span>
                  <button
                    onClick={() => { setReferences((prev) => prev.filter((x) => x.id !== r.id)); highlightRegistry.remove(r.id); }}
                    className="p-0.5 rounded hover:bg-[var(--abu-bg-hover)] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {/* A real flex item keeps the trailing inset scrollable in Chromium;
                  padding-right alone disappears when the row overflows. */}
              <div aria-hidden="true" className={cn('shrink-0 self-stretch', isWelcome ? 'w-3' : 'w-2')} />
            </div>
          )}

          {/* Textarea Row with inline command prefix */}
          <div className={cn(
            'flex items-start gap-0',
            isWelcome
              ? hasAttachments ? 'px-5 pt-1 pb-1' : 'px-5 pt-4 pb-1'
              : hasAttachments ? 'px-4 pt-1 pb-1' : 'px-4 pt-3.5 pb-1'
          )}>
            <textarea
              ref={textareaRef}
              data-chat-composer
              aria-autocomplete="list"
              aria-expanded={showSuggestions && suggestions.length > 0}
              aria-controls={showSuggestions && suggestions.length > 0 ? suggestionListboxId : undefined}
              aria-activedescendant={
                showSuggestions && suggestions.length > 0
                  ? suggestionOptionId(selectedIndex)
                  : undefined
              }
              value={text}
              onChange={(e) => {
                setText(e.currentTarget.value);
                syncSelectionFromTextarea(e.currentTarget);
              }}
              onKeyDown={handleKeyDown}
              onSelect={(e) => syncSelectionFromTextarea(e.currentTarget)}
              onClick={(e) => syncSelectionFromTextarea(e.currentTarget)}
              onKeyUp={(e) => syncSelectionFromTextarea(e.currentTarget)}
              onCompositionStart={() => {
                if (compositionResetTimerRef.current !== null) {
                  window.clearTimeout(compositionResetTimerRef.current);
                  compositionResetTimerRef.current = null;
                }
                composingRef.current = true;
                setIsComposing(true);
              }}
              onCompositionEnd={() => {
                // Safari/WebKit fires compositionEnd BEFORE keydown,
                // so delay reset to let the Enter keydown still see composingRef=true
                if (compositionResetTimerRef.current !== null) {
                  window.clearTimeout(compositionResetTimerRef.current);
                }
                compositionResetTimerRef.current = window.setTimeout(() => {
                  composingRef.current = false;
                  setIsComposing(false);
                  compositionResetTimerRef.current = null;
                }, 0);
              }}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={isWelcome ? 2 : 1}
              className={cn(
                'flex-1 bg-transparent resize-none outline-none text-[var(--abu-text-primary)] leading-relaxed',
                isWelcome
                  ? 'min-h-[52px] max-h-[180px] text-body'
                  : 'min-h-[24px] max-h-[160px] py-0.5 text-body disabled:opacity-40'
              )}
            />
          </div>

          {/* Bottom Toolbar */}
          {isWelcome ? (
            /* Workspace context lives below the input card. The send toolbar
               stays a single, calm row even in a narrow center pane. */
            <div className="flex items-center gap-2 px-5 pb-3.5">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {plusMenu}
                {composerChips}
              </div>

              {/* Model picker — right-aligned, before Start button */}
              <div className="ml-auto flex min-w-0 max-w-full items-center gap-1">
                <PermissionModeChip conversationId={null} />
                <div className="relative min-w-0 max-w-[180px]" ref={modelPickerRef}>
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    title={modelDisplay}
                    className={cn(
                      'btn-ghost flex min-w-0 max-w-[180px] items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-minor font-normal transition-colors',
                      hasActiveProvider
                        ? 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
                        : 'text-[var(--abu-clay)] hover:text-[var(--abu-clay-hover)] hover:bg-[var(--abu-clay-bg)]'
                    )}
                  >
                    <span className="min-w-0 truncate whitespace-nowrap">{modelDisplay}</span>
                    <ChevronDown className={cn('h-3 w-3 transition-transform shrink-0', showModelPicker && 'rotate-180')} />
                  </button>
                  <ModelSelector
                    open={showModelPicker}
                    onClose={() => setShowModelPicker(false)}
                    anchorRef={modelPickerRef as React.RefObject<HTMLElement>}
                  />
                </div>

                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={!hasContent}
                  title={sendTooltip}
                  aria-label={sendTooltip}
                  className={cn(
                    'h-7 w-7 shrink-0 rounded-lg transition-colors',
                    hasContent
                      ? 'bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] text-white shadow-sm'
                      : 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-muted)] cursor-not-allowed hover:bg-[var(--abu-bg-hover)]'
                  )}
                >
                  <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                </Button>
              </div>
            </div>
          ) : (
            /* Chat variant: [+] --- [Model ∨] [Stop/Send] */
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-4 pb-2.5 pt-0.5">
              {/* Left Actions */}
              <div className="flex min-w-0 items-center gap-1">
                {plusMenu}
                {composerChips}
              </div>

              {/* Right Actions: Model picker + Context indicator + Send / Stop */}
              <div className="ml-auto flex min-w-0 max-w-full items-center gap-1">
                <PermissionModeChip conversationId={activeConvIdForIndicator} />
                {/* Model picker */}
                <div className="relative min-w-0 max-w-[180px]" ref={modelPickerRef}>
                  <button
                    onClick={() => setShowModelPicker(!showModelPicker)}
                    title={modelDisplay}
                    className={cn(
                      'btn-ghost flex min-w-0 max-w-[180px] items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-minor font-normal transition-colors',
                      hasActiveProvider
                        ? 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
                        : 'text-[var(--abu-clay)] hover:text-[var(--abu-clay-hover)] hover:bg-[var(--abu-clay-bg)]'
                    )}
                  >
                    <span className="min-w-0 truncate whitespace-nowrap">{modelDisplay}</span>
                    <ChevronDown className={cn('h-3 w-3 transition-transform shrink-0', showModelPicker && 'rotate-180')} />
                  </button>
                  <ModelSelector
                    open={showModelPicker}
                    onClose={() => setShowModelPicker(false)}
                    anchorRef={modelPickerRef as React.RefObject<HTMLElement>}
                  />
                </div>

                {/* Context usage ring — between model picker and send button */}
                {activeConvIdForIndicator && (
                  <div className="flex items-center justify-center h-7 px-1">
                    <ContextIndicator conversationId={activeConvIdForIndicator} />
                  </div>
                )}

                {isStreaming ? (
                  <Button
                    size="icon"
                    onClick={handleStop}
                    aria-label={t.chat.stop}
                    className="h-7 w-7 rounded-lg border border-[var(--abu-border)] bg-transparent text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] hover:border-[var(--abu-border-hover)] transition-colors"
                    title={t.chat.stop}
                  >
                    <Square className="h-3 w-3" fill="currentColor" />
                  </Button>
                ) : (
                  <Button
                    size="icon"
                    onClick={handleSend}
                    disabled={!hasContent || disabled}
                    title={sendTooltip}
                    aria-label={sendTooltip}
                    className={cn(
                      'h-7 w-7 rounded-lg transition-colors',
                      hasContent && !disabled
                        ? 'bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] text-white shadow-sm'
                        : 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-muted)] cursor-not-allowed hover:bg-[var(--abu-bg-hover)]'
                    )}
                  >
                    <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* New-task context: hidden when the conversation/project already
            supplies a workspace. A temporary selection remains visible until
            first send so it never vanishes before the task is actually bound. */}
        {showWorkspaceContextBar && (
          <div
            data-abu-workspace-context
            className="mt-2 flex min-h-10 items-center rounded-xl bg-[var(--abu-bg-muted)] px-2 py-1"
          >
            <FolderSelector
              currentPath={localWorkspace}
              recentPaths={recentPaths}
              onSelect={handleSelectFolder}
              onClear={handleClearWorkspace}
              appearance="context-bar"
              className="min-w-0 max-w-full"
            />
          </div>
        )}

        {/* Promote-to-project hint: shown only on welcome when the bound
            workspace isn't already a project AND the user hasn't dismissed
            it. Component self-gates its own visibility; we just always
            mount it on welcome and let it decide. */}
        {isWelcome && <PromoteToProjectHint workspacePath={localWorkspace} />}
      </div>
    </>
  );
}
