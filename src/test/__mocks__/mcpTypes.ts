// Stub module for `@modelcontextprotocol/sdk/types.js` (the real one pulls in
// zod and the Node-only SDK graph). Only the notification schemas the renderer
// registers handlers for need to exist: client.ts passes the schema straight to
// `Client.setNotificationHandler`, so a stable object identity is enough.
export const ResourceListChangedNotificationSchema = {
  __method: 'notifications/resources/list_changed',
} as const;
