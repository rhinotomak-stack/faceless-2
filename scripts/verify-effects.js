// Verify the Effects Director v2 (base-look lock + deltas + era enforcement +
// clean-respect + single-grade) WITHOUT a render/AI call. Pure functions only.
// Run: node scripts/verify-effects.js
'use strict';
const LOOK = require('../src/render/hf-look-ruleset');
const { GRADES, GRADE_IDS, EFFECT_IDS, recipeFromScene, mergeBaseLook, buildSceneEffects } = require('../src/render/hf-effects');
const { enforceEra } = require('../src/agents/workers/effects-director');

const GRADE_SET = new Set(GRADE_IDS);
const FX_SET = new Set(EFFECT_IDS);
let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL:', msg); } };
const gradesIn = (recipe) => recipe.filter(e => GRADE_SET.has(e.id));

// (1) Base-look coherence for every theme
console.log('[1] base-look per theme');
for (const theme of Object.keys(LOOK.THEME_BASE)) {
    const bl = LOOK.resolveBaseLook(theme, '');
    ok(GRADE_SET.has(bl.grade), `${theme}: base grade "${bl.grade}" is a real grade`);
    ok(Array.isArray(bl.texture) && bl.texture.every(t => FX_SET.has(t.id) && t.intensity >= 0 && t.intensity <= 1), `${theme}: base texture ids valid + in range`);
    if (theme === 'warm-editorial') ok(!bl.texture.some(t => t.id === 'vignette' || t.id === 'bloom'), 'warm-editorial (light) base has no vignette/bloom');
}

// (2) mergeBaseLook: always EXACTLY one grade; base texture present normally, absent when clean
console.log('[2] merge: single grade + texture rules');
{
    const bl = LOOK.resolveBaseLook('crime', 'explainer.crime'); // cold-steel, grain+vignette
    const normal = mergeBaseLook([{ id: 'lightLeak', intensity: 0.3 }], bl);
    ok(gradesIn(normal).length === 1, 'normal scene → exactly one grade');
    ok(gradesIn(normal)[0].id === bl.grade, 'normal scene → the BASE grade');
    ok(normal.some(e => e.id === 'grain') && normal.some(e => e.id === 'lightLeak'), 'normal scene → base texture + delta both present');

    const cleanRecipe = []; cleanRecipe.__clean = true;
    const clean = mergeBaseLook(cleanRecipe, bl);
    ok(gradesIn(clean).length === 1 && gradesIn(clean)[0].id === bl.grade, 'clean scene → base grade only');
    ok(!clean.some(e => e.id === 'grain' || e.id === 'vignette'), 'clean scene → NO base texture (grade only)');

    // flashback scene grade delta overrides base grade (still exactly one grade)
    const flash = mergeBaseLook([{ id: 'sepia-archival' }, { id: 'vintageFrame', intensity: 0.3 }], bl);
    ok(gradesIn(flash).length === 1 && gradesIn(flash)[0].id === 'sepia-archival', 'flashback scene → era grade overrides base (one grade)');
}

// (3) era enforcement — one family, flare budget
console.log('[3] era enforcement');
{
    const bl = LOOK.resolveBaseLook('history', 'explainer.history'); // eraFamily 'projected'
    const scenes = [
        { _fxFlashback: true, _effectRecipe: [{ id: 'vhs', intensity: 0.4 }] },          // wrong family → strip (even on flashback)
        { _fxFlashback: true, _effectRecipe: [{ id: 'filmScratches', intensity: 0.3 }] },// right family + flashback → keep
        { _effectRecipe: [{ id: 'lensFlare', intensity: 0.5 }] },
        { _effectRecipe: [{ id: 'lensFlare', intensity: 0.5 }] },
        { _effectRecipe: [{ id: 'lensFlare', intensity: 0.5 }] },    // 3rd flare → strip (budget 2)
    ];
    enforceEra(scenes, bl);
    ok(!scenes[0]._effectRecipe.some(e => e.id === 'vhs'), 'wrong-family era id (vhs under projected) stripped');
    ok(scenes[1]._effectRecipe.some(e => e.id === 'filmScratches'), 'right-family era id kept');
    const flares = scenes.filter(s => s._effectRecipe.some(e => e.id === 'lensFlare')).length;
    ok(flares <= LOOK.LENS_FLARE_BUDGET, `lensFlare budget ≤ ${LOOK.LENS_FLARE_BUDGET} (got ${flares})`);

    const blNull = LOOK.resolveBaseLook('modern', 'explainer.tech'); // eraFamily null
    const s2 = [{ _effectRecipe: [{ id: 'vhs', intensity: 0.4 }, { id: 'grain', intensity: 0.2 }] }];
    enforceEra(s2, blNull);
    ok(!s2[0]._effectRecipe.some(e => LOOK.ERA_ALL.has(e.id)), 'eraFamily null → ALL era ids stripped');
    ok(s2[0]._effectRecipe.some(e => e.id === 'grain'), 'non-era effect survives era strip');
}

// (4) clean-respect via recipeFromScene (reload-safe: derived from sceneClass)
console.log('[4] recipeFromScene clean');
{
    const r = recipeFromScene({ sceneClass: 'data-claim' });
    ok(Array.isArray(r) && r.length === 0 && r.__clean === true, 'data-claim → empty recipe with __clean sentinel');
    const r2 = recipeFromScene({ sceneClass: 'object-scene', _effectRecipe: [{ id: 'bloom', intensity: 0.3 }] });
    ok(r2.some(e => e.id === 'bloom') && !r2.__clean, 'normal scene → delta kept, not clean');
    // present-but-empty _effectRecipe must NOT fall through to legacy effectOverrides
    const r3 = recipeFromScene({ sceneClass: 'object-scene', _effectRecipe: [], effectOverrides: { grain: { intensity: 0.9, enabled: true } } });
    ok(r3.length === 0, 'empty _effectRecipe is authoritative (no legacy grain leak)');
}

// (5) content→look class-delta mapping
console.log('[5] class → delta mapping');
ok(LOOK.classDelta('hook-tease').some(e => e.id === 'vignette'), 'hook-tease → vignette');
ok(LOOK.classDelta('concept-metaphor').some(e => e.id === 'fogDrift'), 'concept-metaphor → fogDrift');
ok(LOOK.classDelta('transition-bridge').length === 0, 'transition-bridge → clean');
ok(LOOK.classDelta('data-claim').length === 0, 'data-claim → clean');
ok(LOOK.classDelta('object-scene', 'cta').some(e => e.id === 'bloom'), 'cta role → bloom close beat');

// (6) integration: buildSceneEffects renders exactly the base grade filter
console.log('[6] buildSceneEffects integration');
{
    const bl = LOOK.resolveBaseLook('crime', 'explainer.crime');
    const fx = buildSceneEffects({ sceneClass: 'object-scene', _effectRecipe: [] }, 's0', 0, 5, { baseLook: bl });
    ok(fx && fx.filter === GRADES[bl.grade].filter, 'scene renders the base grade filter (single grade, no stack)');
}

// (7) grade survives a LONG flashback recipe (Bug 1 regression guard)
console.log('[7] grade survives long/flashback recipe');
{
    const bl = LOOK.resolveBaseLook('crime', 'explainer.crime'); // 2 base texture (grain+vignette)
    const bigDelta = [{ id: 'lightLeak', intensity: 0.3 }, { id: 'fogDrift', intensity: 0.3 }, { id: 'bloom', intensity: 0.3 }, { id: 'sepia-archival' }, { id: 'vintageFrame', intensity: 0.3 }];
    const merged = mergeBaseLook(bigDelta, bl);
    ok(gradesIn(merged).length === 1, 'long flashback recipe → still exactly one grade (not sliced off)');
    ok(gradesIn(merged)[0] && gradesIn(merged)[0].id === 'sepia-archival', 'long flashback recipe → the era grade survived the cap');
}

// (8) era gated to flashback scenes only (Bug 2 regression guard)
console.log('[8] era only on flashback scenes');
{
    const bl = LOOK.resolveBaseLook('history', 'explainer.history'); // projected family allowed
    const present = { _fxFlashback: false, _effectRecipe: [{ id: 'filmScratches', intensity: 0.3 }, { id: 'grain', intensity: 0.2 }] };
    const flash = { _fxFlashback: true, _effectRecipe: [{ id: 'filmScratches', intensity: 0.3 }] };
    enforceEra([present, flash], bl);
    ok(!present._effectRecipe.some(e => e.id === 'filmScratches'), 'in-family era id STRIPPED from present-day (non-flashback) scene');
    ok(present._effectRecipe.some(e => e.id === 'grain'), 'non-era effect survives on present-day scene');
    ok(flash._effectRecipe.some(e => e.id === 'filmScratches'), 'in-family era id KEPT on flashback scene');
}

console.log(`\n${checks} checks.`);
console.log(fails ? `\n❌ ${fails} FAILURES` : `\n✅ ALL EFFECTS CHECKS PASSED (base-look, single-grade, era, clean, content-map)`);
process.exit(fails ? 1 : 0);
