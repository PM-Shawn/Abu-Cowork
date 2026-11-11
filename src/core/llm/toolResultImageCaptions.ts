import type { ToolResultContent } from '../../types';

/**
 * How a tool says what one of its result images is, and how a provider that
 * receives those images apart from the tool results introduces them.
 *
 * OpenAI-compatible and Ollama chat accept images only in user messages, so a
 * turn's tool-result images arrive after all of its tool results. Without a
 * caption the model cannot tell which image came from which call: three page
 * renders and a zoomed region are four anonymous pictures. Each image is
 * therefore introduced by the call that produced it and by its label.
 *
 * The label convention, written and read only here: a tool labels an image
 * with one text block, a single line in square brackets, placed right before
 * the image in its result (`[Page 18 of contract.pdf, region …]`). The block is
 * part of the result, so the Claude route, which keeps results as they are,
 * and a conversation opened again, which keeps the stored result, both show
 * the model the same label with no extra bookkeeping. A text block of any
 * other shape before an image is not a label: nothing is guessed from it.
 */

/** The text block that labels the image placed right after it. */
export function imageLabelBlock(label: string): ToolResultContent {
  return { type: 'text', text: `[${label.replace(/\s*\n\s*/g, ' ').trim()}]` };
}

/** The label of the image that follows `previous`, if `previous` is a label block. */
export function imageLabel(previous: ToolResultContent | undefined): string | undefined {
  if (previous?.type !== 'text') return undefined;
  const match = /^\[([^\n]+)\]$/.exec(previous.text);
  const label = match?.[1].trim();
  return label || undefined;
}

/** Sent once before the images of a turn when every one of them carries a label: pages, pictures and views a tool chose to show. LLM-facing, so English. */
export const TOOL_RESULT_IMAGES_INTRO =
  '[Tool result images] The images below come from the tool results above; each is introduced by the call that produced it. '
  + 'Base your next step on what they show. If an image cannot be seen or read, say so instead of guessing what it shows.';

/** Sent once before the images of a turn when any of them has no label: screenshots (computer use, browser). LLM-facing, so English. */
export const TOOL_RESULT_SCREENSHOTS_NOTE =
  '[SCREENSHOT] Tool results produced these screenshot(s). You MUST describe what you actually see in the image before deciding next action. If you cannot see the image, say "I cannot see the screenshot" — do NOT guess or fabricate what is on screen.';

/** "[Image 2 of 3, from read_file (call call_1_0): Page 18 of contract.pdf, whole page]" */
export function toolResultImageCaption(
  call: { name: string; id: string },
  label: string | undefined,
  position: number,
  total: number,
): string {
  return `[Image ${position} of ${total}, from ${call.name} (call ${call.id})${label ? `: ${label}` : ''}]`;
}

interface CallWithImages<I> { name: string; id: string; resultImages: readonly I[] }

/** Every image of a turn's tool calls, in order, with its caption and the note that goes before them all. */
export function captionedToolResultImages<I extends { label?: string }>(
  calls: ReadonlyArray<CallWithImages<I>>,
): { note: string; images: Array<{ caption: string; image: I }> } {
  const total = calls.reduce((count, call) => count + call.resultImages.length, 0);
  const images: Array<{ caption: string; image: I }> = [];
  for (const call of calls) {
    for (const image of call.resultImages) {
      images.push({ caption: toolResultImageCaption(call, image.label, images.length + 1, total), image });
    }
  }
  const labeled = images.length > 0 && images.every(({ image }) => image.label);
  return { note: labeled ? TOOL_RESULT_IMAGES_INTRO : TOOL_RESULT_SCREENSHOTS_NOTE, images };
}
