import { useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

// Loaded on first use (React.lazy in MarkdownRenderer), so KaTeX's script, style
// sheet and fonts stay out of the first-screen bundle.

/**
 * TeX rendered by KaTeX. TeX that does not parse is shown as its source in the
 * secondary label color: the formula came from the model, so an error there is
 * the model's, never the app's.
 */
export default function MathFormula({ tex, display }: { tex: string; display: boolean }) {
  const html = useMemo(
    () => katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      errorColor: 'var(--ds-label-secondary)',
    }),
    [tex, display],
  );
  if (display) {
    return <div className="my-3 max-w-full overflow-x-auto overflow-y-hidden" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
