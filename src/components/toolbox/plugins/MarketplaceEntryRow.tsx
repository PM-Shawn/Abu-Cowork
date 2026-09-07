import { Fragment, type ReactNode } from 'react';

export interface MarketplaceEntryRowProps {
  /** Plugin name. Also set as `title` so a truncated row stays readable on hover. */
  name: string;
  /** Free text under the title line, clamped to two lines. */
  description?: string;
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

/**
 * One full-width marketplace row: name + chips on the title line, description
 * below, an optional meta line, and the actions on the right.
 *
 * Presentational only — no store, no i18n, no install logic — so both the OSS
 * 插件 市场 (`MarketplaceBrowser`) and the enterprise organization catalog can
 * render the same row while each keeps its own chips and its own actions.
 *
 * **The title line is a width negotiation, and it has gone wrong before.** The
 * organization catalog used to render as ~240px cards where the name was the
 * only flexible item between two `shrink-0` groups; once the chips and the
 * action filled the row the name was laid out at exactly 0px — present in the
 * DOM with its full text, invisible on screen and `hidden` to Playwright (see
 * `ToolCard.test.tsx`). The mechanism here makes that unrepresentable:
 *
 *   - the title line is `flex-wrap`, so chips that do not fit beside the name
 *     move to a second line instead of eating the name's width;
 *   - the name keeps `flex-basis: auto` (NOT `flex-1`, whose 0% basis would
 *     stop it from ever forcing that wrap), so the full name is what claims
 *     the line;
 *   - `min-w-0 truncate` then applies only when the name ALONE is wider than
 *     the row, which is the one case where truncating is the right answer —
 *     and `title` keeps it readable.
 */
export default function MarketplaceEntryRow({
  name,
  description,
  chips,
  meta,
  icon,
  actions,
  testId,
  nameTestId,
}: MarketplaceEntryRowProps) {
  return (
    <div
      data-testid={testId}
      className="flex items-start gap-3 rounded-lg border border-[var(--abu-border)] px-3 py-2.5"
    >
      {icon && <div className="flex shrink-0 items-center">{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid={nameTestId}
            title={name}
            className="min-w-0 truncate text-h-xs text-[var(--abu-text-primary)]"
          >
            {name}
          </span>
          {chips?.map((chip, i) => <Fragment key={i}>{chip}</Fragment>)}
        </div>
        {description && (
          <p className="mt-0.5 line-clamp-2 text-minor text-[var(--abu-text-tertiary)]">
            {description}
          </p>
        )}
        {meta && <p className="mt-0.5 text-minor text-[var(--abu-text-muted)]">{meta}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
