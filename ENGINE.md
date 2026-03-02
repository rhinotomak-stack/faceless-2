# WYSIWYG WebGL2 Compositor Engine

## Why

The app previously had 3 independent rendering paths (HTML preview, Remotion export, FFmpeg export) that produced visually different output. This engine provides a **single `renderFrame(n)` method** used by both preview and export, guaranteeing pixel-perfect WYSIWYG.

## Architecture

```
video-plan.json
       |
       v
  SceneGraph          (frame-based timeline: scenes, MGs, transitions)
       |
       v
  Compositor           (WebGL2 engine)
   |       |       |
   v       v       v
 VideoSrc  MGRenderer  TransitionRenderer
 (textures) (Canvas2D)  (GLSL shaders)
       |
       v
  Preview: <canvas> (real-time via rAF)
  Export:  readPixels -> IPC -> FFmpeg NVENC
```

## Modules (`ui/js/compositor/`)

| Module | Responsibility |
|--------|---------------|
| `ShaderLib.js` | GLSL shader sources (quad, blit, crossfade, wipe) + WebGL2 compile utilities |
| `TextureManager.js` | Create/update/release GPU textures from video/image/canvas elements |
| `SceneGraph.js` | Parse video-plan.json into frame-based timeline, query active layers at any frame |
| `AnimationUtils.js` | Spring physics + interpolation (exact Remotion port for MG animations) |
| `MGRenderer.js` | Render motion graphics via Canvas2D -> upload as WebGL texture |
| `TransitionRenderer.js` | Shader-based transitions (crossfade, wipe) between two scene textures |
| `Compositor.js` | Main engine: WebGL2 context, renderFrame() pipeline, video management |
| `ExportPipeline.js` | Offline frame loop: renderFrame -> readPixels -> IPC -> FFmpeg |

## Render Pipeline (per frame)

1. **Clear** to black
2. **Query** SceneGraph for active scenes at this frame (sorted by track)
3. **Check** for active transition
4. If **transition**: upload both scene textures, blend via TransitionRenderer shader
5. Else: **blit** each scene texture (fit-mode transform: cover/contain + scale + offset)
6. **Overlay** MGs: MGRenderer draws to Canvas2D, uploads as alpha texture, blend over
7. **Export only**: `gl.readPixels()` -> flip vertical -> IPC to main process -> FFmpeg stdin

## Video Decoding

- Hidden `<video>` elements per scene (created in `Compositor.loadPlan()`)
- Frame upload: `gl.texImage2D(TEXTURE_2D, 0, RGBA, RGBA, UNSIGNED_BYTE, videoElement)`
- Chromium performs GPU-to-GPU copy (fast, no CPU readback)
- Preview: videos play in sync with `<audio>` master clock
- Export: videos are seeked frame-by-frame (`video.currentTime = frame/fps`)

## Motion Graphics (JSON Spec)

MGs are consumed directly from `video-plan.json.motionGraphics[]` format:
```json
{ "type": "headline", "text": "...", "subtext": "...",
  "startTime": 5.2, "duration": 4.0, "position": "center", "style": "clean" }
```

The engine converts times to frames internally. MGRenderer draws each type using Canvas2D (ported from `canvas-mg-renderer.js`) and uploads as a texture. Animations use the same Remotion-compatible spring physics.

**Currently implemented**: headline
**Future**: all 17 MG types (see Migration Plan below)

## Export Pipeline

```
Renderer Process                    Main Process
  |                                   |
  |--[start-webgl-export]------------>| spawn FFmpeg -f rawvideo ...
  |  for each frame:                  |
  |    seek videos                    |
  |    compositor.renderFrame(f)      |
  |    gl.readPixels() -> Uint8Array  |
  |--[export-frame, buffer]---------->| ffmpeg.stdin.write(buffer)
  |--[finish-webgl-export]----------->| close stdin, mux audio
  |<-[{ outputPath }]----------------|
```

Raw RGBA frames (1920x1080x4 = 8.3MB each) transferred via IPC structured clone. NVENC GPU encoding when available, CPU libx264 fallback.

## How to Use

1. **Preview**: Click "Engine: OFF" button in header to toggle ON (or select "WebGL2 Engine" in renderer dropdown)
2. **Export**: Select "WebGL2 Engine (WYSIWYG)" in renderer dropdown, click "Render Video"
3. **Validation**: In DevTools console: `state.compositor.computeFrameHash()` returns a hash of the current frame. Compare between preview and export to verify WYSIWYG.

## Coexistence

The engine runs alongside the existing HTML preview and FFmpeg/Remotion export paths. Toggle compositor mode on/off without losing either system. The renderer dropdown selects which export path to use.

## Migration Plan

| Slice | What |
|-------|------|
| 0 (current) | 1 video + headline MG + crossfade transition |
| 1 | Multi-track (3 tracks), images, fitMode/scale/pos, backgrounds |
| 2 | All 14 canvas-renderable MG types |
| 3 | Fullscreen MG scenes on track-3 |
| 4 | Full transition library as GLSL shaders |
| 5 | Audio mux with SFX in export |
| 6 | Visual effects + overlay clips as post-process shaders |
| 7 | Export optimization (PBO async readback, SharedArrayBuffer) |
| 8 | Make default, retire HTML preview + Remotion export |
