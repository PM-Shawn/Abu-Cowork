import type { ToolDefinition } from '../../../types';
import { useScheduleStore } from '../../../stores/scheduleStore';
import type { ScheduleConfig, ScheduleFrequency } from '../../../types/schedule';
import { useTriggerStore } from '../../../stores/triggerStore';
import { triggerEngine } from '../../trigger/triggerEngine';
import type { TriggerFilter, TriggerAction, DebounceConfig } from '../../../types/trigger';
import { addWatchRule, removeWatchRule, toggleWatchRule, listWatchRules, type FileWatchRule } from '../../agent/fileWatcher';
import { TOOL_NAMES } from '../toolNames';
import { getI18n, getLocale, format } from '../../../i18n';

/** Locale tag for Date#toLocaleString, following the resolved UI locale. */
const dateLocale = (): string => (getLocale() === 'zh-CN' ? 'zh-CN' : 'en-US');

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
    const tr = getI18n().toolResult;
    const t = tr.automation;

    switch (action) {
      case 'create': {
        const name = input.name as string | undefined;
        const prompt = input.prompt as string | undefined;
        const frequency = input.frequency as ScheduleFrequency | undefined;

        if (!name) return t.errMissingTaskName;
        if (!prompt) return t.errMissingPrompt;
        if (!frequency) return t.errMissingFrequency;

        // Duplicate name check — prevent LLM from creating redundant tasks
        const existingTasks = Object.values(store.tasks);
        const duplicate = existingTasks.find(
          (task) => task.name === name && task.status === 'active'
        );
        if (duplicate) {
          return format(t.errDuplicateTask, { name, id: duplicate.id });
        }

        // Build time config with defaults
        const timeHour = input.time_hour as number | undefined;
        const timeMinute = input.time_minute as number | undefined;
        const dayOfWeek = input.day_of_week as number | undefined;

        // Validate ranges
        if (timeHour !== undefined && (timeHour < 0 || timeHour > 23)) {
          return t.errTimeHourRange;
        }
        if (timeMinute !== undefined && (timeMinute < 0 || timeMinute > 59)) {
          return t.errTimeMinuteRange;
        }
        if (dayOfWeek !== undefined && (dayOfWeek < 0 || dayOfWeek > 6)) {
          return t.errDayOfWeekRange;
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
          ? new Date(task.nextRunAt).toLocaleString(dateLocale())
          : tr.valueNone;

        return format(t.taskCreated, { name, id: taskId, frequency, nextRun });
      }

      case 'list': {
        const filter = (input.status_filter as string) || 'all';
        const allTasks = Object.values(store.tasks);

        const filtered = filter === 'all'
          ? allTasks
          : allTasks.filter((task) => task.status === filter);

        if (filtered.length === 0) {
          return filter === 'all'
            ? t.listEmptyAll
            : format(t.listEmptyFiltered, { status: filter === 'active' ? tr.statusActive : tr.statusPaused });
        }

        const lines = filtered.map((task) => {
          const nextRun = task.nextRunAt
            ? new Date(task.nextRunAt).toLocaleString(dateLocale())
            : tr.valueNone;
          return format(t.listItem, {
            icon: task.status === 'active' ? '✅' : '⏸️',
            name: task.name,
            id: task.id,
            frequency: task.schedule.frequency,
            nextRun,
            runs: task.totalRuns,
          });
        });

        return format(t.listHeader, { count: filtered.length, lines: lines.join('\n') });
      }

      case 'update': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return t.errMissingTaskId;

        const existing = store.tasks[taskId];
        if (!existing) return format(t.errTaskNotFound, { id: taskId });

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

        return format(t.taskUpdated, { name: (input.name as string) || existing.name, id: taskId });
      }

      case 'delete': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return t.errMissingTaskId;

        const existing = store.tasks[taskId];
        if (!existing) return format(t.errTaskNotFound, { id: taskId });

        const taskName = existing.name;
        store.deleteTask(taskId);
        return format(t.taskDeleted, { name: taskName, id: taskId });
      }

      case 'pause': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return t.errMissingTaskId;

        const existing = store.tasks[taskId];
        if (!existing) return format(t.errTaskNotFound, { id: taskId });
        if (existing.status === 'paused') return format(t.taskAlreadyPaused, { name: existing.name });

        store.pauseTask(taskId);
        return format(t.taskPaused, { name: existing.name, id: taskId });
      }

      case 'resume': {
        const taskId = input.task_id as string | undefined;
        if (!taskId) return t.errMissingTaskId;

        const existing = store.tasks[taskId];
        if (!existing) return format(t.errTaskNotFound, { id: taskId });
        if (existing.status === 'active') return format(t.taskAlreadyActive, { name: existing.name });

        store.resumeTask(taskId);
        const updated = useScheduleStore.getState().tasks[taskId];
        const nextRun = updated?.nextRunAt
          ? new Date(updated.nextRunAt).toLocaleString(dateLocale())
          : tr.valueNone;
        return format(t.taskResumed, { name: existing.name, id: taskId, nextRun });
      }

      default:
        return format(t.errUnknownAction, { action });
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
    const tr = getI18n().toolResult;
    const t = tr.automation;

    switch (action) {
      case 'create': {
        const name = input.name as string | undefined;
        const prompt = input.prompt as string | undefined;

        if (!name) return t.errMissingTriggerName;
        if (!prompt) return t.errMissingPrompt;

        // Duplicate name check
        const existingTriggers = Object.values(store.triggers);
        const duplicate = existingTriggers.find(
          (trig) => trig.name === name && trig.status === 'active'
        );
        if (duplicate) {
          return format(t.errDuplicateTrigger, { name, id: duplicate.id });
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
          if (!sourcePath) return t.errFileNeedsPath;
          const sourceEvents = (input.source_events as string[] | undefined) ?? ['create'];
          source = {
            type: 'file',
            path: sourcePath,
            events: sourceEvents as ('create' | 'modify' | 'delete')[],
            pattern: input.source_pattern as string | undefined,
          };
        } else if (sourceType === 'cron') {
          const interval = input.source_interval as number | undefined;
          if (!interval || interval < 10) return t.errCronNeedsInterval;
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
        const typeLabel = sourceType === 'file' ? t.sourceFile : sourceType === 'cron' ? t.sourceCron : 'HTTP';
        const resultLines = [
          format(t.triggerCreatedHeader, { name }),
          `ID: ${triggerId}`,
          format(t.triggerTypeLine, { type: typeLabel }),
        ];

        if (sourceType === 'file' && source.type === 'file') {
          resultLines.push(
            format(t.watchPathLine, { path: source.path }),
            format(t.watchEventsLine, { events: source.events.join(', ') }),
            source.pattern ? format(t.fileFilterLine, { pattern: source.pattern }) : '',
          );
        } else if (sourceType === 'cron' && source.type === 'cron') {
          resultLines.push(format(t.pollIntervalLine, { seconds: source.intervalSeconds }));
        } else {
          const endpoint = `http://localhost:${serverPort}/trigger/${triggerId}`;
          resultLines.push(
            format(t.httpEndpointLine, { endpoint }),
            '',
            t.externalTriggerCmd,
            `curl -X POST ${endpoint} \\`,
            `  -H "Content-Type: application/json" \\`,
            `  -d '{"data": {"content": "${t.sampleMessage}"}}'`,
          );
        }

        const capLabel = {
          read_tools: t.capReadTools,
          safe_tools: t.capSafeTools,
          full: t.capFull,
          custom: t.capCustom,
        }[triggerAction.capability ?? 'read_tools'] ?? t.capReadTools;

        resultLines.push(
          format(t.capLevelLine, { label: capLabel }),
          format(t.filterLine, { filter: `${filterType}${filter.keywords ? ` [${filter.keywords.join(', ')}]` : ''}` }),
          format(t.debounceLine, { value: debounce.enabled ? format(t.debounceSeconds, { seconds: debounce.windowSeconds }) : t.debounceOff }),
        );

        if (triggerAction.capability === 'custom' && triggerAction.permissions) {
          const p = triggerAction.permissions;
          if (p.allowedCommands?.length) resultLines.push(format(t.allowCommandsLine, { list: p.allowedCommands.join(', ') }));
          if (p.allowedPaths?.length) resultLines.push(format(t.allowPathsLine, { list: p.allowedPaths.join(', ') }));
          if (p.allowedTools?.length) resultLines.push(format(t.allowToolsLine, { list: p.allowedTools.join(', ') }));
        }

        return resultLines.filter(Boolean).join('\n');
      }

      case 'list': {
        const filter = (input.status_filter as string) || 'all';
        const allTriggers = Object.values(store.triggers);

        const filtered = filter === 'all'
          ? allTriggers
          : allTriggers.filter((trig) => trig.status === filter);

        if (filtered.length === 0) {
          return filter === 'all'
            ? t.triggerListEmptyAll
            : format(t.triggerListEmptyFiltered, { status: filter === 'active' ? tr.statusActive : tr.statusPaused });
        }

        const lines = filtered.map((trig) => {
          const lastRun = trig.lastTriggeredAt
            ? new Date(trig.lastTriggeredAt).toLocaleString(dateLocale())
            : tr.valueNever;
          const sourceLabel =
            trig.source.type === 'file' ? format(t.triggerSourceFileLabel, { path: trig.source.path }) :
            trig.source.type === 'cron' ? format(t.triggerSourceCronLabel, { seconds: trig.source.intervalSeconds }) :
            format(t.triggerSourceHttpLabel, { endpoint: `http://localhost:${serverPort}/trigger/${trig.id}` });
          return format(t.triggerListItem, {
            icon: trig.status === 'active' ? '✅' : '⏸️',
            name: trig.name,
            id: trig.id,
            source: sourceLabel,
            filterType: trig.filter.type,
            lastRun,
            runs: trig.totalRuns,
          });
        });

        return format(t.triggerListHeader, { count: filtered.length, lines: lines.join('\n') });
      }

      case 'update': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return t.errMissingTriggerId;

        const existing = store.triggers[triggerId];
        if (!existing) return format(t.errTriggerNotFound, { id: triggerId });

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
        return format(t.triggerUpdated, { name: (input.name as string) || existing.name, id: triggerId });
      }

      case 'delete': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return t.errMissingTriggerId;

        const existing = store.triggers[triggerId];
        if (!existing) return format(t.errTriggerNotFound, { id: triggerId });

        const triggerName = existing.name;
        store.deleteTrigger(triggerId);
        return format(t.triggerDeleted, { name: triggerName, id: triggerId });
      }

      case 'pause': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return t.errMissingTriggerId;

        const existing = store.triggers[triggerId];
        if (!existing) return format(t.errTriggerNotFound, { id: triggerId });
        if (existing.status === 'paused') return format(t.triggerAlreadyPaused, { name: existing.name });

        store.setTriggerStatus(triggerId, 'paused');
        return format(t.triggerPaused, { name: existing.name, id: triggerId });
      }

      case 'resume': {
        const triggerId = input.trigger_id as string | undefined;
        if (!triggerId) return t.errMissingTriggerId;

        const existing = store.triggers[triggerId];
        if (!existing) return format(t.errTriggerNotFound, { id: triggerId });
        if (existing.status === 'active') return format(t.triggerAlreadyActive, { name: existing.name });

        store.setTriggerStatus(triggerId, 'active');
        return format(t.triggerResumed, { name: existing.name, id: triggerId });
      }

      default:
        return format(t.errUnknownAction, { action });
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
    const t = getI18n().toolResult.automation;

    try {
      switch (action) {
        case 'list': {
          const rules = await listWatchRules();
          if (rules.length === 0) return t.fwListEmpty;
          const lines = rules.map((r) => {
            const status = r.enabled ? (r.active ? t.fwStatusRunning : t.fwStatusEnabled) : t.fwStatusDisabled;
            const patternStr = r.pattern ? ` (${r.pattern})` : '';
            return format(t.fwListItem, {
              status,
              id: r.id,
              path: r.path,
              pattern: patternStr,
              event: r.event,
              prompt: r.prompt,
            });
          });
          return format(t.fwListHeader, { count: rules.length, lines: lines.join('\n') });
        }
        case 'add': {
          const path = input.path as string;
          const prompt = input.prompt as string;
          if (!path || !prompt) return t.fwErrAddNeeds;
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
          return format(t.fwRuleCreated, { id: rule.id, path });
        }
        case 'remove': {
          const ruleId = input.rule_id as string;
          if (!ruleId) return t.fwErrRemoveNeeds;
          await removeWatchRule(ruleId);
          return format(t.fwRuleRemoved, { id: ruleId });
        }
        case 'toggle': {
          const ruleId = input.rule_id as string;
          if (!ruleId) return t.fwErrToggleNeeds;
          await toggleWatchRule(ruleId);
          return format(t.fwRuleToggled, { id: ruleId });
        }
        default:
          return format(t.fwUnknownAction, { action });
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: false,
};
