import { Fragment, type ReactNode } from 'react';
import { Package } from 'lucide-react';
import ToolCard from '@/components/toolbox/ToolCard';

export interface MarketplaceEntryRowProps {
  /** Plugin name. Also set as `title` so a truncated row stays readable on hover. */
  name: string;
  onClick?: () => void;
  /** Free text under the title line, clamped to two lines. */
  description?: ReactNode;
  /**
   * Status/category chips rendered on the title line, right after the name.
   * Purely presentational nodes — the row never interprets them, so a caller
   * can pass a category, a version, a signature warning, anything. Keys are
   * supplied here so callers can build a plain array.
   */
  chips?: ReactNode[];
  /** Optional last line, e.g. 「N 个技能 · M 个连接器 · 最新 vX」. */
  meta?: ReactNode;
  /** Optional leading adornment (icon / avatar). */
  icon?: ReactNode;
  /** Right-hand action area — a button, a `···` menu, or both. */
  actions?: ReactNode;
  /** `data-testid` of the row root. */
  testId?: string;
  /** `data-testid` of the name element. */
  nameTestId?: string;
}

/** Compatibility adapter: plugin catalogs use the same released ToolCard as skills and connectors. */
export default function MarketplaceEntryRow({
  name, description, chips, meta, icon, actions, testId, nameTestId, onClick,
}: MarketplaceEntryRowProps) {
  return (
    <div data-testid={testId} className="h-full">
      <ToolCard onClick={onClick} item={{
        id: name,
        name,
        nameTestId,
        avatar: icon ?? <Package className="h-6 w-6 text-[var(--abu-text-muted)]" />,

        toggle: actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>,
        description,
        footer: (chips?.some(Boolean) || meta) ? <>
          {chips && <div className="flex flex-wrap items-center gap-1">{chips.map((chip, i) => <Fragment key={i}>{chip}</Fragment>)}</div>}
          {meta && <div className="mt-1">{meta}</div>}
        </> : undefined,
      }} />
    </div>
  );
}
