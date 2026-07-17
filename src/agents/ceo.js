/**
 * Editor Agent — CEO
 *
 * Single orchestrator that takes editorial decisions for downloaded scenes.
 * Replaces ratio-based framing logic and (over time) all scattered per-scene
 * editorial AI passes (framing, MGs, templates, explainer images, icons,
 * effects, text overlays).
 *
 * Architecture:
 *   - Runs ONCE per build, AFTER media download.
 *   - For each scene: extract 1 representative frame, build a rich context,
 *     dispatch to workers based on which editorial decisions are needed.
 *   - Workers are LAZY — only spun up for the tasks a given scene requires.
 *   - Scenes are processed in parallel (cap = process.env.EDITOR_AGENT_CONCURRENCY,
 *     default 4) so 40-scene builds don't serialize the editorial pass.
 *
 * Output: each scene gains a `_editorAgent` field with the worker decisions,
 * and the canonical scene fields (framing, scale, background, fitMode, etc.)
 * are stamped to match — so the rest of the pipeline (video-plan.json,
 * renderer) keeps working without any other change.
 */

const { extractRepresentativeFrame, cleanupFrame } = require('./frame-extractor');
let detectSubjectFocus = null;
let detectSubjectFocusTrajectory = null;
try { ({ detectSubjectFocus, detectSubjectFocusTrajectory } = require('../vision/ai-vision')); } catch (_) { detectSubjectFocus = null; }
// Multi-frame smoothed reframe (#16) — optional; degrades to single-frame anchor.
let _clipAnalyzer = null;
try { _clipAnalyzer = require('../media/clip-analyzer'); } catch (_) { _clipAnalyzer = null; }
let _focusTrajectoryDecision = null;
try { ({ _focusTrajectoryDecision } = require('./workers/framing')); } catch (_) { _focusTrajectoryDecision = null; }
const { buildSceneContext } = require('./scene-context');
const { decideFraming } = require('./workers/framing');
const { planFramingStrategy, strategyMap } = require('./workers/framing-strategy');
const { runMotionGraphicsWorker } = require('./workers/motion-graphics');
const { runTemplatesWorker, runTemplateRhythmWorker } = require('./workers/templates');
const { runExplainerImagesWorker } = require('./workers/explainer-images');
const { runMapAssetsWorker } = require('./workers/map-assets');
const { runTransitionsWorker } = require('./workers/transitions');

const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, parseInt(process.env.EDITOR_AGENT_CONCURRENCY || '4', 10) || 4));

function _short(value, n = 120) {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

function _neighbours(scenes, idx) {
    return {
        prev: idx > 0 ? scenes[idx - 1] : null,
        next: idx < scenes.length - 1 ? scenes[idx + 1] : null,
    };
}

/**
 * Apply the framing worker's decision back onto the scene object so the
 * downstream pipeline (video-plan.json, renderer) sees the canonical fields.
 */
function _stampFramingOntoScene(scene, framingDecision) {
    if (!framingDecision) return;
    scene.framing = framingDecision.framing;
    scene.fitMode = framingDecision.fitMode;
    scene.scale = framingDecision.scale;
    scene.background = framingDecision.background;
    scene.posX = framingDecision.posX;
    scene.posY = framingDecision.posY;
    if (framingDecision.borderRadius) scene.borderRadius = framingDecision.borderRadius;
    if (framingDecision.shadow != null) scene.shadow = framingDecision.shadow;
    if (framingDecision.floatingAnim) scene.floatingAnim = framingDecision.floatingAnim;
    if (framingDecision.floatingAnimDuration) scene.floatingAnimDuration = framingDecision.floatingAnimDuration;
    if (Array.isArray(framingDecision.effects) && framingDecision.effects.length > 0) {
        scene.effects = framingDecision.effects;
    }
    scene._editorAgent = scene._editorAgent || {};
    scene._editorAgent.framing = {
        framing: framingDecision.framing,
        background: framingDecision.background,
        scale: framingDecision.scale,
        reason: framingDecision.reason,
    };
}

/**
 * Edit one scene end-to-end. The CEO sequences the workers for THIS scene:
 *   1. extract representative frame
 *   2. build context
 *   3. (mvp) call framing worker — more workers will be added here
 *   4. clean up frame file
 */
async function editOneScene(scene, scriptContext, idx, allScenes, opts = {}) {
    // Scenes without media (e.g. fullscreen MG scenes that fill the canvas
    // with motion graphics) skip framing entirely — there's no clip to frame.
    if (!scene?.mediaFile) {
        return { scene, framing: null, skipped: 'no media file' };
    }
    if (scene.fullscreenMG) {
        return { scene, framing: null, skipped: 'fullscreen MG scene (no underlying clip framing)' };
    }

    try {
        const ctx = buildSceneContext(scene, scriptContext, _neighbours(allScenes, idx));
        const directive = opts.framingDirectives?.get(Number(scene.index)) || {
            action: 'default',
            framing: opts.framingStrategy?.defaultFraming || scene.framing || 'fullscreen',
            reason: 'global strategy default',
        };

        let frame = null;
        let strategyOnly = true;
        let framingDecision;
        try {
            if (directive.action !== 'vision-review') {
                framingDecision = await decideFraming(ctx, null, {
                    strategy: directive,
                    globalStrategy: opts.framingStrategy,
                    noVision: true,
                });
            } else {
                frame = await extractRepresentativeFrame(scene.mediaFile);
                framingDecision = await decideFraming(ctx, frame, {
                    strategy: directive,
                    globalStrategy: opts.framingStrategy,
                });
                strategyOnly = false;
            }
            _stampFramingOntoScene(scene, framingDecision);

            // Subject/face anchor: if this scene's media fills the frame (cover) and its
            // aspect ratio forces a real crop, find the subject and anchor the crop so the
            // face/subject is NOT cut off. Reuses the frame above when one was extracted.
            await _anchorCropToSubject(scene, ctx.media, frame, opts);

            return { scene, framing: framingDecision, strategyOnly };
        } finally {
            cleanupFrame(frame);
        }
    } catch (err) {
        return { scene, error: err?.message || String(err) };
    }
}

// Find the subject and set scene.focusX/focusY (0..1) so a fill-frame crop keeps the face.
// Only runs when the media actually cover-crops (aspect ≠ 16:9). Vision-cheap + graceful:
// any failure leaves the default center crop. HF_FACE_ANCHOR=0 disables.
async function _anchorCropToSubject(scene, media, frame, opts) {
    if (process.env.HF_FACE_ANCHOR === '0' || !detectSubjectFocus) return;
    if ((scene.fitMode || 'cover') !== 'cover') return; // contain shows the whole image
    const aspect = Number(media?.aspectRatio) || 0;
    if (!aspect) return;
    const dst = 16 / 9;
    const cropFrac = aspect < dst ? 1 - aspect / dst : 1 - dst / aspect;
    if (cropFrac < 0.08) return; // negligible crop — centered is fine

    // Multi-frame SMOOTHED reframe (OPENMONTAGE-BORROW-PLAN #16) — VIDEO ONLY
    // (a still image can't move, so its single midpoint frame is already correct).
    // Samples the subject across the clip and either LOCKs a static focus or emits
    // a gentle PAN. Any failure falls through to the single-frame anchor below —
    // this can only improve on today's behavior, never break it. HF_REFRAME_SMOOTH=0 off.
    const isVideo = /\.(mp4|webm|mov|mkv|m4v)$/i.test(String(scene.mediaFile || ''));
    if (isVideo && process.env.HF_REFRAME_SMOOTH !== '0' && detectSubjectFocusTrajectory && _focusTrajectoryDecision && _clipAnalyzer?.extractFrames) {
        try {
            const dur = Math.max(1, (Number(scene.endTime) || 0) - (Number(scene.startTime) || 0) || 3);
            const n = Math.max(2, Math.min(5, parseInt(process.env.HF_REFRAME_FRAMES || '3', 10) || 3));
            const frames = await _clipAnalyzer.extractFrames(scene.mediaFile, dur, n, { scale: 512 });
            const traj = await detectSubjectFocusTrajectory(frames);
            const decision = _focusTrajectoryDecision(traj);
            if (decision) {
                if (decision.mode === 'lock') {
                    scene.focusX = decision.focusX; scene.focusY = decision.focusY;
                    opts.log?.(`   [Framing] scene ${scene.index ?? '?'}: subject focus LOCK (${scene.focusX}, ${scene.focusY}) from ${traj.filter(t => t.ok).length}/${n} frames — crop anchored (${Math.round(cropFrac * 100)}% crop)`);
                } else {
                    // PAN: set the static focus to the START point so a non-animating
                    // renderer still crops sensibly; focusPan drives the animated pan.
                    scene.focusX = decision.fromX; scene.focusY = decision.fromY;
                    scene.focusPan = { fromX: decision.fromX, fromY: decision.fromY, toX: decision.toX, toY: decision.toY };
                    opts.log?.(`   [Framing] scene ${scene.index ?? '?'}: subject focus PAN (${decision.fromX},${decision.fromY})→(${decision.toX},${decision.toY}) from ${traj.filter(t => t.ok).length}/${n} frames — crop follows subject`);
                }
                return; // smoothed decision made — skip the single-frame anchor
            }
        } catch (e) {
            opts.log?.(`   [Framing] scene ${scene.index ?? '?'}: smoothed reframe failed (${String(e.message || e).slice(0, 60)}) — single-frame anchor`);
        }
    }

    let f = frame;
    let extracted = false;
    if (!f) { f = await extractRepresentativeFrame(scene.mediaFile); extracted = true; }
    try {
        if (!f?.base64) return;
        const focus = await detectSubjectFocus(f.base64, f.mimeType);
        if (focus?.ok) {
            scene.focusX = Number(focus.focusX.toFixed(3));
            scene.focusY = Number(focus.focusY.toFixed(3));
            opts.log?.(`   [Framing] scene ${scene.index ?? '?'}: subject focus (${scene.focusX}, ${scene.focusY}) — crop anchored (${Math.round(cropFrac * 100)}% would crop)`);
        }
    } finally {
        if (extracted) cleanupFrame(f);
    }
}

/**
 * Process N scenes in parallel. Limits concurrency to avoid hammering the
 * vision API with 40 simultaneous calls.
 */
async function _runWithConcurrency(items, concurrency, worker) {
    const out = new Array(items.length);
    let cursor = 0;
    async function runner() {
        while (cursor < items.length) {
            const myIdx = cursor++;
            out[myIdx] = await worker(items[myIdx], myIdx);
        }
    }
    const runners = [];
    const N = Math.max(1, Math.min(items.length, concurrency));
    for (let i = 0; i < N; i++) runners.push(runner());
    await Promise.all(runners);
    return out;
}

/**
 * Entry point. Called from build-video.js after Step 5 (media download).
 *
 * @param {Array} scenes — all scenes (including those without mediaFile)
 * @param {Object} scriptContext — Director's context blob
 * @param {Object} [opts] — { concurrency, log }
 * @returns {Promise<{ stats: object, decisions: Array }>}
 */
async function runEditorAgent(scenes, scriptContext = {}, opts = {}) {
    if (!Array.isArray(scenes) || scenes.length === 0) {
        return { stats: { processed: 0 }, decisions: [] };
    }
    const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || DEFAULT_CONCURRENCY));
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const startedAt = Date.now();

    log(`\n🎬 Editor Agent — processing ${scenes.length} scenes (${concurrency} in parallel)`);

    const framingStrategy = await planFramingStrategy(scenes, scriptContext, { log });
    const framingDirectives = strategyMap(framingStrategy);
    const editableFramingScenes = scenes.filter(s => s?.mediaFile && !s.fullscreenMG).length;
    const strategyCounts = { default: 0, force: 0, 'vision-review': 0 };
    for (const row of framingStrategy.scenes || []) {
        const key = strategyCounts[row.action] == null ? 'default' : row.action;
        strategyCounts[key]++;
    }
    const implicitDefault = Math.max(0, editableFramingScenes - strategyCounts.default - strategyCounts.force - strategyCounts['vision-review']);
    log(`   [Framing Strategy] ${framingStrategy.styleIntent || framingStrategy.reason || 'global strategy ready'}`);
    log(`   [Framing Strategy] dispatch: ${strategyCounts.default + implicitDefault} default, ${strategyCounts.force} force, ${strategyCounts['vision-review']} vision-review`);
    scriptContext._editorAgent = scriptContext._editorAgent || {};
    scriptContext._editorAgent.framingStrategy = framingStrategy;

    const results = await _runWithConcurrency(scenes, concurrency, (scene, idx) =>
        editOneScene(scene, scriptContext, idx, scenes, { framingStrategy, framingDirectives })
    );

    const stats = {
        processed: 0,
        skipped: 0,
        errored: 0,
        strategyOnly: 0,
        visionReviewed: 0,
        framingBreakdown: { fullscreen: 0, cinematic: 0, floating: 0 },
    };
    for (const r of results) {
        if (r.skipped) { stats.skipped++; continue; }
        if (r.error) { stats.errored++; continue; }
        stats.processed++;
        if (r.strategyOnly) stats.strategyOnly++;
        else stats.visionReviewed++;
        const f = r.framing?.framing;
        if (f && stats.framingBreakdown[f] != null) stats.framingBreakdown[f]++;
    }
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`   ✅ Editor Agent done in ${elapsed}s — `
        + `${stats.processed} processed, ${stats.skipped} skipped, ${stats.errored} errored | `
        + `${stats.strategyOnly} strategy-only, ${stats.visionReviewed} vision-reviewed | `
        + `framing: ${stats.framingBreakdown.fullscreen} fullscreen, `
        + `${stats.framingBreakdown.cinematic} cinematic, `
        + `${stats.framingBreakdown.floating} floating`);

    // Transitions — scene-to-scene decisions are now OWNED by the Editor Agent
    // (the AI Director defers when EDITOR_AGENT=true). Runs once over all scenes
    // after framing is stamped, so it can use each scene's final framing.
    let transitions = null;
    if (opts.transitions !== false) {
        transitions = await runTransitionsWorker(scenes, scriptContext, { log });
    }
    scriptContext._editorAgent = scriptContext._editorAgent || {};
    scriptContext._editorAgent.transitions = transitions;

    return { stats, decisions: results, transitions };
}

/**
 * Phase 2 — cross-scene batch workers. Runs AFTER mid-build validation
 * (so it sees mgInstructions, listicleProtectedScenes, etc.) and replaces
 * Steps 6 / 6.05 / 6.06 / 6.07 / 6.5 in build-video.js when EDITOR_AGENT
 * is on. Sequence matters:
 *   1. MGs first (downstream workers reference them)
 *   2. Explainer images (only fires when MG plan includes explainerImage)
 *   3. Map assets (only fires when MG plan includes mapChart)
 *   4. Templates (depend on MG decisions to coexist or replace)
 *
 * Stores the aggregated result on scriptContext._editorAgent so the
 * downstream build-video.js code (maxMGs cap, listicleCounter, etc.)
 * can read it.
 *
 * @param {Array} scenes
 * @param {Object} scriptContext
 * @param {Object} [opts] — { aiInstructions, tempDir, log, runWorkers }
 *   runWorkers: { mg: true, templates: true, explainer: true, mapAssets: true }
 *   (default all true)
 */
async function runEditorAgentPhase2(scenes, scriptContext = {}, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const tempDir = opts.tempDir || (require('../settings/config').paths?.temp);
    const which = Object.assign({ mg: true, templates: true, explainer: true, mapAssets: true }, opts.runWorkers || {});
    const aggregated = {
        mg: null,
        templates: null,
        explainer: null,
        mapAssets: null,
        startedAt: Date.now(),
    };

    log(`\n🎬 Editor Agent Phase 2 — cross-scene workers`);

    // 1. MGs
    if (which.mg) {
        aggregated.mg = await runMotionGraphicsWorker(scenes, scriptContext, {
            aiInstructions: opts.aiInstructions || '',
            log,
        });
    }

    // Gather MGs for downstream workers
    const mgResult = aggregated.mg?.result || null;
    const allMGs = mgResult
        ? (Array.isArray(mgResult.motionGraphics) ? mgResult.motionGraphics : (Array.isArray(mgResult) ? mgResult : []))
        : [];
    const explainerMGs = allMGs.filter(mg => mg && mg.type === 'explainerImage');
    const mgScenes = allMGs; // ai-templates expects the MG list

    // 2. Explainer Images
    if (which.explainer && explainerMGs.length > 0) {
        aggregated.explainer = await runExplainerImagesWorker(explainerMGs, scriptContext, tempDir, { log });
    }

    // 3. Map Assets (tiles + waypoint icons)
    if (which.mapAssets) {
        aggregated.mapAssets = await runMapAssetsWorker(allMGs, scriptContext, tempDir, scenes, { log });
    }

    // 4. Templates (last — sees all MG decisions)
    if (which.templates) {
        aggregated.templates = await runTemplatesWorker(scenes, scriptContext, mgScenes, {
            aiInstructions: opts.aiInstructions || '',
            log,
        });
    }

    aggregated.elapsedSec = ((Date.now() - aggregated.startedAt) / 1000).toFixed(1);

    // Stash on scriptContext so build-video.js can read it after the call.
    scriptContext._editorAgent = scriptContext._editorAgent || {};
    scriptContext._editorAgent.phase2 = aggregated;

    log(`   ✅ Editor Agent Phase 2 done in ${aggregated.elapsedSec}s`);
    return aggregated;
}

async function runEditorAgentTemplateRhythm(scenes, scriptContext = {}, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    log(`\n🎬 Editor Agent CEO — pre-media template rhythm`);
    const result = await runTemplateRhythmWorker(scenes, scriptContext, {
        aiInstructions: opts.aiInstructions || '',
        log,
    });

    scriptContext._editorAgent = scriptContext._editorAgent || {};
    scriptContext._editorAgent.preMediaTemplateRhythm = result;
    return result;
}

module.exports = {
    runEditorAgent,
    runEditorAgentPhase2,
    runEditorAgentTemplateRhythm,
    editOneScene,
};
