import type { ReactNode } from 'react';
import type { PreviewSectionId } from './sectionIds';

export function Section({ id, title, children }: { id: PreviewSectionId; title: string; children: ReactNode }) {
  return (
    <section data-preview-section={id} className="mb-8">
      <h2 className="mb-3 text-title text-label">{title}</h2>
      {children}
    </section>
  );
}
