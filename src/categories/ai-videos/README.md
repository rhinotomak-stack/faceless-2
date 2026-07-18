# AI Videos category

Everything for the **AI Videos** production mode lives in this one folder. Nothing
AI-Videos-specific should leak into the shared build pipeline — if you're adding an
AI-Videos capability, you should only ever touch files in here.

## Layout

| File | Responsibility |
|---|---|
| `index.js` | The category descriptor (id/label/allowedFormats/generation) + `pipeline` entry. Registered in `src/categories/index.js`. |
| `pipeline.js` | The isolated **script → generated clips** flow. Ordered, named stages; runs end-to-end today (stops after INPUT) and lights up as stages are added. |
| `script-input.js` | Stage 1 — normalize pasted story/link into clean script text. Pure, unit-tested. |
| `scene-planner.js` | *(next)* Stage 2 — split the script into scene beats. |
| `prompt-generator.js` | *(next)* Stage 3 — write a generation prompt per scene. |

## The pipeline stages (in `pipeline.js`)

```
1. INPUT     script-input.js       normalize story/link → clean script      [done]
2. SCENES    scene-planner.js      script → scene beats (text + timing)     [next]
3. PROMPTS   prompt-generator.js   per-scene → generation prompt            [next]
4. GENERATE  (reuses the Kling/Veo engine in the media layer)              [next]
5. PLAN      assemble a renderer-ready video-plan.json                     [next]
```

A single `ctx` object is threaded through every stage, so a new stage that needs data
from an earlier one just reads `ctx`.

## How to add a feature to AI Videos

1. If it's a new **stage**, add a `<stage>.js` here exporting the stage function, then
   add a `require('./ <stage>')` seam in `pipeline.js` (the pattern is already there —
   unbuilt stages are optional and no-op).
2. If it's a **setting**, add the control to the UI, gate it to AI Videos via
   `_MODE_SHOW` / `_MODE_HIDE` in `ui/js/app.js`, and read it in this module.
3. Keep it pure where you can (no direct I/O / AI calls in the input/planning helpers)
   so it stays unit-testable.
4. Run `node scripts/verify-ai-videos.js` — the isolated tests for this module.

The shared pipeline never needs to change to grow AI Videos.
