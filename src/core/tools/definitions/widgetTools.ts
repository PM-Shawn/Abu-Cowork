/**
 * show_widget / read_me — explicit-tool-call inline visualization.
 *
 * Replaces the old "output a ```html fence in prose" convention (still
 * rendered for backward compatibility — see codeBlockRenderers.ts — but no
 * longer instructed by the system prompt for tool-capable models; models
 * with supportsTools=false keep the fence instruction, see agentLoop's
 * VISUAL_OUTPUT_FENCE_VARIANT) with an explicit tool call, aligned with
 * WorkBuddy's `show_widget`, ChatGPT's `visualize`, and TRAE's `ShowWidget`.
 *
 * Rendering split: this module only validates and confirms — it never
 * renders anything itself. The chat UI (ShowWidgetCard.tsx) reads
 * title/widget_code/loading_messages straight off the tool call's `input`
 * (available as soon as the tool_use event streams in, same as
 * report_plan/parsePlanSteps), NOT off the execute() result string. That
 * keeps the transcript result short — the model must not see widget_code
 * echoed back on every subsequent turn.
 *
 * Validation failures THROW (like askUserQuestionTool). Note the throw is
 * for the MODEL's benefit only: toolRegistry.execute catches it and returns
 * an `Error executing tool "show_widget": …` string (error flag stays
 * false, so ToolCall.isError is NOT set). The UI therefore never trusts the
 * result to decide validity — ShowWidgetCard re-runs `validateWidgetCode`
 * (the same pure check) on the input before mounting the renderer.
 */
import type { ToolDefinition } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { getWidgetGuidelines, WIDGET_GUIDELINE_MODULES } from '../../widget/guidelines';

/**
 * Machine-readable success marker prepended to show_widget's execute()
 * result. ShowWidgetCard's success detection is POSITIVE: only a result
 * carrying this marker (or the pending/stale-undefined states) mounts the
 * widget — any other defined result (param-error strings, policy denials,
 * cancel backfills in either locale) falls to a muted status row. The
 * localized human text follows the marker so raw result rendering still
 * reads fine. Deliberately NOT i18n — it's a protocol constant, not copy.
 */
export const SHOW_WIDGET_OK_MARKER = '[widget:ok] ';

/** A widget fragment's render target — inline SVG or a general HTML fragment. */
export type WidgetRenderMode = 'svg' | 'html';

/** Single source for render-mode detection — shared by the tool (documentation
 *  only) and the chat UI (ShowWidgetCard.tsx), so the two never drift. */
export function detectWidgetRenderMode(widgetCode: string): WidgetRenderMode {
  return widgetCode.trim().toLowerCase().startsWith('<svg') ? 'svg' : 'html';
}

// ---------------------------------------------------------------------------
// widget_code validation — pure, shared by execute() and the chat UI
// ---------------------------------------------------------------------------

/** Size budget for a widget fragment (the guidelines' "~1MB"). Inputs are
 *  persisted un-offloaded with the conversation and re-sent in history every
 *  turn, so an unbounded fragment is a context/storage hazard. */
export const MAX_WIDGET_CODE_LENGTH = 1_000_000;

// Document-wrapper tags a fragment must not contain — the tool contract
// requires a raw fragment even though HtmlWidgetBlock's renderer would
// tolerate a full document (the fence-fallback path leans on that
// tolerance for weaker/BYO models; the tool contract is stricter on
// purpose so models using the explicit tool learn fragment discipline).
const DOCUMENT_WRAPPER_RE = /<(!DOCTYPE|html|head|body)\b/i;
const STORAGE_API_RE = /\b(localStorage|sessionStorage)\b/;
// position:fixed breaks the auto-height iframe — catch the CSS-text form
// plus the two JS assignment forms (el.style.position = 'fixed' and
// style.setProperty('position', 'fixed')).
const POSITION_FIXED_CSS_RE = /position\s*:\s*fixed/i;
const POSITION_FIXED_STYLE_ASSIGN_RE = /\.style\.position\s*=\s*['"]fixed['"]/i;
const POSITION_FIXED_SET_PROPERTY_RE = /setProperty\(\s*['"]position['"]\s*,\s*['"]fixed['"]/i;
const FORM_ELEMENT_RE = /<form[\s>]/i;

/** Machine-readable widget_code violation — mapped to localized messages by
 *  execute() and to the error row by ShowWidgetCard. */
export type WidgetCodeViolation =
  | 'empty'
  | 'too-large'
  | 'document'
  | 'storage'
  | 'position-fixed'
  | 'form';

/**
 * Validate a widget_code fragment against the hard rules. Pure — no i18n,
 * no store access — so the chat UI can gate rendering with the exact same
 * check the tool enforces (results like '[已取消]' come back with the error
 * flag unset, so the UI cannot rely on execute() having accepted the code).
 */
export function validateWidgetCode(code: unknown): WidgetCodeViolation | null {
  if (typeof code !== 'string' || code.trim() === '') return 'empty';
  if (code.length > MAX_WIDGET_CODE_LENGTH) return 'too-large';
  if (DOCUMENT_WRAPPER_RE.test(code)) return 'document';
  if (STORAGE_API_RE.test(code)) return 'storage';
  if (
    POSITION_FIXED_CSS_RE.test(code) ||
    POSITION_FIXED_STYLE_ASSIGN_RE.test(code) ||
    POSITION_FIXED_SET_PROPERTY_RE.test(code)
  ) {
    return 'position-fixed';
  }
  if (FORM_ELEMENT_RE.test(code)) return 'form';
  return null;
}

/**
 * Sanitize a model-supplied widget title into a safe download filename stem
 * (RenderableCodeBlock uses the label as the save-dialog defaultPath).
 * WorkBuddy-style: keep Unicode letters/digits, convert spaces/hyphens to
 * underscore, strip everything else; fallback 'widget'.
 */
export function sanitizeWidgetTitle(title: string | undefined): string {
  if (!title) return 'widget';
  const sanitized = title
    .replace(/[\s-]+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || 'widget';
}

export const showWidgetTool: ToolDefinition = {
  name: TOOL_NAMES.SHOW_WIDGET,
  description:
    'Show visual content — an SVG graphic, diagram, chart, or interactive HTML widget — rendered inline in the conversation alongside your text.' +
    ' Pass a raw HTML/SVG fragment, not a full document.' +
    ' This is for in-conversation visuals that live with the message; for a standalone deliverable file use write_file instead.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short disambiguating identifier for this widget. Also used as the download filename.',
      },
      widget_code: {
        type: 'string',
        description: 'Raw SVG or HTML fragment — no <!DOCTYPE>, <html>, <head>, or <body> wrapper tags.',
      },
      loading_messages: {
        type: 'array',
        items: { type: 'string' },
        description: '1-4 short strings shown as skeleton captions while the widget renders. Write them in the user\'s conversation language.',
      },
    },
    required: ['title', 'widget_code', 'loading_messages'],
  },
  execute: async (input) => {
    const t = getI18n().toolResult.widget;
    const title = input.title as string;
    const widgetCode = input.widget_code as string;
    const loadingMessages = input.loading_messages as unknown[];

    if (typeof title !== 'string' || title.trim() === '') {
      throw new Error(t.errTitleEmpty);
    }
    if (!Array.isArray(loadingMessages) || loadingMessages.length < 1 || loadingMessages.length > 4) {
      throw new Error(
        format(t.errLoadingMessagesLength, {
          received: Array.isArray(loadingMessages) ? String(loadingMessages.length) : typeof loadingMessages,
        }),
      );
    }
    for (let i = 0; i < loadingMessages.length; i++) {
      const m = loadingMessages[i];
      if (typeof m !== 'string' || m.trim() === '') {
        throw new Error(format(t.errLoadingMessageEntry, { idx: String(i) }));
      }
    }

    const violation = validateWidgetCode(widgetCode);
    if (violation) {
      const messageByViolation: Record<WidgetCodeViolation, string> = {
        'empty': t.errWidgetCodeEmpty,
        'too-large': t.errWidgetCodeTooLarge,
        'document': t.errFullDocument,
        'storage': t.errStorageApi,
        'position-fixed': t.errPositionFixed,
        'form': t.errFormElement,
      };
      throw new Error(messageByViolation[violation]);
    }

    // Short confirmation only — widget_code is NOT echoed back into the
    // transcript. The chat UI reads it straight off this tool call's input;
    // the leading marker is its positive success signal (see its docstring).
    return SHOW_WIDGET_OK_MARKER + format(t.rendered, { title });
  },
  // Renders inline, mutates nothing on disk — same read-only classification
  // as ask_user_question / report_plan (also parallel-safe, no shared state).
  isConcurrencySafe: true,
};

export const readMeTool: ToolDefinition = {
  name: TOOL_NAMES.READ_ME,
  description:
    'Load the widget design guidelines before your first show_widget call in a conversation. Returns authoritative styling and structure rules. Do not narrate this call to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      modules: {
        type: 'array',
        items: { type: 'string', enum: [...WIDGET_GUIDELINE_MODULES] },
        description: `Optional subset of guideline modules to load: ${WIDGET_GUIDELINE_MODULES.join(', ')}. Defaults to all.`,
      },
    },
    required: [],
  },
  execute: async (input) => {
    // Pass the raw names through — getWidgetGuidelines owns the documented
    // unknown-name behavior (unknown-only filter → hard rules only). A
    // membership pre-filter here would turn a typo like ['charts'] into []
    // and accidentally load ALL modules instead.
    const modules = Array.isArray(input.modules)
      ? (input.modules as unknown[]).filter((m): m is string => typeof m === 'string')
      : undefined;
    return getWidgetGuidelines(modules);
  },
  isConcurrencySafe: true,
};
