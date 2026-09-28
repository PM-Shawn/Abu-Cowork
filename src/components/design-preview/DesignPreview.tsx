import type { ReactNode } from 'react';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';

// Typographic specimen for the dev-only preview (verifies the CJK font stack); not UI copy.
const CJK_SPECIMEN = '设计系统：阿布正在读取 9 个文件';

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-title text-label mb-3">{title}</h2>
      {children}
    </section>
  );
}

// Developer-only page. Built only when VITE_ABU_DESIGN_PREVIEW=1 (electron:dev),
// so it never ships in a release bundle. Batch 2 adds every component here.
export function DesignPreview() {
  return (
    <div data-design-preview-root className="h-full overflow-auto bg-surface text-label p-8" data-electron-no-drag>
      <h1 className="text-title-lg mb-6">Design system preview</h1>

      <Section title="Surfaces and fills">
        <div className="grid grid-cols-4 gap-3">
          {SURFACE_TOKENS.map((name) => (
            <div key={name} className="rounded-panel shadow-panel overflow-hidden">
              <div className={`h-12 ${SURFACE_CLASS[name]}`} />
              <div className="text-ui-sm text-label-secondary px-2 py-1 font-code">{name}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Text colors">
        {TEXT_TOKENS.map((name) => (
          <p key={name} className={`text-body ${TEXT_CLASS[name]}`}>{`${name} — ${CJK_SPECIMEN}`}</p>
        ))}
        <div className="flex gap-2 mt-3">
          {SOFT_TOKENS.map((name) => (
            <span key={name} className={`text-ui-sm rounded-control px-2 py-1 ${SOFT_CLASS[name]}`}>{name}</span>
          ))}
        </div>
      </Section>

      <Section title="Type scale">
        {TYPE_TOKENS.map((name) => (
          <p key={name} className={`${name} text-label`}>{`${name} — ${CJK_SPECIMEN} · Design system 13 / 14`}</p>
        ))}
      </Section>

      <Section title="Radius and shadows">
        <div className="flex gap-4">
          {RADIUS_TOKENS.map((name) => (
            <div key={name} className={`${name} bg-fill w-24 h-16 flex items-end p-2 text-ui-sm text-label-secondary`}>{name}</div>
          ))}
          {SHADOW_TOKENS.map((name) => (
            <div key={name} className={`${name} rounded-panel bg-raised w-24 h-16 flex items-end p-2 text-ui-sm text-label-secondary`}>{name}</div>
          ))}
        </div>
      </Section>

      <Section title="Icons">
        <div className="grid grid-cols-6 gap-3">
          {Object.entries(AppIcons).map(([name, glyph]) => (
            <div key={name} className="flex items-center gap-2 text-ui text-label-secondary">
              <Icon icon={glyph} />
              <span className="font-code text-ui-sm">{name}</span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
