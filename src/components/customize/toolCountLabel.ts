import { format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';

/**
 * "N tools", or "N tools (M app-only)" when the server really has app-only
 * tools (`_meta.ui.visibility` without `'model'`).
 *
 * The second half is shown only when M > 0: "3 tools (0 app-only)" would
 * invent an empty category on every ordinary connector. `toolCount` keeps its
 * meaning — the model-visible tools — so the two numbers do not overlap.
 *
 * Its own module rather than a named export from `MCPSection`: that file only
 * exports components (react-refresh).
 */
export function toolCountLabel(
  t: TranslationDict,
  toolCount: number | undefined,
  appToolCount: number | undefined,
): string {
  const count = toolCount ?? 0;
  const app = appToolCount ?? 0;
  return app > 0
    ? format(t.toolbox.toolCountWithApp, { count, app })
    : format(t.toolbox.toolCount, { count });
}
