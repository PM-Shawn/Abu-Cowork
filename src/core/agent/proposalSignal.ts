/**
 * Post-loop skill-proposal signal (self-evolution trigger).
 *
 * Module F's SKILLS_GUIDANCE prompt tells the agent "consider saving this as
 * a skill after a 5+ tool-call task". In practice LLMs under-propose without
 * a runtime nudge — they're trained to be cautious about side-effecting
 * actions like file writes. This module provides that nudge.
 *
 * Flow:
 *   1. Agent loop completes → computeProposalSignal inspects the loop's
 *      messages, counts tool calls, checks for errors / skill usage /
 *      already-proposed, and decides if this was a "sink-worthy" task.
 *   2. If yes, stash the signal on the conversation (ephemeral, not
 *      persisted). If no, do nothing.
 *   3. Next turn's system prompt builder reads the signal, injects a
 *      one-shot <consider_sinking> section, then clears it.
 *
 * Thresholds differ by proactivity preset:
 *   - shy      → never fire (agent shouldn't self-propose)
 *   - companion → ≥5 tool calls, no errors, no existing skill matched
 *   - butler   → ≥3 tool calls, same guards
 *
 * Signal is intentionally single-shot: once the nudge is delivered it goes
 * away. We never accumulate or stack — avoids annoying-agent-with-repeated-
 * nudges and keeps the mental model simple.
 */

import type { Message } from '../../types';
import type { ProactivityLevel } from './prompts/skillsGuidance';
import { isDisplayHiddenStepBackedTool } from '../tools/toolNames';

export interface ProposalSignal {
  /** When the signal was computed (ms). */
  computedAt: number;
  /** Total real tool calls in the loop (excludes report_plan; includes
   *  display-hidden step-backed tools like show_widget). */
  toolCallCount: number;
  /** True if any tool call in the loop returned an error. */
  hadErrors: boolean;
  /** True if the loop activated any existing skill via use_skill. */
  usedSkill: boolean;
  /** Proactivity level that was active when the signal was computed. */
  triggerLevel: ProactivityLevel;
}

/** Per-proactivity threshold for the signal to fire. */
const MIN_TOOL_CALLS: Record<ProactivityLevel, number> = {
  shy: Infinity,     // never triggers
  companion: 5,
  butler: 3,
};

/** Tool names that mean the agent already proposed in this loop — skip. */
const SKILL_CREATE_TOOL = 'skill_manage';

/**
 * Inspect the messages produced in a single agent loop and decide whether
 * to raise a proposal signal. Returns `null` when the loop doesn't warrant
 * a nudge, a signal object otherwise.
 *
 * `loopMessages` must be the subset of conversation.messages belonging to
 * this loopId — caller filters. Avoids leaking prior-loop context.
 */
export function computeProposalSignal(
  loopMessages: Message[],
  proactivity: ProactivityLevel,
): ProposalSignal | null {
  if (proactivity === 'shy') return null;

  // Flatten the loop's real tool work. `hidden` normally means "not real
  // work shown to the user" (report_plan), but display-hidden step-backed
  // tools (show_widget) ARE real work — a visualization-heavy loop must
  // still count toward the threshold and surface its errors.
  const toolCalls = loopMessages
    .flatMap((m) => m.toolCalls ?? [])
    .filter((tc) => !tc.hidden || isDisplayHiddenStepBackedTool(tc.name));

  const toolCallCount = toolCalls.length;
  if (toolCallCount < MIN_TOOL_CALLS[proactivity]) return null;

  const hadErrors = toolCalls.some((tc) => tc.isError === true);
  if (hadErrors) return null;

  // Skill usage: detect either `use_skill` calls or existing-skill metadata
  // on the message. The `message.skill` field is set by orchestrator when
  // the loop was spawned under an active skill.
  const usedSkill =
    toolCalls.some((tc) => tc.name === 'use_skill') ||
    loopMessages.some((m) => m.skill != null);

  // If the agent already proposed in this very loop (skill_manage with
  // agent_proposed=true), skip — we don't want to double-nudge next turn.
  const alreadyProposed = toolCalls.some(
    (tc) =>
      tc.name === SKILL_CREATE_TOOL &&
      tc.input?.action === 'create' &&
      tc.input?.agent_proposed === true,
  );
  if (alreadyProposed) return null;

  return {
    computedAt: Date.now(),
    toolCallCount,
    hadErrors,
    usedSkill,
    triggerLevel: proactivity,
  };
}

/**
 * Render the signal as a system prompt section. Caller is responsible for
 * clearing the signal from the conversation after injection (single-shot).
 */
export function renderProposalSignalSection(signal: ProposalSignal): string {
  const skillNote = signal.usedSkill
    ? '（本轮用过已有 skill — 如果要沉淀的是新模式而非重复调用同一 skill，才考虑 create）'
    : '';
  return [
    '## 上一轮动作回顾',
    `刚完成了 ${signal.toolCallCount} 步工具调用，无错误${skillNote}。`,
    '',
    '如果这次流程**值得复用**（以后可能再做同类任务），考虑调用',
    "`skill_manage(action='create', agent_proposed=true, trigger_reason='一句话说明')`",
    '把经验沉淀成 skill 草稿——用户会在对话里看到提议卡片审核，采纳后下次自动可用。',
    '',
    '**不要调**的情况：',
    '- 一次性操作（"帮我找一下这个文件"这种随手问的）',
    '- 流程高度依赖本次具体参数，不能泛化',
    '- 已有相近 skill 覆盖该场景',
    '',
    '只有明确判断"值得"才调；不确定就别调，让用户主动提出。',
  ].join('\n');
}
