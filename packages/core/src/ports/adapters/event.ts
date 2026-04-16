export type Unsubscribe = () => void;

export interface EventAdapter {
  emit<T = unknown>(event: string, payload?: T): void;
  on<T = unknown>(event: string, handler: (payload: T) => void): Unsubscribe;
  once<T = unknown>(event: string, handler: (payload: T) => void): Unsubscribe;
}
