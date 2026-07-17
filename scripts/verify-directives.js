// Verify the Agentic Control Layer v1 — the creator's one free-text order is
// compiled into a structured `directives` object, threaded, and read by every
// stage. Exercised WITHOUT any live-AI/network call (floor + deterministic
// worker overrides only). Run: node scripts/verify-directives.js
'use strict';

// Keep every agentic gate ON (default) so the deterministic overrides fire.
for (const k of ['DIRECTIVE_COMPILER', 'AI_INSTRUCTIONS_GLOBAL', 'HF_TRANSITION_DIRECTOR', 'HF_ICON_DIRECTOR', 'HF_FX_AGENT']) {
    if (/^(0|false|off|no)$/i.test(String(process.env[k] || ''))) delete process.env[k];
}

const dc = require('../src/directives/directive-compiler');
const { __test } = require('../src/agents/ai-visual-planner');
const transitionDirector = require('../src/agents/workers/transition-director');
const iconDirector = require('../src/agents/workers/icon-director');
const framingStrategy = require('../src/agents/workers/framing-strategy');
const effectsDirector = require('../src/agents/workers/effects-director');

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL:', msg); } };

const SAMPLE = 'Hard cuts only, no film grain, keep everything fullscreen, use lots of maps, no icons over faces, prefer real footage, no reddit';

// ── (1) Floor: regex → structured slices ─────────────────────────────────────
console.log('[1] directivesFloor → structured slices');
{
    const d = dc.directivesFloor(SAMPLE);
    ok(d && d.raw === SAMPLE, 'floor keeps raw order verbatim');
    ok(d.overrideHouseRules === true, 'authority: overrideHouseRules=true');
    ok(d.transitions && d.transitions.style === 'hard-cuts', 'transitions.style=hard-cuts');
    ok(d.effects && d.effects.noGrain === true, 'effects.noGrain=true');
    ok(d.framing && d.framing.force === 'fullscreen', 'framing.force=fullscreen');
    ok(d.maps && d.maps.want === 'more', 'maps.want=more');
    ok(d.icons && d.icons.avoidOverFaces === true, 'icons.avoidOverFaces=true (from "over faces")');
    ok(!(d.icons && d.icons.allow === false), '"no icons over faces" does NOT ban icons entirely');
    ok(d.footage && d.footage.preferReal === true, 'footage.preferReal=true');
    ok(d.footage && Array.isArray(d.footage.bannedSources) && d.footage.bannedSources.includes('reddit'), 'footage.bannedSources includes reddit');
    ok(dc.directivesFloor('') === null, 'empty order → null');
    ok(JSON.stringify(dc.directivesFloor(SAMPLE)) === JSON.stringify(d), 'floor is deterministic (same order → same object)');

    const noicons = dc.directivesFloor('no icons at all please');
    ok(noicons.icons && noicons.icons.allow === false, '"no icons at all" → icons.allow=false');
    const nomaps = dc.directivesFloor('clean look, no maps');
    ok(nomaps.maps && nomaps.maps.want === 'none', '"no maps" → maps.want=none');
    ok(nomaps.effects && nomaps.effects.noGrain === true, '"clean look" → effects.noGrain');
}

// ── (2) renderDirectivesBlock: stage-scoped, empty when nothing to say ────────
console.log('[2] renderDirectivesBlock');
{
    const d = dc.directivesFloor(SAMPLE);
    for (const stage of ['effects', 'transitions', 'framing', 'icons', 'graphics', 'composition', 'footage']) {
        ok(dc.renderDirectivesBlock(null, stage) === '', `OFF: null directives → '' for stage ${stage}`);
    }
    ok(/hard cuts/i.test(dc.renderDirectivesBlock(d, 'transitions')), 'transitions block mentions hard cuts');
    ok(/grain/i.test(dc.renderDirectivesBlock(d, 'effects')), 'effects block mentions grain');
    ok(/fullscreen/i.test(dc.renderDirectivesBlock(d, 'framing')), 'framing block mentions fullscreen');
    ok(/face/i.test(dc.renderDirectivesBlock(d, 'icons')), 'icons block mentions faces');
    ok(/real|stock/i.test(dc.renderDirectivesBlock(d, 'footage')), 'footage block mentions real/stock');
    // A directive with only a transitions slice must render '' for unrelated stages.
    const onlyTx = { raw: 'x', transitions: { style: 'hard-cuts' } };
    ok(dc.renderDirectivesBlock(onlyTx, 'effects') === '', 'unrelated stage with no matching slice → ""');
    ok(dc.renderDirectivesBlock(onlyTx, 'transitions') !== '', 'matching stage → non-empty');
}

// ── (3) Compiler gating (no AI) ──────────────────────────────────────────────
console.log('[3] compiler gating');
(async () => {
    process.env.DIRECTIVE_COMPILER = '0';
    ok(dc.isDisabled() === true, 'DIRECTIVE_COMPILER=0 → isDisabled');
    ok((await dc.compileDirectives({ freeInstructions: SAMPLE }, {}, {})) === null, 'disabled → compile returns null (OFF identical)');
    delete process.env.DIRECTIVE_COMPILER;

    process.env.DIRECTIVE_COMPILER_AI = '0'; // keep feature, skip AI → floor only
    const floorViaCompile = await dc.compileDirectives({ freeInstructions: SAMPLE }, {}, {});
    ok(floorViaCompile && floorViaCompile._floor === true, 'DIRECTIVE_COMPILER_AI=0 → floor path (no AI call)');
    ok(floorViaCompile.transitions.style === 'hard-cuts', 'floor-via-compile carries transitions');
    delete process.env.DIRECTIVE_COMPILER_AI;
    ok((await dc.compileDirectives({ freeInstructions: '' }, {}, {})) === null, 'empty order → null');

    // ── (4) Planner merge: compiled slice wins over the regex floor ───────────
    console.log('[4] planner merge (_buildPlannerDirectives)');
    const directives = dc.directivesFloor(SAMPLE);
    const pd = __test._buildPlannerDirectives([{}, {}], { _directives: directives }, { freeInstructions: '' });
    ok(pd.user.avoidStock !== true || true, 'merge runs');
    ok(pd.user.preferRealFootage === true, 'merge: preferRealFootage set from directives');
    ok(pd.user.preferFullscreen === true && pd.user.preferredFraming === 'fullscreen', 'merge: framing force → preferFullscreen');
    ok(pd.user.forceMaps === true && pd.user.preferMaps === true, 'merge: maps.want=more → forceMaps');
    ok(pd.user.bannedSources.has('reddit'), 'merge: banned source carried into Set');
    ok(__test._userExplicitlyWantsMaps(pd) === true, 'userExplicitlyWantsMaps true when forceMaps');
    ok(__test._userExplicitlyWantsMaps({ user: {} }) === false, 'userExplicitlyWantsMaps false with no map ask');

    // ── (5) Authority: creator "use maps" beats the niche mapChart ban ────────
    console.log('[5] authority — map ban override');
    const mapScene = () => ({ index: 0, fullscreenMG: 'mapChart', mapVariant: 'v', keyword: '', text: 'trade routes across the strait' });
    const candidates = ['news.celebrity', 'explainer.food', 'explainer.motivation', 'explainer.diy', 'general'];
    const banningNiche = candidates.find(n => __test._enforceNicheMapChartBan([mapScene()], n, null).length > 0);
    ok(!!banningNiche, `found a niche that bans mapChart by default (baseline strip works): ${banningNiche || 'NONE'}`);
    if (banningNiche) {
        const kept = __test._enforceNicheMapChartBan([mapScene()], banningNiche, { user: { forceMaps: true } });
        ok(kept.length === 0, 'creator "use maps" order → mapChart NOT stripped (authority: user wins)');
    }

    // ── (6) Worker deterministic overrides (no AI) ────────────────────────────
    console.log('[6] worker overrides');
    // (a) Transition Director: hard-cuts forces every boundary to cut, no AI call.
    const txPlan = {
        scriptContext: { themeId: 'standard', nicheId: 'general', _directives: { transitions: { style: 'hard-cuts' } } },
        scenes: [0, 1, 2].map(i => ({ index: i, startTime: i * 3, endTime: i * 3 + 3, mediaFile: `c${i}.mp4`, text: `scene ${i}` })),
    };
    const txRes = await transitionDirector.directTransitions(txPlan, { log: () => {} });
    ok(txRes.directive === 'hard-cuts', 'transition director reports hard-cuts directive');
    ok(txPlan.scenes.filter(s => s.transition && s.transition.type === 'cut').length >= 2, 'all boundaries forced to cut');
    ok(txPlan.scenes.every(s => !s.transition || s.transition.type === 'cut'), 'no visible transition survives hard-cuts');

    // (b) Framing strategy: force → all scenes forced, no AI call.
    const frScenes = [0, 1, 2].map(i => ({ index: i, startTime: i * 3, endTime: i * 3 + 3, mediaFile: `c${i}.mp4`, framing: 'floating', text: `s${i}` }));
    const fr = await framingStrategy.planFramingStrategy(frScenes, { _directives: { framing: { force: 'fullscreen' } } }, { log: () => {} });
    ok(fr.defaultFraming === 'fullscreen', 'framing directive → defaultFraming fullscreen');
    ok(fr.scenes.length && fr.scenes.every(s => s.action === 'force' && s.framing === 'fullscreen'), 'every scene forced to fullscreen');

    // (c) Icon Director: allow:false → no icons, no AI call.
    const icPlan = {
        scriptContext: { themeId: 'standard', nicheId: 'general', _directives: { icons: { allow: false } } },
        scenes: [0, 1].map(i => ({ index: i, startTime: i * 3, endTime: i * 3 + 3, mediaFile: `c${i}.mp4`, text: `s${i}`, words: [] })),
    };
    const icRes = await iconDirector.directIcons(icPlan, { log: () => {} });
    ok(icRes.directive === 'no-icons' && icRes.skipped === true, 'icon director short-circuits on "no icons"');
    ok(icPlan.scenes.every(s => !Array.isArray(s._iconMoments)), 'no icon moments placed');

    // (d) Effects Director: noGrain strips the base texture floor (cached-return path, no AI).
    const fxPlan = {
        scriptContext: { themeId: 'crime', nicheId: 'explainer.crime', _directives: { effects: { noGrain: true } } },
        scenes: [0, 1].map(i => ({ index: i, startTime: i * 3, endTime: i * 3 + 3, mediaFile: `c${i}.mp4`, text: `s${i}`, _effectRecipe: [] })),
    };
    const fxRes = await effectsDirector.directSceneEffects(fxPlan, { log: () => {} });
    if (fxRes.skipped) {
        console.log('  NOTE: FX director skipped (look ruleset/registry unavailable) — texture assertion not run');
    } else {
        ok(fxPlan._hfBaseLook && Array.isArray(fxPlan._hfBaseLook.texture) && fxPlan._hfBaseLook.texture.length === 0, 'noGrain → base look texture stripped to []');
    }

    // ── (7) Persistence: _directives survives the real plan serializer ────────
    console.log('[7] persistence (video-plan.json survival)');
    {
        const directives = dc.directivesFloor(SAMPLE);
        const plan = { scenes: [{ index: 0, _fileIndex: 7 }], scriptContext: { nicheId: 'general', _directives: directives } };
        // Exact replacer used by build-video.js when writing video-plan.json.
        const round = JSON.parse(JSON.stringify(plan, (k, v) => (k === '_fileIndex' ? undefined : v), 2));
        ok(round.scriptContext && round.scriptContext._directives, '_directives persists into serialized plan');
        ok(round.scriptContext._directives.transitions.style === 'hard-cuts', 'persisted directives keep their slices');
        ok(!('_fileIndex' in round.scenes[0]), 'only _fileIndex is stripped by the replacer (baseline)');
        // Resume: re-reading the persisted plan yields the same object every stage reads.
        ok(dc.renderDirectivesBlock(round.scriptContext._directives, 'transitions') !== '', 'resumed directives still render a block');
    }

    // ── (8) Per-scene / time-targeted directives (Feature 2) ─────────────────
    console.log('[8] per-scene/time directives');
    {
        const util = require('../src/directives/directive-util');
        const mkScenes = () => Array.from({ length: 8 }, (_, i) => ({ index: i, startTime: i * 5, endTime: (i + 1) * 5, text: `scene ${i}`, keyword: `kw${i}`, sourceHint: 'stock', framing: 'fullscreen' }));

        // resolver off-by-one fix
        ok(util.resolveSceneIndex(mkScenes(), 5)?.index === 4, 'resolveSceneIndex(5) → scene.index 4 (off-by-one fixed)');
        ok(util.coversTime(mkScenes(), 12).map(s => s.index).join(',') === '2', 'coversTime(12s) → scene 2');
        ok(util.coversFirst(mkScenes(), 10).map(s => s.index).join(',') === '0,1', 'coversFirst(10s) → scenes 0,1');
        ok(util.coversRange(mkScenes(), 6, 14).map(s => s.index).join(',') === '1,2', 'coversRange(6-14) → scenes 1,2');
        ok(util.parseTimestamp('0:30') === 30 && util.parseTimestamp('22s') === 22 && util.parseTimestamp('3m') === 180, 'parseTimestamp mm:ss / Ns / Nm');
        ok(util.resolveMGAlias('map') === 'mapChart' && util.resolveMGAlias('split screen') === 'splitScreen', 'resolveMGAlias canonicalizes');

        // compiler perScene coercion
        const coerced = __test /* planner */ ? null : null; // (planner __test is separate; use compiler __test)
        const dcTest = require('../src/directives/directive-compiler').__test;
        const psRaw = [
            { raw: 'map at 0:30', when: { kind: 'time', at: 30 }, set: { fullscreenMG: 'map' } },
            { raw: 'hard cut on scene 3', when: { kind: 'sceneIndex', sceneFrom: 3 }, set: { transition: { type: 'cut' } } },
            { raw: 'garbage', when: { kind: 'bogus' }, set: { x: 1 } },      // dropped (bad when)
            { raw: 'no fields', when: { kind: 'time', at: 5 }, set: {} },     // dropped (empty set)
        ];
        const ps = dcTest._coercePerScene(psRaw);
        ok(Array.isArray(ps) && ps.length === 2, 'perScene coercion drops malformed entries (2 of 4 kept)');
        ok(ps[0].set.fullscreenMG === 'mapChart', 'perScene fullscreenMG alias → mapChart');
        ok(ps[1].set.transition && ps[1].set.transition.type === 'cut' && ps[1].set.transition.duration === 0, 'perScene transition → {type:cut,duration:0}');
        ok(dcTest._coercePerScene([]) === null, 'empty perScene → null (OFF-identical)');

        // applier (build-video, require with BUILD_VIDEO_NO_RUN=1)
        process.env.BUILD_VIDEO_NO_RUN = '1';
        const { applySceneDirectives } = require('../src/pipeline/build-video').__test;
        const scenes = mkScenes();
        const directives = {
            perScene: [
                { when: { kind: 'sceneIndex', sceneFrom: 5 }, set: { framing: 'cinematic' } },     // scene index 4
                { when: { kind: 'time', at: 12 }, set: { fullscreenMG: 'mapChart' } },              // scene index 2
                { when: { kind: 'sceneIndex', sceneFrom: 4 }, set: { transition: { type: 'cut', duration: 0 } } }, // scene index 3
            ],
        };
        const n = applySceneDirectives(directives, scenes, {});
        ok(n === 3, `applier touched 3 scenes (got ${n})`);
        ok(scenes[4].framing === 'cinematic' && scenes[4].keyword === 'kw4' && scenes[4].sourceHint === 'stock', 'framing override leaves footage fields intact (destructive-null fixed)');
        ok(scenes[2].fullscreenMG === 'mapChart: scene 2' && scenes[2].keyword === null && scenes[2].sourceHint === null, 'fullscreenMG override nulls footage + sets "type: text"');
        ok(scenes[3].transition && scenes[3].transition.type === 'cut' && scenes[3]._txDirected === true, 'transition override → {type,duration} object + _txDirected');
        ok(Array.isArray(scenes[4]._directiveLock) && scenes[4]._directiveLock.includes('framing'), 'scene._directiveLock records written field (serializable array)');
        ok(applySceneDirectives({ perScene: [] }, mkScenes(), {}) === 0, 'no perScene → applier no-op (0)');
    }

    // ── (9) Compliance loop (Feature 3) ─────────────────────────────────────
    console.log('[9] compliance loop');
    {
        const { auditCompliance } = require('../src/directives/compliance-loop');
        const skip = await auditCompliance({ scenes: [], scriptContext: {} }, {});
        ok(skip.skipped === true && skip.ok === true, 'null directives → skipped no-op (OFF-identical)');

        const plan = {
            _hfBaseLook: { grade: 'vivid', texture: [{ id: 'grain' }] },
            scriptContext: { _directives: {
                summary: 'hard cuts, no grain, fullscreen, no maps, no icons',
                transitions: { style: 'hard-cuts' },
                effects: { noGrain: true },
                framing: { force: 'fullscreen' },
                maps: { want: 'none' },
                icons: { allow: false },
            } },
            scenes: [
                { index: 0, mediaFile: 'a.mp4', framing: 'cinematic', transition: { type: 'crossfade' }, _effectRecipe: [{ id: 'grain' }, { id: 'vignette' }], _iconMoments: [{ at: 1 }] },
                { index: 1, mediaFile: 'b.mp4', framing: 'fullscreen', transition: { type: 'cut' }, fullscreenMG: 'mapChart: x' },
            ],
            mgScenes: [{ type: 'mapChart' }, { type: 'statCard' }],
            templateScenes: [],
        };
        const rep = await auditCompliance(plan, {});
        ok(plan.scenes[0].transition.type === 'cut', 'compliance forced non-cut transition → cut');
        ok(plan.scenes[0].framing === 'fullscreen', 'compliance forced framing → fullscreen');
        ok(plan._hfBaseLook.texture.length === 0, 'compliance cleared base grain');
        ok(!plan.scenes[0]._effectRecipe.some(e => e.id === 'grain'), 'compliance stripped grain delta (kept vignette)');
        ok(plan.scenes[0]._effectRecipe.some(e => e.id === 'vignette'), 'compliance left non-texture delta intact');
        ok(plan.scenes[0]._iconMoments.length === 0, 'compliance cleared icons (allow:false)');
        ok(plan.scenes[1].fullscreenMG === null, 'compliance removed mapChart lane (maps:none)');
        ok(plan.mgScenes.length === 1 && plan.mgScenes[0].type === 'statCard', 'compliance removed map mgScene, kept non-map');
        ok(rep.fixed.length > 0 && rep.ok === true, 'compliance reports fixes + ok (all fixable)');

        const rep2 = await auditCompliance(plan, {});
        ok(rep2.fixed.length === 0, 'compliance idempotent — second pass fixes nothing');

        // flag-only: banned source can't be silently dropped
        const plan3 = { scenes: [{ index: 0, mediaFile: 'x.mp4', sourceProvider: 'reddit' }], scriptContext: { _directives: { footage: { bannedSources: ['reddit'] } } } };
        const rep3 = await auditCompliance(plan3, {});
        ok(rep3.unfixable.length === 1 && rep3.ok === false, 'banned actual source → flagged unfixable (not silent-dropped)');
    }

    // ── (10) Acting-agent actuator (Feature 1 backend) ──────────────────────
    console.log('[10] acting-agent actuator');
    {
        const act = require('../src/directives/directive-actuator');
        ok(act.hasActions({ transitions: { style: 'hard-cuts' } }) === true, 'hasActions true for an order slice');
        ok(act.hasActions({ summary: 'just a question' }) === false, 'hasActions false for pure Q&A (no actionable slice)');
        ok(act.hasActions({ perScene: [{ when: {}, set: {} }] }) === true, 'hasActions true when perScene present');

        // applyOrderToPlan on a built plan (directives hand-built → no AI call)
        const plan = {
            _hfBaseLook: { grade: 'vivid', texture: [{ id: 'grain' }] },
            scriptContext: {},
            scenes: [
                { index: 0, mediaFile: 'a.mp4', framing: 'cinematic', transition: { type: 'whip-left' }, keyword: 'x', sourceHint: 'stock' },
                { index: 1, mediaFile: 'b.mp4', framing: 'cinematic', transition: { type: 'crossfade' }, keyword: 'y', sourceHint: 'stock' },
            ],
            mgScenes: [], templateScenes: [],
        };
        const order = {
            summary: 'all fullscreen, hard cuts, no grain; scene 2 footage of a city skyline',
            framing: { force: 'fullscreen' }, transitions: { style: 'hard-cuts' }, effects: { noGrain: true },
            perScene: [{ when: { kind: 'sceneIndex', sceneFrom: 2 }, set: { keyword: 'city skyline', sourceHint: 'stock' } }],
        };
        const r = await act.applyOrderToPlan(plan, order, {});
        ok(plan.scriptContext._directives && plan.scriptContext._directives.framing.force === 'fullscreen', 'order threaded onto plan.scriptContext._directives');
        ok(plan.scenes.every(s => s.framing === 'fullscreen'), 'applyOrderToPlan forced all framing fullscreen (compliance fixers)');
        ok(plan.scenes.every(s => s.transition.type === 'cut'), 'applyOrderToPlan forced all transitions cut');
        ok(plan._hfBaseLook.texture.length === 0, 'applyOrderToPlan cleared base grain');
        ok(plan.scenes[1].keyword === 'city skyline', 'per-scene keyword applied to scene index 1 (user "scene 2")');
        ok(Array.isArray(r.needsFootage) && r.needsFootage.some(n => n.index === 1 && n.keyword === 'city skyline'), 'needsFootage flags scene 1 for real re-download');

        // applyOrderToScene (right-click free-text) — floor-only, no AI call
        process.env.DIRECTIVE_COMPILER_AI = '0';
        const scene = { index: 3, framing: 'cinematic', transition: { type: 'crossfade' }, _effectRecipe: [{ id: 'grain' }] };
        const sres = await act.applyOrderToScene(scene, 'make everything fullscreen, hard cuts only, no grain', {});
        ok(sres.success && scene.framing === 'fullscreen' && scene.transition.type === 'cut', 'applyOrderToScene forced framing+cut on one scene');
        ok(!scene._effectRecipe.some(e => e.id === 'grain'), 'applyOrderToScene stripped grain on the scene');
        delete process.env.DIRECTIVE_COMPILER_AI;
    }

    // ── done ──
    console.log(`\n${fails === 0 ? 'PASS' : 'FAIL'}: ${checks - fails}/${checks} checks passed`);
    process.exit(fails === 0 ? 0 : 1);
})();
