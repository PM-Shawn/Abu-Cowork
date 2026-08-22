/**
 * The unattended read-only tier's tool ceiling.
 *
 * `read_tools` (triggers + IM channels) promises "reads information, changes
 * nothing". Until now that promise rested on the per-run confirmation
 * callbacks, which cannot deliver it: `registry.ts` only consults
 * `commandConfirmCallback` when the permission strategy resolves to
 * `confirm`. For a workspace-internal command classified `safe` by
 * `commandSafety`, standard mode resolves to `allow` outright, so the
 * callback never runs — and `touch` / `mkdir` / `cp` are classified `safe`.
 * An unattended run advertised as read-only could therefore write inside its
 * own workspace. (`readOnlyDetector.ts` does classify those commands as
 * non-read-only, but that verdict feeds tool *concurrency* scheduling, not
 * the approval decision — two independent judgments that were never wired
 * together.)
 *
 * `browserToolPolicy.ts` hit the same shape of hole for browser automation (a
 * standing per-site grant made the gate resolve to 'allow' without the
 * callback) and fixed it the same way this module does: the tier is the
 * CEILING, enforced on the tool roster, above every grant and strategy.
 *
 * This is an ALLOWLIST, not a blocklist, so it is fail-closed: a tool added
 * later — including MCP tools, whose consequences this process cannot know —
 * is denied under `read_tools` until someone deliberately classifies it.
 * `allowedTools` is enforced at the same three points as `blockedTools`:
 * `resolveTools` (the model never sees the tool), `executeToolBatch` (refused
 * at dispatch), and `assertRunToolAllowed` (the sidecar/shell boundary, which
 * also covers reverse `tool.invoke`). It also follows `delegate_to_agent`
 * into subagents, which forwards it for `subagentLoop` to enforce.
 *
 * One delegation path does NOT inherit it yet: the `@agent` prefix route in
 * `agentLoop.ts` reaches `runSubagent` without passing through
 * `delegate_to_agent`, and forwards neither restriction. The tier is chosen
 * by the channel but the prompt is user-authored, so an IM message on a
 * read-only channel beginning with `@researcher` still delegates an
 * unrestricted subagent. That gap predates this roster and is not widened by
 * it; it is closed in the blockedTools-propagation change, which forwards
 * both restrictions on this route too.
 */

import { TOOL_NAMES } from '../tools/toolNames';

/**
 * Every tool an unattended `read_tools` run may call.
 *
 * Deliberately excluded, with reasons — each is a one-line addition if a tier
 * review later decides otherwise:
 *
 * - `run_command`: the RB-02 hole itself. A command-name allowlist is not a
 *   read-only boundary — `touch`, `mkdir`, `cp`, `node -e`, `python -c` and
 *   `npm install` all write, and shell redirection writes with no command
 *   name at all. Restoring a read-only shell needs an OS-level sandbox, not
 *   name matching. Reads have dedicated tools below.
 * - `http_fetch`: takes a `method`, so it speaks POST/PUT/DELETE/PATCH. The
 *   pattern-constraint syntax (`toolFilter.ts`) validates the tool's *first
 *   string field* heuristically, which for this tool is the URL, not the
 *   method — pinning "GET only" through it would be a guess, and guessing is
 *   what produced this class of bug. `web_search` covers reading the web.
 * - `write_file` / `edit_file` / `delete_file`, `update_memory`,
 *   `update_soul`, `clipboard_write`, `create_todo`,
 *   `log_task_completion`: writes, by definition.
 * - `send_file`: exfiltration path — it uploads a local file out to the IM
 *   user. An unattended read-only channel must never send workspace files
 *   outward, so it stays off this allowlist (fail-closed). Do NOT add it.
 *   `authGate.test.ts` asserts this exclusion.
 * - `skill_manage` / `save_agent` / `manage_scheduled_task` /
 *   `manage_trigger` / `manage_file_watch` / `manage_mcp_server`:
 *   self-extension. An unattended run must not be able to widen what the
 *   next unattended run can do.
 * - `delegate_to_agent` / `run_agent_batch` / `use_skill`: the ceiling does
 *   follow into them (see the module comment), so these are contained rather
 *   than dangerous — excluded here only because an unattended read-only tier
 *   has no established need for them.
 * - `computer`, `generate_image`, `process_image`: act on the machine or
 *   write files.
 * - `request_workspace` / `ask_user_question` / `show_widget` / `read_me`:
 *   need a UI that an unattended run does not have.
 * - browser automation: already removed by `blockedTools`
 *   (`listAllBrowserToolPatterns`); absent here too, so both mechanisms agree.
 */
export const READ_ONLY_TOOL_ALLOWLIST: readonly string[] = [
  // Filesystem reads
  TOOL_NAMES.READ_FILE,
  TOOL_NAMES.LIST_DIRECTORY,
  TOOL_NAMES.SEARCH_FILES,
  TOOL_NAMES.FIND_FILES,
  // Memory reads
  TOOL_NAMES.RECALL,
  TOOL_NAMES.READ_MEMORY,
  // Skill reads
  TOOL_NAMES.SKILL_VIEW,
  TOOL_NAMES.READ_SKILL_FILE,
  // Host reads
  TOOL_NAMES.GET_SYSTEM_INFO,
  TOOL_NAMES.CLIPBOARD_READ,
  // Network reads
  TOOL_NAMES.WEB_SEARCH,
  // Capability discovery (reports what this run can do; changes nothing)
  TOOL_NAMES.TOOL_SEARCH,
  TOOL_NAMES.CAPABILITY_SNAPSHOT,
  // Reporting back. Mutates no data, and telling the user what it found is
  // the entire point of an unattended read-only run.
  TOOL_NAMES.SYSTEM_NOTIFY,
];
