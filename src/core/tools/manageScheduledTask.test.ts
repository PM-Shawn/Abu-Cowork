import { describe, it, expect, beforeEach } from 'vitest';
import { useScheduleStore } from '../../stores/scheduleStore';

/**
 * Test the manage_scheduled_task tool execute logic by importing and calling it
 * through the tool registry, or by directly testing the store interactions.
 *
 * Since the tool execute function is not exported directly, we test it
 * end-to-end by registering builtin tools and calling through the registry.
 */
import { toolRegistry } from './registry';
import { registerBuiltinTools } from './builtins';

// Register tools once
registerBuiltinTools();

async function callTool(input: Record<string, unknown>): Promise<string> {
  const tool = toolRegistry.get('manage_scheduled_task');
  if (!tool) throw new Error('manage_scheduled_task not registered');
  return await tool.execute(input);
}

describe('manage_scheduled_task tool', () => {
  beforeEach(() => {
    useScheduleStore.setState({
      tasks: {},
      activeTaskId: null,
      selectedTaskId: null,
      showEditor: false,
      editingTaskId: null,
    });
  });

  // ── Registration ──
  describe('registration', () => {
    it('is registered in the tool registry', () => {
      const tool = toolRegistry.get('manage_scheduled_task');
      expect(tool).toBeDefined();
      expect(tool!.name).toBe('manage_scheduled_task');
    });
  });

  // ── Create ──
  describe('create', () => {
    it('creates a daily task with default time 9:00', async () => {
      const result = await callTool({
        action: 'create',
        name: '每日新闻',
        prompt: '搜索最新科技新闻并总结',
        frequency: 'daily',
      });

      expect(result).toContain('Created scheduled task');
      expect(result).toContain('每日新闻');
      expect(result).toContain('daily');

      const tasks = Object.values(useScheduleStore.getState().tasks);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].name).toBe('每日新闻');
      expect(tasks[0].prompt).toBe('搜索最新科技新闻并总结');
      expect(tasks[0].schedule.frequency).toBe('daily');
      expect(tasks[0].schedule.time?.hour).toBe(9);
      expect(tasks[0].schedule.time?.minute).toBe(0);
      expect(tasks[0].status).toBe('active');
    });

    it('creates a weekly task with specified day and time', async () => {
      const result = await callTool({
        action: 'create',
        name: '周报',
        prompt: '生成本周工作总结',
        frequency: 'weekly',
        time_hour: 17,
        time_minute: 30,
        day_of_week: 5, // Friday
      });

      expect(result).toContain('Created scheduled task');

      const tasks = Object.values(useScheduleStore.getState().tasks);
      expect(tasks[0].schedule.frequency).toBe('weekly');
      expect(tasks[0].schedule.time?.hour).toBe(17);
      expect(tasks[0].schedule.time?.minute).toBe(30);
      expect(tasks[0].schedule.dayOfWeek).toBe(5);
    });

    it('creates an hourly task with specified minute', async () => {
      const result = await callTool({
        action: 'create',
        name: '每小时检查',
        prompt: '检查系统状态',
        frequency: 'hourly',
        time_minute: 15,
      });

      expect(result).toContain('Created scheduled task');

      const tasks = Object.values(useScheduleStore.getState().tasks);
      expect(tasks[0].schedule.time?.minute).toBe(15);
    });

    it('creates a task with optional fields', async () => {
      const result = await callTool({
        action: 'create',
        name: '测试任务',
        description: '这是一个测试',
        prompt: '执行测试',
        frequency: 'daily',
        skill_name: 'summarize',
        workspace_path: '/Users/test/project',
      });

      expect(result).toContain('Created scheduled task');

      const tasks = Object.values(useScheduleStore.getState().tasks);
      expect(tasks[0].description).toBe('这是一个测试');
      expect(tasks[0].skillName).toBe('summarize');
      expect(tasks[0].workspacePath).toBe('/Users/test/project');
    });

    it('returns error when name is missing', async () => {
      const result = await callTool({
        action: 'create',
        prompt: '执行任务',
        frequency: 'daily',
      });
      expect(result).toContain('Error');
      expect(result).toContain('name');
    });

    it('returns error when prompt is missing', async () => {
      const result = await callTool({
        action: 'create',
        name: '任务',
        frequency: 'daily',
      });
      expect(result).toContain('Error');
      expect(result).toContain('prompt');
    });

    it('returns error when frequency is missing', async () => {
      const result = await callTool({
        action: 'create',
        name: '任务',
        prompt: '执行',
      });
      expect(result).toContain('Error');
      expect(result).toContain('frequency');
    });

    it('validates time_hour range', async () => {
      const result = await callTool({
        action: 'create',
        name: '任务',
        prompt: '执行',
        frequency: 'daily',
        time_hour: 25,
      });
      expect(result).toContain('Error');
      expect(result).toContain('time_hour');
    });

    it('validates time_minute range', async () => {
      const result = await callTool({
        action: 'create',
        name: '任务',
        prompt: '执行',
        frequency: 'daily',
        time_minute: 60,
      });
      expect(result).toContain('Error');
      expect(result).toContain('time_minute');
    });

    it('validates day_of_week range', async () => {
      const result = await callTool({
        action: 'create',
        name: '任务',
        prompt: '执行',
        frequency: 'weekly',
        day_of_week: 7,
      });
      expect(result).toContain('Error');
      expect(result).toContain('day_of_week');
    });
  });

  // ── List ──
  describe('list', () => {
    it('returns empty message when no tasks', async () => {
      const result = await callTool({ action: 'list' });
      expect(result).toContain('No scheduled tasks');
    });

    it('lists all tasks', async () => {
      await callTool({
        action: 'create', name: '任务A', prompt: '执行A', frequency: 'daily',
      });
      await callTool({
        action: 'create', name: '任务B', prompt: '执行B', frequency: 'hourly',
      });

      const result = await callTool({ action: 'list' });
      expect(result).toContain('任务A');
      expect(result).toContain('任务B');
      expect(result).toContain('Scheduled tasks (2)');
    });

    it('filters by active status', async () => {
      await callTool({
        action: 'create', name: '活跃任务', prompt: '执行', frequency: 'daily',
      });
      const createResult = await callTool({
        action: 'create', name: '暂停任务', prompt: '执行', frequency: 'daily',
      });
      // Extract task ID from create result
      const idMatch = createResult.match(/ID: (\w+)/);
      if (idMatch) {
        await callTool({ action: 'pause', task_id: idMatch[1] });
      }

      const result = await callTool({ action: 'list', status_filter: 'active' });
      expect(result).toContain('活跃任务');
      expect(result).not.toContain('暂停任务');
    });

    it('filters by paused status', async () => {
      const createResult = await callTool({
        action: 'create', name: '暂停任务', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      if (idMatch) {
        await callTool({ action: 'pause', task_id: idMatch[1] });
      }

      const result = await callTool({ action: 'list', status_filter: 'paused' });
      expect(result).toContain('暂停任务');
    });
  });

  // ── Update ──
  describe('update', () => {
    it('updates task name and prompt', async () => {
      const createResult = await callTool({
        action: 'create', name: '旧名称', prompt: '旧指令', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      const result = await callTool({
        action: 'update',
        task_id: taskId,
        name: '新名称',
        prompt: '新指令',
      });

      expect(result).toContain('Updated scheduled task');
      expect(result).toContain('新名称');

      const task = useScheduleStore.getState().tasks[taskId];
      expect(task.name).toBe('新名称');
      expect(task.prompt).toBe('新指令');
    });

    it('updates schedule frequency', async () => {
      const createResult = await callTool({
        action: 'create', name: '任务', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      await callTool({
        action: 'update',
        task_id: taskId,
        frequency: 'hourly',
        time_minute: 30,
      });

      const task = useScheduleStore.getState().tasks[taskId];
      expect(task.schedule.frequency).toBe('hourly');
    });

    it('returns error when task_id is missing', async () => {
      const result = await callTool({ action: 'update', name: '新名称' });
      expect(result).toContain('Error');
      expect(result).toContain('task_id');
    });

    it('returns error when task does not exist', async () => {
      const result = await callTool({ action: 'update', task_id: 'nonexistent' });
      expect(result).toContain('Error');
      expect(result).toContain('task not found');
    });
  });

  // ── Delete ──
  describe('delete', () => {
    it('deletes a task', async () => {
      const createResult = await callTool({
        action: 'create', name: '待删除', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      const result = await callTool({ action: 'delete', task_id: taskId });
      expect(result).toContain('Deleted scheduled task');
      expect(result).toContain('待删除');
      expect(useScheduleStore.getState().tasks[taskId]).toBeUndefined();
    });

    it('returns error when task_id is missing', async () => {
      const result = await callTool({ action: 'delete' });
      expect(result).toContain('Error');
    });

    it('returns error when task does not exist', async () => {
      const result = await callTool({ action: 'delete', task_id: 'nonexistent' });
      expect(result).toContain('Error');
      expect(result).toContain('task not found');
    });
  });

  // ── Pause ──
  describe('pause', () => {
    it('pauses an active task', async () => {
      const createResult = await callTool({
        action: 'create', name: '任务', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      const result = await callTool({ action: 'pause', task_id: taskId });
      expect(result).toContain('Paused scheduled task');

      const task = useScheduleStore.getState().tasks[taskId];
      expect(task.status).toBe('paused');
    });

    it('returns message when already paused', async () => {
      const createResult = await callTool({
        action: 'create', name: '任务', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      await callTool({ action: 'pause', task_id: taskId });
      const result = await callTool({ action: 'pause', task_id: taskId });
      expect(result).toContain('is already paused');
    });
  });

  // ── Resume ──
  describe('resume', () => {
    it('resumes a paused task', async () => {
      const createResult = await callTool({
        action: 'create', name: '任务', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      await callTool({ action: 'pause', task_id: taskId });
      const result = await callTool({ action: 'resume', task_id: taskId });

      expect(result).toContain('Resumed scheduled task');
      expect(result).toContain('Next run');

      const task = useScheduleStore.getState().tasks[taskId];
      expect(task.status).toBe('active');
      expect(task.nextRunAt).toBeDefined();
    });

    it('returns message when already active', async () => {
      const createResult = await callTool({
        action: 'create', name: '任务', prompt: '执行', frequency: 'daily',
      });
      const idMatch = createResult.match(/ID: (\w+)/);
      const taskId = idMatch![1];

      const result = await callTool({ action: 'resume', task_id: taskId });
      expect(result).toContain('is already active');
    });
  });

  // ── Unknown action ──
  describe('unknown action', () => {
    it('returns error for unknown action', async () => {
      const result = await callTool({ action: 'invalid' });
      expect(result).toContain('Error');
      expect(result).toContain('unknown action');
    });
  });
});
