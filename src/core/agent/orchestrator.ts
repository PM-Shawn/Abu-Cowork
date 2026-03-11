import type { SubagentDefinition, Skill } from '../../types';
import { agentRegistry } from './registry';
import { skillLoader } from '../skill/loader';
import { loadAgentMemory, loadProjectMemory } from './agentMemory';
import { loadAllRules } from './projectRules';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getSessionOutputDir } from '../session/sessionDir';
import { isWindows } from '../../utils/platform';
import { mcpManager } from '../mcp/client';
import { substituteVariables, executeInlineCommands } from '../skill/preprocessor';

const DEFAULT_PERSONA = '你叫阿布，是一个专业靠谱的桌面助手。回复友好简洁。';

// Planning instruction - AI must call report_plan for complex tasks, but simple questions can be answered directly
const PLANNING_INSTRUCTION = `
## 执行规范（必须遵守）

**收到任务后，根据情况选择执行方式：**

### 情况 A：不需要工具就能回答（闲聊、知识问答、计算、翻译、写作等）
→ 直接回复，不需要调用任何工具，也不需要 report_plan

### 情况 B：任务匹配某个技能的 TRIGGER 条件
→ 先调用 use_skill 激活匹配的技能
→ 然后按照技能指令完成任务（技能会定义自己的工作流程）

### 情况 C：任务匹配某个代理的专长
→ 先调用 report_plan 列出步骤
→ 然后调用 delegate_to_agent 委派任务
→ 收到结果后，汇总呈现给用户

### 情况 D：需要执行操作且你清楚如何完成（文件操作、系统操作等）
→ 先调用 report_plan，然后执行

### 情况 E：任务涉及你不确定的内容（陌生名词、需要调研的信息）
→ 先用 web_search 了解情况，再调用 report_plan，最后执行
→ 不要在搜索之前做计划，否则计划会基于错误假设

**决策优先级：B > C > D/E > A**
当技能的 TRIGGER 条件匹配时，优先使用技能。
当代理的专长匹配时，优先委派给代理。

### 工具选择原则（情况 D/E 执行时遵守）

执行操作时，优先使用高效工具，避免低效方式：
- 读取文件内容 → read_file，不要用 computer 截屏看
- 查看目录文件 → list_directory，不要用 computer 截屏看桌面
- 重命名/移动/复制文件 → run_command（mv/cp），不要通过 Finder GUI 操作
- 编辑文件 → edit_file 或 write_file，不要用 computer 点击编辑器
- 搜索文件 → find_files 或 search_files，不要用 computer 截屏找
- 获取网页信息 → web_search 或 http_fetch，不要打开浏览器截屏
- 系统设置 → run_command（osascript/defaults），不要截屏操作系统设置
- computer use 只在必须看屏幕画面或操作 GUI 界面时才用

report_plan 的 steps 要用用户能理解的语言，例如：
- ✅ "扫描桌面文件"、"识别发票文件"、"创建整理文件夹"
- ❌ "调用 list_directory"（不要用工具名）
- ❌ "获取系统信息"（太技术化）
多步任务的最后一步应该是验证（如 list_directory 确认文件操作结果），不要仅依赖执行时的输出。

完成任务后的回复要有信息量，根据场景选择合适的格式：
- 列举类（如"桌面有什么文件"）→ 按类型分组，简要说明每个文件的用途
- 变更类（如重命名/移动文件）→ 简洁告知结果 + 表格展示变更前→变更后对照
- 说明关键决策（如"发票用销售方名称而非购买方"）
- 如有异常情况，主动说明

示例 1（技能匹配）：
用户说"帮我深度研究 AI Agent 的发展趋势"
→ use_skill({"skill_name": "deep-research", "context": "AI Agent 发展趋势"})
（技能会定义自己的工作流程）

示例 2（代理委派）：
用户说"帮我审查 src/main.ts 的代码"
→ report_plan({"steps": ["读取源码文件", "委派给代码审查专家进行全面审查", "整理审查结果"]})
→ delegate_to_agent({"agent_name": "coder", "task": "审查 src/main.ts 的代码质量、潜在问题和改进建议"})

示例 3（确定性任务）：
用户说"帮我整理桌面发票"
→ report_plan({"steps": ["扫描桌面文件", "识别发票", "创建发票文件夹", "移动发票"]})
→ 然后执行

示例 4（需要搜索的任务）：
用户说"帮我了解 OpenClaw 的应用场景"
→ 先 web_search("OpenClaw") 了解是什么
→ 再 report_plan({"steps": ["搜索更多应用案例", "整理分类", "生成报告"]})
→ 然后继续执行
`;

export interface RouteResult {
  type: 'skill' | 'agent' | 'general' | 'delegate';
  name: string;
  definition?: SubagentDefinition;
  skill?: Skill;          // Full skill object for execution
  skillContent?: string;  // Kept for backward compatibility
  args?: string;
  cleanInput: string;     // User input with command stripped
  delegateAgent?: SubagentDefinition;  // For @agent direct delegation
}

/**
 * Orchestrator: routes user input to the appropriate skill.
 *
 * Like Claude Code/Cowork, Abu is a single unified agent.
 * No @agent selection - users just describe their task.
 *
 * Routing priority:
 * 1. Slash command → exact skill match (user explicitly invokes)
 * 2. General → Claude decides if/when to use skills via use_skill tool
 */
export function routeInput(input: string): RouteResult {
  const trimmed = input.trim();

  // Guard: empty input or bare slash
  if (!trimmed || trimmed === '/') {
    return {
      type: 'general',
      name: 'abu',
      definition: agentRegistry.getAgent('abu'),
      cleanInput: trimmed,
    };
  }

  // 1. @agent delegation: @agent-name [task]
  if (trimmed.startsWith('@')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const agentName = parts[0];
    const taskText = parts.slice(1).join(' ');

    if (agentName) {
      const agent = agentRegistry.getAgent(agentName);
      if (agent && agent.name !== 'abu') {
        // Check if disabled
        const disabledAgents = useSettingsStore.getState().disabledAgents ?? [];
        if (!disabledAgents.includes(agentName)) {
          return {
            type: 'delegate',
            name: agentName,
            delegateAgent: agent,
            cleanInput: taskText || `@${agentName}`,
          };
        }
      }
    }
  }

  // 2. Slash command: /skill-name [args]
  if (trimmed.startsWith('/')) {
    const parts = trimmed.slice(1).split(/\s+/);
    const skillName = parts[0];
    const args = parts.slice(1).join(' ');

    const skill = skillLoader.getSkill(skillName);
    if (skill) {
      return {
        type: 'skill',
        name: skillName,
        skill,
        skillContent: skill.content,
        args,
        cleanInput: args || `执行 ${skillName} 技能`,
      };
    }
  }

  // 3. General: let Claude decide when to use skills via use_skill tool
  // Skills are listed in system prompt, Claude can call use_skill when relevant
  return {
    type: 'general',
    name: 'abu',
    definition: agentRegistry.getAgent('abu'),
    cleanInput: trimmed,
  };
}

/**
 * Build an enhanced system prompt that includes:
 * - Base agent persona
 * - Workspace context (if set) or session output directory
 * - Skill content (if routed to a skill)
 * - Active skills content (injected via use_skill tool)
 * - Available skills list for discovery
 */
export async function buildSystemPrompt(
  route: RouteResult,
  basePrompt: string,
  conversationId: string,
): Promise<string> {
  const parts: string[] = [];
  const isSkillMode = route.type === 'skill' && route.skillContent;
  const isForkContext = isSkillMode && route.skill?.context === 'fork';

  // Preprocess skill content if available
  let processedSkillContent = route.skillContent ?? '';
  if (isSkillMode && route.skill) {
    const settings = useSettingsStore.getState();
    processedSkillContent = substituteVariables(
      processedSkillContent,
      route.args ?? '',
      route.skill.skillDir,
      conversationId,
    );
    if (settings.allowSkillCommands) {
      processedSkillContent = await executeInlineCommands(processedSkillContent, route.skill.skillDir);
    }
  }

  if (isForkContext && route.skill) {
    // Fork mode: Skill instructions come FIRST with maximum priority
    parts.push('## 当前任务 — 严格按以下步骤执行\n' + processedSkillContent);

    // Preload other skills if specified
    if (route.skill.preloadSkills && route.skill.preloadSkills.length > 0) {
      const preloaded = route.skill.preloadSkills
        .map(name => skillLoader.getSkill(name))
        .filter((s): s is NonNullable<typeof s> => s !== undefined)
        .map(s => `### ${s.name}\n${s.content}`)
        .join('\n\n');
      if (preloaded) {
        parts.push('\n## 预加载技能知识\n' + preloaded);
      }
    }

    // Use agent-specific persona if skill.agent is set
    if (route.skill.agent) {
      const agentDef = agentRegistry.getAgent(route.skill.agent);
      if (agentDef?.systemPrompt) {
        parts.push('\n## 身份\n' + agentDef.systemPrompt);
      } else {
        parts.push('\n## 身份\n' + DEFAULT_PERSONA);
      }
    } else {
      parts.push('\n## 身份\n你叫阿布，是一个专业靠谱的桌面助手。回复友好简洁。');
    }
    // No PLANNING_INSTRUCTION — the skill defines its own workflow
  } else if (isSkillMode) {
    // Inline mode (default): Skill content right after persona, BEFORE planning
    parts.push(basePrompt);
    parts.push('\n## 当前技能指令\n' + processedSkillContent);
    // No PLANNING_INSTRUCTION — skill already defines its own workflow
  } else {
    // Normal mode: full persona + planning instruction
    parts.push(basePrompt);
    parts.push(PLANNING_INSTRUCTION);
  }

  // Inject current date and time so the model knows "today"
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  parts.push(`\n## 当前时间\n${dateStr} ${timeStr}`);

  // Inject workspace context or session output directory
  const workspacePath = useWorkspaceStore.getState().currentPath;

  if (workspacePath) {
    parts.push(`\n## 当前工作区
路径: ${workspacePath}
你可以使用文件工具在此目录下读写文件。当用户提到文件或目录时，默认在此工作区路径下操作。`);
  } else {
    // No workspace selected - use session output directory
    const outputDir = await getSessionOutputDir(conversationId);
    parts.push(`\n## 输出目录
当前没有设置工作区。生成的文件请保存到：
${outputDir}

这是专门为本次会话创建的输出目录。`);
  }

  // Inject Windows-specific guidance when on Windows
  if (isWindows()) {
    parts.push(`\n## 操作系统: Windows
- 命令通过 PowerShell 执行，可直接使用 PowerShell cmdlet
- 打开网址/文件用 Start-Process 或 start 命令（不是 open），例如: Start-Process https://www.baidu.com
- 打开文件夹用 explorer 命令，例如: explorer C:\\Users
- 路径使用反斜杠 (\\) 或正斜杠 (/)，环境变量用 $env:VAR 语法
- 常用命令对照: ls→Get-ChildItem, cat→Get-Content, rm→Remove-Item, cp→Copy-Item, mv→Move-Item, grep→Select-String, open→Start-Process`);
  }

  const settingsState = useSettingsStore.getState();

  // Inject project rules (user-maintained, high priority)
  if (!isForkContext) {
    try {
      const rules = await loadAllRules(workspacePath);
      if (rules.trim()) {
        parts.push(`\n## 项目规则\n以下是用户定义的规则，必须始终遵守。规则由用户手动维护，不要尝试修改。\n${rules}`);
      }
    } catch (err) {
      console.warn('Failed to load project rules:', err);
    }
  }

  // Inject main agent (abu) long-term memory
  if (!isForkContext) {
    try {
      const memory = await loadAgentMemory('abu');
      if (memory.trim()) {
        parts.push(`\n## 你的长期记忆
以下是你跨会话保持的记忆，始终参考这些信息来个性化你的回复。
${memory}`);
      }
      // Brief memory management reminder
      parts.push(`\n在对话中观察到值得记住的信息时，用 update_memory 工具保存到记忆。记忆应精炼有条理。
- scope="user": 个人记忆，跨项目永久保持（如用户偏好、格式习惯）
- scope="project": 项目记忆，仅在当前工作区生效（如项目规范、技术栈、业务术语、数据结构）
- 项目规则（.abu/ABU.md 和 .abu/rules/）由用户手动维护，不要用 update_memory 修改规则文件`);
    } catch (err) {
      console.warn('Failed to load abu memory:', err);
    }

    // Inject project-level memory
    if (workspacePath) {
      try {
        const projectMemory = await loadProjectMemory(workspacePath);
        if (projectMemory.trim()) {
          parts.push(`\n## 项目记忆
以下是本项目的持久化记忆（存储在工作区 .abu/MEMORY.md），包含项目规范、数据结构、业务术语等信息。始终参考这些信息。
${projectMemory}`);
        }
      } catch (err) {
        console.warn('Failed to load project memory:', err);
      }
    }

    // Inject computer use guidance (if enabled)
    if (settingsState.computerUseEnabled) {
      parts.push(`\n## 电脑操控能力
你有一个统一的 computer 工具，可以截屏、鼠标、键盘操作，看到并操控用户屏幕上的任何应用。

### computer 工具
通过 action 参数调度不同操作：
- action="screenshot": 截取屏幕（自动隐藏阿布窗口），返回截图图片。可选 width/height 截取区域
- action="click": 在 (x,y) 点击鼠标。可选 button: left/right/middle/double
- action="move": 移动鼠标到 (x,y)
- action="scroll": 在 (x,y) 滚动。direction: up/down/left/right，可选 amount（默认3）
- action="drag": 从 (startX,startY) 拖拽到 (endX,endY)
- action="type": 输入文本 text。中文/非ASCII字符会自动通过剪贴板粘贴，确保输入正确
- action="key": 按下 key 快捷键，可选 modifiers: ["ctrl","shift","alt","meta"]
- action="wait": 等待指定毫秒数。参数 duration（默认1000，最大10000）。用于操作之间等待UI加载

### 坐标系统
- 所有坐标使用截图的像素坐标系（截图左上角为原点）
- 截图已自动缩放，坐标会自动映射回真实屏幕，你无需手动换算
- 每次截屏后坐标系会更新，操作前请确保有最新截图

### 核心原则：命令优先，computer use 兜底
能用 run_command 或其他工具完成的任务，不要用 computer use 去点 GUI。
computer use（截屏+点击）速度慢、容易出错，只在必须看屏幕或操作 GUI 时才用。

#### 优先级
1. **run_command 直接完成**：文件操作、系统设置、打开应用等，用 shell/AppleScript 一条命令搞定，不需要截屏。
2. **run_command + computer use 配合**：先用命令打开应用，再用 computer use 操作应用内 GUI。
3. **纯 computer use**：只在必须交互式操作 GUI、且没有命令行替代方案时使用。

如果你已经通过工具拿到了所需信息（文件内容、目录列表等），不要再用 computer use 重复获取同样的信息。

#### 场景分类（当确实需要 computer use 时）

**场景 A：需要操作已知应用的 GUI（"在XX中搜索YY"、"帮我播放XX"）**
1. 用 run_command 打开/切换到目标应用（如 open -a "AppName"）
2. computer(action="wait", duration=2000) 等待窗口加载
3. 截屏查看应用当前状态
4. 根据截图操作 UI

**场景 B：需要查看屏幕当前状态（"屏幕上有什么"、"帮我看看这个页面"）**
1. 直接截屏查看
2. 分析并回复用户

**场景 C：在已打开的应用中连续操作**
1. 执行操作（click/type/key）
2. 截屏确认结果
3. 继续下一步操作

**关键：截图是手段，不是目的。用户没要求截图时，不要主动发截图给用户，除非你需要看屏幕来完成任务。**

### 截图显示控制
- **需要查看屏幕内容时，必须用 computer(action="screenshot")，不要用 run_command 执行 screencapture！** run_command 截图只会存文件，用户在聊天中看不到；computer 工具会返回内联图片，你和用户都能直接看到。
- 只有用户要求"保存截图到某个路径"时，才用 screencapture 命令保存文件。
- computer 工具有 show_user 参数，控制截图是否在聊天界面展示给用户
- 用户明确要求看屏幕时（"给我看看"、"屏幕上有什么"、"截个图"），用 computer(action="screenshot", show_user=true)
- 自动化执行任务时，不设 show_user（默认不展示，但你仍能看到截图）
- action="screenshot" 默认展示，其他操作的自动截图默认不展示

### 打开应用
- 用 run_command 执行 open -a "AppName"，AppName 是 /Applications 下的英文名
- 不要用 open URL 代替打开桌面应用。例如不要用 open https://music.163.com 代替 open -a NeteaseMusic
- 不确定英文名时，先用 run_command 执行 ls /Applications | grep -i 关键词 查找
- 常见对照：网易云音乐 → NeteaseMusic，微信 → WeChat，钉钉 → DingTalk，QQ音乐 → QQMusic，飞书 → Lark，VS Code → "Visual Studio Code"
- 如果后续需要操作应用 GUI，打开后等待 2 秒再截屏；如果只是打开应用本身，不需要截屏

### 识别用户意图
当用户说"打开XX"、"帮我换壁纸"、"帮我播放XX"等，要用工具实际操作电脑，不要只回复文字教程。

### 诚实报告结果
- 没有通过截屏验证的操作，不能说"已完成"
- 每执行一个操作后截屏验证，不要连续执行多个操作不看结果
- 如果截屏显示操作没有生效，分析原因并重试，不要假装成功
- 如果无法完成任务，诚实告诉用户哪一步失败了

### 操作节奏
- 每个操作（click/type/key/scroll/drag）执行后会自动截图返回，你可以直接看到操作结果
- 不需要手动调用 screenshot 来确认操作结果，系统已自动完成
- 只在需要查看初始状态、或等待较长加载后才需要手动调用 screenshot
- 如果自动截图显示操作未生效，分析原因后重试

### 失败恢复策略
- 点击没反应？→ 检查坐标是否准确，尝试用键盘快捷键代替（Tab切换焦点、Cmd+F搜索等）
- 搜索框找不到？→ 尝试 Cmd+F 或 Cmd+L（地址栏），或截取局部区域放大查看
- 文字没输入进去？→ 先点击确认焦点在输入框，再 type
- 应用没有响应？→ wait 等待更长时间，或截屏看是否有弹窗阻挡
- 完全无法操作？→ 诚实告诉用户具体卡在哪一步

### 注意事项
- 对外发送消息（邮件、聊天）等操作前，先截屏让用户确认内容
- 下拉菜单/弹窗等动态UI出现后，先截屏再操作
- 坐标要精确到 UI 元素中心，不要随意估计
- 操作时阿布窗口会自动隐藏，不用担心遮挡`);
    }

    // Inject browser automation guidance when abu-browser-bridge is connected
    const browserBridgeConnected = mcpManager.isConnected('abu-browser-bridge');
    if (browserBridgeConnected) {
      const playwrightConnected = mcpManager.isConnected('playwright');
      let browserGuide = `\n## 浏览器操作能力（abu-browser-bridge）
你已连接到用户的 Chrome 浏览器，可以操作用户真实的浏览器标签页。

### 使用流程
1. 先调用 abu-browser-bridge__get_tabs 获取所有标签页
2. 根据返回的 tabId 进行后续操作（snapshot、click、fill 等）
3. 返回结果按窗口分组，标记了 "当前窗口" 和 "当前标签页"

### 重要提示
- get_tabs 返回的是 Chrome 所有窗口的所有标签页，数量可能很多
- 关注 "focused: true" 的标签页，那是用户当前正在查看的页面
- 每次操作前都应该重新调用 get_tabs 获取最新状态，不要复用旧的标签页数据`;

      if (playwrightConnected) {
        browserGuide += `

### 工具选择规则（重要）
- 操作用户已打开的 Chrome 浏览器 → 使用 abu-browser-bridge__ 开头的工具
- **不要**使用 playwright__browser_tabs 来查看用户的浏览器标签页，那会启动一个全新的空白浏览器
- playwright 工具适合自动化测试场景（打开新浏览器访问指定网址），不适合操作用户现有浏览器`;
      }

      parts.push(browserGuide);
    }
  }

  // Inject agent-specific system prompt (Abu unified agent)
  // Skip in fork mode — we already have a minimal identity
  if (!isForkContext && route.definition?.systemPrompt) {
    parts.push('\n## Role\n' + route.definition.systemPrompt);
  }

  // NOTE: Active skills content (from use_skill tool) is now injected dynamically
  // per-turn inside agentLoop via loadActiveSkillContent(), not here.

  // List available skills for discovery (filter out disabled skills)
  // Apply context budget: max(16K chars, contextWindow × 2%)
  try {
    const disabledSkills = new Set(settingsState.disabledSkills ?? []);
    const skills = skillLoader.getAvailableSkills().filter(
      (s) => s.userInvocable !== false && !disabledSkills.has(s.name)
    );
    if (skills.length > 0) {
      const contextWindowSize = settingsState.contextWindowSize ?? 200000;
      // Budget in characters (rough estimate: 1 token ≈ 4 chars)
      const budget = Math.max(16000, Math.floor(contextWindowSize * 4 * 0.02));
      let usedChars = 0;
      const skillLines: string[] = [];
      let truncated = false;

      for (const s of skills) {
        let line: string;
        if (s.trigger) {
          line = `- ${s.name}: ${s.description}\n    TRIGGER when: ${s.trigger}`;
          if (s.doNotTrigger) {
            line += `\n    DO NOT TRIGGER when: ${s.doNotTrigger}`;
          }
        } else {
          line = `- /${s.name} — ${s.description}`;
        }

        if (usedChars + line.length > budget) {
          const remaining = skills.length - skillLines.length;
          skillLines.push(`（还有 ${remaining} 个技能可通过 use_skill 调用）`);
          truncated = true;
          break;
        }
        skillLines.push(line);
        usedChars += line.length;
      }

      const header = truncated
        ? '以下技能可通过 use_skill 工具主动使用（部分列表）。\n'
        : '以下技能可通过 use_skill 工具主动使用。\n';
      parts.push(
        '\n## Available Skills\n' +
        header +
        '**决策规则**：收到用户请求后，首先检查是否匹配某个技能的 TRIGGER 条件。\n' +
        '如果匹配（且不符合 DO NOT TRIGGER 条件），必须通过 use_skill 激活该技能。\n' +
        '技能包含最佳实践和完整工作流，使用技能 = 更好的结果。\n\n' +
        skillLines.join('\n')
      );
    }
  } catch (err) {
    console.warn('Failed to load available skills for system prompt:', err);
  }

  // List available agents for delegation
  try {
    const disabledAgents = new Set(settingsState.disabledAgents ?? []);
    const availableAgents = agentRegistry.getAvailableAgents().filter(
      (a) => a.name !== 'abu' && !disabledAgents.has(a.name)
    );
    if (availableAgents.length > 0) {
      const agentLines = availableAgents.map((a) => `- ${a.name}: ${a.description}`);
      parts.push(
        '\n## Available Agents\n' +
        '以下代理可通过 delegate_to_agent 工具进行任务委派。\n' +
        '当用户的任务明显匹配某个代理的专长时，优先委派给专业代理处理。\n' +
        '委派后等待结果返回，你负责汇总和呈现给用户。\n\n' +
        agentLines.join('\n')
      );
    }
  } catch (err) {
    console.warn('Failed to load available agents for system prompt:', err);
  }

  return parts.join('\n');
}
