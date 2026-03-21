import { useState, useRef, useEffect } from 'react';
import { Folder, FolderOpen, ChevronDown, Check, X } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { getBaseName } from '@/utils/pathUtils';

export interface FolderSelectorProps {
  currentPath: string | null;
  recentPaths: string[];
  onSelect: (path: string) => void;
  onClear?: () => void;
  className?: string;
}

/** Get the folder name from a full path */
function getFolderName(path: string): string {
  return getBaseName(path);
}

export default function FolderSelector({
  currentPath,
  recentPaths,
  onSelect,
  onClear,
  className,
}: FolderSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { t } = useI18n();

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close dropdown on escape key
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  const handleOpenDialog = async () => {
    setIsOpen(false);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t.folder.selectWorkspaceFolder,
      });
      if (selected) {
        onSelect(selected as string);
      }
    } catch (err) {
      console.error('Failed to open folder dialog:', err);
    }
  };

  const handleSelectRecent = (path: string) => {
    setIsOpen(false);
    onSelect(path);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClear?.();
  };

  return (
    <div ref={dropdownRef} className={cn('relative', className)}>
      {/* Trigger Button */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => {
            // First time use: no recent paths and no current path
            // Directly open folder dialog instead of showing dropdown
            if (!currentPath && recentPaths.length === 0) {
              handleOpenDialog();
            } else {
              setIsOpen(!isOpen);
            }
          }}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] rounded-lg transition-colors',
            currentPath
              ? 'text-[var(--abu-text-primary)] bg-[var(--abu-clay-bg)] hover:bg-[var(--abu-clay-20)]'
              : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)]'
          )}
        >
          {currentPath ? (
            <FolderOpen className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
          ) : (
            <Folder className="h-3.5 w-3.5" />
          )}
          <span className="max-w-[120px] truncate">
            {currentPath ? getFolderName(currentPath) : t.folder.loadFolder}
          </span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </button>

        {/* Clear button (only when folder selected) */}
        {currentPath && onClear && (
          <button
            onClick={handleClear}
            className="flex items-center justify-center w-6 h-6 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] rounded-md transition-colors"
            title={t.folder.clearWorkspace}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Dropdown Menu — opens upward to avoid bottom overflow */}
      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1.5 w-72 bg-white rounded-lg border border-[var(--abu-bg-hover)] shadow-lg z-50 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150">
          {/* Recent folders section */}
          {(recentPaths.length > 0) && (
            <>
              <div className="px-3 py-2 text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider border-b border-[var(--abu-bg-active)]">
                {t.folder.recentFolders}
              </div>
              <div className="py-1 max-h-[200px] overflow-y-auto">
                {recentPaths.slice(0, 5).map((path) => (
                  <button
                    key={path}
                    onClick={() => handleSelectRecent(path)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--abu-bg-muted)] transition-colors"
                  >
                    {/* Selection indicator */}
                    <div className="w-4 h-4 flex items-center justify-center shrink-0">
                      {path === currentPath && (
                        <Check className="h-4 w-4 text-[var(--abu-clay)]" />
                      )}
                    </div>
                    {/* Folder icon */}
                    <Folder
                      className={cn(
                        'h-4 w-4 shrink-0',
                        path === currentPath ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)]'
                      )}
                    />
                    {/* Folder name and path */}
                    <div className="flex-1 min-w-0">
                      <div
                        className={cn(
                          'text-[13px] truncate',
                          path === currentPath
                            ? 'text-[var(--abu-text-primary)] font-medium'
                            : 'text-[var(--abu-text-secondary)]'
                        )}
                      >
                        {getFolderName(path)}
                      </div>
                      <div className="text-[11px] text-[var(--abu-text-muted)] truncate">
                        {path}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Separator */}
          {recentPaths.length > 0 && (
            <div className="border-t border-[var(--abu-bg-active)]" />
          )}

          {/* Choose different folder — at bottom */}
          <div className="py-1">
            <button
              onClick={handleOpenDialog}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--abu-bg-muted)] transition-colors"
            >
              <div className="w-4 h-4" /> {/* Spacer for alignment */}
              <Folder className="h-4 w-4 text-[var(--abu-text-tertiary)] shrink-0" />
              <span className="text-[13px] text-[var(--abu-text-tertiary)]">
                {recentPaths.length > 0 ? t.folder.selectOtherFolder : `${t.folder.selectFolder}...`}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
