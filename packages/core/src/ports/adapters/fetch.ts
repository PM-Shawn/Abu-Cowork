export interface FetchAdapter {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}
