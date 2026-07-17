/**
 * Effects Director Worker — the COLORIST + EDITOR of the pipeline.
 *
 * Two-layer model (mirrors how a real colorist works):
 *  1. BASE LOOK ("film stock") — ONE grade + a subtle texture floor for the WHOLE
 *     video, derived DETERMINISTICALLY from theme+niche (src/hf-look-ruleset.js).
 *     The AI never touches it, so the film stock can never drift scene-to-scene.
 *  2. STANDOUT DELTAS — sparse per-scene effects the AI adds on top, motivated by
 *     scene CLASS + arc position + content (a vignette on a hook, fog on a
 *     metaphor, an era look on a flashback). Most scenes get NOTHING extra.
 *
 * Output: plan._hfBaseLook = {grade, texture[], eraFamily, atmos} (video-wide) +
 * scene._effectRecipe = [{id,intensity}] (DELTAS ONLY). hf-effects.mergeBaseLook
 * composites base+delta at render into one coherent film. plan._hfBackgroundPack
 * = one background style for the video.
 *
 * Deterministic guarantees (not prompt-hopes): one era family per video, era
 * looks on flashback beats only, data/chart scenes stay clean, ≤2 lens flares,
 * a single grade owner per scene.
 *
 * Flag: HF_FX_AGENT=0 disables the whole agentic layer (legacy theme-grade floor
 * in build-video takes over). Cost: 1 AI call/build, cached to .hf-fx-cache.json.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../../brain/ai-provider');
let renderDirectivesBlock = () => '';
try { ({ renderDirectivesBlock } = require('../../directives/directive-compiler')); } catch (_) { /* optional */ }

let EFFECT_IDS = [], GRADE_IDS = [];
try { ({ EFFECT_IDS, GRADE_IDS } = require('../../render/hf-effects')); } catch (_) { /* registry optional */ }
let BACKGROUND_PACK_IDS = [];
try { ({ BACKGROUND_PACK_IDS } = require('../../render/hf-background-packs')); } catch (_) { /* packs optional */ }
let LOOK = null;
try { LOOK = require('../../render/hf-look-ruleset'); } catch (_) { /* ruleset optional */ }

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_FX_AGENT || '').trim());
}
function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.4; }

// Delta vocabulary the AI may ADD on top of the base (era ids handled separately).
const DELTA_FX = ['vignette', 'lightLeak', 'lightStreaks', 'lensFlare', 'bloom', 'fogDrift', 'embers', 'glitchPulse', 'chromaticEdge'];

function buildPrompt(scenes, themeId, nicheId, base, directives) {
    const eraLine = base.eraFamily && LOOK && LOOK.ERA_FAMILIES[base.eraFamily]
        ? `"${base.eraFamily}" — allowed era ids: ${LOOK.ERA_FAMILIES[base.eraFamily].fx.join(', ')}`
        : 'NONE (never output an era id — this is a present-day video)';
    const directivesBlock = renderDirectivesBlock(directives, 'effects');
    const sceneLines = scenes.map(s =>
        `  ${s.index}: [${s.sceneClass || 'scene'}, ${s.arcPct}%, ${s.role || 'body'}, ${s.framing || 'fullscreen'}/${s.isImage ? 'still' : 'video'}] "${String(s.text || '').replace(/\s+/g, ' ').slice(0, 110)}"`
    ).join('\n');
    return `You are the COLORIST + EDITOR for a faceless YouTube video (theme "${themeId}", niche "${nicheId}").

THE FILM STOCK IS ALREADY LOCKED — do NOT restate it: every scene already gets
grade "${base.grade}" + base texture [${(base.texture || []).map(t => t.id).join(', ') || 'none'}].
Your job is ONLY the sparse STANDOUT beats on top of it — a colorist adding a
look to a few key shots, NOT regrading the film.

For each scene return the DELTA effects to ADD (usually [], 0-1 effect, rarely 2).
MOST scenes MUST be [] (base stock only). Effects on every scene reads amateur;
restraint reads as film.

DELTA EFFECT IDS (use these only): ${DELTA_FX.join(', ')}
  hook / big reveal    → vignette (focus) or lensFlare (epic; ≤2 in the WHOLE video)
  abstract / metaphor  → fogDrift or lightStreaks (contemplative)
  data / chart / quote → [] (NEVER texture over graphics/numbers)
  transition / bridge  → [] (connective tissue is invisible)
  war / aftermath      → embers ;  tech / digital-threat → glitchPulse
  place-establishing   → lightLeak (sense of arrival)
  intensity 0.15-0.35 normal; 0.5-0.7 for ONE deliberate dramatic beat only.

ERA LOOKS are OFF by default. This video's era family is: ${eraLine}.
Add an era id (and set "era":true) ONLY to a scene whose CONTENT is explicitly
PAST / archival / flashback / historical — never a present-day beat. One family only.
${directivesBlock}
SCENES  (index [class, arc%, role, framing/type] "text"):
${sceneLines}
${BACKGROUND_PACK_IDS.length ? `
BACKGROUND STYLE — choose exactly ONE for this video's framed/flat-bg scenes:
${BACKGROUND_PACK_IDS.join(', ')}` : ''}

Respond with ONLY JSON mapping scene index → {"fx":[{"id","intensity"}],"era":bool}${BACKGROUND_PACK_IDS.length ? ', plus "videoBackground"' : ''}:
{${BACKGROUND_PACK_IDS.length ? '"videoBackground":"spotlight",' : ''}"0":{"fx":[{"id":"vignette","intensity":0.3}],"era":false},"1":{"fx":[],"era":false}, ...}`;
}

function parseRecipes(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

// One-era-family guarantee + flare budget (deterministic, not prompt-hoped).
function enforceEra(scenes, baseLook) {
    if (!LOOK) return;
    const fam = baseLook.eraFamily ? LOOK.ERA_FAMILIES[baseLook.eraFamily] : null;
    const allowed = new Set(fam ? [...fam.fx, fam.grade] : []);
    let flare = 0;
    for (const s of scenes) {
        if (!Array.isArray(s._effectRecipe)) continue;
        const flashback = s._fxFlashback === true;
        s._effectRecipe = s._effectRecipe.filter(e => {
            if (LOOK.ERA_ALL.has(e.id)) {
                if (!allowed.has(e.id)) return false; // wrong/forbidden era family → strip
                if (!flashback) return false;         // era looks ONLY on flashback beats → strip elsewhere
            }
            if (e.id === 'lensFlare' && ++flare > LOOK.LENS_FLARE_BUDGET) return false;
            return true;
        });
    }
}

/**
 * Decide the video's base look + per-scene effect deltas (mutates the plan).
 * Returns { decided, baseLook?, cached?, skipped?, failed? }.
 */
async function directSceneEffects(plan, opts = {}) {
    if (!plan || isDisabled() || !EFFECT_IDS.length || !LOOK) return { decided: 0, skipped: true };
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const scenes = (plan.scenes || []).filter(s => s && !s.disabled && !s.isMGScene && s.mediaFile);
    if (!scenes.length) return { decided: 0 };

    const themeId = plan.scriptContext?.themeId || plan.themeId || 'standard';
    const nicheId = plan.scriptContext?.nicheId || '';
    const directives = plan.scriptContext?._directives || null;
    const fxDir = directives?.effects || null;
    // Clone so a creator directive override never mutates the shared ruleset object.
    const baseLook = { ...LOOK.resolveBaseLook(themeId, nicheId) };
    // Creator authority: "no film grain / clean look" strips the base texture floor;
    // an explicit grade overrides the deterministic film stock for the whole video.
    if (fxDir) {
        if (fxDir.noGrain) baseLook.texture = [];
        if (fxDir.grade && (!GRADE_IDS.length || GRADE_IDS.includes(fxDir.grade))) baseLook.grade = fxDir.grade;
    }
    plan._hfBaseLook = baseLook; // ALWAYS set — the film stock is deterministic

    if (scenes.every(s => Array.isArray(s._effectRecipe))) return { decided: 0, cached: true, baseLook };

    const cachePath = opts.projectDir ? path.join(opts.projectDir, '.hf-fx-cache.json') : null;
    const scenesHash = crypto.createHash('sha1')
        .update(JSON.stringify(['v2', themeId, nicheId, baseLook, EFFECT_IDS, GRADE_IDS, BACKGROUND_PACK_IDS,
            scenes.map(s => [s.index, String(s.text || '').slice(0, 120), s.framing || '', s.sceneClass || '', s.role || ''])]))
        .digest('hex').slice(0, 16);
    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached && cached.hash === scenesHash && cached.recipes) {
                let applied = 0;
                for (const scene of scenes) {
                    const r = cached.recipes[String(scene.index)];
                    if (Array.isArray(r)) { scene._effectRecipe = r; applied++; }
                }
                if (cached.baseLook) plan._hfBaseLook = cached.baseLook;
                if (cached.videoBackground && BACKGROUND_PACK_IDS.includes(cached.videoBackground)) plan._hfBackgroundPack = cached.videoBackground;
                if (applied > 0) {
                    log(`  🎞️ [FX Director] base look "${plan._hfBaseLook.grade}" + ${applied} scene delta(s) from cache${plan._hfBackgroundPack ? `, bg "${plan._hfBackgroundPack}"` : ''} (0 AI calls)`);
                    return { decided: applied, cached: true, baseLook: plan._hfBaseLook };
                }
            }
        } catch (_) { /* stale — recompute */ }
    }

    const total = scenes.length;
    const briefScenes = scenes.map((s, i) => ({
        index: s.index,
        text: s.text,
        framing: s.framing,
        sceneClass: s.sceneClass || '',
        role: s.role || (Number(s.startTime) < Number(plan.scriptContext?.hookEndTime || 0) ? 'hook' : 'body'),
        arcPct: Math.round(100 * i / Math.max(1, total - 1)),
        isImage: /\.(jpe?g|png|webp|gif)$/i.test(String(s.mediaFile || '')),
    }));

    let parsed = null;
    try {
        const text = await callAI(buildPrompt(briefScenes, themeId, nicheId, baseLook, directives), { maxTokens: 2500, temperature: 0.4, taskType: 'brain' });
        parsed = parseRecipes(text);
    } catch (e) {
        log(`  ⚠️ [FX Director] AI call failed: ${String(e.message || e).slice(0, 110)} — using deterministic class deltas over the base look`);
    }

    const validFx = new Set(DELTA_FX);
    const eraGrade = baseLook.eraFamily && LOOK.ERA_FAMILIES[baseLook.eraFamily] ? LOOK.ERA_FAMILIES[baseLook.eraFamily].grade : null;
    const eraFxAll = new Set([...LOOK.ERA_ALL]); // era ids the model may return on flashback scenes
    let decided = 0, aiScenes = 0;
    const recipesOut = {};
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const bs = briefScenes[i];
        const raw = parsed ? parsed[String(scene.index)] : null;
        const isFlashback = !!(raw && raw.era === true && baseLook.eraFamily); // era only where flagged AND allowed
        let recipe;
        if (raw && (Array.isArray(raw) || Array.isArray(raw.fx) || raw.era === true)) {
            const fxArr = Array.isArray(raw.fx) ? raw.fx : (Array.isArray(raw) ? raw : []);
            recipe = fxArr
                // era ids are accepted ONLY on a flashback-flagged scene; present-day
                // beats get delta fx only (deterministic "era on flashback only" guarantee).
                .filter(e => e && (validFx.has(e.id) || (isFlashback && eraFxAll.has(e.id))))
                .slice(0, 3)
                .map(e => ({ id: e.id, intensity: clamp01(e.intensity == null ? 0.3 : e.intensity), ...(e.warmth != null ? { warmth: clamp01(e.warmth) } : {}), ...(e.radius != null ? { radius: clamp01(e.radius) } : {}) }));
            // Flashback scene → give it the era grade (overrides base for this scene) + a signature era fx if none.
            if (isFlashback) {
                const fam = LOOK.ERA_FAMILIES[baseLook.eraFamily];
                if (eraGrade && !recipe.some(e => e.id === eraGrade)) recipe.push({ id: eraGrade });
                if (!recipe.some(e => fam.fx.includes(e.id))) recipe.push({ id: fam.fx[0], intensity: 0.3 });
            }
            aiScenes++;
        } else {
            // No AI entry → deterministic class-driven delta (base look still applies).
            recipe = LOOK.classDelta(bs.sceneClass, bs.role).filter(e => validFx.has(e.id));
        }
        scene._effectRecipe = recipe; // DELTAS ONLY — base look is added at render via mergeBaseLook
        scene._fxFlashback = isFlashback; // read by enforceEra (+ reload-safe era gating)
        decided++;
    }

    // Per-scene creator effect directives (scene._directiveEffect, set by the
    // per-scene directive applier): push a grade override for that scene + strip
    // texture deltas when noGrain was ordered. Runs BEFORE enforceEra so the era
    // one-family floor still governs. (Global base grain is video-wide; per-scene
    // noGrain is best-effort at the delta level.)
    const _DIR_TEXTURE_FX = new Set(['grain', 'dust', 'vhsband', 'staticNoise', 'flicker', 'scanlines']);
    for (const s of scenes) {
        const de = s._directiveEffect;
        if (!de || !Array.isArray(s._effectRecipe)) continue;
        if (de.noGrain) s._effectRecipe = s._effectRecipe.filter(e => !_DIR_TEXTURE_FX.has(e.id));
        if (de.grade && (!GRADE_IDS.length || GRADE_IDS.includes(de.grade)) && !s._effectRecipe.some(e => e.id === de.grade)) {
            s._effectRecipe.push({ id: de.grade });
        }
    }

    enforceEra(scenes, baseLook);
    for (const s of scenes) recipesOut[String(s.index)] = s._effectRecipe;

    let videoBackground = null;
    if (parsed && typeof parsed.videoBackground === 'string' && BACKGROUND_PACK_IDS.includes(parsed.videoBackground.toLowerCase())) {
        videoBackground = parsed.videoBackground.toLowerCase();
        plan._hfBackgroundPack = videoBackground;
    }
    if (cachePath && decided > 0) {
        try { fs.writeFileSync(cachePath, JSON.stringify({ hash: scenesHash, recipes: recipesOut, videoBackground, baseLook })); } catch (_) { /* non-fatal */ }
    }
    const standouts = scenes.filter(s => (s._effectRecipe || []).length).length;
    log(`  🎞️ [FX Director] film stock "${baseLook.grade}"${baseLook.eraFamily ? ` (era ${baseLook.eraFamily})` : ''} + ${standouts}/${total} standout scene(s)${videoBackground ? `, bg "${videoBackground}"` : ''} (${aiScenes ? '1 AI call' : 'deterministic fallback'})`);
    return { decided, baseLook };
}

module.exports = { directSceneEffects, enforceEra };
