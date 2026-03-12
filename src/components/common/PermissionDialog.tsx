import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Shield, FolderOpen, Terminal, FileEdit, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { PermissionDuration } from '@/stores/permissionStore';

export interface PermissionRequest {
  type: 'workspace' | 'shell' | 'file-write' | 'file-read' | 'folder-select';
  path?: string;
  details?: string;
  reason?: string;  // For folder-select: why the workspace is needed
}

export type { PermissionDuration };

interface PermissionDialogProps {
  request: PermissionRequest;
  onAllow: (duration: PermissionDuration) => void;
  onDeny: () => void;
  onChooseFolder?: () => void;  // For folder-select type
}

const iconMap = {
  workspace: FolderOpen,
  shell: Terminal,
  'file-write': FileEdit,
  'file-read': FolderOpen,
  'folder-select': FolderOpen,
};

const colorMap = {
  workspace: { color: 'text-amber-500', bgColor: 'bg-amber-500/10' },
  shell: { color: 'text-orange-500', bgColor: 'bg-orange-500/10' },
  'file-write': { color: 'text-blue-500', bgColor: 'bg-blue-500/10' },
  'file-read': { color: 'text-emerald-500', bgColor: 'bg-emerald-500/10' },
  'folder-select': { color: 'text-[#d97757]', bgColor: 'bg-[#d97757]/10' },
};

export default function PermissionDialog({ request, onAllow, onDeny, onChooseFolder }: PermissionDialogProps) {
  const [selectedDuration, setSelectedDuration] = useState<PermissionDuration>('session');
  const [showAlwaysConfirm, setShowAlwaysConfirm] = useState(false);
  const { t } = useI18n();

  // Close on Escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onDeny();
    }
  }, [onDeny]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const Icon = iconMap[request.type];
  const colors = colorMap[request.type];

  // Cowork-style folder selection variant
  if (request.type === 'folder-select') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="relative w-full max-w-sm mx-4 bg-white rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
          {/* Close button */}
          <button
            onClick={onDeny}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Centered content */}
          <div className="text-center py-8 px-6">
            <div className={`inline-flex p-4 rounded-2xl ${colors.bgColor} mb-4`}>
              <FolderOpen className={`h-12 w-12 ${colors.color}`} />
            </div>

            <h3 className="text-lg font-semibold text-[#29261b] mb-2">
              {t.permission.folderSelect?.title ?? ''}
            </h3>

            <p className="text-[14px] text-[#656358] mb-4">
              {t.permission.folderSelect?.description ?? ''}
            </p>

            <Button
              size="lg"
              onClick={onChooseFolder}
              className="px-8 h-11 text-[15px] bg-[#d97757] hover:bg-[#c66646] text-white"
            >
              {t.permission.folderSelect?.selectButton ?? ''}
            </Button>
          </div>

          {/* Footer hint */}
          <div className="px-6 pb-6">
            <p className="text-[12px] text-[#8b887c] text-center">
              {t.permission.folderSelect?.hint ?? ''}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Get the appropriate permission config from translations
  const getPermissionConfig = () => {
    switch (request.type) {
      case 'workspace':
        return t.permission.workspace;
      case 'shell':
        return t.permission.shell;
      case 'file-write':
        return t.permission.fileWrite;
      case 'file-read':
        return t.permission.fileRead!;
      default:
        return t.permission.workspace;
    }
  };

  const config = getPermissionConfig();

  const durationOptions: Array<{ value: PermissionDuration; label: string; description: string }> = [
    { value: 'once', label: t.permission.durationOnce, description: t.permission.forgetAfterSession },
    { value: 'session', label: t.permission.durationSession, description: t.permission.forgetAfterSession },
    { value: '24h', label: t.permission.duration24h, description: '' },
    { value: 'always', label: t.permission.durationAlways, description: t.permission.rememberChoiceDescription },
  ];

  const getAllowButtonText = () => {
    switch (selectedDuration) {
      case 'once': return t.permission.allowOnceButton;
      case 'session': return t.permission.allowSessionButton;
      case '24h': return t.permission.allow24hButton;
      case 'always': return t.permission.allowAlwaysButton;
    }
  };

  const handleAllow = () => {
    // Show inline confirmation for 'always' option instead of window.confirm
    if (selectedDuration === 'always' && !showAlwaysConfirm) {
      setShowAlwaysConfirm(true);
      return;
    }
    onAllow(selectedDuration);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md mx-4 bg-white rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4">
          <button
            onClick={onDeny}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-xl ${colors.bgColor}`}>
              <Icon className={`h-6 w-6 ${colors.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-[#29261b]">{config.title}</h2>
              <p className="text-[14px] text-[#656358] mt-0.5">{config.description}</p>
            </div>
          </div>
        </div>

        {/* Path display */}
        {request.path && (
          <div className="mx-6 px-3 py-2 bg-[#f5f3ee] rounded-lg border border-[#e8e4dd]">
            <p className="text-[13px] text-[#656358] truncate font-mono">{request.path}</p>
          </div>
        )}

        {/* Capabilities */}
        <div className="px-6 py-4">
          <p className="text-[13px] font-medium text-[#29261b] mb-2">{t.permission.abuCanDo}</p>
          <ul className="space-y-1.5">
            {config.capabilities.map((cap, i) => (
              <li key={i} className="flex items-center gap-2 text-[13px] text-[#3d3929]">
                <Shield className="h-3.5 w-3.5 text-green-500 shrink-0" />
                {cap}
              </li>
            ))}
          </ul>
        </div>

        {/* Warning */}
        <div className="mx-6 mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[12px] text-amber-700 leading-relaxed">{config.warning}</p>
          </div>
        </div>

        {/* Duration selector - segmented control */}
        <div className="mx-6 mb-4">
          <p className="text-[12px] text-[#656358] mb-2">{t.permission.durationLabel}</p>
          <div className="flex items-center gap-1 p-1 bg-[#f0ede8] rounded-lg">
            {durationOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => setSelectedDuration(option.value)}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded-md text-[12px] font-medium transition-colors text-center',
                  option.value === selectedDuration
                    ? 'bg-white text-[#29261b] shadow-sm'
                    : 'text-[#656358] hover:text-[#29261b] hover:bg-white/50'
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* Always-confirm inline warning */}
        {showAlwaysConfirm && (
          <div className="mx-6 mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex gap-2">
              <AlertTriangle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
              <p className="text-[12px] text-red-700 leading-relaxed">{t.permission.durationAlwaysConfirm}</p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 px-6 pb-6">
          <Button
            variant="outline"
            onClick={() => {
              if (showAlwaysConfirm) {
                setShowAlwaysConfirm(false);
              } else {
                onDeny();
              }
            }}
            className="flex-1 h-10 text-[14px] border-[#d5d2c9] hover:bg-[#f5f3ee]"
          >
            {showAlwaysConfirm ? t.common.cancel : t.permission.deny}
          </Button>
          <Button
            onClick={handleAllow}
            className={cn(
              'flex-1 h-10 text-[14px] text-white',
              showAlwaysConfirm
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-[#29261b] hover:bg-[#3d3929]'
            )}
          >
            {showAlwaysConfirm ? t.common.confirm : getAllowButtonText()}
          </Button>
        </div>
      </div>
    </div>
  );
}
