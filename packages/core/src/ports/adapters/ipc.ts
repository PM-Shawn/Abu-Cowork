export interface IPCAdapter {
  invoke<T = unknown>(command: string, payload?: Record<string, unknown>): Promise<T>;
  available(command: string): boolean;
}
