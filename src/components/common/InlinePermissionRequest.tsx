import { AlertTriangle, FolderOpen, Terminal, FileEdit, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

export interface InlinePermissionProps {
  type: 'workspace' | 'shell' | 'file-write';
  path?: string;
  details?: string;
  onAllow: () => void;
  onDeny: () => void;
}

const iconMap = {
  workspace: FolderOpen,
  shell: Terminal,
  'file-write': FileEdit,
};

const colorMap = {
  workspace: { border: 'border-amber-200', bg: 'bg-amber-50', icon: 'text-amber-500' },
  shell: { border: 'border-orange-200', bg: 'bg-orange-50', icon: 'text-orange-500' },
  'file-write': { border: 'border-blue-200', bg: 'bg-blue-50', icon: 'text-blue-500' },
};

/**
 * InlinePermissionRequest - Shows permission requests directly in chat flow
 * Reduces modal interruptions for simple permission requests
 */
export default function InlinePermissionRequest({
  type,
  path,
  details,
  onAllow,
  onDeny,
}: InlinePermissionProps) {
  const { t } = useI18n();
  const Icon = iconMap[type];
  const colors = colorMap[type];

  // Get title based on type
  const getTitle = () => {
    switch (type) {
      case 'workspace':
        return t.permission.workspace.title;
      case 'shell':
        return t.permission.shell.title;
      case 'file-write':
        return t.permission.fileWrite.title;
    }
  };

  // Get description based on type
  const getDescription = () => {
    switch (type) {
      case 'workspace':
        return t.permission.workspace.description;
      case 'shell':
        return t.permission.shell.description;
      case 'file-write':
        return t.permission.fileWrite.description;
    }
  };

  return (
    <div
      className={cn(
        'inline-permission rounded-xl border p-4 my-3 max-w-md',
        colors.border,
        colors.bg
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={cn('p-2 rounded-lg bg-[var(--abu-bg-muted)]/80')}>
          <Icon className={cn('h-5 w-5', colors.icon)} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-[14px] font-medium text-[var(--abu-text-primary)]">{getTitle()}</h4>
          <p className="text-[13px] text-[var(--abu-text-tertiary)] mt-0.5">{getDescription()}</p>
        </div>
      </div>

      {/* Path display */}
      {path && (
        <div className="mt-3 px-3 py-2 bg-[var(--abu-bg-muted)]/60 rounded-lg">
          <p className="text-[12px] text-[var(--abu-text-tertiary)] truncate font-mono">{path}</p>
        </div>
      )}

      {/* Details */}
      {details && (
        <div className="mt-2 flex items-start gap-2 px-1">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--abu-text-tertiary)] leading-relaxed">{details}</p>
        </div>
      )}

      {/* Quick actions */}
      <div className="flex items-center gap-2 mt-4">
        <Button
          size="sm"
          onClick={onAllow}
          className="h-8 px-4 text-[13px] bg-[var(--abu-text-primary)] hover:bg-[var(--abu-text-secondary)] text-white"
        >
          <Check className="h-3.5 w-3.5 mr-1.5" />
          {t.permission.allowOnce}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onDeny}
          className="h-8 px-4 text-[13px] border-[var(--abu-border-hover)] hover:bg-[var(--abu-bg-hover)]"
        >
          <X className="h-3.5 w-3.5 mr-1.5" />
          {t.permission.deny}
        </Button>
        <span className="text-[11px] text-[var(--abu-text-muted)] ml-2">
          {t.permission.durationOnce}
        </span>
      </div>
    </div>
  );
}

/**
 * Compact inline permission for less intrusive requests
 */
export function CompactPermissionRequest({
  type,
  path,
  onAllow,
  onDeny,
}: Omit<InlinePermissionProps, 'details'>) {
  const { t } = useI18n();
  const Icon = iconMap[type];
  const colors = colorMap[type];

  const getLabel = () => {
    switch (type) {
      case 'workspace':
        return t.permission.compactAccessLabel;
      case 'shell':
        return t.permission.compactShellLabel;
      case 'file-write':
        return t.permission.compactWriteLabel;
    }
  };

  const fileName = path ? path.split(/[/\\]/).pop() : undefined;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-3 py-2 my-2',
        colors.border,
        colors.bg
      )}
    >
      <Icon className={cn('h-4 w-4', colors.icon)} />
      <span className="text-[13px] text-[var(--abu-text-primary)]">
        {getLabel()}
        {fileName && (
          <span className="font-mono ml-1 text-[var(--abu-text-tertiary)]">{fileName}</span>
        )}
        ?
      </span>
      <div className="flex items-center gap-1 ml-2">
        <button
          onClick={onAllow}
          className="p-1 rounded hover:bg-[var(--abu-bg-hover)] text-green-600 transition-colors"
          title={t.permission.allowOnce}
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={onDeny}
          className="p-1 rounded hover:bg-[var(--abu-bg-hover)] text-red-500 transition-colors"
          title={t.permission.deny}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
