import type { PluggableList } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { remarkMath, remarkSingleDollarMath } from './mathSyntax';

/**
 * The remark plugins of every rendered reply. The streaming block splitter parses
 * with the same list, so its block boundaries are the ones the renderer sees.
 *
 * `singleTilde: false` — a lone `~` must NOT become strikethrough. Chinese
 * chat text uses `~` as a casual tone softener ("好的~", "操作了~"), and
 * remark-gfm's default (`singleTilde: true`) turns any two of them in one
 * message into a <del> span over the text between them. Require `~~` for
 * strikethrough instead.
 */
export const REMARK_PLUGINS: PluggableList = [
  [remarkGfm, { singleTilde: false }],
  remarkBreaks,
  remarkMath,
  remarkSingleDollarMath,
];
