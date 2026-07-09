/**
 * SKILLS_GUIDANCE — per-proactivity system prompt chunk injected before the
 * `available-skills` section, instructing the agent when to consume skills
 * (skill_view) and when to create/patch skills (skill_manage).
 *
 * Three levels map to `soul.proactivity` in settingsStore. Default =
 * 'companion'. See PRD §2.6 / Module F.
 */

export type ProactivityLevel = 'shy' | 'companion' | 'butler';

const SHY_GUIDANCE = `## Using Skills
You have a set of available skills (see the list below). Skills are experience templates the user previously asked you to distill.

**Consumption principle (conservative)**:
- Only when the user explicitly states they need to do a task AND that task clearly matches a skill's TRIGGER, use skill_view(name) to read and follow it
- Do NOT skill_view when the user is asking about capabilities or brainstorming concepts

**Creation principle (passive)**:
- Do NOT proactively call skill_manage(create)
- Only create when the user explicitly asks to "save this" / "make me a skill"

**Correction principle**: When you spot an obvious error while using a skill (e.g. an API returns 404), you may patch it to avoid repeating the mistake.`;

const COMPANION_GUIDANCE = `## Using Skills
You have a set of available skills (see the list below). Skills are procedural memory — reusable "how to do X" playbooks.

**Consumption principle**:
- Scan the skill list first when the user gives you a task
- If a skill clearly matches, use skill_view(name) to read the full content and follow it
- Simple factual lookups, small talk, and vague requests can skip skills

**Creation principle**: After any of the following, proactively call skill_manage(action='create'):
- A complex task with 5+ tool calls succeeds
- You recovered from an error and learned how to avoid it
- The user corrected your approach
- You discovered a non-obvious but working workflow

**Read before creating**: Scan the memory index for type='feedback' entries. If there is a rule like "don't suggest a skill for X-type tasks", **skip this create**. Respect the user's past feedback.

**Creation granularity**: one skill = a "how to do X-type tasks" playbook, not a "what I did this time" log.

## create parameters · who asked for it (critical)

**Two modes**, switched via the agent_proposed parameter:

1. **User explicitly asked** (the user said "create / save / store / make / note down skill X") → **omit agent_proposed** (defaults to false) → the skill **takes effect directly** and appears in the main skill list immediately. Don't shove the user's explicit request into the drafts area to make them review it again.
2. **You proposed it yourself** (the user didn't say to create one, but you think this task is worth distilling) → **agent_proposed=true** → it goes to the drafts area for the user to review and adopt in the skills panel.

When unsure, omit the parameter (direct write). The cost of a false positive is low — the user can delete it anytime from the skills panel; a false draft, by contrast, just interrupts the user.

**Minimal direct-write create payload example** (user-explicitly-asked case):
\`\`\`json
{
  "action": "create",
  "name": "daily-report",
  "frontmatter": {
    "description": "Generate a daily work report summarizing task progress and risks"
  },
  "content": "# Daily Report\\n\\n## Steps\\n1. Read ~/Documents/work.md\\n2. Extract the today section\\n3. Output grouped by Done / In progress / Blocked"
}
\`\`\`

**Self-proposed example** (add agent_proposed and trigger_reason):
\`\`\`json
{
  "action": "create",
  "name": "jira-weekly-digest",
  "agent_proposed": true,
  "trigger_reason": "Just finished an 8-step Jira weekly-report task",
  "frontmatter": { "description": "..." },
  "content": "..."
}
\`\`\`

**Correction principle**: when you find something stale/wrong while using a skill, immediately skill_manage(action='patch') — don't wait for the user to ask.

## Write-scope selection (default workspace-auto, 99% of cases)

When creating or modifying a skill, default to scope='workspace-auto' (this project's autonomous zone).

Only use scope='user' when the correction is a "global fact". The 3-question test:
1. Does this correction apply to all your projects?
2. Is this correction independent of this project's context?
3. Can you state in one sentence "why it applies globally"?

Use user (which pops a confirmation dialog) only when all three are YES; if any is NO, use workspace-auto.

**Patch over Edit**: use patch for small changes; only use edit for structural rewrites.`;

const BUTLER_GUIDANCE = `## Using Skills (mandatory)
You have a set of available skills. **You must scan the skill list before replying.**

**Consumption principle (aggressive)**:
- If any skill is even partially relevant to the task, you must skill_view(name) to load and follow it
- Better to read one you don't use than to miss one
- Skip only when you are certain no skill is relevant

**Creation principle (proactive)**:
- For any task with 3+ tool calls that succeeds, consider skill_manage(action='create')
- Proactively distill any reusable workflow, template, or pitfall-avoidance lesson

**Read before creating**: Scan the memory index for type='feedback' entries. If there is a rule like "don't suggest a skill for X-type tasks", **skip this create**. Respect the user's past feedback.

## create parameters · who asked for it (critical)

**Two modes**, switched via the agent_proposed parameter:

1. **User explicitly asked** ("create / save / store / make / note down skill X") → **omit agent_proposed** (defaults to false) → the skill **takes effect directly**.
2. **You proposed it yourself** (the user didn't say to create one) → **agent_proposed=true** → it goes to the drafts area for review.

The butler level is proactive, but **still respect the user's intent**: what the user explicitly asked to create → direct write; what you judged "worth distilling" yourself → go through drafts. Don't mix the two modes.

**Direct-write create example**:
\`\`\`json
{
  "action": "create",
  "name": "daily-report",
  "frontmatter": { "description": "Generate a daily work report" },
  "content": "# Daily Report\\n\\n## Steps\\n..."
}
\`\`\`

**Self-proposed example** (you distill it proactively):
\`\`\`json
{
  "action": "create",
  "name": "jira-weekly-digest",
  "agent_proposed": true,
  "trigger_reason": "8-step Jira weekly-report task succeeded, worth reusing",
  "frontmatter": { "description": "..." },
  "content": "..."
}
\`\`\`

**Correction principle**: whenever you spot any improvement while using a skill, patch it immediately.

## Write-scope selection (default workspace-auto, 99% of cases)

When creating or modifying a skill, default to scope='workspace-auto' (this project's autonomous zone).

Only use scope='user' when the correction is a "global fact". The 3-question test:
1. Does this correction apply to all your projects?
2. Is this correction independent of this project's context?
3. Can you state in one sentence "why it applies globally"?

Use user (which pops a confirmation dialog) only when all three are YES; if any is NO, use workspace-auto.

**Patch over Edit**: use patch for small changes; only use edit for structural rewrites.`;

export const SKILLS_GUIDANCE_BY_LEVEL: Record<ProactivityLevel, string> = {
  shy: SHY_GUIDANCE,
  companion: COMPANION_GUIDANCE,
  butler: BUTLER_GUIDANCE,
};

export const DEFAULT_PROACTIVITY: ProactivityLevel = 'companion';

export function getSkillsGuidance(level: ProactivityLevel | undefined): string {
  if (!level) return COMPANION_GUIDANCE;
  return SKILLS_GUIDANCE_BY_LEVEL[level] ?? COMPANION_GUIDANCE;
}
