// Order of the preview page; the visual regression spec screenshots each one.
export const PREVIEW_SECTIONS = ['tokens', 'basics', 'forms', 'overlays', 'containers', 'feedback', 'motion'] as const;
export type PreviewSectionId = (typeof PREVIEW_SECTIONS)[number];
