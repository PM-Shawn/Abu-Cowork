import { useEffect, useState } from 'react';
import { Plus, Wand2, PenLine, Upload } from 'lucide-react';
import { useI18n } from '@/i18n';

interface ToolboxCreateMenuProps {
  /** Direct mode: clicking the "+ 添加" button fires this immediately, no dropdown
   *  (used by the MCP tab, which just opens the add-server form). Mutually exclusive
   *  with the menu-mode props below. */
  onClick?: () => void;
  /** Menu mode: dropdown with up to 3 entries (used by Agents/Skills tabs). */
  onAICreate?: () => void;
  onManualCreate?: () => void;
  onUploadFile?: () => void;
  /** Label for the third ("upload") menu item — Agents says "上传文件", Skills says "导入技能". */
  uploadLabel?: string;
  triggerTestId?: string;
  menuTestId?: string;
}

/**
 * Content-area header "+ 添加" control shared by the Agents/Skills/MCP toolbox
 * tabs (see ToolboxModal). Filled clay button; in menu mode it opens a small
 * dropdown replicating the create-menu that used to live inside each section
 * (AI-create / manual-create / upload), closing on outside click or on
 * selecting an entry.
 */
export default function ToolboxCreateMenu({
  onClick, onAICreate, onManualCreate, onUploadFile, uploadLabel, triggerTestId, menuTestId,
}: ToolboxCreateMenuProps) {
  const [open, setOpen] = useState(false);
  const { t } = useI18n();
  const isMenuMode = !onClick;

  // Close the dropdown on outside click (menu mode only).
  useEffect(() => {
    if (!isMenuMode || !open) return;
    const handleClick = () => setOpen(false);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [isMenuMode, open]);

  const handleTriggerClick = (e: React.MouseEvent) => {
    if (onClick) { onClick(); return; }
    e.stopPropagation();
    setOpen((v) => !v);
  };

  return (
    <div className="relative shrink-0">
      <button
        data-testid={triggerTestId}
        onClick={handleTriggerClick}
        className="flex items-center gap-1.5 px-3 h-8 rounded-lg text-[13px] font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] transition-colors shrink-0"
      >
        <Plus className="h-3.5 w-3.5" />
        <span>{t.settings.add}</span>
      </button>
      {isMenuMode && open && (
        <div
          data-testid={menuTestId}
          className="absolute z-50 top-full right-0 mt-1 w-44 bg-[var(--abu-bg-base)] rounded-lg shadow-lg border border-[var(--abu-border)] py-1"
        >
          {onAICreate && (
            <button
              onClick={() => { setOpen(false); onAICreate(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              <Wand2 className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
              <span>{t.toolbox.createWithAbu}</span>
            </button>
          )}
          {onManualCreate && (
            <button
              onClick={() => { setOpen(false); onManualCreate(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              <PenLine className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
              <span>{t.toolbox.createManually}</span>
            </button>
          )}
          {onUploadFile && (
            <button
              onClick={() => { setOpen(false); onUploadFile(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              <Upload className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
              <span>{uploadLabel}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
