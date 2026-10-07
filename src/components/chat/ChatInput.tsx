import { memo, useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback, useId, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import { InlineSkillInput, type InlineSkillInputHandle } from '@/components/ui/inline-skill-input';
import { splitInputCommand, mergeDraftPrefill } from '@/utils/inputCommand';
import { ModelSelector } from '@/components/chat/ModelSelector';
import VoiceInputControl from '@/components/chat/VoiceInputControl';
import { spaceForInsertion, type VoiceDraftSnapshot } from '@/core/speech/voiceInputText';
import { useVoiceInputStore } from '@/stores/voiceInputStore';
import { isSpeechAvailable } from '@/core/speech/speechBridge';
import { ManagedProviderOfflineBar } from '@/components/chat/ManagedProviderOfflineBar';
import { useManagedProviderLiveness } from '@/components/chat/useManagedProviderLiveness';
import { subscribeModelPickerRequest } from '@/components/chat/modelPickerRequest';
import TeamAvatar from '@/components/team/TeamAvatar';
import AgentAvatar from '@/components/common/AgentAvatar';
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
import { isPluginOwnedAgent } from '@/utils/agentSource';
import { isImageFile } from '@/components/chat/FileAttachment';
import { isImeComposing, resolveEnterAction } from '@/components/chat/composerKeys';
import { isMacOS } from '@/utils/platform';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { parseGoalCommand } from '@/core/goal/goalCommand';
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
import { getModelUnavailableReason, getModelDisplayLabel } from '@/utils/settingsSelectors';
import { describeModelUnavailable } from '@/utils/modelUnavailableCopy';
import { useVisibleTeams } from '@/core/team/useVisibleTeams';
import { Button as DsButton, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { Tooltip } from '@/components/ds/tooltip';
import { cn } from '@/lib/utils';
import { fileReferenceForPath, InvalidAttachmentPathError } from '@/utils/fileReference';
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
  offset?: number;
  name: string;
  description: string;
  trigger?: string;
  /** True for team entries in the @ list — picking one pins the conversation
   *  to the team (its leader runs the loop) instead of becoming an @ prefix. */
  team?: boolean;
  teamId?: string;
  /** Team or expert avatar (`icon:<icon>/<tint>` preset or a legacy emoji);
   *  absent = the default mark for that kind. */
  avatar?: string;
  /** True when the agent's AGENT.md was installed by a plugin (provenance tag). */
  fromPlugin?: boolean;
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
  const mergedText = mergeDraftTextForRestore(currentWithoutExpiredTokens.text, cleanSentDraft.text);
  const currentSkill = currentWithoutExpiredTokens.text.length === 0 && currentWithoutExpiredTokens.selectedSkill?.name === cleanSentDraft.selectedSkill?.name
    ? null : currentWithoutExpiredTokens.selectedSkill;
  const restoredSkill = currentSkill ?? (cleanSentDraft.selectedSkill ? {
    ...cleanSentDraft.selectedSkill,
    offset: Math.max(0, mergedText.lastIndexOf(cleanSentDraft.text)) + (cleanSentDraft.selectedSkill.offset ?? 0),
  } : null);
  const mergedFiles = mergeFileAttachments(currentWithoutExpiredTokens.files, cleanSentDraft.files).files;
  return {
    draft: {
      text: mergedText,
      images: [...currentWithoutExpiredTokens.images, ...cleanSentDraft.images],
      files: mergedFiles,
      references: dedupeReferencesForRestore([...currentWithoutExpiredTokens.references, ...cleanSentDraft.references]),
      selectedSkill: restoredSkill,
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
  if (paths.some((path) => fileReferenceForPath(path) === null)) throw new InvalidAttachmentPathError();
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

// The model picker's button. The Popover hands its props (open state, click, ref) to this
// component; spreading them onto the button lets the Tooltip wrap it. The hover text is
// the full name, since the button truncates it.
function ModelPickerTrigger({ label, unavailable, className, ...props }: ComponentProps<'button'> & {
  label: string | undefined;
  unavailable: boolean;
}) {
  return (
    <Tooltip content={label}>
      <DsButton variant="plain" size="sm" className={cn('max-w-full', unavailable && 'text-link', className)} {...props}>
        <span className="min-w-0 truncate">{label}</span>
        <Icon icon={AppIcons.expand} size="sm" />
      </DsButton>
    </Tooltip>
  );
}

/**
 * Composer suggestion popup — grouped like Codex's composer (user feedback
 * 2026-09-01): small section headers (团队 / 队员 / 技能), names only (no
 * descriptions — too long), one scrollable list whose height is clamped to
 * the space above the composer so the top can never be clipped by the window.
 */
const SUGGESTION_MAX_HEIGHT = 320;
const SUGGESTION_TOP_MARGIN = 16;

function SuggestionPopup({ listboxId, ariaLabel, suggestions, selectedIndex, suggestionType, sectionLabels, pluginTagLabel, optionId, onApply, anchorRef, search }: {
  search?: { query: string; label: string; closeLabel: string; onChange: (query: string) => void; onClose: () => void; onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void };
  listboxId: string;
  ariaLabel: string;
  suggestions: SuggestionItem[];
  selectedIndex: number;
  suggestionType: 'skill' | 'agent' | null;
  sectionLabels: { teams: string; agents: string; skills: string };
  /** Provenance tag shown on an agent installed by a plugin. */
  pluginTagLabel: string;
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
  const popupRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!search) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !popupRef.current?.contains(event.target)) search.onClose();
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [search]);
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
      ref={popupRef}
      role={search ? "dialog" : undefined}
      aria-label={search ? ariaLabel : undefined}
      style={style}
      // Overlays painted above the window chrome must carve themselves out of
      // the drag lane (src/styles/index.css) — this one can now overlap it.
      data-electron-no-drag
      data-composer-suggestions
      className="z-popover overflow-y-auto overflow-x-hidden rounded-panel bg-raised p-1 text-label shadow-float"
    >
      {search && <div className="flex items-center gap-2 px-2 py-2">
        <TextField autoFocus value={search.query} aria-label={search.label} placeholder={search.label}
          aria-controls={listboxId} aria-autocomplete="list"
          aria-activedescendant={suggestions[selectedIndex] ? optionId(selectedIndex) : undefined}
          onChange={(event) => search.onChange(event.target.value)} onKeyDown={search.onKeyDown} />
        <IconButton size="sm" icon={AppIcons.close} label={search.closeLabel} onClick={search.onClose} />
      </div>}
      <div id={listboxId} role="listbox" aria-label={ariaLabel}>
      {sections.filter((section) => section.items.length > 0).map((section) => (
        <div key={section.label} role="group" aria-label={section.label}>
          <div className="select-none px-3 pb-1 pt-2 text-ui-sm font-medium text-label-tertiary">{section.label}</div>
          {/* Options never take focus: the text field keeps it and points at the
              current one through aria-activedescendant. */}
          {section.items.map(({ item, idx }) => (
            <div
              key={item.name}
              id={optionId(idx)}
              role="option"
              aria-selected={idx === selectedIndex}
              onClick={() => onApply(item)}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                'flex h-7 cursor-default items-center gap-3 rounded-control px-3 text-ui',
                idx === selectedIndex ? 'bg-fill-selected' : 'hover:bg-fill-hover'
              )}
            >
              <span className={cn(
                'w-5 shrink-0 text-center',
                // Type classes belong to the 「/」 mark only — the agent branch
                // renders an avatar, which no text style reaches.
                suggestionType !== 'agent' && 'font-code text-ui-sm text-label-tertiary'
              )}>
                {suggestionType === 'agent'
                  ? (item.team
                      ? <TeamAvatar avatar={item.avatar} size="xs" round className="mx-auto" />
                      : <AgentAvatar agent={{ name: item.name, avatar: item.avatar }} size="xs" round className="mx-auto" />)
                  : '/'}
              </span>
              <span className="truncate font-medium text-label">{item.name}</span>
              {item.fromPlugin && (
                <span data-testid="agent-source-plugin" className="flex shrink-0">
                  <Tag>{pluginTagLabel}</Tag>
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
      </div>
    </div>,
    document.body,
  );
}

// The parts below are memoized: the composer re-renders on every keystroke and every
// streamed token, and their hover tips and menu must not re-render with it.

// WorkBuddy-style `+` menu (design §2.1): 添加文件 / 专家·专家团 / 技能. Arrow keys move the
// highlight; Enter or a click applies.
const PlusMenu = memo(function PlusMenu({ open, onOpenChange, onCloseAutoFocus, onAddFile, onTeamOrMember, onSkill }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
  onAddFile: () => void;
  onTeamOrMember: () => void;
  onSkill: () => void;
}) {
  const { t } = useI18n();
  return (
    <Menu
      side="top"
      align="start"
      open={open}
      onOpenChange={onOpenChange}
      onCloseAutoFocus={onCloseAutoFocus}
      trigger={<IconButton icon={AppIcons.add} label={t.chat.composerMenu.open} data-testid="composer-plus" />}
    >
      <MenuItem icon={AppIcons.attach} onSelect={onAddFile}>
        <span data-testid="composer-menu-add-file">{t.chat.composerMenu.addFile}</span>
      </MenuItem>
      <MenuItem icon={AppIcons.team} onSelect={onTeamOrMember}>
        <span data-testid="composer-menu-team">{t.chat.composerMenu.teamOrMember}</span>
      </MenuItem>
      <MenuItem icon={AppIcons.skill} onSelect={onSkill}>
        <span data-testid="composer-menu-skill">{t.chat.composerMenu.skill}</span>
      </MenuItem>
    </Menu>
  );
});

// A team pin or an @expert. Rest: avatar + name; hover: the avatar becomes ✕ (WorkBuddy).
const ComposerChip = memo(function ComposerChip({ kind, testId, name, avatar, ariaLabel, closeLabel, onClear }: {
  kind: 'team' | 'agent';
  testId?: string;
  name: string;
  avatar?: string;
  ariaLabel: string;
  closeLabel: string;
  onClear: () => void;
}) {
  return (
    <Tooltip content={closeLabel}>
      <Pressable
        onClick={onClear}
        data-testid={testId}
        aria-label={ariaLabel}
        className="group inline-flex h-6 min-w-0 max-w-55 shrink items-center gap-1 rounded-control bg-fill px-2 text-ui-sm text-label hover:bg-fill-hover"
      >
        <span aria-hidden="true" className="flex shrink-0 group-hover:hidden">
          {kind === 'team'
            ? <TeamAvatar avatar={avatar} size="xs" round />
            : <AgentAvatar agent={{ name, avatar }} size="xs" round />}
        </span>
        <span aria-hidden="true" className="hidden shrink-0 text-label-secondary group-hover:flex">
          <Icon icon={AppIcons.close} size="sm" />
        </span>
        {/* Last stop of the toolbar's degradation ladder: the avatar alone
            still says which team is pinned, and `aria-label` keeps the name
            for assistive tech. Only the team chip collapses its name this
            far — the `@expert` chip keeps its name at every width. */}
        <span className={cn('truncate', kind === 'team' && '@max-[330px]:hidden')}>{name}</span>
      </Pressable>
    </Tooltip>
  );
});

// The one filled button of the composer.
const SendButton = memo(function SendButton({ label, disabled, onSend }: { label: string; disabled: boolean; onSend: () => void }) {
  return <IconButton variant="primary" icon={AppIcons.send} label={label} disabled={disabled} onClick={onSend} />;
});

const StopButton = memo(function StopButton({ label, onStop }: { label: string; onStop: () => void }) {
  return <IconButton variant="secondary" icon={AppIcons.stop} label={label} onClick={onStop} />;
});

const AttachmentStrip = memo(function AttachmentStrip({ images, files, references, isWelcome, conversationId, workspacePath, onRemoveImage, onRemoveFile, onRemoveReference }: {
  images: ImageAttachment[];
  files: FileAttachmentItem[];
  references: ChatReference[];
  isWelcome: boolean;
  conversationId: string | undefined;
  workspacePath: string | null | undefined;
  onRemoveImage: (id: string) => void;
  onRemoveFile: (id: string) => void;
  onRemoveReference: (id: string) => void;
}) {
  const { t } = useI18n();
  const chipClass = 'flex shrink-0 items-center gap-1 rounded-control bg-fill px-2 py-1 text-ui-sm text-label';
  return (
    <div className={cn('flex items-center gap-2 overflow-x-auto', isWelcome ? 'pl-5 pt-3 pb-1' : 'pl-4 pt-3 pb-1')}>
      {images.map((img, index) => (
        <div key={img.id} className="group/img relative shrink-0">
          <Pressable
            className="block overflow-hidden rounded-control border border-separator hover:border-control-border"
            onClick={(event) => {
              useImageLightboxStore.getState().open(
                images.map((image) => ({
                  id: image.id,
                  data: image.data,
                  mediaType: image.mediaType,
                  filePath: image.filePath,
                  conversationId,
                  workspacePath: workspacePath ?? undefined,
                })),
                index,
                event.currentTarget,
              );
            }}
            title={t.chat.clickToViewFull}
            aria-label={t.chat.clickToViewFull}
          >
            <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="h-12 w-12 object-cover" />
          </Pressable>
          {/* Shown on hover or keyboard focus. The opaque backing keeps the button
              readable over any picture (the secondary fill is translucent). */}
          <span className="absolute -right-1 -top-1 flex rounded-control bg-raised opacity-0 shadow-float group-hover/img:opacity-100 focus-within:opacity-100">
            <IconButton
              size="sm"
              variant="secondary"
              icon={AppIcons.close}
              label={t.chat.removeImage}
              onClick={() => onRemoveImage(img.id)}
            />
          </span>
        </div>
      ))}
      {files.map((f) => (
        <div key={f.id} className={chipClass}>
          <Icon icon={AppIcons.file} size="sm" className="text-label-secondary" />
          <span className="max-w-40 truncate">{f.name}</span>
          <IconButton size="sm" icon={AppIcons.close} label={t.toolbox.menuRemove} onClick={() => onRemoveFile(f.id)} />
        </div>
      ))}
      {references.map((r) => (
        <div
          key={r.id}
          className={chipClass}
          title={`${r.source.name}\n${r.selection.text}${r.comment ? `\n${r.comment}` : ''}`}
        >
          <Icon icon={AppIcons.file} size="sm" className="text-label-secondary" />
          <span className="max-w-50 truncate">
            {/* dom-element: r.selection.text is the raw outerHTML (tag
                soup) — show the readable label createDomElementReference
                already computed into source.name instead (e.g.
                "div#hero.card"). doc-selection keeps showing the quoted
                selected text. The title on the chip still shows the
                fuller detail on hover. */}
            {referenceChipLabel(r)}
            {r.comment && <span className="text-label-tertiary"> · {r.comment}</span>}
          </span>
          <IconButton size="sm" icon={AppIcons.close} label={t.toolbox.menuRemove} onClick={() => onRemoveReference(r.id)} />
        </div>
      ))}
      {/* A real flex item keeps the trailing inset scrollable in Chromium;
          padding-right alone disappears when the row overflows. */}
      <div aria-hidden="true" className={cn('shrink-0 self-stretch', isWelcome ? 'w-3' : 'w-2')} />
    </div>
  );
});

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

  const [editorHistoryKey, setEditorHistoryKey] = useState(draftKey);
  const [text, setText] = useState(initialDraft.text);
  const [images, setImages] = useState<ImageAttachment[]>(initialDraft.images);
  const [files, setFiles] = useState<FileAttachmentItem[]>(initialDraft.files);
  const [references, setReferences] = useState<ChatReference[]>(initialDraft.references);
  const [selectedSkill, setSelectedSkill] = useState<SuggestionItem | null>(initialDraft.selectedSkill);
  const [selectedAgent, setSelectedAgent] = useState<SuggestionItem | null>(initialDraft.selectedAgent);
  const activeTeams = useVisibleTeams().filter(team => !team.managed || team.managed.ready);
  const [dismissedSuggestionKey, setDismissedSuggestionKey] = useState<string | null>(null);
  const [menuPicker, setMenuPicker] = useState<{ type: 'skill' | 'agent'; query: string } | null>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selection, setSelection] = useState<ComposerSelection>({
    start: initialDraft.text.length,
    end: initialDraft.text.length,
  });
  const [isComposing, setIsComposing] = useState(false);
  const textareaRef = useRef<InlineSkillInputHandle>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  // What takes focus once the + menu has gone: a picker, or the text field.
  const afterPlusMenuRef = useRef<'skill' | 'agent' | 'field' | null>(null);
  const voiceInputEnabled = useVoiceInputStore((s) => s.enabled);
  const [voiceInputAvailable] = useState(isSpeechAvailable);

  // Voice input (VoiceInputControl): the transcript lands where the caret was
  // when recording started, and only if the draft has not changed since —
  // otherwise the control holds it for an explicit insert.
  const getVoiceDraftSnapshot = useCallback((): VoiceDraftSnapshot => {
    const textarea = textareaRef.current;
    const value = textarea?.value ?? '';
    return {
      text: value,
      start: textarea?.selectionStart ?? value.length,
      end: textarea?.selectionEnd ?? value.length,
    };
  }, []);
  const insertVoiceText = useCallback((transcript: string, at?: VoiceDraftSnapshot) => {
    const textarea = textareaRef.current;
    if (!textarea) return false;
    if (at && textarea.value !== at.text) return false;
    textarea.focus();
    if (at) textarea.setSelectionRange(at.start, at.end);
    const start = textarea.selectionStart ?? textarea.value.length;
    const insertion = spaceForInsertion(textarea.value.slice(0, start), transcript);
    textarea.insertText(insertion);
    setSelection({ start: start + insertion.length, end: start + insertion.length });
    return true;
  }, [setSelection]);
  const insertVoiceTextIfUnchanged = useCallback(
    (transcript: string, snapshot: VoiceDraftSnapshot) => insertVoiceText(transcript, snapshot),
    [insertVoiceText],
  );
  const insertVoiceTextAtCursor = useCallback((transcript: string) => {
    insertVoiceText(transcript);
  }, [insertVoiceText]);
  const voiceControl = voiceInputEnabled && voiceInputAvailable ? (
    <VoiceInputControl
      resetKey={draftKey}
      getDraftSnapshot={getVoiceDraftSnapshot}
      insertIfUnchanged={insertVoiceTextIfUnchanged}
      insertAtCursor={insertVoiceTextAtCursor}
    />
  ) : null;
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
  }, [text, selectedSkill]);

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
  const pendingInputStartsTask = useChatStore((s) => s.pendingInputStartsTask);
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
  const globalActiveModel = useSettingsStore((s) => s.activeModel);
  const providers = useSettingsStore((s) => s.providers);
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
  // A managed provider names its models itself; show the id as given even
  // before its list has been pulled.
  const isManagedModel = effProvider?.source === 'managed' && currentModel.length > 0;
  const modelIssue = getModelUnavailableReason({ providers }, effModel);
  const hasActiveProvider = !modelIssue;
  const availableModels = effProvider?.models ?? [];
  const activeModelInfo = availableModels.find((m) => m.id === currentModel);
  const modelDisplay = modelIssue
    ? (providers.some((p) => p.enabled)
        ? describeModelUnavailable(t.chat, modelIssue, getModelDisplayLabel({ providers }, effModel)).label
        : t.chat.noModelConfigured)
    : isManagedModel && !activeModelInfo
      ? currentModel
      : (activeModelInfo?.label ?? (currentModel ? currentModel.split('/').pop()?.split('-').slice(0, 2).join(' ') : 'Claude'));
  const [showModelPicker, setShowModelPicker] = useState(false);
  // Built once per name: the composer re-renders on every streamed token, the picker must not.
  const modelPickerTrigger = useMemo(
    () => <ModelPickerTrigger label={modelDisplay} unavailable={!hasActiveProvider} />,
    [modelDisplay, hasActiveProvider],
  );
  useManagedProviderLiveness(effProvider, isRunning);
  // A send guard elsewhere may ask for the picker (a model the organization withdrew).
  useEffect(() => subscribeModelPickerRequest(() => setShowModelPicker(true)), []);
  const managedProviderOffline = effProvider?.source === 'managed' && effProvider.status === 'failed';

  const showAttachmentAdmissionFailed = useCallback((error?: unknown) => {
    useToastStore.getState().addToast({
      type: 'error',
      title: error instanceof InvalidAttachmentPathError ? t.chat.attachmentInvalidFileName : t.chat.attachmentAdmissionFailed,
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
        return !admittedNames.has(name);
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
  const pinnedTeam = pinnedTeamId ? activeTeams.find((team) => team.id === pinnedTeamId) ?? null : null;
  const pinTeam = useCallback((teamId: string | undefined) => {
    if (teamId) {
      setSelectedAgent(null);
      if (!activeConvId) useChatStore.getState().setPendingAgent(null);
    }
    if (activeConvId) setConversationTeamId(activeConvId, teamId);
    else setPendingTeamId(teamId);
  }, [activeConvId, setConversationTeamId, setPendingTeamId]);

  // Every explicit picker/prefill uses the same replacement rule. Keep the
  // conversation pin and draft identity exclusive without changing history.
  const selectEntry = useCallback((item: SuggestionItem) => {
    if (item.team) pinTeam(item.teamId);
    else if (pinnedTeamId) pinTeam(undefined);
    setSelectedAgent(item.team ? null : item);
    if (!activeConvId) useChatStore.getState().setPendingAgent(item.team ? null : item.name);
  }, [activeConvId, pinTeam, pinnedTeamId]);

  // Legacy session drafts may contain both identities. A restored draft must
  // not silently override the conversation's team; explicit picks clear it first.
  useEffect(() => {
    if (pinnedTeamId && selectedAgent) {
      setSelectedAgent(null);
      if (!activeConvId) useChatStore.getState().setPendingAgent(null);
    } else if (!activeConvId && selectedAgent) {
      useChatStore.getState().setPendingAgent(selectedAgent.name);
    }
  }, [activeConvId, pinnedTeamId, selectedAgent]);

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
    setEditorHistoryKey(draftKey);
    setImages(draft.images);
    setFiles(draft.files);
    setReferences(draft.references);
    setSelectedSkill(draft.selectedSkill);
    setSelectedAgent(draft.selectedAgent);
    setSelection({ start: draft.text.length, end: draft.text.length });
    setDismissedSuggestionKey(null);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    setMenuPicker(null);
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

  // Prefills supplement the target draft; explicit commands select a route without replacing its body.
  useEffect(() => {
    if (pendingInput !== null) {
      if (pendingInputStartsTask) {
        setSelectedAgent(null);
        setSelectedSkill(null);
        if (!activeConvId) useChatStore.getState().setPendingAgent(null);
      }
      const command = splitInputCommand(pendingInput);
      const skill = command?.prefix === '/' ? skills.find((item) => item.name === command.name && item.userInvocable !== false && !disabledSkills.includes(item.name)) : undefined;
      const agent = command?.prefix === '@' ? agents.find((item) => item.name === command.name && item.name !== 'abu') : undefined;
      const currentText = currentDraftRef.current.text;
      const body = command ? mergeDraftPrefill(currentText === pendingInput ? '' : currentText, command.body) : '';
      const nextText = command
        ? (skill || agent ? body : `${command.prefix}${command.name}${body ? ' ' + body : ''}`)
        : mergeDraftPrefill(currentText, pendingInput);
      if (skill) {
        setSelectedSkill({ name: skill.name, description: skill.description, trigger: skill.trigger });
        setSelectedAgent(null);
        if (!activeConvId) useChatStore.getState().setPendingAgent(null);
      } else if (agent) {
        selectEntry({ name: agent.name, description: agent.description, avatar: agent.avatar });
        setSelectedSkill(null);
      } else if (command) {
        // Discovery may still be loading: retain the command for later auto-selection.
        setSelectedAgent(null);
        setSelectedSkill(null);
        if (!activeConvId) useChatStore.getState().setPendingAgent(null);
      }
      const pendingSelection = { start: nextText.length, end: nextText.length };
      pendingSelectionRef.current = pendingSelection;
      setText(nextText);
      setSelection(pendingSelection);
      // React does not schedule a render when the store value equals the
      // current draft. Keep the real DOM caret in sync in that case too.
      const textarea = textareaRef.current;
      if (textarea) {
        const alreadyRendered = textarea.value === nextText;
        textarea.setSelectionRange(pendingSelection.start, pendingSelection.end);
        if (alreadyRendered) pendingSelectionRef.current = null;
      }
      setPendingInput(null);
      textarea?.focus();
    }
  }, [pendingInput, pendingInputStartsTask, setPendingInput, skills, agents, disabledSkills, activeConvId, selectEntry]);

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

  const handleStop = useCallback(() => {
    if (activeConvId) {
      cancelStreaming(activeConvId, { source: 'chat-input-stop-button' });
    }
  }, [activeConvId, cancelStreaming]);

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

  const skillTarget = useMemo(() => {
    if (isComposing || selection.start !== selection.end) return null;
    const head = text.slice(0, selection.start);
    const match = /(?:^|[\s（(，。；：！？、\p{Script=Han}])\/([^\s/]*)$/u.exec(head);
    if (match) return { start: head.length - match[1].length - 1, end: head.length, query: match[1].toLowerCase() };
    // Preserve pasted leading commands with a body until explicitly selected.
    const command = !selectedSkill ? /^\s*\/([^\s]+)[ \t]/.exec(text) : null;
    return command ? { start: text.indexOf('/'), end: text.indexOf('/') + command[1].length + 1, query: command[1].toLowerCase() } : null;
  }, [isComposing, selection.start, selection.end, text, selectedSkill]);

  const disabledSkillSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

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
    // `@` keeps working with an agent chip set — picking again switches the
    // chip (user report 2026-09-04: "已选择 Agent 后再输入 @ 没反应").
    if (menuPicker) return menuPicker.type;
    if (agentMentionTarget) return 'agent';
    if (skillTarget) return 'skill';
    return null;
  }, [agentMentionTarget, skillTarget, menuPicker]);

  // Skill/Agent suggestions
  const suggestions = useMemo((): SuggestionItem[] => {
    // Agent + team suggestions when typing @. Teams come first with a kind
    // badge so 用户 can tell 团队 from 单个队员 at a glance (feedback 2026-08-31).
    if (suggestionType === 'agent') {
      const query = menuPicker?.query.toLowerCase() ?? agentMentionTarget?.query ?? '';
      const teamItems: SuggestionItem[] = activeTeams
        .filter((team) => !query || team.name.toLowerCase().includes(query))
        .map((team) => ({ name: team.name, description: t.team.suggestionTeamHint, team: true, teamId: team.id, avatar: team.avatar }));
      return [
        ...teamItems,
        ...agents
          .filter((a) => a.name !== 'abu')
          .filter((a) => {
            if (!query) return true;
            return a.name.toLowerCase().includes(query) ||
              a.description.toLowerCase().includes(query);
          })
          .map((a) => ({
            name: a.name,
            description: a.description,
            avatar: a.avatar,
            fromPlugin: isPluginOwnedAgent(a),
          })),
      ];
    }

    // Skill suggestions when typing /
    if (suggestionType === 'skill') {
      const query = menuPicker?.query.toLowerCase() ?? skillTarget?.query ?? '';
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
  }, [skills, agents, activeTeams, suggestionType, agentMentionTarget, disabledSkillSet, t.team.suggestionTeamHint, menuPicker, skillTarget]);

  const suggestionKey = useMemo(() => {
    if (menuPicker) return `menu:${menuPicker.type}:${menuPicker.query}`;
    if (suggestionType === 'agent') return agentMentionTarget?.key ?? null;
    if (suggestionType === 'skill') {
      return skillTarget ? `skill:${skillTarget.start}:${skillTarget.query}` : null;
    }
    return null;
  }, [agentMentionTarget, suggestionType, menuPicker, skillTarget]);

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
    (menuPicker !== null || suggestions.length > 0);

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
      const listbox = option.closest<HTMLElement>('[data-composer-suggestions]');
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
    if (menuPicker || !suggestionType || selectedSkill || selectedAgent || isComposing) return;
    const command = splitInputCommand(text);

    if (suggestionType === 'skill') {
      if (command?.prefix === '/' && /^\s*\/\S+\s/.test(text) && suggestions.length === 1 && suggestions[0].name === command.name) {
        setSelectedSkill({ ...suggestions[0], offset: 0 });
        setText(command.body);
        setSelection({ start: (command.body).length, end: (command.body).length });
        setDismissedSuggestionKey(suggestionKey);
      }
    } else if (suggestionType === 'agent') {
      const leadingCommand = parseLeadingAgentCommand(text);
      if (leadingCommand && /\s/.test(text[leadingCommand.range.end] ?? '') &&
        suggestions.length === 1 &&
        suggestions[0].name.toLowerCase() === leadingCommand.query
      ) {
        selectEntry(suggestions[0]);
        const remainingText = leadingCommand.body;
        setText(remainingText);
        setSelection({ start: remainingText.length, end: remainingText.length });
        setDismissedSuggestionKey(suggestionKey);
      }
    }
  }, [isComposing, text, suggestionKey, suggestionType, suggestions, selectedSkill, selectedAgent, selectEntry, menuPicker]);

  // Auto-resize textarea
  const maxHeight = isWelcome ? 180 : 160;
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
    }
  }, [text, maxHeight]);

  const syncSelectionFromTextarea = useCallback((textarea: InlineSkillInputHandle) => {
    if (pendingSelectionRef.current) return;

    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    setSelection((prev) => (
      prev.start === start && prev.end === end ? prev : { start, end }
    ));
  }, [setSelection]);

  const resolveDomAgentMentionTarget = useCallback((textarea: InlineSkillInputHandle): AgentMentionTarget | null => {
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
    if (menuPicker) {
      if (menuPicker.type === 'skill') {
        const point = Math.min(selection.start, text.length);
        setSelectedSkill({ ...item, offset: point });
        pendingSelectionRef.current = { start: point, end: point };
        setSelectedAgent(null);
        if (!activeConvId) useChatStore.getState().setPendingAgent(null);
      } else {
        setSelectedSkill(null);
        selectEntry(item);
      }
      setMenuPicker(null);
      setDismissedSuggestionKey(suggestionKey);
      textareaRef.current?.focus();
      return;
    }
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
      const bodyStart = replacementRange.end + (currentTarget.source === 'leading-command' && /[ \t]/.test(textarea.value[replacementRange.end] ?? '') ? 1 : 0);
      const nextText = textarea.value.slice(0, replacementRange.start) +
        textarea.value.slice(bodyStart);
      const nextCaret = replacementRange.start;
      pendingSelectionRef.current = { start: nextCaret, end: nextCaret };
      selectEntry(item);
      setText(nextText);
      setSelection({ start: nextCaret, end: nextCaret });
      setDismissedSuggestionKey(currentTarget.key);
    } else {
      if (!skillTarget) return;
      const current = textareaRef.current?.value ?? text;
      const suffix = item.name.toLowerCase().startsWith(skillTarget.query) ? item.name.slice(skillTarget.query.length) : '';
      const triggerEnd = skillTarget.end + (suffix && current.slice(skillTarget.end, skillTarget.end + suffix.length).toLowerCase() === suffix.toLowerCase() ? suffix.length : 0);
      const end = triggerEnd + (skillTarget.start === 0 && /[ \t]/.test(current[triggerEnd] ?? '') ? 1 : 0);
      const body = current.slice(0, skillTarget.start) + current.slice(end);
      setSelectedSkill({ ...item, offset: skillTarget.start });
      setSelectedAgent(null);
      setText(body);
      pendingSelectionRef.current = { start: skillTarget.start, end: skillTarget.start };
      setSelection({ start: skillTarget.start, end: skillTarget.start });
      setDismissedSuggestionKey(suggestionKey);
    }
    textareaRef.current?.focus();
  };

  const removeSkill = () => {
    setSelectedSkill(null);
    textareaRef.current?.focus();
  };

  const removeAgent = useCallback(() => {
    setSelectedAgent(null);
    if (!activeConvId) useChatStore.getState().setPendingAgent(null);
    textareaRef.current?.focus();
  }, [activeConvId]);

  const removeReference = useCallback((id: string) => {
    setReferences((prev) => prev.filter((x) => x.id !== id));
    highlightRegistry.remove(id);
  }, []);

  const resetInput = () => {
    const keepSelectors = activeConvId !== null;
    currentDraftRef.current = {
      text: '',
      images: [],
      files: [],
      references: [],
      selectedSkill: keepSelectors && selectedSkill ? { ...selectedSkill, offset: 0 } : null,
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
    if (keepSelectors && selectedSkill) setSelectedSkill({ ...selectedSkill, offset: 0 });
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

    if (files.some((file) => file.path !== undefined && fileReferenceForPath(file.path) === null)) {
      showAttachmentAdmissionFailed(new InvalidAttachmentPathError());
      return;
    }

    const unsupportedToken = files.find((file) => (
      file.token !== undefined
    ));
    if (unsupportedToken) {
      useToastStore.getState().addToast({
        type: 'error',
        title: format(t.chat.unsupportedDocumentAttachment, { name: unsupportedToken.name }),
      });
      return;
    }

    // Preserve the established path-reference contract for ordinary workspace
    // files. These are prompt context only; unlike image attachments, no file
    // bytes cross the provider boundary here.
    const fileContext = files
      .flatMap((file) => {
        const reference = file.path ? fileReferenceForPath(file.path) : null;
        return reference ? [reference] : [];
      })
      .join('\n');
    const referenceContext = serializeReferences(references);

    // Compose parts, then join with newline
    const bodyParts = [fileContext, referenceContext, trimmed ? text : ''].filter(Boolean).join('\n\n');

    let message: string;
    if (selectedAgent) {
      message = `@${selectedAgent.name}${bodyParts ? ' ' + bodyParts : ''}`;
    } else if (selectedSkill) {
      message = `/${selectedSkill.name}${bodyParts ? ' ' + bodyParts : ''}`;
    } else {
      message = bodyParts;
    }

    // Goal mode: `/goal …` is an instruction to the app, never a message for
    // the model, so it must not wait in the queue behind the running task (a
    // goal keeps the conversation running, which is exactly when the user
    // types `/goal pause`). It goes to the send handler at once; the text
    // stays in the composer when the handler refuses it.
    const sendGoalCommandNow = () => {
      void Promise.resolve(onSend(message)).then(
        (accepted) => {
          if (accepted !== false) resetInput();
        },
        // A send that fails did not take the command: it is still in the composer.
        () => {},
      );
    };
    const isGoalCommand = images.length === 0 && parseGoalCommand(message) !== null;
    if (isGoalCommand && isRunning) {
      sendGoalCommandNow();
      return;
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
      if (address && running && requestDispatchInput(running.key, address.body)) {
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
      if (isGoalCommand) {
        sendGoalCommandNow();
        return;
      }
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
        // One pick per press of Enter: the repeat of a held Enter picks nothing.
        if (e.key === 'Enter' && e.repeat) return;
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
        // One message per press: a held Enter repeats, and this field takes the focus by itself
        // after actions whose key may still be down (start a conversation with an expert, pick a
        // suggestion). The repeat sends nothing and, its default prevented, adds no line.
        // Shift+Enter and Alt+Enter keep repeating: holding them adds lines.
        if (e.repeat) return;
        handleSend();
      } else if (action === 'insert') {
        e.preventDefault();
        const textarea = textareaRef.current;
        if (textarea) {
          const insertionPoint = textarea.selectionStart ?? text.length;
          textarea.insertText('\n');
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
      const selected = await selectElectronUserAttachments({ mediaTypes: [...ELECTRON_PICKER_MEDIA_TYPES, 'application/pdf'] });
      if (selected.length === 0) return;
      const filePaths = selected.flatMap((item) => 'path' in item ? [item.path] : []);
      const imageTokens = selected.filter((item): item is ElectronUserAttachmentToken => 'token' in item);
      try {
        await processFilePaths(
          filePaths,
          (imgs) => appendImagesForDraftKey(admissionKey, imgs),
          (items) => appendFilesForDraftKey(admissionKey, items),
        );
      } catch (error) {
        for (const image of imageTokens) releaseToken(image.token);
        throw error;
      }
      const imageResults = await Promise.allSettled(imageTokens.map(imageFromToken));
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

  const closeMenuPicker = () => {
    setMenuPicker(null);
    textareaRef.current?.focus();
  };

  // The + menu, the chips and the send button are memoized (the composer re-renders on
  // every keystroke and streamed token), so they call the latest handlers through a ref.
  const latestHandlersRef = useRef({ attach: handleAttachClick, send: handleSend });
  useLayoutEffect(() => {
    latestHandlersRef.current = { attach: handleAttachClick, send: handleSend };
  });
  // After 添加文件 the text field takes focus back (the files are context for what the
  // user types next), not the + button.
  const pickAddFile = useCallback(() => {
    afterPlusMenuRef.current = 'field';
    void latestHandlersRef.current.attach();
  }, []);
  // Opening a picker is a read-only action on the draft. Commit only on selection.
  // The picker opens once the + menu has gone: while the menu is on screen it keeps
  // focus inside itself, so the picker's search field could not take it.
  const pickTeamOrMember = useCallback(() => { afterPlusMenuRef.current = 'agent'; }, []);
  const pickSkill = useCallback(() => { afterPlusMenuRef.current = 'skill'; }, []);
  const handlePlusMenuCloseAutoFocus = useCallback((event: Event) => {
    const next = afterPlusMenuRef.current;
    if (!next) return;
    afterPlusMenuRef.current = null;
    event.preventDefault();
    if (next === 'field') textareaRef.current?.focus();
    else setMenuPicker({ type: next, query: '' });
  }, [setMenuPicker]);
  // Reopening + during its exit animation keeps the menu mounted, so the close handler
  // never runs for the earlier choice. Drop it here, or the next Escape would open it.
  const handlePlusMenuOpenChange = useCallback((open: boolean) => {
    if (open) afterPlusMenuRef.current = null;
    setShowPlusMenu(open);
  }, [setShowPlusMenu]);
  const sendFromButton = useCallback(() => latestHandlersRef.current.send(), []);
  const clearTeamPin = useCallback(() => { pinTeam(undefined); textareaRef.current?.focus(); }, [pinTeam]);

  // Who takes the next message: the team pin or an @expert. Lives in the bottom
  // row next to `+` (WorkBuddy chip bar); click = clear.
  const composerChips = (
    <>
      {pinnedTeam && (
        <ComposerChip
          kind="team"
          testId="composer-team-chip"
          name={pinnedTeam.name}
          avatar={pinnedTeam.avatar}
          ariaLabel={`👥${pinnedTeam.name}`}
          closeLabel={t.common.close}
          onClear={clearTeamPin}
        />
      )}
      {selectedAgent && (
        <ComposerChip
          kind="agent"
          name={selectedAgent.name}
          avatar={selectedAgent.avatar}
          ariaLabel={`@${selectedAgent.name}`}
          closeLabel={t.common.close}
          onClear={removeAgent}
        />
      )}
    </>
  );

  const plusMenu = (
    <PlusMenu
      open={showPlusMenu}
      onOpenChange={handlePlusMenuOpenChange}
      onCloseAutoFocus={handlePlusMenuCloseAutoFocus}
      onAddFile={pickAddFile}
      onTeamOrMember={pickTeamOrMember}
      onSkill={pickSkill}
    />
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
        {showSuggestions && (
          <SuggestionPopup
            anchorRef={composerAnchorRef}
            listboxId={suggestionListboxId}
            ariaLabel={t.chat.composerSuggestions}
            suggestions={suggestions}
            selectedIndex={selectedIndex}
            suggestionType={suggestionType}
            sectionLabels={{ teams: t.chat.suggestionSectionTeams, agents: t.chat.suggestionSectionAgents, skills: t.chat.suggestionSectionSkills }}
            pluginTagLabel={t.chat.pickAgentPluginTag}
            optionId={suggestionOptionId}
            onApply={applySuggestion}
            search={menuPicker ? {
              query: menuPicker.query,
              label: t.common.search,
              closeLabel: t.common.close,
              onChange: (query) => setMenuPicker({ ...menuPicker, query }),
              onClose: closeMenuPicker,
              onKeyDown: (event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === 'Escape') { event.preventDefault(); closeMenuPicker(); }
                else if (event.key === 'ArrowDown') { event.preventDefault(); setSelectedIndex((index) => Math.max(0, Math.min(suggestions.length - 1, index + 1))); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setSelectedIndex((index) => Math.max(0, index - 1)); }
                else if (event.key === 'Enter' && suggestions[selectedIndex]) { event.preventDefault(); applySuggestion(suggestions[selectedIndex]); }
              },
            } : undefined}
          />
        )}

        {managedProviderOffline && effProvider && (
          <ManagedProviderOfflineBar provider={effProvider} conversationId={activeConv?.id ?? null} />
        )}

        {/* Input Card */}
        <div
          {...dropTargetProps}
          className={cn(
            'relative rounded-panel border border-separator bg-field shadow-composer',
            !isWelcome && isDragging ? 'ring-2 ring-focus' : 'focus-within:border-control-border'
          )}
        >
          {/* Attachment Strip (images + file badges) */}
          {hasAttachments && (
            <AttachmentStrip
              images={images}
              files={files}
              references={references}
              isWelcome={isWelcome}
              conversationId={activeConv?.id}
              workspacePath={activeConv?.workspacePath}
              onRemoveImage={removeImage}
              onRemoveFile={removeFile}
              onRemoveReference={removeReference}
            />
          )}

          {/* Textarea Row with inline command prefix */}
          <div className={cn(
            'flex items-start gap-0',
            isWelcome
              ? hasAttachments ? 'px-5 pt-1 pb-1' : 'px-5 pt-4 pb-1'
              : hasAttachments ? 'px-4 pt-1 pb-1' : 'px-4 pt-3 pb-1'
          )}>
            <InlineSkillInput
              historyKey={editorHistoryKey}
              imeActive={isComposing}
              skill={selectedSkill}
              removeLabel={t.common.close}
              ref={textareaRef}
              aria-autocomplete="list"
              aria-expanded={showSuggestions && suggestions.length > 0}
              aria-controls={showSuggestions && suggestions.length > 0 ? suggestionListboxId : undefined}
              aria-activedescendant={
                showSuggestions && suggestions.length > 0
                  ? suggestionOptionId(selectedIndex)
                  : undefined
              }
              value={text}
              onChange={(value, skill) => {
                setText(value);
                setSelectedSkill(skill);
                if (skill) {
                  setSelectedAgent(null);
                  if (!activeConvId) useChatStore.getState().setPendingAgent(null);
                }
                if (textareaRef.current) syncSelectionFromTextarea(textareaRef.current);
              }}
              onKeyDown={handleKeyDown}
              onSelect={() => { if (textareaRef.current) syncSelectionFromTextarea(textareaRef.current); }}
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
                'flex-1 resize-none bg-transparent text-body text-label outline-none placeholder:text-label-placeholder',
                isWelcome
                  ? 'min-h-[52px] max-h-[180px]'
                  : 'min-h-[24px] max-h-[160px] py-1 disabled:opacity-40'
              )}
            />
          </div>

          {/* Bottom Toolbar */}
          {isWelcome ? (
            /* Workspace context lives below the input card. The send toolbar
               stays a single, calm row even in a narrow center pane — same
               degradation ladder as the chat variant below, minus the context
               ring (there is no conversation yet to measure). */
            <div data-testid="composer-toolbar" className="@container flex items-center gap-2 px-5 pb-3">
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {plusMenu}
                {composerChips}
              </div>

              {/* Model picker — right-aligned, before Start button */}
              <div className="flex min-w-0 items-center gap-1">
                <PermissionModeChip conversationId={null} />
                <div className="flex min-w-0 max-w-45">
                  <ModelSelector open={showModelPicker} onOpenChange={setShowModelPicker} trigger={modelPickerTrigger} />
                </div>

                {voiceControl}

                <SendButton label={sendTooltip} disabled={!hasContent} onSend={sendFromButton} />
              </div>
            </div>
          ) : (
            /* Chat variant: [+] [chips] --- [Perm] [Model ∨] [◯] [Stop/Send]
               One row at every width. This row used to be `flex-wrap` with two
               content-sized groups, and CSS resolves wrapping against content
               size *before* it shrinks anything: once the workspace panel
               starved the chat column, the whole right half went to a second,
               `ml-auto`-aligned line instead of the model name truncating the
               way the code below intends (measured 72px tall at a ~300px
               toolbar; the guard for it is tests/e2e/composer-narrow-toolbar).

               What actually holds the row together is `flex-1` on the left
               group below — a zero basis means it can only ever take leftover
               space, so it yields continuously instead of forcing a break.
               Dropping `flex-wrap` on top of that is belt and braces: with the
               zero basis in place the row no longer wraps even if `flex-wrap`
               comes back, so don't read its absence as the fix.

               Space is then given up in a fixed order: chip names truncate →
               the permission label collapses to its icon → the context ring
               hides → the chip goes avatar-only. `+` and send/stop never move.
               Widths are queried on this toolbar (`@container`), not the
               window: this pane narrows while the window itself stays wide. */
            <div data-testid="composer-toolbar" className="@container flex items-center gap-x-2 px-4 pb-2 pt-1">
              {/* Left Actions — `flex-1` on a zero basis, so the chips absorb
                  every bit of slack and give it back first. Load-bearing: see
                  the note above before "simplifying" it back to `flex`. */}
              <div className="flex min-w-0 flex-1 items-center gap-1">
                {plusMenu}
                {composerChips}
              </div>

              {/* Right Actions: Model picker + Context indicator + Send / Stop */}
              <div className="flex min-w-0 items-center gap-1">
                <PermissionModeChip conversationId={activeConvIdForIndicator} />
                {/* Model picker */}
                <div className="flex min-w-0 max-w-45">
                  <ModelSelector open={showModelPicker} onOpenChange={setShowModelPicker} trigger={modelPickerTrigger} />
                </div>

                {/* Context usage ring — between model picker and send button.
                    Third rung of the ladder: at the narrowest widths its 30px
                    buy back a readable model name, and the same number is one
                    click away in the usage chip under the composer. */}
                {activeConvIdForIndicator && (
                  <div className="flex items-center justify-center h-7 px-1 @max-[360px]:hidden">
                    <ContextIndicator conversationId={activeConvIdForIndicator} />
                  </div>
                )}

                {voiceControl}

                {isStreaming ? (
                  <StopButton label={t.chat.stop} onStop={handleStop} />
                ) : (
                  <SendButton label={sendTooltip} disabled={!hasContent || !!disabled} onSend={sendFromButton} />
                )}
              </div>
            </div>
          )}

          {/* Chat-only drag overlay. Last in the card, so it paints over every
              positioned control above it without a z-index. */}
          {!isWelcome && isDragging && (
            <div className="absolute inset-0 flex items-center justify-center rounded-panel bg-fill-selected text-ui text-label">
              {t.chat.dropFilesHere}
            </div>
          )}
        </div>

        {/* New-task context: hidden when the conversation/project already
            supplies a workspace. A temporary selection remains visible until
            first send so it never vanishes before the task is actually bound. */}
        {showWorkspaceContextBar && (
          <div
            data-abu-workspace-context
            className="mt-2 flex min-h-10 items-center rounded-panel bg-fill px-2 py-1"
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
