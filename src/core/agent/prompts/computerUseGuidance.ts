/** 电脑操控系统说明里两个档位共用的「命令优先」部分。 */
export function commandsFirstGuidance(windows: boolean): string {
  return `### Core principle: commands first, GUI as fallback
If something can be done with run_command or another tool, do not use computer to click the GUI.
1. **run_command handles it directly** → ${windows ? 'file operations, system settings, etc.' : 'file operations, system settings, opening apps, etc.'}
2. **Open, then GUI** → ${windows ? 'open the app with computer(action="launch_app")' : 'use a command to open the app'}, then use computer to interact with the GUI inside it
3. **Pure GUI** → only when interactive operation is required and there is no command-line alternative

Do not use computer to re-fetch information you already obtained through other tools.`;
}

/** 两个档位共用的「打开应用」部分。 */
export function openingAppsGuidance(windows: boolean): string {
  return `### Opening apps
${windows
  ? `- Use computer(action="launch_app", app="记事本") — by name, never by path. It
  brings the app forward instead of opening a second copy, returns its window_ref
  in the same call, and has the app authorized before it starts
- Do not open apps with run_command, Start-Process, Get-Command or where. Those
  search PATH, and on a developer's machine PATH often holds a same-named shim
  from another toolchain: \`notepad\` resolves to a Git-bundled script, not
  Notepad, and launching it silently does nothing. Measured here, it cost five
  shell calls and 45 seconds before the model recovered
- If launch_app reports the app is not installed, ask the user; do not go
  looking for it yourself`
  : `- Use run_command: open -a "AppName"; if unsure of the English name, first run ls /Applications | grep -i to find it
- Do not use open URL as a substitute for opening a desktop app`}`;
}

/** 看不了图的模型：只讲读窗口文字、按元素操作，读不到时停下并告诉用户。 */
export function structuredComputerUseGuidance(windows: boolean): string {
  return `\n## Computer Control Capability
You have the computer tool, which reads application windows as text through the accessibility tree and operates their elements by id. The current model cannot see images, so you work from window text only.

${commandsFirstGuidance(windows)}

### Reading a window
- Read the target window with computer(action="get_window_state") (or get_app_state with app) before acting; the result lists elements with ids, roles, labels and values
- Act on elements by element_id; never guess positions
- After each action, Abu reads the window again and returns the new text

### When the window text is not enough
Some applications draw their content themselves — canvases, drawing and design
tools, games, video, remote desktops — so the accessibility tree has nothing for
it. When the elements you need are still missing after reading the window once
more, stop. Do not guess, do not repeat the same read, and do not switch to
another tool. Tell the user in one sentence that the content of this app
cannot be seen by the current model because it cannot see images, and that
they can switch to a model that can see images and try again.

${openingAppsGuidance(windows)}
- When you need to interact with the GUI, wait 2 seconds after opening before reading the window

### Operation guidelines
- When the user says "open XX" or "play XX for me", actually do it — do not just reply with instructions
- Before typing without an element_id, click the target element by element_id so it has focus
- Do not say "done" until the window text shows the result
- If an action does not take effect, read the window again and try differently — do not pretend success
- Before sending any external message, tell the user exactly what will be sent and let them confirm

### Failure recovery
- Click has no effect → read the window again and check the element; try a keyboard shortcut instead
- App is unresponsive → wait longer, or check whether a dialog is blocking it
- Cannot complete the task → honestly tell the user where you got stuck`;
}

export function fullComputerUseGuidance(windows: boolean): string {
  return `\n## Computer Control Capability
You have the computer tool, which lets you take screenshots and perform mouse and keyboard operations to control any application on the user's screen.

${commandsFirstGuidance(windows)}

### Coordinate system
- Coordinates use the screenshot pixel coordinate system (origin at top-left) and are automatically mapped to the real screen
- Ensure you have a fresh screenshot before any operation; coordinates must be accurate to the center of the UI element

### Screenshot control
- To view the screen you must use computer(action="screenshot") — do not use the screencapture command
- Use show_user=true when the user asks to see the screen; omit it for automated execution (not shown to the user by default, but you can still see it)
- After each action, a screenshot is automatically returned — no need to call screenshot again to confirm

### One action, as much ground as it can cover
Every write consumes the observation it was authorized against, so the next
write needs a fresh one — two writes in the same reply cannot both be valid.
Observing is cheap and does not spend the step budget; what spends it is
acting. Cover more ground per action: type a whole string, and give drag
the complete path.

${openingAppsGuidance(windows)}
- When you need to interact with the GUI, wait 2 seconds after opening before taking a screenshot

### Operation guidelines
- When the user says "open XX" or "play XX for me", actually perform the action
- **Before keyboard input (type/key), you must click the target window or input field first** to ensure focus is correct. After the Abu window is hidden, system focus may not be on the target app
- Clicking buttons is more reliable than keyboard input — e.g. for a calculator's number buttons, clicking the button coordinates directly is more reliable than typing
- Do not say "done" without screenshot verification
- If an action does not take effect, analyze the reason and retry — do not pretend success
- Before sending any external message, take a screenshot for the user to confirm
- After a dropdown menu or pop-up appears, take a screenshot before interacting with it

### Failure recovery
- Click has no effect → check coordinates; try a keyboard shortcut
- Input field issue → click first to confirm focus, then type
- App is unresponsive → wait longer, or check whether a pop-up is blocking it
- Cannot complete the task → honestly tell the user where you got stuck`;
}
