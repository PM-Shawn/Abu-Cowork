# Model data — how to keep it fresh

Model capability/pricing metadata is **generated at build time**, not hand-maintained.
Three layers merge into `../generated/modelData.generated.ts`, which `modelCapabilities.ts`
(`KNOWN_MODELS`) and `costTracker.ts` (`MODEL_PRICING`) consume.

```
vendor/models-dev.snapshot.json   ← pinned models.dev export. NEVER hand-edit.
overlay/volcengine.json           ← 火山豆包/aggregator models models.dev lacks (hand-written)
overlay/abu-overrides.json        ← per-id Abu-private fields + corrections (hand-written)
        │
        ▼  scripts/gen-model-data.ts   (npm run gen:models)
   ../generated/modelData.generated.ts  ← GENERATED, committed, do-not-edit
```

**Precedence (per field):** `abu-overrides > volcengine > models.dev > classifier-derived`.

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

Edit `overlay/volcengine.json` (or add another overlay file in the same shape:
`{ "models": [ ModelRecord, ... ] }`), then `npm run gen:models` → `npm test` → commit.

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
