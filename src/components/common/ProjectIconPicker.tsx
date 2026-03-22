/**
 * Project icon system — Lucide line icons for project identification.
 * Icons are stored as string keys in project.icon field.
 */

import {
  Folder, FolderOpen, Code, FileText, BarChart3, FlaskConical,
  TrendingUp, Palette, Zap, Wrench, Package, Globe,
  Target, Mail, TestTube, Layers, Building2, BookOpen,
  Database, MessageSquare, type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Icon registry: key → Lucide component
const ICON_MAP: Record<string, LucideIcon> = {
  folder: Folder,
  'folder-open': FolderOpen,
  code: Code,
  'file-text': FileText,
  'bar-chart': BarChart3,
  flask: FlaskConical,
  'trending-up': TrendingUp,
  palette: Palette,
  zap: Zap,
  wrench: Wrench,
  package: Package,
  globe: Globe,
  target: Target,
  mail: Mail,
  'test-tube': TestTube,
  layers: Layers,
  building: Building2,
  'book-open': BookOpen,
  database: Database,
  'message-square': MessageSquare,
};

export const PROJECT_ICON_KEYS = Object.keys(ICON_MAP);
export const DEFAULT_PROJECT_ICON = 'folder';

/** Render a project icon by its string key */
export function ProjectIcon({ icon, className }: { icon?: string; className?: string }) {
  const IconComponent = ICON_MAP[icon || DEFAULT_PROJECT_ICON] || Folder;
  return <IconComponent className={cn('h-4 w-4', className)} strokeWidth={1.75} />;
}

/** Icon picker grid */
export function ProjectIconGrid({
  value,
  onChange,
}: {
  value: string;
  onChange: (icon: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PROJECT_ICON_KEYS.map((key) => {
        const Icon = ICON_MAP[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center transition-colors',
              value === key
                ? 'bg-[var(--abu-clay-bg)] ring-2 ring-[var(--abu-clay)] text-[var(--abu-clay)]'
                : 'text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]'
            )}
          >
            <Icon className="h-4 w-4" strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
