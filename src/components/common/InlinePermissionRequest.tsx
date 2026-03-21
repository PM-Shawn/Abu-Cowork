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
        return t.permission.workspace?.title || '访问工作区';
      case 'shell':
        return t.permission.shell?.title || '执行命令';
      case 'file-write':
        return t.permission.fileWrite?.title || '写入文件';
    }
  };

  // Get description based on type
  const getDescription = () => {
    switch (type) {
      case 'workspace':
        return '阿布需要访问这个文件夹';
      case 'shell':
        return '阿布需要执行命令';
      case 'file-write':
        return '阿布需要修改文件';
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
        <div className={cn('p-2 rounded-lg bg-white/80')}>
          <Icon className={cn('h-5 w-5', colors.icon)} />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-[14px] font-medium text-[var(--abu-text-primary)]">{getTitle()}</h4>
          <p className="text-[13px] text-[var(--abu-text-tertiary)] mt-0.5">{getDescription()}</p>
        </div>
      </div>

      {/* Path display */}
      {path && (
        <div className="mt-3 px-3 py-2 bg-white/60 rounded-lg">
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
          允许
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onDeny}
          className="h-8 px-4 text-[13px] border-[var(--abu-border-hover)] hover:bg-white/80"
        >
          <X className="h-3.5 w-3.5 mr-1.5" />
          拒绝
        </Button>
        <span className="text-[11px] text-[var(--abu-text-muted)] ml-2">
          仅本次
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
  const Icon = iconMap[type];
  const colors = colorMap[type];

  const getLabel = () => {
    switch (type) {
      case 'workspace':
        return '访问';
      case 'shell':
        return '执行';
      case 'file-write':
        return '写入';
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
          className="p-1 rounded hover:bg-white/80 text-green-600 transition-colors"
          title="允许"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={onDeny}
          className="p-1 rounded hover:bg-white/80 text-red-500 transition-colors"
          title="拒绝"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
