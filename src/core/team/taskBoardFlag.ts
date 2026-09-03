/**
 * The v2 task-board model (任务 kanban / 收件箱 / TeamTask entity / per-member
 * background conversations / scheduler team dispatch) is SHELVED, not deleted
 * — product direction changed 2026-09-04 to "one conversation, leader as the
 * root agent, members as its sub-agents" (docs/abu-team-in-conversation-design-2026-09.md).
 * Flip to true to restore every board entry point at once. Kept separate from
 * LABS_TEAM, which gates the 团队 page itself (members/teams management stays).
 */
export const TEAM_BOARD_ENABLED = false;
