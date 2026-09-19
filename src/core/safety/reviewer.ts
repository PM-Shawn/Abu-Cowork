/**
 * AI reviewer for the "smart" permission tier.
 *
 * When an action would normally prompt the user (an escalation: out-of-workspace
 * write, dangerous command), the reviewer grades its risk against the user's
 * intent and either allows it, escalates to the user, or denies it. Mirrors
 * Codex auto-review: deny critical, escalate high, allow low/medium. Runs on the
 * user's main model (same approach as Codex's reviewer agent).
 *
 * Safety: the reviewer only operates within the "would have asked the user"
 * space — block-level commands, sensitive-path hard-blocks and the content guard
 * are enforced independently and never reach here. On any failure
 * (timeout / unparseable / abort) it escalates to the user, never silently allows.
 */

import { llmCall } from '../llm/llmCall';
import { useChatStore } from '../../stores/chatStore';

export type ReviewRisk = 'low' | 'medium' | 'high' | 'critical';
export type ReviewDecision = 'allow' | 'escalate' | 'deny';

export interface ReviewContext {
  kind: 'command' | 'file-write' | 'file-read';
  /** The command text or file path under review. */
  detail: string;
  /** Static-analysis hint (danger reason, "writes outside workspace", etc.). */
  staticReason: string;
  /** Active conversation id — used to pull the user's recent intent. */
  conversationId?: string;
}

export interface ReviewVerdict {
  risk: ReviewRisk;
  decision: ReviewDecision;
  reason: string;
}

const REVIEW_TIMEOUT_MS = 15_000;
const INTENT_MAX_CHARS = 500;

/** Risk → decision: deny critical, escalate high, allow low/medium. */
function mapRiskToDecision(risk: ReviewRisk): ReviewDecision {
  if (risk === 'critical') return 'deny';
  if (risk === 'high') return 'escalate';
  return 'allow';
}

/** Pull the most recent user-message text from the active conversation. */
function recentUserIntent(conversationId?: string): string {
  if (!conversationId) return '';
  const conv = useChatStore.getState().conversations[conversationId];
  if (!conv) return '';
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== 'user') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ');
    return text.trim().slice(0, INTENT_MAX_CHARS);
  }
  return '';
}

const KIND_LABEL: Record<ReviewContext['kind'], string> = {
  command: '执行命令',
  'file-write': '写入文件',
  'file-read': '读取文件',
};

const SYSTEM_PROMPT = `你是 Abu 的操作安全审核员。Abu 是本地 AI 办公助手，正代用户执行任务。
你的唯一职责：判断某个"越界操作"（超出工作区或含潜在危险）应当放行到何种程度。
综合考虑：用户真实意图、操作影响、是否存在数据窃取/凭证泄露/不可逆破坏/与意图明显不符的迹象。
风险分四级：
- low / medium：与意图一致、影响可控
- high：高风险但可能合理，需用户定夺
- critical：数据窃取、凭证探测、不可逆破坏，或明显与用户意图不符
只输出一行 JSON，不要任何额外文字：{"risk":"low|medium|high|critical","reason":"简短中文理由"}`;

function buildUserMessage(ctx: ReviewContext, intent: string): string {
  return `用户最近意图：${intent || '（未知）'}
操作类型：${KIND_LABEL[ctx.kind]}
操作内容：${ctx.detail}
静态分析提示：${ctx.staticReason || '无'}
请判断风险并按要求输出 JSON。`;
}

/** Map an English-or-Chinese risk token to the canonical enum. */
function normalizeRisk(v: unknown): ReviewRisk | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'low' || s === 'medium' || s === 'high' || s === 'critical') return s;
  if (/严重|危急|极高/.test(s)) return 'critical';
  if (/高/.test(s)) return 'high';
  if (/中/.test(s)) return 'medium';
  if (/低|安全/.test(s)) return 'low';
  return null;
}

/** Last-resort: scan free text for a risk signal (severe wins). */
function scanRiskKeyword(text: string): ReviewRisk | null {
  const t = text.toLowerCase();
  if (/\bcritical\b|严重|危急/.test(t)) return 'critical';
  if (/\bhigh\b|高风险|高危/.test(t)) return 'high';
  if (/\bmedium\b|中风险|中等/.test(t)) return 'medium';
  if (/\blow\b|低风险|低危|风险低/.test(t)) return 'low';
  return null;
}

/**
 * Parse a verdict from the model's (often messy) output. Handles reasoning
 * preambles, markdown code fences and full-width CJK punctuation. Falls back to
 * a keyword scan, then to a conservative escalate that surfaces a raw snippet
 * for diagnosis.
 */
function parseVerdict(text: string): ReviewVerdict {
  // Empty content — common with reasoning models when the token budget is spent
  // on thinking (see project_reasoning_model_starvation). Escalate cleanly.
  if (!text.trim()) {
    return { risk: 'high', decision: 'escalate', reason: '审核服务未返回内容，转人工确认' };
  }

  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*/gi, '')
    .replace(/```/g, '');

  // Prefer flat JSON objects (no nested braces); try the last one first.
  const objs = cleaned.match(/\{[^{}]*\}/g);
  if (objs) {
    for (let i = objs.length - 1; i >= 0; i--) {
      const normalized = objs[i]
        .replace(/，/g, ',')
        .replace(/：/g, ':')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'");
      try {
        const parsed = JSON.parse(normalized) as { risk?: unknown; reason?: unknown };
        const risk = normalizeRisk(parsed.risk);
        if (risk) {
          const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
          return { risk, decision: mapRiskToDecision(risk), reason };
        }
      } catch {
        // try the previous candidate
      }
    }
  }

  // Fallback: keyword scan over the whole response.
  const kw = scanRiskKeyword(cleaned);
  if (kw) {
    return { risk: kw, decision: mapRiskToDecision(kw), reason: cleaned.trim().slice(0, 100) || '（无理由）' };
  }

  // Total failure → escalate. Log raw output for debugging; keep the UI message clean.
  console.warn('[reviewer] unparseable verdict:', text.slice(0, 300));
  return { risk: 'high', decision: 'escalate', reason: '审核结果无法解析，转人工确认' };
}

/**
 * Grade an escalating action. Always resolves — on timeout/abort/error it
 * returns an 'escalate' verdict so the caller falls back to a human prompt.
 */
export async function reviewAction(ctx: ReviewContext, signal?: AbortSignal): Promise<ReviewVerdict> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const { text } = await llmCall({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(ctx, recentUserIntent(ctx.conversationId)) }],
      maxTokens: 200,
      signal: controller.signal,
      conversationId: ctx.conversationId,
    });
    return parseVerdict(text);
  } catch {
    return { risk: 'high', decision: 'escalate', reason: '审核未完成，转人工确认' };
  } finally {
    clearTimeout(timer);
  }
}
