> **CONTINUITY**: Read [SESSION-HANDOFF.md](SESSION-HANDOFF.md) first — it carries the cross-session state (current task, protocol, what was built). Transcript backups: .claude-session-backup/.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Electron desktop app that generates faceless YouTube videos from audio narration. Uses AI to analyze scripts, split scenes, download footage, author motion graphics, plan transitions/effects, and render the final video. The final render engine is the **HyperFrames Bridge** (HTML + GSAP compositions captured frame-by-frame), not WebGL2 or FFmpeg.

## Commands

```bash
npm start          # Launch Electron app
npm run dev        # Launch with DevTools (electron . --dev)
npm run preview    # Launch with DevTools
npm run build      # Run AI build pipeline (src/build-video.js)
npm run all        # Build pipeline (same as build)
npm run render     # (no-op) prints "Use the in-app HyperFrames renderer"
npm run qwen-status # Qwen vision model health (scripts/qwen-vision-status.js)
npm run qwen-sync   # Sync Qwen vision model registry
npm run storyblocks-cookies # Refresh Storyblocks cookies
```

## Architecture

**Electron app**: `main.js` (main process, IPC handlers, HyperFrames CLI runner), `preload.js` (IPC bridge), `ui/` (renderer).

**Build pipeline** (`src/build-video.js`) runs many sequential, numbered steps (with graceful degradation and resume/checkpoint support). Core flow:

1. **Step 0–1** — Clean artifacts → find audio → `directors-brief.js` (Director's Brief)
2. **Step 2** — Transcribe (`transcribe.js`: WhisperX preferred, vanilla Whisper fallback; `WHISPER_ENGINE`/`WHISPER_MODEL`)
3. **Step 3** — **AI Director** (`ai-director.js`) — scene splitting (via Smart Splitter: `speech-units.js` + `scene-boundary-scorer.js` + `scene-optimizer.js`), context/format/hook/CTA detection, theme selection
4. **Step 3.5** — **Map Assignment** (`map-assignment.js`) — deterministic per-scene map disposition
5. **Step 4** — **Visual Planner** (`ai-visual-planner.js`) — batch keyword/query/effects/mgHint planning for all scenes in one AI call
6. **Step 4.1** — Parse time-targeted directives from AI Instructions
7. **Step 4.8** — **Orchestrator pre-build review** (`build-orchestrator.js`) + map compile (`map-compiler.js`); writes resume checkpoint
8. **Step 4.85** — Editor Agent template rhythm (`editor-agent/ceo.js`)
9. **Step 4.9 / 4.95** — Topic footage scout (`topic-footage-scout.js`) + niche fallback pool
10. **Step 5** — **Download Media** (`footage-manager.js` + media subsystem, below), just-in-time vision scoring
11. **Step 5.05b** — **Editor Agent (CEO)** (`editor-agent/ceo.js`) — per-scene framing/effects decisions
12. **Step 5.1** — Aspect ratio & framing (legacy fill-in)
13. **Step 6** — **Motion Graphics** (`editor-agent/workers/motion-graphics.js`, legacy `ai-motion-graphics.js`) + map merge
14. **Step 6.05 / 6.06 / 6.07** — Explainer images, map images (MapTiler), map waypoint icons
15. **Step 6.5** — **AI Templates** (`editor-agent/workers/templates.js`, `ai-templates.js`)
16. **Step 6.9** — **HyperFrames Motion Director** (`hyperframes-motion-director.js`)
17. **Step 6.95** — SFX download (`sfx-provider.js`)
18. **Step 7** — Build `public/video-plan.json`
19. **Step 7.6** — **Composition Author** (`hf-template-author.js` via `editor-agent/workers/composition-author.js`) — agent-authored MGs
20. **Step 8** — Copy assets to `public/`

**AI Provider layer** (`src/ai-provider.js`): Unified `callAI()` and `callVisionAI()`. Config in `src/config.js`.
- **Text brain**: **AWS Bedrock** is the base brain (e.g. `deepseek.v3.2`), with per-task model split (`BEDROCK_PLANNER_MODEL`, `BEDROCK_UTILITY_MODEL`, `BEDROCK_FALLBACK_MODEL`). Hybrid routing via `_getTextRoute()` can put **AiLink** (GPT-5.5), **APlink** (Claude relay), **Azure Claude**, or **Azure OpenAI** (grok-4.3) *beside* Bedrock for specific task types, with Bedrock as auto-fallback.
- **Vision**: **Qwen-VL** self-hosted (vLLM on AWS GPU box / `QWEN_BASE_URL`, or Lightning rotation), falling back to **Bedrock** vision (Nova / Qwen-VL / Claude). Selected by `VISION_BACKEND` (`aws` default | `lightning` | `bedrock`), resolved by `config.resolveVisionBackend()`.
- Old providers removed: NVIDIA client, Gemini vision, Ollama/OpenAI/DeepSeek/Groq direct, Google CSE.

**Rendering — HyperFrames Bridge** (`src/hyperframes-bridge.js`): converts `video-plan.json` into an HTML/CSS/GSAP composition (`index.html` with `window.__timelines['yta-hyperframes']`). The `hyperframes` npm CLI (v0.6.69) captures it frame-by-frame via `chrome-headless-shell`. `main.js` orchestrates via `runHyperframesCli()`. The in-app preview loads the *same* generated HTML in an iframe (`hyperframes-preview-frame`).

**Legacy WebGL2 compositor** (`ui/js/compositor/`): `Compositor.js`, `MGRenderer.js`, `ShaderLib.js`, `TransitionRenderer.js`, etc. Still present as an alternate in-app preview path (`initCompositor`/`loadPlanIntoCompositor`, `state.compositorActive`) but NOT the final render engine. The `src/ffmpeg-renderer.js` and `src/canvas-mg-renderer.js` files have been **removed**.

**UI** (`ui/js/app.js`): Timeline editor with 3 video tracks, HyperFrames preview + legacy compositor preview, clip properties panel, build settings. Large single-file state.

## Editor Agent (CEO + Workers)

`src/editor-agent/ceo.js` orchestrates lazy, per-scene and cross-scene batch workers. Each scene gains a `_editorAgent` field with worker decisions.

Workers in `src/editor-agent/workers/`:
- `framing.js` / `framing-strategy.js` — per-scene scale/fit/crop + strategy
- `motion-graphics.js` — MG placement (cross-scene batch)
- `templates.js` — fullscreen template cards + template rhythm
- `transitions.js` — algorithmic transition floor
- `transition-director.js` — brain call: motivated per-boundary transitions
- `effects-director.js` — brain call: per-scene film-FX recipe + background pack
- `icon-director.js` — word-synced explainer icons/photos over footage
- `composition-author.js` — drives `hf-template-author.js` (agent-authored HTML/GSAP MGs)
- `explainer-images.js` — explainer image search + bg removal
- `map-assets.js` — map image/icon assets
Plus `frame-extractor.js`, `scene-context.js`.

## HyperFrames Engine Modules

- `hyperframes-bridge.js` — plan → HTML/GSAP composition (final render + preview)
- `hf-template-author.js` — agent authors bespoke MGs (textual + numeric-whitelist + visual lint + repair round + cache `.hf-authored-cache.json`; perfectionist vision review; OPEN MODE is cache-only, never calls AI on open)
- `hf-visual-lint.js` — rendered-pixel checks (overflow/overlap/invisible/no-entrance/overlay-coverage) + `captureHeroFrame`
- `hf-effects.js` — 17 animated CSS/GSAP effects + 9 grades (era rule: one era family per video)
- `hf-background-packs.js` — 7 theme-tinted scene backgrounds, one per video
- `hf-design-doc.js` — DESIGN doc / design tokens for authored comps
- `map-hf-builder.js` — SVG+GSAP map compositions (real OSM borders, 5 styles, journey camera)
- `subject-image-fetcher.js` — on-demand subject photo fetch for named entities

## Key Data Flow

All steps feed `public/video-plan.json` — the contract between the build pipeline and the HyperFrames renderer. Key fields: `scenes[]`, `mgScenes[]`/`motionGraphics[]`, `transitions[]`, `overlayScenes[]`, `scriptContext`, `sfxClips[]`, plus authored-composition and effect-recipe metadata.

## Multi-Track Video System

- 3 tracks: `video-track-1` (base, z:1), `video-track-2` (middle, z:2), `video-track-3` (top, z:3)
- Each scene has a `trackId`; tracks composite together
- `loadActiveScenes()` loads all scenes active at the current playhead across tracks
- Fullscreen MGs on track-3, overlay MGs on track-2

## Critical Patterns

- **`renderTimeline()` uses innerHTML** — reset `_cachedPlayhead/_cachedTimelineScroll/_cachedTimelineTime = null` before innerHTML or the playhead freezes from stale DOM refs
- **Undo/redo must call `loadActiveScenes()`** after restoring scenes or preview desyncs
- **Font names with double quotes break HTML `style=""`** — `.replace(/"/g, "'")`
- **Authored comps must open with `gsap.set` initial states** (entrance guard) — the bridge primes each timeline (`progress(1,true).progress(0,true)`) to avoid frame-0 showing the finished layout
- **All build steps have try/catch** with graceful degradation — missing API keys skip steps, don't crash
- **HyperFrames render REQUIRES `chrome-headless-shell`** — `main.js` locates/repairs it (`findHyperframesHeadlessShell`, `purgePartialHyperframesBrowser`); DevTools remote-debug on port 9223

## Theme System

**8 themes** in `src/themes.js`: `crime`, `history`, `modern`, `minimal`, `standard`, `warm-editorial` (light cream/serif), `luxury` (black/gold), `nature` (forest). Each defines colors, fonts, transition prefs, overlay/effect params, MG style overrides. Light-canvas themes supported (textSecondary derives from text color, theme-derived bg tones, per-theme default map basemap). Theme flows: AI Director selects → `directors-brief.js` allows override → `scriptContext.themeId` → renderer + preview.

## Niche System

`src/niches.js` — **two categories**, ~18 niches, controlling content strategy (allowedMGs, footagePriority, pacing, searchPolicy, mapPolicy, mgRules):
- **explainer.\*** (educational/documentary): `nature`, `crime`, `business`, `luxury`, `sport`, `history`, `motivation`, `food`, `diy`, `military`, `politics`, `tech`
- **news.\*** (breaking events): `politics`, `economy`, `military`, `celebrity`, `tech`, `sport`

News niches use youtube/reddit/stock — never stock-priority. Visual Planner picks per-scene effects (theme pool) and mgHint (niche allowedMGs).

## Media / Footage Subsystem

`src/providers/` — provider classes: `pexels-image`, `pexels-video`, `pixabay-image`, `pixabay-video`, `reddit-video`, `youtube-video`, `bing-image`, `brave-image`, `storyblocks-video`, plus `base-provider.js` (rejects watermarked/small media) and `ytdlp-utils.js`.
**Removed providers**: nvidia-client, google-cse/google-images/bing-images (old), unsplash, vk-video, telegram-video.

Orchestration layer:
- `footage-manager.js` — downloads scenes in parallel with per-scene priority from `sourceHint` (stock/youtube/web-image), inline vision scoring
- `media-agent.js` / `media-hunter.js` / `media-scout.js` — agentic query planning + retrieval
- `candidate-referee.js` / `candidate-race.js` / `candidate-finalist-scout.js` — candidate selection, clean-beats-defective rule
- `clip-analyzer.js` / `clip-prescreen.js` — Omni multi-frame clip vetting
- `vision-score-sanity.js` — clamps self-reported defects (broadcast packaging, low-res)
- `retrievability-rescue.js` — rewrites un-findable visual intents into findable B-roll BEFORE download
- `title-sanity.js`, `source-policy.js`, `media-memory-bank.js`, `media-intent-controller.js`

## Environment

All API keys and build settings in `.env`. Key vars: `AI_PROVIDER` (`bedrock` / hybrid), Bedrock creds + model split vars, `VERTEX_*`/`AZURE_*`/`AILINK_*`/`APLINK_*` for hybrid brains, `VISION_BACKEND` + `QWEN_BASE_URL` + `QWEN_VISION_API_KEY`, footage provider keys, `BUILD_QUALITY_TIER`, `BUILD_FORMAT`, `BUILD_THEME`, `BUILD_MAP_STYLE_PACK`, `AI_INSTRUCTIONS`, `WHISPER_ENGINE`/`WHISPER_MODEL`. HyperFrames feature flags: `HF_AUTHOR_PERFECTIONIST`, `HF_AUTHOR_SUBJECT_FETCH`, `HF_AUTHOR_OVERLAYS`, `HF_AUTHOR_REFRESH`, `HF_TRANSITION_DIRECTOR`, `HF_ICON_DIRECTOR`, `HF_BACKGROUND_PACKS`, `HF_FACE_ANCHOR`.
