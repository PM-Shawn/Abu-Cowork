import type { FetchAdapter } from '../ports/adapters/fetch';

export type MockHandler = (
  url: string,
  init: RequestInit | undefined
) => Response | Promise<Response>;

export class MemoryFetchAdapter implements FetchAdapter {
  private handlers: { match: RegExp | string; handler: MockHandler }[] = [];
  readonly calls: { url: string; init?: RequestInit }[] = [];

  on(match: RegExp | string, handler: MockHandler): this {
    this.handlers.push({ match, handler });
    return this;
  }

  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    for (const { match, handler } of this.handlers) {
      const hit =
        match instanceof RegExp ? match.test(url) : url.includes(match);
      if (hit) return handler(url, init);
    }
    return new Response(null, { status: 404, statusText: 'Not Mocked' });
  }
}
