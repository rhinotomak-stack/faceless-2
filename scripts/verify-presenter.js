// Verify talking-head Presenter placement (agentic director parse + deterministic floor
// + span enforce + provider + map precedence) WITHOUT a render/live-AI call.
// Run: node scripts/verify-presenter.js
'use strict';
const { assignPresenterDispositions, enforcePresenterDispositions } = require('../src/agents/presenter-assignment');
const { assignMapDispositions } = require('../src/map/map-assignment');
const { createPresenterProvider, StaticImagePresenterProvider, resolvePresenterMedia } = require('../src/media/presenter-provider');
const presenterDirector = require('../src/agents/workers/presenter-director');

let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL:', msg); } };

// 12 short (~3s) beats so holds naturally span multiple scenes.
function scenes() {
    const mk = (index, text, sceneClass) => ({ index, startTime: index * 3, endTime: (index + 1) * 3, text, sceneClass });
    return [
        mk(0, 'Welcome — today we uncover how the whole thing worked.', 'hook-tease'),
        mk(1, 'It starts long before anyone noticed.', 'hook-tease'),
        mk(2, 'The factory floor stretched for hundreds of meters.', 'object-scene'),
        mk(3, 'Machines hummed through the night shift.', 'object-scene'),
        mk(4, '"The system was rigged from the start," he said.', 'quote-callout'),
        mk(5, 'Nobody wanted to believe it at first.', 'object-scene'),
        mk(6, 'Trucks lined up outside the gates.', 'object-scene'),
        mk(7, 'The warehouse never seemed to empty.', 'object-scene'),
        mk(8, 'Over 60% of the cases went unreported that year.', 'data-claim'),
        mk(9, 'Investigators kept digging.', 'object-scene'),
        mk(10, 'So here is what it all means for you.', 'object-scene'),
        mk(11, 'If this helped, subscribe and comment below.', 'hook-tease'),
    ];
}
const CTX = () => ({
    productionMode: 'talkingHead',
    presenter: { mode: 'static', imageFile: 'C:/x/presenter.png', source: 'user' },
    hookEndTime: 9, ctaStartTime: 30, nicheId: 'explainer.crime', entities: [], entityTypes: {},
});

// (1) OFF short-circuit
console.log('[1] faceless / no-media short-circuit');
ok(assignPresenterDispositions(scenes(), { productionMode: 'faceless', presenter: { imageFile: 'x' } }).length === 0, 'faceless → no holds');
ok(assignPresenterDispositions(scenes(), { productionMode: 'talkingHead', presenter: null }).length === 0, 'no presenter image → no holds');

// (2) floor selection → SPANS, no cap, spread, layout rules
console.log('[2] floor selection → spans');
const spans = assignPresenterDispositions(scenes(), CTX());
{
    ok(spans.length > 0, `floor picks ≥1 hold (got ${spans.length})`);
    ok(spans.every(s => Number.isInteger(s.startSceneIndex) && s.endSceneIndex >= s.startSceneIndex), 'each hold is a valid span (end≥start)');
    ok(spans.some(s => s.endSceneIndex > s.startSceneIndex), 'at least one MULTI-beat hold (span, not a blip)');
    const starts = spans.map(s => s.startSceneIndex).sort((a, b) => a - b);
    let gapOk = true; for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] < 3) gapOk = false;
    ok(gapOk, `holds spread ≥3 apart (starts ${starts.join(',')})`);
    const hook = spans.find(s => s.startSceneIndex === 0);
    ok(hook && hook.layout === 'framed', 'hook hold → framed (fullscreen presenter removed)');
    const quote = spans.find(s => s.startSceneIndex <= 4 && s.endSceneIndex >= 4);
    ok(!quote || quote.layout === 'framed', 'quote hold → framed');
    ok(spans.every(s => ['light', 'normal', 'heavy'].includes(s.decorate)), 'every hold carries a decorate level');
}

// (3) enforce spans → every beat in a hold marked; continuation + span timing + download skip
console.log('[3] enforce spans');
{
    const s = scenes();
    s[0].keyword = 'factory'; s[0].sourceHint = 'stock'; s[0].fullscreenMG = 'mapChart: locator';
    const d = assignPresenterDispositions(s, CTX());
    const res = enforcePresenterDispositions(s, d, CTX());
    ok(res.holds === d.length, 'enforce reports every hold');
    const hold0 = d[0];
    for (let idx = hold0.startSceneIndex; idx <= hold0.endSceneIndex; idx++) {
        const sc = s.find(x => x.index === idx);
        ok(sc.presenterInsert && sc.presenterInsert.spanId, `beat ${idx} in hold marked presenterInsert`);
        ok(sc._presenterSpan && sc._presenterSpan.end > sc._presenterSpan.start, `beat ${idx} carries span timing`);
        ok(sc.mediaIntent.policy.download === 'skip', `beat ${idx} download=skip`);
    }
    const first = s.find(x => x.index === hold0.startSceneIndex);
    ok(first.presenterInsert.spanRole === (hold0.endSceneIndex > hold0.startSceneIndex ? 'start' : 'solo'), 'first beat role start/solo');
    ok(first.fullscreenMG === null && first.keyword === null, 'competing MG/footage stripped on hold');
    if (hold0.endSceneIndex > hold0.startSceneIndex) {
        const last = s.find(x => x.index === hold0.endSceneIndex);
        ok(last._presenterContinuation === true, 'continuation beat flagged (inner-cut suppression)');
        ok(!first._presenterContinuation, 'first beat NOT a continuation (keeps its entry transition)');
        ok(first._presenterSpan.id === last._presenterSpan.id, 'all beats share one spanId (continuous hold)');
    }
}

// (4) precedence: EVERY beat in a fullframe/framed hold forced must_not_map
console.log('[4] presenter holds out-rank maps');
{
    const s = scenes();
    s[0].text = 'Troops moved from France to Germany overnight.';
    s[1].text = 'The border between France and Germany blurred.';
    const ctx = { ...CTX(), nicheId: 'explainer.history', entities: ['France', 'Germany'], entityTypes: { france: 'country', germany: 'country' } };
    ctx._presenterDispositions = assignPresenterDispositions(s, ctx);
    const hold = ctx._presenterDispositions.find(x => x.startSceneIndex === 0);
    ok(hold, 'hook hold chosen');
    const maps = assignMapDispositions(s, ctx, null, null, {});
    for (let idx = hold.startSceneIndex; idx <= hold.endSceneIndex; idx++) {
        const m = maps.find(mm => mm.sceneIndex === idx);
        ok(m && m.disposition === 'must_not_map', `beat ${idx} forced must_not_map (presenter owns it)`);
    }
}

// (5) provider — static returns same image for every beat
console.log('[5] StaticImagePresenterProvider');
{
    const ctx = CTX();
    const p = createPresenterProvider(ctx);
    ok(p instanceof StaticImagePresenterProvider, 'static mode → StaticImagePresenterProvider');
    const m = p.getPresenterMedia(scenes()[0], ctx);
    ok(m && m.type === 'image' && m.file === ctx.presenter.imageFile, 'returns {type:image, file}');
}

// (6) agentic parse — spans validated, overlaps dropped, pip→framed (pip off), out-of-range clamped
console.log('[6] presenter-director.parse');
{
    const sc = scenes();
    const good = JSON.stringify({ spans: [
        { start: 0, end: 2, layout: 'fullframe', decorate: 'heavy', reason: 'hook' },
        { start: 1, end: 3, layout: 'framed', decorate: 'normal', reason: 'overlaps → drop' },
        { start: 6, end: 7, layout: 'pip', decorate: 'light', reason: 'pip disabled → framed' },
        { start: 99, end: 200, layout: 'framed', decorate: 'normal', reason: 'out of range start → drop' },
    ] });
    const parsed = presenterDirector.parse('here you go: ' + good, sc);
    ok(Array.isArray(parsed), 'parse returns array');
    ok(parsed.length === 2, `overlaps + out-of-range dropped (kept ${parsed.length})`);
    ok(parsed[0].startSceneIndex === 0 && parsed[0].endSceneIndex === 2 && parsed[0].layout === 'framed', 'first span kept intact (fullframe→framed)');
    ok(parsed[1].layout === 'framed', 'pip downgraded to framed when HF_PRESENTER_PIP off');
    ok(presenterDirector.parse('no json here', sc) === null, 'garbage → null (caller uses floor)');
    ok(Array.isArray(presenterDirector.parse(JSON.stringify({ spans: [] }), sc)), 'empty spans → [] (agent chose none)');
    const spl = presenterDirector.parse(JSON.stringify({ spans: [{ start: 3, end: 4, layout: 'split', side: 'right', decorate: 'normal' }] }), sc);
    ok(spl.length === 1 && spl[0].layout === 'split' && spl[0].side === 'right', 'parse accepts split layout + side');
}

// (7) resolvePresenterMedia fills every hold beat; faceless no-op
console.log('[7] resolvePresenterMedia');
(async () => {
    const s = scenes();
    const ctx = CTX();
    const d = assignPresenterDispositions(s, ctx);
    enforcePresenterDispositions(s, d, ctx);
    const anchorBeats = s.filter(x => x.presenterInsert).length;
    const filled = await resolvePresenterMedia(s, ctx, {});
    ok(filled === anchorBeats, `resolvePresenterMedia filled all ${anchorBeats} hold beat(s)`);
    ok(s.filter(x => x.presenterInsert).every(x => x.mediaFile === ctx.presenter.imageFile), 'every hold beat got the presenter image');
    const s2 = scenes();
    const filled2 = await resolvePresenterMedia(s2, { productionMode: 'faceless' }, {});
    ok(filled2 === 0 && !s2.some(x => x.presenterInsert), 'faceless resolvePresenterMedia is a no-op');

    // (8) FIX (critical): presenter anchors survive the Step-5 download filter + merge-back
    console.log('[8] anchors survive Step-5 filter + merge (critical-fix logic)');
    {
        const sc = scenes(); const cx = CTX();
        enforcePresenterDispositions(sc, assignPresenterDispositions(sc, cx), cx);
        // reproduce build-video.js:2864 filter + the merge-back fix
        let scenesWithMedia = sc.filter(x => !x.fullscreenMG && x.mediaIntent?.policy?.download !== 'skip');
        const filteredOut = sc.filter(x => x._presenterAnchor && !scenesWithMedia.includes(x));
        scenesWithMedia = [...scenesWithMedia, ...filteredOut].sort((a, b) => (Number(a.startTime) || 0) - (Number(b.startTime) || 0));
        ok(filteredOut.length > 0, 'anchors ARE filtered out pre-merge (merge is load-bearing)');
        ok(sc.filter(x => x._presenterAnchor).every(a => scenesWithMedia.includes(a)), 'every presenter anchor survives filter + merge');
    }

    // (9) FIX: multi-beat pip clamps to a single beat (no per-inner-cut pop)
    console.log('[9] pip single-beat clamp');
    {
        const sp = scenes(); const cx = CTX();
        enforcePresenterDispositions(sp, [{ startSceneIndex: 2, endSceneIndex: 5, layout: 'pip', decorate: 'normal', reason: 'pip' }], cx);
        const pipScenes = sp.filter(x => x.presenterInsert && x.presenterInsert.layout === 'pip');
        ok(pipScenes.length === 1 && pipScenes[0].index === 2, 'multi-beat pip → single beat (index 2 only)');
        ok(!sp.find(x => x.index === 5).presenterInsert, 'pip does not stamp later beats');
    }

    // (10) FIX: parse() clamps a hallucinated giant end to ~20s (not the whole video)
    console.log('[10] parse span-length clamp');
    {
        const long = [];
        for (let i = 0; i < 40; i++) long.push({ index: i, startTime: i * 3, endTime: (i + 1) * 3, text: 'x', sceneClass: 'object-scene' });
        const clamped = presenterDirector.parse(JSON.stringify({ spans: [{ start: 2, end: 999, layout: 'fullframe', decorate: 'normal' }] }), long);
        ok(Array.isArray(clamped) && clamped.length === 1, 'giant end → one span (not rejected)');
        const holdSec = long[clamped[0].endSceneIndex].endTime - long[clamped[0].startSceneIndex].startTime;
        ok(holdSec <= 23, `hold clamped to ~20s (got ${holdSec}s)`);
        ok(clamped[0].endSceneIndex < 39, 'hold does not swallow the whole video');
    }

    // (11) split-screen: presenter beside B-roll — footage KEPT, base preserved, side set
    console.log('[11] split-screen layout');
    {
        const sp = scenes(); const cx = CTX();
        sp[8].keyword = 'thermometer'; sp[8].sourceHint = 'stock'; sp[8].mediaFile = 'C:/broll/scene8.mp4';
        enforcePresenterDispositions(sp, [{ startSceneIndex: 8, endSceneIndex: 8, layout: 'split', side: 'left', decorate: 'normal', reason: 'split' }], cx);
        const s8 = sp.find(x => x.index === 8);
        ok(s8.presenterInsert && s8.presenterInsert.layout === 'split' && s8.presenterInsert.side === 'left', 'split beat → presenterInsert split/left');
        ok(s8._presenterSplit === true, 'split beat flagged _presenterSplit');
        ok(s8.keyword === 'thermometer' && (!s8.mediaIntent || s8.mediaIntent.policy?.download !== 'skip'), 'split KEEPS footage (keyword kept + download NOT skipped)');
        const filledSp = await resolvePresenterMedia(sp, cx, {});
        ok(filledSp >= 1, 'resolvePresenterMedia fills the split presenter panel');
        ok(s8.presenterInsert.mediaFile === cx.presenter.imageFile, 'split: presenter image on the inset');
        ok(s8.mediaFile === 'C:/broll/scene8.mp4', 'split: B-roll base media PRESERVED (not overwritten by presenter)');
    }

    console.log(`\n${checks} checks.`);
    console.log(fails ? `\n❌ ${fails} FAILURES` : `\n✅ ALL PRESENTER CHECKS PASSED (floor spans, enforce holds, precedence, provider, agentic parse, split-screen)`);
    process.exit(fails ? 1 : 0);
})();
