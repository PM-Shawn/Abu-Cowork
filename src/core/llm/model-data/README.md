# Model data — how to keep it fresh

Model capability/pricing metadata is **generated at build time**, not hand-maintained.
A pinned snapshot, the model overlays, and the per-id override layer merge into
`../generated/modelData.generated.ts`, which `modelCapabilities.ts` (`KNOWN_MODELS`) and
`costTracker.ts` (`MODEL_PRICING`) consume.

```
vendor/models-dev.snapshot.json   ← pinned models.dev export. NEVER hand-edit.
overlay/volcengine.json           ← 火山豆包/aggregator models models.dev lacks (hand-written)
overlay/local-models.json         ← Ollama/LM Studio local models (hand-written)
overlay/deepseek.json             ← DeepSeek models newer than the snapshot (hand-written)
overlay/abu-overrides.json        ← per-id Abu-private fields + corrections (hand-written)
        │
        ▼  scripts/gen-model-data.ts   (npm run gen:models)
   ../generated/modelData.generated.ts  ← GENERATED, committed, do-not-edit
```

**Precedence (per field):** `abu-overrides > model overlays > models.dev > classifier-derived`.
The model overlays are concatenated, so an id must appear in only one of them.

## Why two output fields

models.dev's `limit.output` is the model's **maximum output capability**. Abu needs a
**conservative per-turn request budget** (what it actually sends as `max_tokens`). So:

- `maxOutputTokens` = request budget = `min(ceiling, thinking==='uncontrollable' ? 32768 : 128000)`.
  Knob-less reasoning models are bounded hard; controllable/plain models keep a generous cap.
- `outputCeiling` = the true model max. Used by agentLoop's max_tokens-recovery escalation
  to climb toward the real limit only when a turn actually needs it.

`contextWindow` is the upstream value; `resolveEffectiveContextWindow()` clamps it to the
user's setting, so a large upstream window (e.g. Claude 4.x at 1M) never over-claims.

## What models.dev cannot give us (lives in overlays / a classifier)

- `thinking` **protocol type** (`anthropic` / `openai-reasoning` / `qwen` / `uncontrollable`) —
  upstream only has a `reasoning` boolean; the protocol is derived in `classify.ts`.
- `toolResultImages` (`native` / `workaround` / `none`), `documentBlock` — derived in `classify.ts`.
- 火山引擎/豆包 — models.dev has no such provider; hand-written in `overlay/volcengine.json`.

## Routine: refresh from models.dev

```bash
npm run sync:models             # dry run — review the added/removed/price/window diff
npm run sync:models -- --write  # accept it (overwrites the snapshot wholesale)
npm run gen:models              # regenerate the TS table
npm test                        # pretest runs gen:models:check + full suites
git add src/core/llm/model-data src/core/llm/generated
git commit -m "chore(model-data): refresh from models.dev"
```

Because all hand edits live in `overlay/*` and never in the snapshot, re-syncing is always a
clean whole-file replace — no merge conflicts with your edits.

## Add a model models.dev doesn't have

Edit the overlay that owns that vendor (or add another overlay file in the same shape:
`{ "models": [ ModelRecord, ... ] }` — then wire it into `loadAndMerge()` in
`scripts/gen-model-data.ts`), then `npm run gen:models` → `npm test` → commit.

**Worked example — `overlay/deepseek.json` (`deepseek-v4-flash-vision-exp`).** DeepSeek's
vision route shipped after the pinned snapshot, and it is the only DeepSeek id that accepts
image input. Three choices in that entry are worth copying when the next such model lands:

- **Overlay, not a `modelCapabilities.ts` pattern.** The runtime pattern fallback is
  `/deepseek/i → vision:false`, so the vision id would otherwise resolve as text-only and
  `normalizeMessages` would strip every image. Fixing that in the pattern would move the
  default for the whole `deepseek-*` family; an overlay entry is scoped to one exact id, and
  following an `-exp` id as it moves stays a one-line JSON edit.
- **Mirror the sibling model, vary only what actually differs.** Every field is copied from
  `deepseek-v4-flash` (the vision route is that model plus image input, and the official
  pricing table lists identical price/context/max-output) except `vision` and
  `toolResultImages`. `toolResultImages: "workaround"` because DeepSeek tool messages carry
  string content only — `openai-compatible.ts` already re-emits tool-result images as a
  following user message, which is what that label names.
- **Omit `pricing` when a shorter id prefix already prices it.** `costTracker`'s
  `findPricing` matches by longest id prefix, so `deepseek-v4-flash-vision-exp` inherits
  `deepseek-v4-flash`'s numbers. Hand-copying them would go stale the first time a snapshot
  refresh repriced flash, and nothing would flag the drift.

## Correct a wrong upstream value

Add an entry to `overlay/abu-overrides.json` keyed by exact model id, e.g.:

```json
{ "overrides": { "deepseek-chat": { "vision": false } } }
```

Any `ModelRecord` field can be overridden (vision, thinking, maxOutputTokens, contextWindow, …).
Never edit `vendor/models-dev.snapshot.json` by hand.

## Build safety

`npm run build` and `npm test` both run `gen:models:check` first, which fails if the committed
generated file is out of sync with the layers — so a stale generated table can't ship.
