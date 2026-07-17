# SESSION HANDOFF — read this to continue exactly where we left off

> Maintained by Claude. Updated July 6, 2026 (doc/memory resync). If you are a
> fresh Claude session (any account): read this + MEMORY.md (auto-loaded) and
> you have full context. The literal transcript backup lives in
> `.claude-session-backup/` (jsonl files — restorable to
> `C:\Users\user\.claude\projects\D--Youtube-YTA-EMPIRE-WEBGL\`).

## LATEST — July 6, 2026: docs + memory resynced to code
User asked to sync all docs with the codebase. Done, verified against actual files:
- **CLAUDE.md fully rewritten** to match reality: render engine is the
  **HyperFrames Bridge** (`src/hyperframes-bridge.js` → `hyperframes` CLI,
  captured via chrome-headless-shell in main.js), NOT WebGL2/FFmpeg. The
  `ffmpeg-renderer.js` + `canvas-mg-renderer.js` files are GONE; the WebGL2
  compositor (`ui/js/compositor/`) is legacy in-app preview only. Documented
  the 20-step build pipeline, the editor-agent CEO + 11 workers, the media
  subsystem, 8 themes, ~18 niches.
- **AI brain architecture changed** (new since the June-12 log below): text =
  **AWS Bedrock base** (deepseek.v3.2 default) + **hybrid brains beside it** —
  AiLink (GPT-5.5), APlink (Claude relay), Azure Claude, Azure OpenAI. **Grok
  is BACK** — served via the Azure OpenAI-compat endpoint (`config.azureOpenAI`,
  grok-4.3), NOT Vertex (the "Grok abandoned" note below is superseded).
  Vertex/Gemini (`vertex-auth.js`) now powers ONLY Style Studio / QA / Style
  Learner. Vision unchanged: Qwen-VL (self-hosted) → Bedrock fallback,
  selected by `VISION_BACKEND`.
- **Memory updated:** new `project_brain_architecture.md`; MEMORY.md index
  compacted (was ~23KB → ~14KB) + stale one-liners fixed (themes 5→8, vision
  chain, explainer.politics, Grok status); `project_removed_disabled.md` gained
  the FFmpeg/canvas-renderer + deleted-provider removals.
- No open task was in flight; this was a documentation pass only. The June-12
  build-feature history below remains accurate as history.

## Who/what
Solo dev building a VidRush-class faceless-video platform (this repo).
Render engine: **HyperFrames Bridge (HTML/MG)** — HTML+GSAP compositions,
captured frame-by-frame by the hyperframes CLI. Test project:
`C:\Users\user\Downloads\Mps Fixing` (Red Sea/shipping niche, ~38 scenes).

## Working protocol (MANDATORY — user-mandated)
Fix → self-review → verify on the REAL pipeline (generate the actual HF
project) → SCREENSHOT PROOF shown to user → check upstream decisions (VP/
Director/briefs) → anything off = root-cause + fix siblings → re-verify.
Screenshot tooling: headless Chrome on generated `index.html`
(`window.__timelines['yta-hyperframes'].time(t)` then screenshot), ffmpeg
frame-extraction from MP4s, PrintWindow for the live app, DevTools port 9223.

## What was built June 10–11 (all verified with screenshots)
1. **Map system (GEOLayers-grade)** — `src/map-hf-builder.js` wired into
   `hyperframes-bridge.js`: real MapTiler basemaps, hi-fi OSM borders
   (threshold 0.00008, cap 22k pts), cartography stack (casing + 1.8px core +
   inner glow band 14px/0.20), zoom-adaptive labels (ZOOM_ADAPT k=0.35 via
   overlayScaleFor — icons later plug in here), camera zoom cap 2.0,
   mainland-framing (largest ring only), 3D pitch (rotationX tilt wrapper,
   route 9° / region 15°), draw-on animations. Verified on Spain vs GEOLayers.
2. **Agent-authored compositions** — templates + fullscreen MGs authored as
   bespoke HTML/CSS/GSAP by Sonnet (taskType=brain) via skill pack
   `skills/hyperframes-template/` + `src/hf-template-author.js` (textual lint
   + numeric whitelist [facts must come from brief] + `src/hf-visual-lint.js`
   rendered-pixel checks [overflow/overlap/invisible] + repair round + cache
   `.hf-authored-cache.json`, AUTHOR_VERSION v7). Runs in build Step 7.6 +
   render-prep. Overlay MGs stay on legacy path (user decision).
3. **Effects system** — `src/hf-effects.js` animated registry (grain/leak/
   flicker/vignette/bloom/chromaticEdge + 6 grades; letterbox REMOVED) +
   `effects-director.js` (1 batch brain call → scene._effectRecipe, cached
   `.hf-fx-cache.json`). Edge effects banned on framed clips (FULLFRAME_ONLY).
4. **Render-quality fixes** — video data-start (static-noise bug), @font-face
   embedding (16 woff2 in assets/fonts), backdrop coverage rule (any scale<1
   gets blurred-media backdrop; flat bgs tint OVER media blur), Ken Burns
   coverage (fromScale 1.06), preview centering (margin:auto + body grid).
5. **Footage fixes** — stock-query entity sanitizer (VP `_sanitizeStockQuery`),
   vision score-retry (ai-vision.js strict retry — was 30 unjudged/build),
   clip-analyzer Omni strict retry (was 11 parse fails/build), sanity-bump
   guard (maps/charts/labels never rescued), topic-map rescue demoted 7→5.
6. **Infra** — HF project dirs auto-pruned (keep 3), workers default 4,
   ENOSPC root-caused (C: was 0.6GB free), DevTools port 9223 in main.js.

## Current state (June 11 evening)
User just FINISHED A FRESH BUILD of Mps Fixing — the first with ALL fixes.
**NEXT TASK: full verification vs this scorecard** (log audit + screenshot sweep):
- Direct footage: was 17/25 → expect higher
- vision "unjudged": was 30 → expect 0 | Omni parse fails: was 11 → ~0
- map-image/heatmap B-roll: expect 0 | letterbox/black-box artifacts: 0
- media phase: was ~36min → expect shorter | maps: new system everywhere
Logs: `C:\Users\user\Downloads\Mps Fixing\logs\app-*.log` (newest).
A background watcher may have already flagged completion.

## Build verification June 11 night (DONE): direct footage 24/30 (was 17/25), unjudged 0 (was 30), Omni parse fails 0 (was 11), sources video-dominant, maps 7/7, author 23/25. HUMAN-EDITOR fixes applied post-audit: (1) rejectedAll marker — Omni all-frames rejection now KILLS the candidate instead of heuristic-trimming it in (clip-analyzer.js + youtube-video.js; was how TOI burned-banner clip shipped); (2) low-res/upscaled footage → MAX 4 rubric penalty (ai-vision.js). OPEN from sweep: empty frame moment at ~t=160 (dead air — uninvestigated); scene-frame overflow clipped (grain box == footage box now); stage-visual scale-in takeover entrances (user testing).

## Graphics balance (June 11, late): plan analysis showed templates 54% + maps 25% = 79% runtime coverage, footage visible 22% — inverted editing. ROOT: VP section-16 template triggers fire on every number/place/quote with no counterweight, and Editor-Agent mode preserves all hints. FIX (user mandate: NO hardcoded caps — agent judgment only): hardcoded budget REVERTED; added FOOTAGE-FIRST EDITORIAL JUDGMENT block to VP prompt (templates must EARN slots, no back-to-back graphic scenes, passing-mention numbers = footage + overlay, footage is the backbone). Verify next build: footage-visible share should rise sharply; if VP still over-hints, strengthen prompt further — never add caps.

## LOOK HUMAN rule (June 11, late night): user banned eyebrow/category labels
("• KEY TAKEAWAY", "• KEY CHOKEPOINT") on stage visuals — "all motion graphic
shit should look human not ai". Fixed globally, 3 layers: (1) SKILL.md hard
content rule (no meta-labels, every text element must tell the STORY not
describe the GRAPHIC); (2) brief no longer passes kicker (composition-author)
+ KICKER prompt line removed + generic lint rejects on-screen type-tag text
(hf-template-author, AUTHOR_VERSION v8-human-not-ai — full re-author on next
open); (3) legacy path: templateKicker + buildAgenticMarkup gated by
isStageVisual (person-intro exempt — its label is a real role; overlay MGs
untouched). VERIFIED: 4 keyTakeaways re-authored via real worker, screenshots
clean. SIBLING BUG found+fixed during verify: gsap was CDN-only — visual lint
ran with NO gsap (initial-state measurements wrong). gsap@3.14.2 now a
devDependency; lint measures real frames.

## Media asset pipe v9 (June 12): authored comps can now USE REAL IMAGES.
User showed VidRush-style examples (subject photo + animated callouts,
sketch charts) — gap was `assets: []` (author was media-blind). Now:
composition-author resolves up to 2 images per brief (mg's own media, else
owner/nearest footage scene within 12s, images only) as `__HF_ASSET_i__`
tokens + desc; prompt/linter token-aware; bridge substitutes real copied
paths at render (missing used asset → fixed-renderer fallback);
mg._authoredAssets persists. SKILL.md media playbook: subject board (photo
panel + callout cards + connector draw-ons), photo panel w/ Ken Burns,
blurred backdrop, cover-fit + scrim rules; house-style: connector pattern +
chart-build pattern (axes draw → bars grow → count-ups). AUTHOR_VERSION
v9-media-assets. VERIFIED on real plan: 17/25 briefs carry an image;
stat-card (8-9M barrels over real ship aerial) + comparison-card (VS split
over darkened gulf aerial) authored + screenshotted clean. Videos as
authored assets = future work (needs runtime seek-sync).

## Subject-image fetch v9.1 (June 12): asset-less authored beats that NAME a
Director-tagged entity now fetch ONE subject photo on demand.
`src/subject-image-fetcher.js` (Bing→Brave via live providers, base-provider
floors + PNG sanitize, deterministic cache `public/authored-assets/
subject-<slug>.png`) + `enrichBriefsWithSubjectImages` in composition-author
(entity picked from scriptContext.entities matched in the beat's own text,
ranked person>org>event>place; abstract beats correctly stay designed-bg;
HF_AUTHOR_SUBJECT_FETCH=0 disables). VERIFIED live: Houthi-forces quote-card
fetched a clean parade photo and authored a split quote+photo-panel comp
(screenshot shown). Needs user rebuild/reopen to land project-wide.

## Entrance guard v10 (June 12): user caught frame-0 of authored comps
showing the FINISHED layout (GSAP fromTo doesn't apply "from" until first
render). Fixed 3 layers: (1) bridge primes every authored timeline
(`tl.progress(1,true).progress(0,true)` before master.add) — fixes all comps
deterministically; (2) hf-visual-lint primes too + new t=0.03 check (all
text fully visible at t=0 → "no entrance animation" rejection into repair);
(3) SKILL.md contract: timeline must OPEN with gsap.set initial states.
AUTHOR_VERSION v10-entrance-guard. VERIFIED via re-rendered trump-demo.mp4
(frame 0 black/backdrop-only, entrance builds). ENTRY-ANIM AUDIT: legacy
templates/fullscreen/overlay MGs = hfEnterState takeover + graphicAnims ✓;
maps = explicit gsap.set initial states ✓; effects = ambient loops (no
entrance by design) ✓. Authored path was the only hole.

## Transition system v2 (June 12): replaced the lazy slab-only system.
(1) RUNTIME (hyperframes-bridge): scene-MOTION engine — push-l/r/up, wipe-l/
r/up (clip-path), whip-l/r (xPercent+blur), zoom-punch/pull, blur-dissolve,
spin-settle animate the ACTUAL scene containers; overlay slab kept only for
flash-white/dip-black/light-sweep/glitch. canonicalTransitionType now
direction-preserving; collectTransitionOverlays emits mode:'motion' items
with outId/inId (adjacent footage) or incoming-only when graphics precede.
BUG FIXED during verify: loop started at i=1 — first footage scene's
boundary was silently dropped whenever the video opens with graphics.
(2) BRAIN: src/editor-agent/workers/transition-director.js — 1 batch brain
call sees the FULL visual sequence (footage+templates+maps), assigns
motivated transitions per boundary (cut = default, ~25-35% visible budget,
signature-set consistency, location→whip, time→dissolve, reveal→zoom-punch,
act break→dip-black ≤2). Writes scene.transition {type,duration,reason} —
same contract as algorithmic pass (which stays as floor). Cache
.hf-tx-cache.json, HF_TRANSITION_DIRECTOR=0 disables. Wired into
authorPlanCompositions next to FX director.
VERIFIED on real Mps Fixing plan: 8/8 boundaries decided with editorial
reasons (6 visible), real project generated, 4-boundary MP4 demo rendered
(.tmp/map-test/transitions-demo.mp4) — blur-dissolve + dip-black + punches
confirmed on rendered frames.

## Overlay MGs → authored path (June 12): the last MG family converted.
composition-author now collects plan.motionGraphics as kind 'overlay'
(OVERLAY_EXCLUDED: listicle-counter/subscribe-cta/progress-tracker/caption;
HF_AUTHOR_OVERLAYS=0 reverts). Overlay briefs: NO assets (footage is the
image), position zone passed + hashed. SKILL.md OVERLAY MODE: transparent
stage, coverage ≤~30%, anchor in position zone, tight plates/shadows only,
smaller type, 1-2 elements, ≤0.45s entrance. hf-visual-lint overlay checks
(grid coverage >32% reject, single painted element >62% frame reject) —
negative-tested: full-frame scrim and oversized plate both rejected, clean
lower-third passes. Bridge: authored block accepts overlays,
data-hf-authored-overlay attr breaks container out of pos-* boxes
(inset:0, transform-locked), container enter is opacity-only (authored
timeline owns motion); mg._authoredRendered flags markup success for the
runtime. VERIFIED: real kineticText + synthetic lowerThird/statCounter
authored over real footage frame — broadcast-grade plates, footage stays
the star. Legacy agentic-spec path remains the fallback floor.

## Variety v11 (June 12): user rejected same-silhouette convergence ("i need
the agent to be creative... beautiful variants"). No fixed variants exist —
problem was model habit (every comp = dark plate + accent rule). Fix:
(1) SKILL.md VARIETY section — same-silhouette = failure mode, inspiration
repertoires for stage + overlays (frosted glass, bare shadow-text+underline,
pill badge, bracket frame, leader line, oversized numeral, ticker strip…),
"vary STRUCTURE/MOTION, never the palette"; (2) STYLE LEDGER — each comp's
fingerprint (kind/type/notes) accumulates during the batch; later briefs see
siblings' treatments + hard rule: 2+ plates already → MUST use different
construction. Seeded from cache hits; concurrency means first ~3 are blind.
AUTHOR_VERSION v11-variety. VERIFIED (5 sequential overlays): comps 1-3
plates, comp 4 varied accents/numeral, comp 5 broke silhouette entirely
(bare shadow-text + draw-on underline) — mechanism works, diversity grows
with ledger depth.

## Background packs (June 12): stylist scene backgrounds, ONE per video.
src/hf-background-packs.js — 7 theme-token-tinted CSS packs (studio-gradient,
spotlight, dot-matrix, blueprint-grid, paper-grain, bokeh-drift, split-tone),
each with slow GPU-friendly motion. Duplicate-blur backdrop stays the
universal default lane ('blur' scenes unchanged); scenes with FLAT background
choices (gradient:x/soft-x) now render the VIDEO's pack instead of generic
tints. Selection: effects director picks "videoBackground" in its existing
batch call (validated, cached in .hf-fx-cache.json → plan._hfBackgroundPack);
fallback = theme default map (crime→spotlight, history→paper-grain,
modern→dot-matrix, minimal→split-tone, standard→studio-gradient).
HF_BACKGROUND_PACKS=0 reverts to legacy tints. VERIFIED: real generation
(pack resolved+rendered+CSS injected, log line "[HyperFrames] Background
pack: …") + 7-pack gallery behind a framed clip; first pass was too subtle —
alphas/vignettes retuned for clear visibility. Future: UI dropdown override,
DESIGN-doc echo into authored comps.

## Explainer icons (June 12): word-synced animated visuals over footage.
src/editor-agent/workers/icon-director.js — 1 batch brain call reads footage
narration + Whisper word timings, assigns SPARSE icon moments (~quarter of
scenes max): kind "photo" (concrete things → web photo, watermark-filtered →
@imgly bg removal → transparent PNG; Storyblocks fallback) or "svg" (abstract
concepts → director-authored pictogram, strict sanitizer: shape tags only,
viewBox, currentColor, no scripts/links; QUALITY BAR: stranger names it in
1s). CUTOUT QUALITY GATE (canvas alpha measurement: solid 5-70%, bbox ≥25%)
rejects bg-removal ghosts — drops the moment rather than shipping garbage.
Bridge: icons render INSIDE scene wraps (travel with transitions), pop in
back.out on the trigger word, float, exit; theme-accent currentColor; 6
corner/side positions, never center. Cache .hf-icon-cache.json;
HF_ICON_DIRECTOR=0 disables. VERIFIED real pipeline: warning-triangle +
route pictograms clean; watermarked-ghost case caught by gate (subject
fetcher now also rejects watermark domains globally — benefits subject
photos too). THIRD KIND added same day: "image" — whole photograph kept
(no cutout), rendered as a small framed picture card (400×270, white
border, -1.6° tilt, shadow) for places/events/people/documents; verified
via real bridge render.

## Perfectionist mode v12 (June 12): the authored loop now SEES its work.
After lint passes, hf-template-author captures the hero frame
(captureHeroFrame in hf-visual-lint) and the VISION chain reviews it as an
art director: "APPROVE" or "REVISE: ≤3 concrete visual fixes" (hierarchy,
balance, alignment, AI-tells; never copy/facts). On REVISE: one refine round
with the critique + previous output; refined version must re-pass ALL lints
or the original ships (no regression). HF_AUTHOR_PERFECTIONIST=0 disables.
Cost: +1 vision call per comp, +1 author call only when revised.
AUTHOR_VERSION v12-perfectionist. VERIFIED live: both test comps got REVISE
(headline scale + left-align notes), refined cleanly — "BACKUP ROUTE" became
a left-aligned typographic poster with drawn arrow; "ANOTHER CHOKEPOINT"
became a left-aligned editorial layout over real footage with corner
brackets. This closes the "Claude Code can look at its result" gap.

## Rebuild diagnostic (June 12, log app-2026-06-12T11-32-52): user's first
full build with the entire stack. HEALTHY: FX 15/15 + blueprint-grid
(director-chosen), transitions 15/15 decided → 10 visible rendered (match),
icons 3 decided → 3 rendered (match), maps 8/8, art director 1 approved /
16 revised / 1 kept (review bites), lints caught fabricated 1869/7000/80 +
no-entrance + overlap (3 comps correctly fell back). BUGS FOUND + FIXED:
(1) authored OVERLAYS never rendered — the agentic-spec early return in
buildMgMarkup came BEFORE the authored block; moved authored to highest
priority; regen verified 15/15 rendered (was 12). (2) DOUBLE-AUTHOR per
build — ns embedded the candidates array INDEX; post-build plan mutations
shift indexes → render-prep cache misses (18+11 calls). ns now
content-hashed (auth-<type>-<sha6>), dedupe for identical briefs. One-time
cache bust. (3) BURNED-BANNER clip shipped (scene 5): referee SAW "visible
news graphics ('13' logo)" and picked it anyway over a clean 7/10 carrier
clip; post-download scorer also gave 7/10 while describing the defect.
Fixed: clampSelfReportedDefects in vision-score-sanity (description admits
broadcast packaging → score capped 4, deterministic, unit-tested incl.
negations) applied in applyMediaHunterFrameGate; HARD DEFECT RULE in
candidate-referee prompt (clean beats defective regardless of subject
match). (4) Author fabricated source line "Suez Canal Authority · UNCTAD"
on the bar-chart — NO INVENTED ATTRIBUTIONS rule added to SKILL.md factual
safety. FIXED same day — RAW MATERIAL PRINCIPLE added to
the VP keyword rules AND the source-auditor prompt (user mandate: global,
no word lists): "a query names what the CAMERA SAW — subject + action +
setting — never the packaging/distribution form of the content; you want
the rushes, not the broadcast; dates/sources belong in overlay MGs, not
queries." Generalizes across niches (news→coverage, tech→reviews,
sports→broadcast highlights all = packaging-form queries). REMAINING
OBSERVATION: art-director revise rate ~85% (quality good, cost +1
call/comp — tune APPROVE bar if cost matters).

## CapCut-class effects library (June 12): hf-effects grew 7→17 effects +
6→9 grades, all CSS/GSAP deterministic. NEW: filmScratches, vintageFrame
(rounded ring + breathing inner fade — the user's reference look), oldTv
(scanlines+roll), vhs (RGB ghosts + tracking band), staticNoise, glitchPulse
(sparse slice bursts every ~2.2s), lightStreaks, lensFlare (anamorphic
sweep), fogDrift, embers (irregular prime-tile particles). New grades:
sepia-archival, vhs-wash, neon-night. FULLFRAME_ONLY += vintageFrame/oldTv/
vhs/lensFlare/lightStreaks. Effects-director prompt: categorized vocabulary
with use-cases + ERA RULE (era looks = signature: max ONE era family per
video, only on past/archival/flashback content, never present-day). FX
cache hash now includes vocabulary → new menu auto re-decides. Tuning
lessons: scratch/scanline alphas need ~0.7+ to read at video scale; glitch
slices must be sparse (<25% coverage) or it reads broken; particle tiles
need prime sizes + irregular dot coords or the grid shows. All 10 verified
on real footage screenshots (3 rounds of tuning).

## Map journey (June 12): user flagged 4 adjacent map scenes rendering as
separate restarting maps + camera firing instantly at entry. ROOT: the
build-video merge refused "semantic mismatch" (route vs locator vs region) —
scenes 11-14 alternated modes so nothing merged. FIX: (1) adjacent maps now
ALWAYS merge into ONE map journey (only 'comparison' refuses); per-source
windows recorded as mg._mapSegments → merged.segments ({start,end,mode,
subjects} relative to merged span) in build-video + mergeMapScenes synthesis.
(2) map-hf-builder: segments → JOURNEY camera (wide establishing SET, hold
≥0.8s, then long power2.inOut glides arriving at each segment's frame ~35%
into its narration window; frameFor() resolves subject names → pins +
largestRingBBox borders; degenerate bbox → 1.5 zoom-in); pins/borders appear
at THEIR segment start (+0.45) not global stagger. (3) slow-start pacing for
ALL maps (non-segmented too): route hold ≤1.1s then eased 3-phase;
locator/region hold ≤0.9s then one long push-in — camera never moves on
frame one. VERIFIED: real mapScene + 3 segments → keyframes correct
(0.8/3.6/7.6 arrivals synced) + 4-frame screenshot journey (wide → Bab
el-Mandeb → Yemen border draw → Djibouti reframe). Takes effect on next
REBUILD (merge is build-time; current saved plan still has the split maps).

## Template chains (June 12): template→template boundaries are now SEAMLESS
(user: "the shift between template and template unnoticeable"). (1) Bridge:
stage-visual chains detected (adjacent, gap ≤0.35s, maps excluded) →
seamIn/seamOut flags on graphicAnims; runtime: seamIn = container appears
set (opacity1/scale1, NO takeover pop), seamOut = container exit anim
skipped (holds to clamp) — internal choreography carries the swap. Applies
to authored AND legacy templates. (2) Author: chainPrev/chainNext flags on
briefs (computed across stage candidates) → CHAIN CONTINUITY prompt lines:
"next page of the same design system, calm full-frame bg from DESIGN base
colors, content entrance carries the change / exit content but keep bg to
the last frame". Hash includes chain flags. VERIFIED: 7 seam pairs flagged
on the real regenerated page; 2 chained locationCards authored — A exits to
calm canvas, B opens on matching canvas, boundary invisible (4-frame grid).
Full effect on next rebuild (chained comps re-author with continuity).

## Grok hybrid brain (June 12): user wanted Grok BESIDE Bedrock — built
hybrid routing in _getTextRoute: AI_PROVIDER=bedrock + VERTEX_TASK_TYPES=
brain → vertex:grok serves brain tasks first, Bedrock auto-fallback
(verified live incl. degradation + 120s health cooldown). FOUND: the
Google openapi endpoint REJECTS API keys → added service-account auth
(VERTEX_CREDENTIALS_FILE via google-auth-library, 45min cache, re-mint on
401; no gcloud install needed — gcloud absent on this machine). .env has a
commented template (VERTEX_PROJECT_ID + VERTEX_CREDENTIALS_FILE +
VERTEX_TASK_TYPES=brain). User must supply GCP project + SA json + enable
the xAI Grok model in Model Garden.

## Grok LIVE + UI switch (June 12 evening): Grok 4.3 answering (SA auth,
role "Agent Platform User" — console renamed Vertex AI User; key at
C:/Users/user/.gcp/). VERTEX_REASONING_EFFORT=high wired into request body.
AI Provider dropdown gained "Bedrock + Grok 4.3 Brain (Vertex)":
dropdown → set-ai-provider IPC → applyBrainProvider (live process.env +
.env persist) → routes read VERTEX_TASK_TYPES live → switch flips without
restart (verified both directions, real calls). User must SELECT the new
option after restart (settings-load syncs dropdown → env; plain bedrock
clears the hybrid).

## Theme expansion (June 12 night): user asked if graphics adapt to themes
like the video does — pipeline was fully token-driven but ALL 5 themes were
dark. Added warm-editorial (LIGHT cream/orange/serif — matches user's
reference frame), luxury (black/gold), nature (forest) + editorial-light MG
preset + validators/UI dropdown/allowlists/signal rules + LIGHT-CANVAS
support: DESIGN doc light guidance, textSecondary derives from text color
(was white-on-cream bug), bg packs use theme-derived tones (no hardcoded
near-black), THEME_DEFAULT_MAP_STYLE (warm-editorial→light basemap etc).
VERIFIED: authored bar-chart under warm-editorial reproduced the user's
reference look exactly; packs render warm cream. See
project_theme_expansion.md.

## Zero-cost opens (June 12 night): user caught ANOTHER full re-author on
open — the theme-token fix (textSecondary) shifted the DESIGN doc by one
character → design.length in briefHash → all 18 hashes busted. STRUCTURAL
FIX: OPEN MODE — runCompositionAuthorPass passes openMode:true (render-prep/
open/refresh); authorCompositions in openMode is CACHE-ONLY: hit → use,
miss → reuse newest cache entry with same content-stable ns (entries now
carry .ns; user cache backfilled 54 entries), none → fixed renderer until
next build. It can NEVER call AI. Fresh authoring = builds only (Step 7.6
passes no openMode) or HF_AUTHOR_REFRESH=1. Directors also reuse saved
plan state on open (_txDirected / _iconMoments / _effectRecipe guards).
VERIFIED: simulated hash-busting drift → stale reuse, 0 calls. ALSO from
user log: .fvp does NOT persist _authoredComposition (only the disk cache
does); Grok hit 429 RESOURCE_EXHAUSTED mid-batch (low GCP quota for xai
model — concurrency 3 bursts exceed it), Sonnet fallback covered cleanly.

## Known open items / backlog
- Icons layer for maps (plug into ZOOM_ADAPT) — completes GEOLayers parity
- Batch thumbnail pre-screening before download (biggest media-time lever)
- Overlay MGs → authored path (pending user judgment)
- FX director vision upgrade (frame-aware effect choices)
- Suez Canal (thin waterways) needs point/line OSM treatment
- Outline misses hints for last 2 scenes; sfx-blur.mp3 missing
- Utility AI calls batching (160 calls/build)

## Style/voice notes
User: direct, fast, hates waiting, wants global root fixes ("fix it globally,
not one scene"), insists on screenshot proof, all niches (no politics
hardcoding). Address findings honestly, lead with results.
