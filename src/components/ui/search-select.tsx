import * as React from 'react';
import { createPortal } from 'react-dom';
import { Search, Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

/**
 * Searchable dropdown select (single + multi), extending the ui/ library per
 * AGENTS.md §4.1 rather than hand-rolling pickers in feature code.
 *
 * Born from the team surfaces (task assignee, leader, member roster, skill
 * binding — user feedback 2026-08-31: "要下拉搜索列表，不要平铺"), but written
 * as a generic control: options carry an optional icon/badge for kind markers
 * (e.g. 👥 for teams vs members).
 */

export interface SearchSelectOption {
  value: string;
  label: string;
  /** Secondary line under the label (e.g. the member's duty). */
  description?: string;
  /** Leading glyph, e.g. an avatar emoji or a kind icon. */
  icon?: React.ReactNode;
  /** Small trailing kind badge, e.g. 团队. */
  badge?: string;
}

function useOutsideClose(
  open: boolean,
  refs: Array<React.RefObject<HTMLElement | null>>,
  close: () => void,
) {
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (refs.every((ref) => !ref.current || !ref.current.contains(e.target as Node))) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs array is stable per call site
  }, [open, close]);
}

/**
 * Anchor the dropdown to the trigger with fixed positioning in a portal, so
 * it can never be clipped by a dialog's overflow container (the bug this
 * replaced: absolute positioning inside DialogShell's scroll area). Flips
 * upward when the space below the trigger is too tight, and tracks scroll
 * (capture phase — dialog bodies scroll, not the window) and resize.
 */
const DROPDOWN_MAX_HEIGHT = 300;

function useAnchoredRect(open: boolean, triggerRef: React.RefObject<HTMLElement | null>) {
  const [style, setStyle] = React.useState<React.CSSProperties | null>(null);
  React.useLayoutEffect(() => {
    if (!open) { setStyle(null); return; }
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const openUp = rect.bottom + DROPDOWN_MAX_HEIGHT > window.innerHeight && rect.top > DROPDOWN_MAX_HEIGHT;
      setStyle({
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); };
  }, [open, triggerRef]);
  return style;
}

function OptionRow({ option, selected, onPick }: { option: SearchSelectOption; selected: boolean; onPick: () => void }) {
  return (
    <div
      onClick={onPick}
      className={cn(
        'flex items-center gap-2.5 px-3 py-2 cursor-pointer rounded-lg',
        selected ? 'bg-[var(--abu-bg-hover)]' : 'hover:bg-[var(--abu-bg-hover)]',
      )}
      role="option"
      aria-selected={selected}
      data-testid={`search-select-option-${option.value}`}
    >
      {option.icon && <span className="shrink-0 text-body leading-none">{option.icon}</span>}
      <div className="flex-1 min-w-0">
        <div className="text-body text-[var(--abu-text-primary)] truncate">
          {option.label}
          {option.badge && (
            <span className="ml-1.5 text-caption px-1.5 py-0.5 rounded bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)] align-middle">{option.badge}</span>
          )}
        </div>
        {option.description && <div className="text-caption text-[var(--abu-text-tertiary)] truncate">{option.description}</div>}
      </div>
      {selected && <Check className="h-4 w-4 shrink-0 text-[var(--abu-clay)]" />}
    </div>
  );
}

const Dropdown = React.forwardRef<HTMLDivElement, {
  options: SearchSelectOption[];
  isSelected: (value: string) => boolean;
  onPick: (value: string) => void;
  searchPlaceholder: string;
  emptyText: string;
  style: React.CSSProperties;
}>(function Dropdown({ options, isSelected, onPick, searchPlaceholder, emptyText, style }, ref) {
  const [query, setQuery] = React.useState('');
  const filtered = React.useMemo(() => {
    if (!query.trim()) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) || (o.description ?? '').toLowerCase().includes(q));
  }, [options, query]);
  return (
    <div ref={ref} style={style} className="z-[10001] rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] shadow-lg p-1.5" role="listbox">
      <div className="relative px-1 pb-1.5">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)] pointer-events-none" />
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className="h-8 pl-8 pr-3 text-body"
          data-testid="search-select-query"
        />
      </div>
      <div className="max-h-56 overflow-y-auto">
        {filtered.length === 0
          ? <div className="px-3 py-3 text-caption text-[var(--abu-text-tertiary)]">{emptyText}</div>
          : filtered.map((o) => <OptionRow key={o.value} option={o} selected={isSelected(o.value)} onPick={() => onPick(o.value)} />)}
      </div>
    </div>
  );
});

const triggerCls = 'w-full flex items-center gap-2 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-base)] px-3 py-2 text-left text-body hover:bg-[var(--abu-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-clay)]';

export function SearchSelect({ value, onChange, options, placeholder, searchPlaceholder, emptyText, className, testId }: {
  value: string | null;
  onChange: (value: string) => void;
  options: SearchSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useOutsideClose(open, [ref, dropdownRef], close);
  const anchorStyle = useAnchoredRect(open, ref);
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <div ref={ref} className={cn('relative', className)}>
      <button type="button" onClick={() => setOpen((v) => !v)} className={triggerCls} data-testid={testId} aria-haspopup="listbox" aria-expanded={open}>
        {selected?.icon && <span className="shrink-0 leading-none">{selected.icon}</span>}
        <span className={cn('flex-1 truncate', selected ? 'text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-tertiary)]')}>
          {selected ? selected.label : placeholder}
        </span>
        {selected?.badge && <span className="text-caption px-1.5 py-0.5 rounded bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)]">{selected.badge}</span>}
        <ChevronDown className="h-4 w-4 shrink-0 text-[var(--abu-text-tertiary)]" />
      </button>
      {open && anchorStyle && createPortal(
        <Dropdown
          ref={dropdownRef}
          style={anchorStyle}
          options={options}
          isSelected={(v) => v === value}
          onPick={(v) => { onChange(v); setOpen(false); }}
          searchPlaceholder={searchPlaceholder}
          emptyText={emptyText}
        />,
        document.body,
      )}
    </div>
  );
}

export function MultiSearchSelect({ values, onChange, options, placeholder, searchPlaceholder, emptyText, className, testId }: {
  values: string[];
  onChange: (values: string[]) => void;
  options: SearchSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);
  useOutsideClose(open, [ref, dropdownRef], close);
  const anchorStyle = useAnchoredRect(open, ref);
  const selected = values
    .map((v) => options.find((o) => o.value === v))
    .filter((o): o is SearchSelectOption => o !== undefined);
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  return (
    <div ref={ref} className={cn('relative', className)}>
      <button type="button" onClick={() => setOpen((v) => !v)} className={cn(triggerCls, 'flex-wrap min-h-[38px]')} data-testid={testId} aria-haspopup="listbox" aria-expanded={open}>
        {selected.length === 0
          ? <span className="flex-1 text-[var(--abu-text-tertiary)]">{placeholder}</span>
          : selected.map((o) => (
              <span key={o.value} className="inline-flex items-center gap-1 rounded-lg bg-[var(--abu-bg-muted)] px-2 py-0.5 text-body text-[var(--abu-text-primary)]">
                {o.icon && <span className="leading-none">{o.icon}</span>}
                {o.label}
                <X
                  className="h-3 w-3 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
                  onClick={(e) => { e.stopPropagation(); toggle(o.value); }}
                />
              </span>
            ))}
        <ChevronDown className="h-4 w-4 shrink-0 ml-auto text-[var(--abu-text-tertiary)]" />
      </button>
      {open && anchorStyle && createPortal(
        <Dropdown
          ref={dropdownRef}
          style={anchorStyle}
          options={options}
          isSelected={(v) => values.includes(v)}
          onPick={toggle}
          searchPlaceholder={searchPlaceholder}
          emptyText={emptyText}
        />,
        document.body,
      )}
    </div>
  );
}
