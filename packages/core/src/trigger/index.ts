export * from './fileMatcher';
export * from './fileTriggerWatcher';
/**
 * core/trigger 只覆盖 cron + file 两种来源（cron 用 scheduler/DueTaskScheduler）。
 *
 * 未迁移（交给 shell 侧 `@abu/core-tauri` / Abu Desktop）：
 * - HTTP trigger 服务器（原 `invoke('start_trigger_server')`）
 * - IM trigger 监听（依赖 @abu/core-im 插件包）
 * - triggerPermission.ts（depends on tools/pathSafety + permissionStore）
 *
 * 这样 core 对外仅暴露"触发语义"，具体接入哪些来源由 shell 组装。
 */
