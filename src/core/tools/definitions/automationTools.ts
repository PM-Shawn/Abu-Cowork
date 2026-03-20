import type { ToolDefinition } from '../../../types';
import { useScheduleStore } from '../../../stores/scheduleStore';
import type { ScheduleConfig, ScheduleFrequency } from '../../../types/schedule';
import { useTriggerStore } from '../../../stores/triggerStore';
import { triggerEngine } from '../../trigger/triggerEngine';
import type { TriggerFilter, TriggerAction, DebounceConfig } from '../../../types/trigger';
import { addWatchRule, removeWatchRule, toggleWatchRule, listWatchRules, type FileWatchRule } from '../../agent/fileWatcher';

export const manageScheduledTaskTool: ToolDefinition = {
  name: 'manage_scheduled_task',
  description: '创建、查看、更新、删除、暂停或恢复定时任务。当用户需要定期/定时自动执行某操作时使用。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'],
        description: '操作类型',
      },
      name: { type: 'string', description: '任务名称（create/update 时使用）' },
      description: { type: 'string', description: '任务描述（可选）' },
      prompt: { type: 'string', description: '每次执行时的指令内容（create/update 时使用）' },
      frequency: {
        type: 'string',
        enum: ['hourly', 'daily', 'weekly', 'weekdays', 'manual'],
        description: '执行频率',
      },
      time_hour: { type: 'number', description: '小时 0-23' },
      time_minute: { type: 'number', description: '分钟 0-59' },
      day_of_week: { type: 'number', description: '星期几 0=周日..6=周六（weekly 时使用）' },
      skill_name: { type: 'string', description: '绑定技能名称（可选）' },
      workspace_path: { type: 'string', description: '工作区路径（可选）' },
      task_id: { type: 'string', description: '任务 ID（update/delete/pause/resume 时必填）' },
      status_filter: {
        type: 'string',
        enum: ['active', 'paused', 'all'],
        description: '列表过滤条件（list 时使用，默认 all）',
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
};

export const manageTriggerTool: ToolDefinition = {
  name: 'manage_trigger',
  description: '创建、查看、更新、删除、暂停或恢复触发器（事件驱动的自动化任务）。当用户需要监听外部事件并自动响应时使用。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'list', 'update', 'delete', 'pause', 'resume'],
        description: '操作类型',
      },
      name: { type: 'string', description: '触发器名称（create/update 时使用）' },
      description: { type: 'string', description: '触发器描述（可选）' },
      prompt: { type: 'string', description: '触发时执行的指令。用 $EVENT_DATA 引用事件数据（create/update 时使用）' },
      skill_name: { type: 'string', description: '绑定技能名称（可选，如 alert-sop）' },
      workspace_path: { type: 'string', description: '工作区路径（可选）' },
      filter_type: {
        type: 'string',
        enum: ['always', 'keyword', 'regex'],
        description: '过滤方式（默认 always）',
      },
      filter_keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '关键词列表（filter_type=keyword 时）',
      },
      filter_pattern: { type: 'string', description: '正则表达式（filter_type=regex 时）' },
      filter_field: { type: 'string', description: '在事件数据的哪个字段上匹配（可选，默认整个 JSON）' },
      source_type: {
        type: 'string',
        enum: ['http', 'file', 'cron'],
        description: '触发源类型（默认 http）。file=文件监听，cron=定时轮询',
      },
      source_path: { type: 'string', description: '监听的文件或目录路径（source_type=file 时必填）' },
      source_events: {
        type: 'array',
        items: { type: 'string', enum: ['create', 'modify', 'delete'] },
        description: '监听的文件事件类型（source_type=file 时使用，默认 ["create"]）',
      },
      source_pattern: { type: 'string', description: '文件名 glob 过滤（source_type=file 时可选，如 "*.pdf"）' },
      source_interval: { type: 'number', description: '轮询间隔秒数（source_type=cron 时必填，最小 10）' },
      debounce_enabled: { type: 'boolean', description: '是否启用防抖（默认 true）' },
      debounce_seconds: { type: 'number', description: '防抖时间窗口秒数（默认 300）' },
      capability: {
        type: 'string',
        enum: ['read_tools', 'safe_tools', 'full', 'custom'],
        description: '能力等级（默认 read_tools）。read_tools=只读分析；safe_tools=可读写工作区+安全命令；full=几乎所有操作；custom=自定义白名单',
      },
      allowed_commands: {
        type: 'array',
        items: { type: 'string' },
        description: '命令白名单，glob 模式（capability=custom 时使用，如 ["npm run *", "git pull"]）',
      },
      allowed_paths: {
        type: 'array',
        items: { type: 'string' },
        description: '路径白名单，运行时自动授权（capability=custom 时使用）',
      },
      allowed_tools: {
        type: 'array',
        items: { type: 'string' },
        description: '工具白名单（capability=custom 时使用，如 ["read_file", "http_fetch"]）',
      },
      trigger_id: { type: 'string', description: '触发器 ID（update/delete/pause/resume 时必填）' },
      status_filter: {
        type: 'string',
        enum: ['active', 'paused', 'all'],
        description: '列表过滤条件（list 时使用，默认 all）',
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
};

export const manageFileWatchTool: ToolDefinition = {
  name: 'manage_file_watch',
  description: '管理文件监听规则。当检测到目录中的文件变化时，自动触发后台任务。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型',
        enum: ['add', 'remove', 'toggle', 'list'],
      },
      // For 'add'
      path: { type: 'string', description: '监听的目录路径（add 时必填）' },
      pattern: { type: 'string', description: '文件名过滤，如 "*.pdf"、"*.xlsx"（可选）' },
      event: { type: 'string', description: '监听事件类型: create / modify / any（默认 any）', enum: ['create', 'modify', 'any'] },
      prompt: { type: 'string', description: '触发时的提示词，支持 {filePath} 和 {fileName} 占位符（add 时必填）' },
      skill_name: { type: 'string', description: '触发时使用的技能名称（可选）' },
      // For 'remove' / 'toggle'
      rule_id: { type: 'string', description: '规则 ID（remove/toggle 时必填）' },
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
};
