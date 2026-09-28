import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Section } from './Section';
import { CJK_SPECIMEN } from './specimen';

const SURFACE_TOKENS = ['desk', 'desk-solid', 'surface', 'raised', 'material', 'code', 'field', 'fill', 'fill-hover', 'fill-selected', 'fill-pressed', 'emphasis', 'scrim', 'brand'];
const TEXT_TOKENS = ['label', 'label-secondary', 'label-tertiary', 'label-placeholder', 'link', 'success', 'warning', 'danger', 'info'];
const SOFT_TOKENS = ['success-soft', 'warning-soft', 'danger-soft', 'info-soft'];
const TYPE_TOKENS = ['text-title-lg', 'text-title', 'text-ui', 'text-ui-sm', 'text-caption', 'text-body', 'text-h1', 'text-h2', 'text-h3', 'text-mono'];
const RADIUS_TOKENS = ['rounded-window', 'rounded-panel', 'rounded-control'];
const SHADOW_TOKENS = ['shadow-panel', 'shadow-float', 'shadow-dialog'];

// Class names must be complete literals so Tailwind can generate them.
const SURFACE_CLASS: Record<string, string> = {
  desk: 'bg-desk', 'desk-solid': 'bg-desk-solid', surface: 'bg-surface', raised: 'bg-raised', material: 'bg-material',
  code: 'bg-code', field: 'bg-field', fill: 'bg-fill', 'fill-hover': 'bg-fill-hover', 'fill-selected': 'bg-fill-selected',
  'fill-pressed': 'bg-fill-pressed', emphasis: 'bg-emphasis', scrim: 'bg-scrim', brand: 'bg-brand',
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

export function TokenSection() {
  return (
    <Section id="tokens" title="Tokens">
      <div className="grid grid-cols-4 gap-3">
        {SURFACE_TOKENS.map((name) => (
          <div key={name} className="overflow-hidden rounded-panel shadow-panel">
            <div className={`h-12 ${SURFACE_CLASS[name]}`} />
            <div className="px-2 py-1 font-code text-ui-sm text-label-secondary">{name}</div>
          </div>
        ))}
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
          <p key={name} className={`${name} text-label ${name === 'text-mono' ? 'font-code' : ''}`}>{`${name} — ${CJK_SPECIMEN} · Design system 13 / 14`}</p>
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
      <div className="mt-4 grid grid-cols-6 gap-3">
        {Object.entries(AppIcons).map(([name, glyph]) => (
          <div key={name} className="flex items-center gap-2 text-ui text-label-secondary">
            <Icon icon={glyph} />
            <span className="font-code text-ui-sm">{name}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
