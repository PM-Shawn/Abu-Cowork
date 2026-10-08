import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ds/table';
import { cn } from '@/lib/utils';
import { Section } from './Section';
import { CJK_SPECIMEN } from './specimen';
import { readRootVariable, useComputedValue } from './useComputedValue';

const TEXT_TOKENS = ['label', 'label-secondary', 'label-tertiary', 'label-placeholder', 'link', 'success', 'warning', 'danger', 'info'];
const SOFT_TOKENS = ['success-soft', 'warning-soft', 'danger-soft', 'info-soft'];
const TYPE_TOKENS = ['text-title-lg', 'text-title', 'text-ui', 'text-ui-sm', 'text-caption', 'text-body', 'text-h1', 'text-h2', 'text-h3', 'text-mono', 'text-code-inline'];
const RADIUS_TOKENS = ['rounded-window', 'rounded-panel', 'rounded-control'];
const SHADOW_TOKENS = ['shadow-panel', 'shadow-float', 'shadow-dialog', 'shadow-composer'];
const ICON_SIZES = ['sm', 'md', 'lg'] as const;
// Code highlighting colors have no Tailwind class; the swatch paints the variable directly.
const SYNTAX_TOKENS = ['syntax-comment', 'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-function', 'syntax-property'];

// Every color token of tokens.css, as a swatch. Class names must be complete literals so
// Tailwind can generate them.
const COLOR_CLASS: Record<string, string> = {
  desk: 'bg-desk', 'desk-solid': 'bg-desk-solid', surface: 'bg-surface', raised: 'bg-raised',
  code: 'bg-code', 'diagram-canvas': 'bg-diagram-canvas', 'page-canvas': 'bg-page-canvas', field: 'bg-field', fill: 'bg-fill', 'fill-hover': 'bg-fill-hover', 'fill-selected': 'bg-fill-selected',
  'fill-pressed': 'bg-fill-pressed', emphasis: 'bg-emphasis', 'on-emphasis': 'bg-on-emphasis', scrim: 'bg-scrim',
  brand: 'bg-brand', 'brand-ink': 'bg-brand-ink',
  label: 'bg-label', 'label-secondary': 'bg-label-secondary', 'label-tertiary': 'bg-label-tertiary',
  'label-placeholder': 'bg-label-placeholder', link: 'bg-link',
  separator: 'bg-separator', 'control-border': 'bg-control-border', focus: 'bg-focus',
  success: 'bg-success', 'success-soft': 'bg-success-soft', warning: 'bg-warning', 'warning-soft': 'bg-warning-soft',
  danger: 'bg-danger', 'danger-soft': 'bg-danger-soft', info: 'bg-info', 'info-soft': 'bg-info-soft',
  'heat-1': 'bg-heat-1', 'heat-2': 'bg-heat-2', 'heat-3': 'bg-heat-3', 'heat-4': 'bg-heat-4',
};
const TEXT_CLASS: Record<string, string> = {
  label: 'text-label', 'label-secondary': 'text-label-secondary', 'label-tertiary': 'text-label-tertiary',
  'label-placeholder': 'text-label-placeholder', link: 'text-link', success: 'text-success', warning: 'text-warning',
  danger: 'text-danger', info: 'text-info',
};
const SOFT_CLASS: Record<string, string> = {
  'success-soft': 'bg-success-soft text-success', 'warning-soft': 'bg-warning-soft text-warning',
  'danger-soft': 'bg-danger-soft text-danger', 'info-soft': 'bg-info-soft text-info',
};

// Non-color scales, measured from a sample element that carries the class.
const SCALES: { name: string; className: string; property: string }[] = [
  { name: 'z-sticky', className: 'relative z-sticky', property: 'z-index' },
  { name: 'z-fullscreen', className: 'relative z-fullscreen', property: 'z-index' },
  { name: 'z-popover', className: 'relative z-popover', property: 'z-index' },
  { name: 'z-dialog', className: 'relative z-dialog', property: 'z-index' },
  { name: 'z-toast', className: 'relative z-toast', property: 'z-index' },
  { name: 'z-tooltip', className: 'relative z-tooltip', property: 'z-index' },
  { name: 'duration-fast', className: 'duration-fast', property: 'transition-duration' },
  { name: 'duration-base', className: 'duration-base', property: 'transition-duration' },
  { name: 'duration-slow', className: 'duration-slow', property: 'transition-duration' },
  { name: 'ease-enter', className: 'ease-enter', property: 'transition-timing-function' },
  { name: 'ease-exit', className: 'ease-exit', property: 'transition-timing-function' },
  { name: 'rounded-window', className: 'rounded-window', property: 'border-top-left-radius' },
  { name: 'rounded-panel', className: 'rounded-panel', property: 'border-top-left-radius' },
  { name: 'rounded-control', className: 'rounded-control', property: 'border-top-left-radius' },
  { name: 'shadow-panel', className: 'shadow-panel', property: 'box-shadow' },
  { name: 'shadow-float', className: 'shadow-float', property: 'box-shadow' },
  { name: 'shadow-dialog', className: 'shadow-dialog', property: 'box-shadow' },
  { name: 'shadow-composer', className: 'shadow-composer', property: 'box-shadow' },
];

function ColorSwatch({ name }: { name: string }) {
  const value = useComputedValue(() => readRootVariable(`--ds-${name}`));
  return (
    <div data-token={name} className="overflow-hidden rounded-panel shadow-panel">
      <div className={`h-12 ${COLOR_CLASS[name]}`} />
      <div className="px-2 py-1">
        <div className="font-code text-ui-sm text-label">{name}</div>
        <div data-token-value className="font-code text-caption text-label-secondary">{value}</div>
      </div>
    </div>
  );
}

function SyntaxSwatch({ name }: { name: string }) {
  const value = useComputedValue(() => readRootVariable(`--ds-${name}`));
  return (
    <div data-token={name} className="overflow-hidden rounded-panel bg-code shadow-panel">
      <div className="h-12" style={{ backgroundColor: `var(--ds-${name})` }} />
      <div className="px-2 py-1">
        <div className="font-code text-ui-sm" style={{ color: `var(--ds-${name})` }}>{name}</div>
        <div data-token-value className="font-code text-caption text-label-secondary">{value}</div>
      </div>
    </div>
  );
}

// Selection colors have no Tailwind class; each is painted over the background it sits on.
// The class names are complete literals so Tailwind can generate them.
const SELECTION_TOKENS = [
  { name: 'selection', baseClass: 'bg-surface' },
  { name: 'page-selection', baseClass: 'bg-page-canvas' },
];

function SelectionSwatch({ name, baseClass }: { name: string; baseClass: string }) {
  const value = useComputedValue(() => readRootVariable(`--ds-${name}`));
  return (
    <div data-token={name} className="overflow-hidden rounded-panel bg-surface shadow-panel">
      <div className={baseClass}>
        <div className="h-12" style={{ backgroundColor: `var(--ds-${name})` }} />
      </div>
      <div className="px-2 py-1">
        <div className="font-code text-ui-sm text-label">{name}</div>
        <div data-token-value className="font-code text-caption text-label-secondary">{value}</div>
      </div>
    </div>
  );
}

function ScaleRow({ name, className, property }: { name: string; className: string; property: string }) {
  const value = useComputedValue(() => {
    const sample = document.querySelector(`[data-scale-sample="${name}"]`);
    return sample ? getComputedStyle(sample).getPropertyValue(property) : '';
  });
  return (
    <TableRow>
      <TableCell><span className="font-code text-ui-sm">{name}</span></TableCell>
      <TableCell>
        {/* isolate keeps a sample's layer level inside this cell */}
        <span className="isolate inline-flex">
          <span data-scale-sample={name} className={cn('inline-block h-4 w-4 bg-fill', className)} />
        </span>
      </TableCell>
      <TableCell><span data-scale-value className="font-code text-ui-sm text-label-secondary">{value}</span></TableCell>
    </TableRow>
  );
}

export function TokenSection() {
  return (
    <Section id="tokens" title="Tokens">
      <div className="grid grid-cols-4 gap-3">
        {Object.keys(COLOR_CLASS).map((name) => <ColorSwatch key={name} name={name} />)}
      </div>
      <div data-preview-syntax className="mt-4">
        <p className="text-ui-sm font-medium text-label-tertiary">Code syntax</p>
        <div className="mt-2 grid grid-cols-6 gap-3">
          {SYNTAX_TOKENS.map((name) => <SyntaxSwatch key={name} name={name} />)}
        </div>
      </div>
      <div data-preview-selection className="mt-4">
        <p className="text-ui-sm font-medium text-label-tertiary">Selection</p>
        <div className="mt-2 grid grid-cols-6 gap-3">
          {SELECTION_TOKENS.map((token) => <SelectionSwatch key={token.name} {...token} />)}
        </div>
      </div>
      <div className="mt-4">
        {TEXT_TOKENS.map((name) => (
          <p key={name} className={`text-body ${TEXT_CLASS[name]}`}>{`${name} — ${CJK_SPECIMEN}`}</p>
        ))}
        <div className="mt-3 flex gap-2">
          {SOFT_TOKENS.map((name) => (
            <span key={name} className={`rounded-control px-2 py-1 text-ui-sm ${SOFT_CLASS[name]}`}>{name}</span>
          ))}
        </div>
      </div>
      <div className="mt-4">
        {TYPE_TOKENS.map((name) => (
          <p key={name} className={`${name} text-label ${name === 'text-mono' || name === 'text-code-inline' ? 'font-code' : ''}`}>{`${name} — ${CJK_SPECIMEN} · Design system 13 / 14`}</p>
        ))}
      </div>
      <div className="mt-4 flex gap-4">
        {RADIUS_TOKENS.map((name) => (
          <div key={name} className={`${name} flex h-16 w-24 items-end bg-fill p-2 text-ui-sm text-label-secondary`}>{name}</div>
        ))}
        {SHADOW_TOKENS.map((name) => (
          <div key={name} className={`${name} flex h-16 w-24 items-end rounded-panel bg-raised p-2 text-ui-sm text-label-secondary`}>{name}</div>
        ))}
      </div>
      <div className="mt-4 max-w-3xl">
        <Table label="Scales">
          <TableHeader><TableRow><TableHead>Token</TableHead><TableHead>Sample</TableHead><TableHead>Value</TableHead></TableRow></TableHeader>
          <TableBody>
            {SCALES.map((scale) => <ScaleRow key={scale.name} {...scale} />)}
          </TableBody>
        </Table>
      </div>
      <div data-preview-icons className="mt-4 grid grid-cols-4 gap-3">
        {Object.entries(AppIcons).map(([name, glyph]) => (
          <div key={name} className="flex items-center gap-2 text-ui text-label-secondary">
            {ICON_SIZES.map((size) => <Icon key={size} icon={glyph} size={size} />)}
            <span className="font-code text-ui-sm">{name}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
