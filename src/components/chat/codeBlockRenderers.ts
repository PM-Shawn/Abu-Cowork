/**
 * Code Block Renderer Registry
 *
 * Decouples MarkdownRenderer from specific visualization libraries.
 * To add a new renderable code block type:
 * 1. Create a renderer component (e.g. MyBlock.tsx) with props { code: string }
 * 2. Register it here with registerCodeBlockRenderer('language', ...)
 * 3. Create a corresponding skill in builtin-skills/ to guide LLM output
 *
 * MarkdownRenderer will automatically pick it up — no changes needed there.
 */
import { lazy, type ComponentType } from 'react';

export interface CodeBlockRenderer {
  /** Lazy-loaded component that renders the code block */
  component: React.LazyExoticComponent<ComponentType<{ code: string }>>;
}

const registry = new Map<string, CodeBlockRenderer>();

/**
 * Register a code block renderer for a specific language.
 * The component should accept { code: string } props.
 */
export function registerCodeBlockRenderer(
  language: string,
  component: React.LazyExoticComponent<ComponentType<{ code: string }>>,
) {
  registry.set(language, { component });
}

/** Look up a renderer for a code block language */
export function getCodeBlockRenderer(language: string): CodeBlockRenderer | undefined {
  return registry.get(language);
}

// --- Built-in registrations ---

registerCodeBlockRenderer(
  'mermaid',
  lazy(() => import('./MermaidBlock')),
);

registerCodeBlockRenderer(
  'infographic',
  lazy(() => import('./InfographicBlock')),
);

registerCodeBlockRenderer(
  'html',
  lazy(() => import('./HtmlWidgetBlock')),
);
