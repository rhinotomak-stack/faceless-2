# AI Videos category

Everything for the **AI Videos** production mode lives in this one folder. Nothing
AI-Videos-specific should leak into the shared build pipeline — if you're adding an
AI-Videos capability, you should only ever touch files in here.

## Layout

| File | Responsibility |
|---|---|
| `index.js` | The category descriptor (id/label/allowedFormats/generation) + `pipeline` entry. Registered in `src/categories/index.js`. |
| `pipeline.js` | The isolated **script → generated clips** flow. Ordered, named stages; runs end-to-end. |
| `source-loader.js` | Secure TXT/Markdown/RTF/JSON/subtitle/HTML/DOCX/ODT/EPUB and public-URL text import. |
| `script-input.js` | Stage 1 — normalize imported/pasted story text. Pure, unit-tested. |
| `scene-planner.js` | Stage 2 — split the script into scene beats (deterministic; AI splitter is a drop-in tweak). |
| `prompt-generator.js` | Stage 3 — write a generation prompt per scene (template; AI writer is a drop-in tweak). |
| `generate.js` | Stage 4 — one clip per prompt. Dry-run by default; real Kling/Veo behind `opts.generate`. |
| `plan-builder.js` | Stage 5 — assemble scenes + clips into a renderer-shaped video-plan. |

## The pipeline stages (in `pipeline.js`)

```
1. INPUT     script-input.js       normalize story/link → clean script      [done]
2. SCENES    scene-planner.js      script → scene beats (text + timing)     [done]
3. PROMPTS   prompt-generator.js   per-scene → generation prompt            [done]
4. GENERATE  generate.js           prompt → clip (Kling/Veo; dry-run def.)  [done]
5. PLAN      plan-builder.js       scenes + clips → video-plan object       [done]
```

The whole flow is unit-tested in **dry-run** (`scripts/verify-ai-videos.js`) and the
app invokes it with real generation enabled. Generator, resolution, quality, niche,
theme, title, and creator instructions are carried into the script build.

AI Videos also supports a narration-first route: when narration audio is selected,
the normal build pipeline runs transcription, Director, Visual Planner, subtitles,
and audio timing, then forces every eligible visual scene through the AI-video lane.

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
