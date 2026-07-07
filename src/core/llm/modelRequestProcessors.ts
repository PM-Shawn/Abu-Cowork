import type { DeclaredCapabilities } from '@/types/provider';

export interface RequestContext {
  modelId: string;
  requestHost: string;
  hasTools: boolean;
  caps?: DeclaredCapabilities;
}

export interface ModelRequestProcessor {
  name: string;
  priority?: number;
  matches(body: Record<string, unknown>, ctx: RequestContext): boolean;
  apply(body: Record<string, unknown>, ctx: RequestContext): void;
}

const EFFORT_ORDER = ['low', 'medium', 'high'] as const;

function isGpt55(model: string): boolean {
  return /gpt-?5\.5/i.test(model);
}
const responsesNativeFallback: ModelRequestProcessor = {
  name: 'responses-native-fallback',
  priority: 10,
  // Host-agnostic: gpt-5.5 rejects reasoning_effort when tools are present on ANY
  // host (direct OpenAI, proxy, gateway). The original fix (#86) guarded only
  // api.openai.com — this restores protection for routed/proxied deployments.
  matches: (_b, ctx) => ctx.hasTools && isGpt55(ctx.modelId),
  apply: (b) => { delete b.reasoning_effort; delete (b as { reasoning?: unknown }).reasoning; },
};

const reasoningSupport: ModelRequestProcessor = {
  name: 'reasoning-support',
  priority: 20,
  matches: (_b, ctx) => ctx.caps?.supportsReasoning === false,
  apply: (b) => { delete b.reasoning_effort; delete (b as { reasoning?: unknown }).reasoning; delete b.thinking_budget; },
};

const toolsGate: ModelRequestProcessor = {
  name: 'tools-gate',
  priority: 20,
  matches: (_b, ctx) => ctx.caps?.supportsTools === false,
  apply: (b) => { delete b.tools; delete b.tool_choice; },
};

const effortClamp: ModelRequestProcessor = {
  name: 'effort-clamp',
  priority: 30,
  matches: (b, ctx) =>
    typeof b.reasoning_effort === 'string' &&
    Array.isArray(ctx.caps?.supportedEfforts) &&
    ctx.caps!.supportedEfforts!.length > 0 &&
    !ctx.caps!.supportedEfforts!.includes(b.reasoning_effort as 'low' | 'medium' | 'high'),
  apply: (b, ctx) => {
    const supported = ctx.caps!.supportedEfforts!;
    const want = EFFORT_ORDER.indexOf(b.reasoning_effort as typeof EFFORT_ORDER[number]);
    let best = supported[0];
    let bestDist = Infinity;
    for (const e of supported) {
      const d = Math.abs(EFFORT_ORDER.indexOf(e) - want);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    b.reasoning_effort = best;
  },
};

const PROCESSORS: ModelRequestProcessor[] = [responsesNativeFallback, reasoningSupport, toolsGate, effortClamp];

export function applyModelRequestProcessors(body: Record<string, unknown>, ctx: RequestContext): void {
  for (const p of [...PROCESSORS].sort((a, b) => (a.priority ?? 1000) - (b.priority ?? 1000))) {
    if (p.matches(body, ctx)) p.apply(body, ctx);
  }
}
