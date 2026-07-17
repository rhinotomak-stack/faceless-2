# Verification harness — the smartness safety net

The refactor rule: we only **extract / relocate / wrap / registry-ify**. We never
touch a prompt string, a parse/validate/enforce body, `callAI` taskType routing,
the vision chain, a deterministic floor, or a cache key. This harness *proves* that.

Run before **and** after every refactor step. Any regression = revert, don't "close enough".

## Tools (available now)

| Command | What it proves |
|---|---|
| `npm run verify:paths` | Every relative `require()` resolves + every file parses. **The folder-move guardrail.** Static — executes nothing. |
| `npm run verify:sacred` | Load-bearing "smartness" code anchors still exist verbatim (see `sacred-invariants.json`). Tripwire against a refactor gutting a body. |
| `npm run verify:plan <baseline.json> <candidate.json>` | Two `video-plan.json` are identical after normalizing volatile noise (abs/tmp paths → basename, timestamps stripped, keys sorted). **An empty diff = the AI output is unchanged.** |
| `npm run verify` | paths + sacred together (quick gate). |

`sacred-invariants.json` is a living checklist — **add anchors as each phase lands**,
and when a file legitimately moves (P1), update its path here in the same commit.

## Golden-fixture + record-replay (wire before P5)

The static tools gate the mechanical phases (quick wins, folder reorg, settings
schema, format/mode registries). The **behavior-risky** phases (P5 agent registry,
P6 pipeline registry) additionally need a live-build proof:

1. **Golden fixtures** — freeze 3 scripts (documentary / listicle / talking-head) +
   their audio + a pinned `.env`. Commit each normalized baseline `video-plan.json`
   (via `verify:plan`) and a rendered hero-frame PNG.
2. **Record-replay** — capture the real AI responses once (`callAI` / `callVisionAI`
   keyed by input hash), then replay them so a refactor build is deterministic and a
   non-empty `verify:plan` diff means a *real* behavior change, not LLM randomness.
   (User-approved approach. Implement as a gated, no-op-when-off hook.)
3. **ON/OFF matrix** — run each agent with its flag ON and OFF; both the deterministic
   floor and the AI-override output must match their own baseline.
4. **Render proof** — render the hero frame via the real HyperFrames CLI, pixel-compare.
5. **Cache proof** — re-run/open-mode build makes **0** AI calls (protects OPEN MODE).

Capturing the golden baseline needs one real successful build (vision backend up +
provider keys), so it's scheduled just before P5.

## Migration phases (see memory `project_professionalization_goal`)
P0 harness → QW quick wins → P1 folder reorg → P2 settings schema → P3 format
registry → P4 production-mode registry → P5 agent registry → P6 pipeline registry →
GEN generation-provider registry → P7 AI Stories → P8 UI modularization.
