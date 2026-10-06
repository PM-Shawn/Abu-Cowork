import type { ToolDefinition } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, format } from '../../../i18n';
import { useChatStore } from '../../../stores/chatStore';
import { checkGoalAuthority, type GoalAuthorityDenial, type GoalToolAction } from '../../goal/goalAuthority';
import {
  blockConversationGoal,
  completeConversationGoal,
  createConversationGoal,
  editConversationGoal,
  getGoal,
  isGoalDrivingConversation,
  pauseConversationGoal,
  resumeConversationGoal,
} from '../../goal/goalService';
import type { GoalTransitionResult } from '../../goal/goalTransitions';
import { GOAL_BLOCK_AFTER_ROUNDS, goalRef, type GoalPhase } from '../../goal/goalTypes';

const ACTIONS: readonly GoalToolAction[] = ['get', 'create', 'edit', 'pause', 'resume', 'complete', 'block'];

function phaseLabel(phase: GoalPhase): string {
  const t = getI18n().toolResult.goal;
  switch (phase) {
    case 'active': return t.phaseActive;
    case 'paused': return t.phasePaused;
    case 'blocked': return t.phaseBlocked;
    case 'complete': return t.phaseComplete;
  }
}

function denialMessage(denial: GoalAuthorityDenial, rounds: number): string {
  const t = getI18n().toolResult.goal;
  switch (denial) {
    case 'subagent': return t.deniedSubagent;
    case 'automated-conversation': return t.deniedAutomated;
    case 'needs-human-turn': return t.deniedNeedsHuman;
    case 'block-too-early': return format(t.deniedBlockTooEarly, { min: GOAL_BLOCK_AFTER_ROUNDS, rounds });
  }
}

function transitionError(result: Extract<GoalTransitionResult, { ok: false }>): string {
  const t = getI18n().toolResult.goal;
  switch (result.error) {
    case 'no-goal': return t.noGoal;
    case 'stale-revision': return t.staleRevision;
    case 'empty-objective': return t.missingObjective;
    case 'missing-evidence': return t.missingEvidence;
    case 'rounds-exhausted':
    case 'invalid-transition':
      return format(t.invalidTransition, { phase: result.phase ? phaseLabel(result.phase) : '' });
  }
}

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === 'string' ? value : '';
}

export const manageGoalTool: ToolDefinition = {
  name: TOOL_NAMES.MANAGE_GOAL,
  description: [
    "Manage this conversation's goal (goal mode). While a goal is active, the app automatically starts new rounds in this same conversation after each run ends, until the goal is completed, blocked, paused by the user, or out of rounds.",
    'Actions:',
    '- get: read the current goal.',
    '- create: set a goal. Use it when the user\'s own message asks for work to keep going until it is done (in any language, e.g. "finish all of them", "keep going until it passes"). Never create a goal on your own initiative. Only one unfinished goal per conversation.',
    '- edit: replace the objective when the user changes what they want.',
    '- pause: pause automatic rounds when the user asks.',
    '- resume: restart automatic rounds for a paused, blocked or stopped goal when the user\'s own message asks to continue it (in any language, e.g. "keep going", "continue"). Harmless when the goal is already running.',
    '- complete: mark the goal achieved. Only when the WHOLE objective is done and verified against the workspace and tool results; give a summary and concrete evidence (files produced, checks run, counts). Partial progress is not complete.',
    `- block: mark the goal blocked when no meaningful progress is possible without the user or an external change, after at least ${GOAL_BLOCK_AFTER_ROUNDS} rounds. Difficulty, uncertainty or remaining work is not blocked. State exactly what is needed from the user.`,
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do with the goal.' },
      objective: { type: 'string', description: 'create / edit: the goal, stated as a checkable end state in the user\'s words.' },
      max_rounds: { type: 'number', description: 'create: optional round budget. Only set it when the user asks for a limit.' },
      summary: { type: 'string', description: 'complete: what was achieved.' },
      evidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'complete: concrete evidence that the whole objective is met (file paths, checks run and their results, counts).',
      },
      reason: { type: 'string', description: 'block: the blocking condition and what is needed from the user.' },
    },
    required: ['action'],
  },
  execute: async (input, context) => {
    const t = getI18n().toolResult.goal;
    const action = readString(input, 'action') as GoalToolAction;
    if (!ACTIONS.includes(action)) return t.invalidAction;
    const conversationId = context?.conversationId;
    const conversation = conversationId ? useChatStore.getState().conversations[conversationId] : undefined;
    if (!conversationId || !conversation) return t.noConversation;

    const goal = getGoal(conversationId);
    const denial = checkGoalAuthority(action, context ?? {}, conversation, goal);
    if (denial) return denialMessage(denial, goal?.roundsStarted ?? 0);

    const describe = () => {
      const current = getGoal(conversationId);
      if (!current) return t.noGoal;
      return format(t.status, {
        objective: current.objective,
        phase: phaseLabel(current.phase),
        rounds: current.roundsStarted,
        maxRounds: current.maxRounds,
      });
    };

    switch (action) {
      case 'get':
        return describe();
      case 'create': {
        const objective = readString(input, 'objective').trim();
        if (!objective) return t.missingObjective;
        if (goal && goal.phase !== 'complete') return format(t.alreadyExists, { objective: goal.objective });
        const maxRounds = typeof input.max_rounds === 'number' ? input.max_rounds : undefined;
        const result = createConversationGoal(conversationId, { objective, maxRounds });
        if (!result.ok) return transitionError(result);
        return format(t.created, { objective: result.goal.objective });
      }
      case 'resume': {
        if (!goal) return t.noGoal;
        if (isGoalDrivingConversation(conversationId)) return t.alreadyRunning;
        // No kick: this run's own settle starts the next round.
        const result = resumeConversationGoal(conversationId, goalRef(goal));
        return result.ok ? t.resumed : transitionError(result);
      }
      case 'edit': {
        if (!goal) return t.noGoal;
        const objective = readString(input, 'objective').trim();
        if (!objective) return t.missingObjective;
        const result = editConversationGoal(conversationId, goalRef(goal), objective);
        return result.ok ? format(t.edited, { objective: result.goal.objective }) : transitionError(result);
      }
      case 'pause': {
        if (!goal) return t.noGoal;
        const result = pauseConversationGoal(conversationId, goalRef(goal));
        return result.ok ? t.paused : transitionError(result);
      }
      case 'complete': {
        if (!goal) return t.noGoal;
        const evidence = Array.isArray(input.evidence)
          ? input.evidence.filter((item): item is string => typeof item === 'string')
          : [];
        const result = completeConversationGoal(
          conversationId,
          goalRef(goal),
          { summary: readString(input, 'summary'), evidence },
          context?.loopId,
        );
        return result.ok ? t.completed : transitionError(result);
      }
      case 'block': {
        if (!goal) return t.noGoal;
        const reason = readString(input, 'reason').trim();
        if (!reason) return t.missingReason;
        const result = blockConversationGoal(
          conversationId,
          goalRef(goal),
          { code: 'model-reported', message: reason },
          context?.loopId,
        );
        return result.ok ? format(t.blocked, { reason: result.goal.blockedReason?.message ?? reason }) : transitionError(result);
      }
    }
  },
};
