# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Electron desktop app that generates faceless YouTube videos from audio narration. Uses AI to analyze scripts, download footage, create motion graphics, plan transitions, and render final video via WebGL2.

## Commands

```bash
npm start          # Launch Electron app
npm run dev        # Launch with DevTools
npm run build      # Run AI build pipeline (src/build-video.js)
npm run render     # Use in-app WebGL2 renderer
npm run all        # Build pipeline
npm run preview    # Launch with DevTools
```

## Architecture

**Electron app**: `main.js` (main process), `preload.js` (IPC bridge), `ui/` (renderer)

**Build pipeline** (`src/build-video.js`) runs ~10 steps sequentially:
1. Clean → Find audio → Transcribe (Whisper)
2. **AI Director** (`ai-director.js`) — scene splitting, context extraction, format/hook/CTA detection
3. **Visual Planner** (`ai-visual-planner.js`) — batch keyword generation for all scenes in one AI call
4. **Download Media** (`footage-manager.js`) — multi-provider parallel downloads with smart priority per scene
5. **Vision Analysis** (`ai-vision.js`) — ffmpeg frame extraction + AI analysis of downloaded clips
6. **Motion Graphics** (`ai-motion-graphics.js`) — placement of 15+ MG types (charts, headlines, stats, etc.)
7. **Transitions** (`ai-transitions.js`) — algorithmic 70/30 rule, theme-aware, zero AI cost
8. **Visual Effects** (`ai-effects.js`) — overlay selection + CSS effects
9. **Overlay Download** (`overlay-manager.js`) — grain/dust/lightLeak video clips from Pexels/Pixabay
10. Build `video-plan.json` → copy assets to `public/`

**AI Provider layer** (`src/ai-provider.js`): Unified `callAI()` and `callVisionAI()` supporting 8 providers (Ollama, Claude, OpenAI, DeepSeek, Qwen, Gemini, NVIDIA, Groq). Config in `src/config.js`.

**Rendering** (`ui/js/compositor/`): WebGL2 compositor with Canvas2D MG renderer. `MGRenderer.js` renders 15+ MG component types. Multi-track scene compositing, transitions, MGs, overlays, audio, subtitles.

**UI** (`ui/js/app.js`): Timeline editor with 3 video tracks, preview player with zoom/pan, clip properties panel, build settings. All state managed in a single file.

## Multi-Track Video System

- 3 tracks: `video-track-1` (base, z:1), `video-track-2` (middle, z:2), `video-track-3` (top, z:3)
- Each scene has `trackId` property; tracks composite together via CSS grid
- `loadActiveScenes()` loads all scenes active at current playhead across all tracks
- Fullscreen MGs go on track-3, overlay MGs on track-2

## Key Data Flow

All steps produce data that feeds into `public/video-plan.json`, which is the contract between the build pipeline and WebGL2 renderer. Key fields: `scenes[]`, `mgScenes[]`, `transitions[]`, `visualEffects[]`, `overlayScenes[]`, `scriptContext`, `sfxClips[]`.

## Critical Patterns

- **`renderTimeline()` uses innerHTML** — must reset `_cachedPlayhead/_cachedTimelineScroll/_cachedTimelineTime = null` before innerHTML or playhead freezes from stale DOM refs
- **Undo/redo must call `loadActiveScenes()`** after restoring scenes or preview desyncs
- **Font names with double quotes break HTML `style=""`** — must `.replace(/"/g, "'")`
- **Gemini vision uses native `box_2d` format** (0-1000 scale), NOT the OpenAI-compat endpoint for bounding boxes
- **All build steps have try/catch** with graceful degradation — missing API keys skip steps, don't crash

## NVIDIA Key Rotation

`src/nvidia-client.js` rotates multiple API keys (comma-separated in `NVIDIA_API_KEYS` env var). Switches on 429/401/403 status codes AND timeouts. Text and vision models are separate (`NVIDIA_MODEL` and `NVIDIA_VISION_MODEL` env vars).

## FFmpeg GPU Renderer (`src/ffmpeg-renderer.js`)

Reads `video-plan.json`, uses pure FFmpeg compositing + NVENC GPU encoding.

**Pipeline**: Pass 1 (prep clips, parallel, limit=2) → Pass 1.5 (MG pre-render) → Pass 2 (filter_complex_script compose + encode)

**MG Rendering** — Canvas-based:
- `src/canvas-mg-renderer.js`: @napi-rs/canvas (Rust/Skia) renders 14 MG types at ~200fps. Raw RGBA piped to FFmpeg → **FFV1 lossless in MKV** (`-c:v ffv1 -pix_fmt yuva444p`) for guaranteed alpha transparency. Outputs `mg-overlay-N.mkv` / `mg-fullscreen-N.mkv`.
- `src/mg-style-utils.js`: Shared styles/colors between canvas renderer and MG components

**Critical bugs found and fixed**:
- `scene.duration` is in FRAMES not seconds — `getSceneDurationSec()` uses `endTime - startTime`
- VP8/VP9 WebM alpha is unreliable — switched to FFV1 MKV for guaranteed alpha
- `renderFocusWord` scrim was drawing opaque fill on ALL MGs — wrapped in `isFullScreen` check
- CUDA `-hwaccel cuda` caused empty output files — removed entirely
- Single `_activeProcess` couldn't cancel parallel preps — changed to `_activeProcesses = new Set()`

**FFmpeg path**: `C:\ffmg\bin\ffmpeg.exe` (system FFmpeg with NVENC). NVENC probed once at startup, falls back to libx264.

## Theme System

7 themes in `src/themes.js` (tech, nature, crime, corporate, luxury, sport, neutral). Each defines colors, fonts, transition preferences, overlay preferences, MG style. Theme flows: AI Director selects → `directors-brief.js` allows override → stored in `scriptContext.themeId` → used by WebGL2 renderer + preview.

## Footage Providers

`src/providers/` contains provider classes (Pexels, Pixabay, Unsplash, Google Images, Google CSE, DuckDuckGo, Bing, YouTube, News). `footage-manager.js` orchestrates with smart per-scene priority based on `sourceHint` (stock/youtube/web-image). Downloads 3 scenes in parallel. `base-provider.js` rejects watermarked/small media.

## Environment

All API keys and build settings in `.env`. Key vars: `AI_PROVIDER`, provider API keys, footage provider keys, `BUILD_QUALITY_TIER` (mini/standard/pro), `BUILD_FORMAT`, `BUILD_THEME`, `AI_INSTRUCTIONS`.
