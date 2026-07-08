import type { ToolDefinition } from '../../../types';
import { useScheduleStore } from '../../../stores/scheduleStore';
import type { ScheduleConfig, ScheduleFrequency } from '../../../types/schedule';
import { useTriggerStore } from '../../../stores/triggerStore';
import { triggerEngine } from '../../trigger/triggerEngine';
import type { TriggerFilter, TriggerAction, DebounceConfig } from '../../../types/trigger';
import { addWatchRule, removeWatchRule, toggleWatchRule, listWatchRules, type FileWatchRule } from '../../agent/fileWatcher';
import { TOOL_NAMES } from '../toolNames';

export const manageScheduledTaskTool: ToolDefinition = {
  name: TOOL_NAMES.MANAGE_SCHEDULED_TASK,
  description: 'Create, list, update, delete, pause, or resume scheduled tasks. Use when the user needs an operation to run automatically on a recurring or timed schedule.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'],
        description: 'Operation type',
      },
      name: { type: 'string', description: 'Task name (used for create/update)' },
      description: { type: 'string', description: 'Task description (optional)' },
      prompt: { type: 'string', description: 'Instruction to execute each time the task runs (used for create/update)' },
      frequency: {
        type: 'string',
        enum: ['hourly', 'daily', 'weekly', 'weekdays', 'manual'],
        description: 'Execution frequency',
      },
      time_hour: { type: 'number', description: 'Hour 0-23' },
      time_minute: { type: 'number', description: 'Minute 0-59' },
      day_of_week: { type: 'number', description: 'Day of week: 0=Sunday … 6=Saturday (used when frequency=weekly)' },
      skill_name: { type: 'string', description: 'Skill name to bind (optional)' },
      workspace_path: { type: 'string', description: 'Workspace path (optional)' },
      task_id: { type: 'string', description: 'Task ID (required for update/delete/pause/resume)' },
      status_filter: {
        type: 'string',
        enum: ['active', 'paused', 'all'],
        description: 'List filter (used with list action, default: all)',
      },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;
    const store = useScheduleStore.getState();

    switch (action) {
      case 'create': {
        const name = input.name as string | undefined;
        const prompt = input.prompt as string | undefined;
        const frequency = input.frequency as ScheduleFrequency | undefined;

        if (!name) return 'Error: 缺少任务名称 (name)';
        if (!prompt) return 'Error: 缺少执行指令 (prompt)';
        if (!frequency) return 'Error: 缺少执行频率 (frequency)';

        // Duplicate name check — prevent LLM from creating redundant tasks
        const existingTasks = Object.values(store.tasks);
        const duplicate = existingTasks.find(
          (t) => t.name === name && t.status === 'active'
        );
        if (duplicate) {
          return `Error: 已存在同名活跃任务「${name}」(ID: ${duplicate.id})，请勿重复创建。如需修改请使用 update 操作。`;
        }

        // Build time config with defaults
        const timeHour = input.time_hour as number | undefined;
        const timeMinute = input.time_minute as number | undefined;
        const dayOfWeek = input.day_of_week as number | undefined;

        // Validate ranges
        if (timeHour !== undefined && (timeHour < 0 || timeHour > 23)) {
          return 'Error: time_hour 必须在 0-23 之间';
        }
        if (timeMinute !== undefined && (timeMinute < 0 || timeMinute > 59)) {
          return 'Error: time_minute 必须在 0-59 之间';
        }
        if (dayOfWeek !== undefined && (dayOfWeek < 0 || dayOfWeek > 6)) {
          return 'Error: day_of_week 必须在 0-6 之间 (0=周日)';
        }

        // Default time: 9:00 for daily/weekly/weekdays, 0 minute for hourly
        const schedule: ScheduleConfig = { frequency };
        if (frequency === 'hourly') {
          schedule.time = { hour: 0, minute: timeMinute ?? 0 };
        } else if (frequency !== 'manual') {
          schedule.time = { hour: timeHour ?? 9, minute: timeMinute ?? 0 };
        }
        if (frequency === 'weekly') {
          schedule.dayOfWeek = dayOfWeek ?? 1; // default Monday
        }

        const taskId = store.createTask({
          name,
          description: input.description as string | undefined,
          prompt,
          schedule,
          skillName: input.skill_name as string | undefined,
          workspacePath: input.workspace_path as string | undefined,
        });

        const task = useScheduleStore.getState().tasks[taskId];
        const nextRun = task?.nextRunAt
          ? new Date(task.nextRunAt).toLocaleString('zh-CN')
          : '无';

        return `成功创建定时任务「${name}」\nID: ${taskId}\n频率: ${frequency}\n下次执行: ${nextRun}`;
      }

      case 'list': {
        const filter = (input.status_filter as string) || 'all';
        const allTasks = Object.values(store.tasks);

        const filtered = filter === 'all'
          ? allTasks
          : allTasks.filter((t) => t.status === filter);

        if (filtered.length === 0) {
          return filter === 'all'
            ? '当前没有定时任务。'
            : `没有${filter === 'active' ? '活跃' : '已暂停'}的定时任务。`;
        }

        const lines = filtered.map((t) => {
          const nextRun = t.nextRunAt
            ? new Date(t.nextRunAt).toLocaleString('zh-CN')
            : '无';
          return `- [${t.status === 'active' ? '✅' : '⏸️'}] ${t.name} (ID: ${t.id})\n  频率: ${t.schedule.frequency} | 下次执行: ${nextRun} | 已执行: ${t.totalRuns} 次`;
        });

        return `定时任务列表 (${filtered.length} 个):\n\n${lines.join('\n')}`;
      }

      case 'update': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;

        const updateData: Record<string, unknown> = {};
        if (input.name !== undefined) updateData.name = input.name;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.prompt !== undefined) updateData.prompt = input.prompt;
        if (input.skill_name !== undefined) updateData.skillName = input.skill_name;
        if (input.workspace_path !== undefined) updateData.workspacePath = input.workspace_path;

        // Build schedule update if any schedule field changed
        const frequency = input.frequency as ScheduleFrequency | undefined;
        const timeHour = input.time_hour as number | undefined;
        const timeMinute = input.time_minute as number | undefined;
        const dayOfWeek = input.day_of_week as number | undefined;

        if (frequency || timeHour !== undefined || timeMinute !== undefined || dayOfWeek !== undefined) {
          const newSchedule: ScheduleConfig = {
            frequency: frequency || existing.schedule.frequency,
            time: {
              hour: timeHour ?? existing.schedule.time?.hour ?? 9,
              minute: timeMinute ?? existing.schedule.time?.minute ?? 0,
            },
          };
          if (newSchedule.frequency === 'weekly') {
            newSchedule.dayOfWeek = dayOfWeek ?? existing.schedule.dayOfWeek ?? 1;
          }
          updateData.schedule = newSchedule;
        }

        store.updateTask(taskId, updateData as Parameters<typeof store.updateTask>[1]);

        return `成功更新定时任务「${input.name || existing.name}」(ID: ${taskId})`;
      }

      case 'delete': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;

        const taskName = existing.name;
        store.deleteTask(taskId);
        return `成功删除定时任务「${taskName}」(ID: ${taskId})`;
      }

      case 'pause': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;
        if (existing.status === 'paused') return `任务「${existing.name}」已经处于暂停状态。`;

        store.pauseTask(taskId);
        return `已暂停定时任务「${existing.name}」(ID: ${taskId})`;
      }

      case 'resume': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return 'Error: 缺少 task_id';

        const existing = store.tasks[taskId];
        if (!existing) return `Error: 找不到任务 (ID: ${taskId})`;
        if (existing.status === 'active') return `任务「${existing.name}」已经处于活跃状态。`;

        store.resumeTask(taskId);
        const updated = useScheduleStore.getState().tasks[taskId];
        const nextRun = updated?.nextRunAt
          ? new Date(updated.nextRunAt).toLocaleString('zh-CN')
          : '无';
        return `已恢复定时任务「${existing.name}」(ID: ${taskId})\n下次执行: ${nextRun}`;
      }

      default:
        return `Error: 未知操作 "${action}"。可用操作: create, list, update, delete, pause, resume`;
    }
  },
  isConcurrencySafe: false,
};

export const manageTriggerTool: ToolDefinition = {
  name: TOOL_NAMES.MANAGE_TRIGGER,
  description: 'Create, list, update, delete, pause, or resume triggers (event-driven automation tasks). Use when the user needs to listen for external events and respond automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'],
        description: 'Operation type',
      },
      name: { type: 'string', description: 'Trigger name (used for create/update)' },
      description: { type: 'string', description: 'Trigger description (optional)' },
      prompt: { type: 'string', description: 'Instruction to execute on trigger. Use $EVENT_DATA to reference event data (used for create/update)' },
      skill_name: { type: 'string', description: 'Skill name to bind (optional, e.g. alert-sop)' },
      workspace_path: { type: 'string', description: 'Workspace path (optional)' },
      filter_type: {
        type: 'string',
        enum: ['always', 'keyword', 'regex'],
        description: 'Filter mode (default: always)',
      },
      filter_keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'Keyword list (used when filter_type=keyword)',
      },
      filter_pattern: { type: 'string', description: 'Regular expression (used when filter_type=regex)' },
      filter_field: { type: 'string', description: 'Which field in the event data to match against (optional, defaults to the entire JSON)' },
      source_type: {
        type: 'string',
        enum: ['http', 'file', 'cron'],
        description: 'Trigger source type (default: http). file=file watcher, cron=polling',
      },
      source_path: { type: 'string', description: 'File or directory path to watch (required when source_type=file)' },
      source_events: {
        type: 'array',
        items: { type: 'string', enum: ['create', 'modify', 'delete'] },
        description: 'File event types to listen for (used when source_type=file, default: ["create"])',
      },
      source_pattern: { type: 'string', description: 'Filename glob filter (optional when source_type=file, e.g. "*.pdf")' },
      source_interval: { type: 'number', description: 'Polling interval in seconds (required when source_type=cron, minimum 10)' },
      debounce_enabled: { type: 'boolean', description: 'Whether to enable debounce (default: true)' },
      debounce_seconds: { type: 'number', description: 'Debounce time window in seconds (default: 300)' },
      capability: {
        type: 'string',
        enum: ['read_tools', 'safe_tools', 'full', 'custom'],
        description: 'Capability level (default: read_tools). read_tools=read-only analysis; safe_tools=read/write workspace + safe commands; full=almost all operations; custom=custom allowlist',
      },
      allowed_commands: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command allowlist, glob patterns (used when capability=custom, e.g. ["npm run *", "git pull"])',
      },
      allowed_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Path allowlist, auto-authorized at runtime (used when capability=custom)',
      },
      allowed_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool allowlist (used when capability=custom, e.g. ["read_file", "http_fetch"])',
      },
      trigger_id: { type: 'string', description: 'Trigger ID (required for update/delete/pause/resume)' },
      status_filter: {
        type: 'string',
        enum: ['active', 'paused', 'all'],
        description: 'List filter (used with list action, default: all)',
      },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;
    const store = useTriggerStore.getState();
    const serverPort = triggerEngine.getServerPort() ?? 18080;

    switch (action) {
      case 'create': {
        const name = input.name as string | undefined;
        const prompt = input.prompt as string | undefined;

        if (!name) return 'Error: 缺少触发器名称 (name)';
        if (!prompt) return 'Error: 缺少执行指令 (prompt)';

        // Duplicate name check
        const existingTriggers = Object.values(store.triggers);
        const duplicate = existingTriggers.find(
          (t) => t.name === name && t.status === 'active'
        );
        if (duplicate) {
          return `Error: 已存在同名活跃触发器「${name}」(ID: ${duplicate.id})，请勿重复创建。如需修改请使用 update 操作。`;
        }

        // Build filter
        const filterType = (input.filter_type as string) || 'always';
        const filter: TriggerFilter = {
          type: filterType as TriggerFilter['type'],
          keywords: input.filter_keywords as string[] | undefined,
          pattern: input.filter_pattern as string | undefined,
          field: input.filter_field as string | undefined,
        };

        // Build action with capability
        const capabilityInput = input.capability as string | undefined;
        const triggerAction: TriggerAction = {
          prompt,
          skillName: input.skill_name as string | undefined,
          workspacePath: input.workspace_path as string | undefined,
          capability: (capabilityInput as TriggerAction['capability']) ?? undefined,
          permissions: capabilityInput === 'custom' ? {
            allowedCommands: input.allowed_commands as string[] | undefined,
            allowedPaths: input.allowed_paths as string[] | undefined,
            allowedTools: input.allowed_tools as string[] | undefined,
          } : undefined,
        };

        // Build debounce
        const debounce: DebounceConfig = {
          enabled: (input.debounce_enabled as boolean) ?? true,
          windowSeconds: (input.debounce_seconds as number) ?? 300,
        };

        // Build source based on source_type
        const sourceType = (input.source_type as string) || 'http';
        let source: import('../../../types/trigger').TriggerSource;

        if (sourceType === 'file') {
          const sourcePath = input.source_path as string | undefined;
          if (!sourcePath) return 'Error: source_type=file 时必须提供 source_path（监听路径）';
          const sourceEvents = (input.source_events as string[] | undefined) ?? ['create'];
          source = {
            type: 'file',
            path: sourcePath,
            events: sourceEvents as ('create' | 'modify' | 'delete')[],
            pattern: input.source_pattern as string | undefined,
          };
        } else if (sourceType === 'cron') {
          const interval = input.source_interval as number | undefined;
          if (!interval || interval < 10) return 'Error: source_type=cron 时必须提供 source_interval（最小 10 秒）';
          source = { type: 'cron', intervalSeconds: interval };
        } else {
          source = { type: 'http' };
        }

        const triggerId = store.createTrigger({
          name,
          description: input.description as string | undefined,
          source,
          filter,
          action: triggerAction,
          debounce,
        });

        // Build response based on source type
        const resultLines = [
          `成功创建触发器「${name}」`,
          `ID: ${triggerId}`,
          `类型: ${sourceType === 'file' ? '文件监听' : sourceType === 'cron' ? '定时轮询' : 'HTTP'}`,
        ];

        if (sourceType === 'file' && source.type === 'file') {
          resultLines.push(
            `监听路径: ${source.path}`,
            `监听事件: ${source.events.join(', ')}`,
            source.pattern ? `文件过滤: ${source.pattern}` : '',
          );
        } else if (sourceType === 'cron' && source.type === 'cron') {
          resultLines.push(`轮询间隔: ${source.intervalSeconds} 秒`);
        } else {
          const endpoint = `http://localhost:${serverPort}/trigger/${triggerId}`;
          resultLines.push(
            `HTTP 端点: POST ${endpoint}`,
            '',
            '外部触发命令:',
            `curl -X POST ${endpoint} \\`,
            `  -H "Content-Type: application/json" \\`,
            `  -d '{"data": {"content": "测试消息"}}'`,
          );
        }

        const capLabel = {
          read_tools: '只读分析',
          safe_tools: '读写+安全命令',
          full: '完全自主',
          custom: '自定义白名单',
        }[triggerAction.capability ?? 'read_tools'] ?? '只读分析';

        resultLines.push(
          `能力等级: ${capLabel}`,
          `过滤: ${filterType}${filter.keywords ? ` [${filter.keywords.join(', ')}]` : ''}`,
          `防抖: ${debounce.enabled ? `${debounce.windowSeconds}秒` : '关闭'}`,
        );

        if (triggerAction.capability === 'custom' && triggerAction.permissions) {
          const p = triggerAction.permissions;
          if (p.allowedCommands?.length) resultLines.push(`允许命令: ${p.allowedCommands.join(', ')}`);
          if (p.allowedPaths?.length) resultLines.push(`允许路径: ${p.allowedPaths.join(', ')}`);
          if (p.allowedTools?.length) resultLines.push(`允许工具: ${p.allowedTools.join(', ')}`);
        }

        return resultLines.filter(Boolean).join('\n');
      }

      case 'list': {
        const filter = (input.status_filter as string) || 'all';
        const allTriggers = Object.values(store.triggers);

        const filtered = filter === 'all'
          ? allTriggers
          : allTriggers.filter((t) => t.status === filter);

        if (filtered.length === 0) {
          return filter === 'all'
            ? '当前没有触发器。'
            : `没有${filter === 'active' ? '活跃' : '已暂停'}的触发器。`;
        }

        const lines = filtered.map((t) => {
          const lastRun = t.lastTriggeredAt
            ? new Date(t.lastTriggeredAt).toLocaleString('zh-CN')
            : '从未';
          const sourceLabel =
            t.source.type === 'file' ? `文件监听: ${t.source.path}` :
            t.source.type === 'cron' ? `定时轮询: ${t.source.intervalSeconds}秒` :
            `HTTP 端点: POST http://localhost:${serverPort}/trigger/${t.id}`;
          return `- [${t.status === 'active' ? '✅' : '⏸️'}] ${t.name} (ID: ${t.id})\n  ${sourceLabel}\n  过滤: ${t.filter.type} | 最近触发: ${lastRun} | 已执行: ${t.totalRuns} 次`;
        });

        return `触发器列表 (${filtered.length} 个):\n\n${lines.join('\n')}`;
      }

      case 'update': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return 'Error: 缺少 trigger_id';

        const existing = store.triggers[triggerId];
        if (!existing) return `Error: 找不到触发器 (ID: ${triggerId})`;

        const updateData: Record<string, unknown> = {};
        if (input.name !== undefined) updateData.name = input.name;
        if (input.description !== undefined) updateData.description = input.description;
        if (input.prompt !== undefined || input.skill_name !== undefined || input.workspace_path !== undefined || input.capability !== undefined) {
          const updatedCapability = input.capability !== undefined
            ? (input.capability as TriggerAction['capability'])
            : existing.action.capability;
          updateData.action = {
            prompt: (input.prompt as string) ?? existing.action.prompt,
            skillName: input.skill_name !== undefined ? input.skill_name : existing.action.skillName,
            workspacePath: input.workspace_path !== undefined ? input.workspace_path : existing.action.workspacePath,
            capability: updatedCapability,
            permissions: updatedCapability === 'custom' ? {
              allowedCommands: input.allowed_commands !== undefined ? input.allowed_commands : existing.action.permissions?.allowedCommands,
              allowedPaths: input.allowed_paths !== undefined ? input.allowed_paths : existing.action.permissions?.allowedPaths,
              allowedTools: input.allowed_tools !== undefined ? input.allowed_tools : existing.action.permissions?.allowedTools,
            } : existing.action.permissions,
          };
        }
        if (input.filter_type !== undefined || input.filter_keywords !== undefined || input.filter_pattern !== undefined || input.filter_field !== undefined) {
          updateData.filter = {
            type: (input.filter_type as string) ?? existing.filter.type,
            keywords: input.filter_keywords !== undefined ? input.filter_keywords : existing.filter.keywords,
            pattern: input.filter_pattern !== undefined ? input.filter_pattern : existing.filter.pattern,
            field: input.filter_field !== undefined ? input.filter_field : existing.filter.field,
          };
        }
        if (input.debounce_enabled !== undefined || input.debounce_seconds !== undefined) {
          updateData.debounce = {
            enabled: (input.debounce_enabled as boolean) ?? existing.debounce.enabled,
            windowSeconds: (input.debounce_seconds as number) ?? existing.debounce.windowSeconds,
          };
        }

        store.updateTrigger(triggerId, updateData as Parameters<typeof store.updateTrigger>[1]);
        return `成功更新触发器「${input.name || existing.name}」(ID: ${triggerId})`;
      }

      case 'delete': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return 'Error: 缺少 trigger_id';

        const existing = store.triggers[triggerId];
        if (!existing) return `Error: 找不到触发器 (ID: ${triggerId})`;

        const triggerName = existing.name;
        store.deleteTrigger(triggerId);
        return `成功删除触发器「${triggerName}」(ID: ${triggerId})`;
      }

      case 'pause': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return 'Error: 缺少 trigger_id';

        const existing = store.triggers[triggerId];
        if (!existing) return `Error: 找不到触发器 (ID: ${triggerId})`;
        if (existing.status === 'paused') return `触发器「${existing.name}」已经处于暂停状态。`;

        store.setTriggerStatus(triggerId, 'paused');
        return `已暂停触发器「${existing.name}」(ID: ${triggerId})`;
      }

      case 'resume': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return 'Error: 缺少 trigger_id';

        const existing = store.triggers[triggerId];
        if (!existing) return `Error: 找不到触发器 (ID: ${triggerId})`;
        if (existing.status === 'active') return `触发器「${existing.name}」已经处于活跃状态。`;

        store.setTriggerStatus(triggerId, 'active');
        return `已恢复触发器「${existing.name}」(ID: ${triggerId})`;
      }

      default:
        return `Error: 未知操作 "${action}"。可用操作: create, list, update, delete, pause, resume`;
    }
  },
  isConcurrencySafe: false,
};

export const manageFileWatchTool: ToolDefinition = {
  name: TOOL_NAMES.MANAGE_FILE_WATCH,
  description: 'Manage file watch rules. Automatically triggers background tasks when file changes are detected in a directory.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation type',
        enum: ['add', 'remove', 'toggle', 'list'],
      },
      // For 'add'
      path: { type: 'string', description: 'Directory path to watch (required for add)' },
      pattern: { type: 'string', description: 'Filename filter, e.g. "*.pdf", "*.xlsx" (optional)' },
      event: { type: 'string', description: 'Event type to listen for: create / modify / any (default: any)', enum: ['create', 'modify', 'any'] },
      prompt: { type: 'string', description: 'Prompt to run on trigger. Supports {filePath} and {fileName} placeholders (required for add)' },
      skill_name: { type: 'string', description: 'Skill name to use when triggered (optional)' },
      // For 'remove' / 'toggle'
      rule_id: { type: 'string', description: 'Rule ID (required for remove/toggle)' },
    },
    required: ['action'],
  },
  execute: async (input) => {
    const action = input.action as string;

    try {
      switch (action) {
        case 'list': {
          const rules = await listWatchRules();
          if (rules.length === 0) return '当前没有文件监听规则。';
          const lines = rules.map((r) => {
            const status = r.enabled ? (r.active ? '运行中' : '已启用') : '已禁用';
            const patternStr = r.pattern ? ` (${r.pattern})` : '';
            return `- [${status}] ${r.id}: ${r.path}${patternStr} → ${r.event} → "${r.prompt}"`;
          });
          return `文件监听规则 (${rules.length}):\n${lines.join('\n')}`;
        }
        case 'add': {
          const path = input.path as string;
          const prompt = input.prompt as string;
          if (!path || !prompt) return '错误：add 操作需要 path 和 prompt。';
          const rule: FileWatchRule = {
            id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
            path,
            pattern: input.pattern as string | undefined,
            event: (input.event as FileWatchRule['event']) ?? 'any',
            prompt,
            skillName: input.skill_name as string | undefined,
            enabled: true,
          };
          await addWatchRule(rule);
          return `已创建文件监听规则 ${rule.id}，监听 ${path}。`;
        }
        case 'remove': {
          const ruleId = input.rule_id as string;
          if (!ruleId) return '错误：remove 操作需要 rule_id。';
          await removeWatchRule(ruleId);
          return `已删除规则 ${ruleId}。`;
        }
        case 'toggle': {
          const ruleId = input.rule_id as string;
          if (!ruleId) return '错误：toggle 操作需要 rule_id。';
          await toggleWatchRule(ruleId);
          return `已切换规则 ${ruleId} 的启用状态。`;
        }
        default:
          return `未知操作: ${action}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: false,
};
