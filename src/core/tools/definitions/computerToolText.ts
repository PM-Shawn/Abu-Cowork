import type { ToolDefinition } from '../../../types';
import type { ComputerUseModelTier } from '../../llm/modelCapabilities';
import { TOOL_NAMES } from '../toolNames';

export const COMPUTER_EVIDENCE_RULE =
  '④ Evidence that a task is done must come from an action you took. State that was already present when you first observed the app proves nothing: the app may have restored a previous session, an earlier attempt may have left it behind, or the user may have done it themselves. If what the user asked for is already there before you act, say so and ask — do not report it as your result. A task in which no action of yours changed the target is not a completed task.';

export const COMPUTER_TARGETING_RULES = [
  'If a named app is unavailable or has no visible window, do not omit/change the app and do not inspect or operate another foreground app. On Windows, when the user asked you to use that app, open it with launch_app — never with run_command, Start-Process, a script or a shortcut path. Otherwise stop and ask the user to open a visible window for that exact app. When several windows match, select only from the returned window_ref candidates.',
  'When the user names an application—even with a localized name such as “记事本”—you MUST pass that name in app on the first get_app_state call. Omit app only when the user truly did not identify an application. Never use run_command, a shell, or another tool to launch a missing app when the user asked to operate only the current/already-open app.',
].join('\n');

export const COMPUTER_SAFETY_RULES = `THIS TOOL IS THE ONLY WAY TO OPERATE THE DESKTOP. When an action here is refused, blocked, or stopped, that refusal is the answer — do not reach for another tool to accomplish the same thing. Never use run_command, a shell, a script you write, AppleScript, or any other mechanism to send clicks or keystrokes, move or focus a window, or drive an application's UI. Writing the clipboard through another tool in order to paste here counts as the same workaround. Re-observe with get_app_state and choose differently, or tell the user what is blocking you and stop.

SAFETY CONTRACT: Every call must set consequence. Use "none" only when this
specific action cannot itself send, publish, delete, overwrite, install,
purchase, change credentials, or change security settings. Typing a draft is
"none"; clicking Send is "send". For any non-none value, consequence_detail
must state the exact outcome without including secrets. Abu asks the user
immediately before that one action, even in Full Autonomy.

Two cases that read as harmless and are not:
• Sending content you did not put there. Before any action that sends or
  publishes, the content must be content you typed in this turn. A message box
  or editor can already hold a draft — left by the user, or by an earlier turn
  that never sent it. Say what you found and ask; never send it as if it were
  yours.
• Opening an item in a file manager. Folders and documents are "none", but a
  program, installer or script — an .exe, .msi, .bat, .cmd, .ps1, .vbs, or a
  name that reads like an installer or setup — runs code the moment it opens,
  so it is "ambiguous" with the name in consequence_detail. File extensions are
  hidden by default on Windows, so judge the name as the user would read it and
  say what you are unsure about rather than assuming a plain name is a
  document.`;

const STRUCTURED_ACTIONS = [
  'list_windows', 'get_window_state', 'get_app_state', 'activate_app', 'launch_app',
  'click', 'type', 'perform_action', 'scroll', 'key', 'wait',
] as const;

/** 看不了图时不给的参数：截图编号、截图裁剪、所有坐标。 */
const STRUCTURED_OMITTED_PROPERTIES: ReadonlySet<string> = new Set([
  'screenshot_id', 'x', 'y', 'startX', 'startY', 'endX', 'endY', 'path', 'width', 'height', 'show_user',
]);

export const STRUCTURED_COMPUTER_DESCRIPTION = `Operate applications through their accessibility (AX) tree. The current model cannot see images, so this tool never returns pictures of the screen: you read each window as text (elements with ids, roles, labels and values) and act on elements by id.

[Workflow]
① list_windows when an app can have multiple visible windows, then get_window_state with exactly one returned window_ref. get_app_state remains a compatibility alias. When the user refers to the window active at submission, explicitly pass target_selector="foreground-at-submit".
   If the result is target-ambiguous, choose exactly one returned candidate and retry with its opaque window_ref. Never invent or modify a window_ref.
② Every write must carry window_ref and the exact state_id as expected_state_id. Add expected_effect when the result is machine-checkable.
③ Abu consumes state_id once and automatically reads the app again, returning separate observation evidence (changed/unchanged/unavailable) and expectation evidence (not-requested/satisfied/not-satisfied/unverifiable). A UI change without a specific expected_effect does not prove the target was achieved.
${COMPUTER_EVIDENCE_RULE}
⑤ A write consumes the observation it was authorized against, so two writes in the same reply cannot both be valid — the second one's state_id is already spent. Reading is cheap and does not spend the step budget; acting is what spends it. Type a whole string rather than a key at a time.

WHEN THE WINDOW TEXT IS NOT ENOUGH: some apps draw their content themselves (canvas, drawing and design tools, games, video, remote desktops), so their AX tree has nothing for it. If the elements you need are still missing after reading the window once more, stop. Do not guess positions and do not try other tools. Tell the user, in one sentence, that the content of this app cannot be seen by the current model because it cannot see images, and that they can switch to a model that can see images and try again.

${COMPUTER_TARGETING_RULES}

${COMPUTER_SAFETY_RULES}

━━━ Action list ━━━

🔍 Reading + switching (read the window before each operation turn)
• list_windows    Lists visible windows for one named app and returns opaque window_ref candidates. Parameter: app.
• get_window_state Reads one exact window's AX tree as text. Parameter: window_ref (preferred), or app/target_selector for first selection.
• get_app_state   Compatibility alias for get_window_state.
• activate_app    Brings an app to the foreground only (does not read the tree). Parameter: app.
• launch_app      Windows: opens an app by name, or brings it forward if it is already running (no second copy). Parameter: app (a name such as "记事本" or "QQ", never a path). Returns window_ref candidates; read one with get_window_state before acting. The app is authorized before it starts, so the user may be asked once.

✅ Operations (by element id)
• click           Click an element. element_id=N (AXPress). Optional button (left/right/middle/double).
• type            Type text. element_id=N (AXSetValue) + text, or text alone (keyboard input into the focused element). Text containing line breaks is inserted through the clipboard automatically and presses nothing, so type the whole multi-line block in one call rather than pressing Return between lines (Return may send or submit). Optional method=paste (clipboard + Ctrl+V) only after a previous type verified as no change.
• perform_action  Execute a secondary AX action, e.g. context menu (AXShowMenu), select (AXPick), increment/decrement (AXIncrement/AXDecrement). Parameters: element_id, action_name.
• scroll          Scroll at an element. element_id=N, direction (up/down/left/right), amount (default 3).
• key             Press a named key or a modifier chord. Parameters: key (Return/Tab/Escape/Space/ArrowUp/Home/F1…), modifiers ([ctrl/shift/alt/meta]). A single plain character is injected as text (IME-safe); for words use type.
• wait            Wait. Parameters: duration (ms, default 1000, max 10000).`;

/**
 * 当前模型看不了图（structured 档位）时，电脑操控工具换成只读窗口文字的版本：
 * 动作列表去掉截图，参数去掉截图编号与坐标。执行层的 errNoVision 拦截仍然保留。
 */
export function adaptComputerToolForTier(tool: ToolDefinition, tier: ComputerUseModelTier | undefined): ToolDefinition {
  if (tool.name !== TOOL_NAMES.COMPUTER || tier !== 'structured') return tool;
  const properties = Object.fromEntries(
    Object.entries(tool.inputSchema.properties).filter(([key]) => !STRUCTURED_OMITTED_PROPERTIES.has(key)),
  );
  return {
    ...tool,
    description: STRUCTURED_COMPUTER_DESCRIPTION,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        action: { type: 'string', description: `Action: ${STRUCTURED_ACTIONS.join(', ')}` },
      },
    },
  };
}
