// Verify SFX↔transition/MG matching + gating + levels WITHOUT an app rebuild,
// AI call, or render. Feeds toClips an ADVERSARIAL wrong-family event for every
// transition/MG type and asserts the enforcement snaps it to the correct family
// (or silences it). Run: node scripts/verify-sfx-matching.js
'use strict';
const { collectMoments, toClips, livePalette } = require('../src/agents/workers/sound-designer');
const { TX_CANON_SFX, MG_CANON_SFX, MOTIVATED_TRANSITIONS, IMPACT_MG_TYPES, ROLE, normTx } = require('../src/agents/workers/sfx-rules');

const palette = livePalette();
const onDisk = (l) => (l || []).find(f => palette[f]) || null;
const WRONG = 'sfx-mg-chime.mp3'; // adversarial: force the wrong family on every moment
let fails = 0, checks = 0, skipped = 0;

const cutPlan = (tx) => ({
    scenes: [
        { index: 0, startTime: 0, endTime: 5, mediaFile: 'a.mp4', text: 'a' },
        { index: 1, startTime: 5, endTime: 10, mediaFile: 'b.mp4', text: 'b', transition: { type: tx, duration: 0.5 } },
    ], totalDuration: 12, scriptContext: {},
});

// (A) every MOTIVATED transition → its canonical family, at a valid role level
for (const tx of MOTIVATED_TRANSITIONS) {
    const m = collectMoments(cutPlan(tx));
    const out = toClips([{ at: 5, file: WRONG, vol: 0.99 }], palette, 12, m);
    const want = onDisk(TX_CANON_SFX[normTx(tx)]);
    if (!want) { skipped++; console.log(`  skip ${tx} (canonical family not on disk)`); continue; }
    checks++;
    const bad = out.length !== 1 || out[0].file !== want;
    const meta = out[0] && palette[out[0].file], role = meta && ROLE[meta.role];
    const volOk = out[0] && role && out[0].volume <= role.vmax + 1e-6 && out[0].volume >= role.vmin - 1e-6;
    if (bad || !volOk) { fails++; console.log(`  FAIL A ${tx}: got ${JSON.stringify((out || []).map(c => [c.file, c.volume]))} want ${want}`); }
}

// (B) soft blends / plain cuts stay SILENT
for (const tx of ['cut', 'crossfade', 'fade', 'dissolve', 'blur', 'panLeft', 'morph', 'ripple']) {
    checks++;
    const out = toClips([{ at: 5, file: 'sfx-whip.mp3', vol: 0.9 }], palette, 12, collectMoments(cutPlan(tx)));
    if (out.length !== 0) { fails++; console.log(`  FAIL B silent-${tx}: emitted ${out.length}`); }
}

// (C) every IMPACT MG reveal → its accent family
for (const mg of IMPACT_MG_TYPES) {
    const plan = { scenes: [{ index: 0, startTime: 0, endTime: 30, mediaFile: 'a.mp4', text: 'a' }], motionGraphics: [{ type: mg, startTime: 10, templateText: 'x' }], totalDuration: 40, scriptContext: {} };
    const want = onDisk(MG_CANON_SFX[mg]);
    if (!want) { skipped++; console.log(`  skip reveal ${mg} (no canonical accent on disk)`); continue; }
    checks++;
    const out = toClips([{ at: 10, file: WRONG, vol: 0.9 }], palette, 40, collectMoments(plan));
    if (out.length !== 1 || out[0].file !== want) { fails++; console.log(`  FAIL C reveal-${mg}: got ${(out || []).map(c => c.file)} want ${want}`); }
}

// (D) silent overlays never sound (lower-third etc.)
for (const mg of ['lowerThird', 'callout', 'focusWord', 'kineticText', 'caption', 'bulletList']) {
    checks++;
    const plan = { scenes: [{ index: 0, startTime: 0, endTime: 30, mediaFile: 'a.mp4', text: 'a' }], motionGraphics: [{ type: mg, startTime: 10, text: 'x' }], totalDuration: 40, scriptContext: {} };
    const out = toClips([{ at: 10, file: 'sfx-mg-pop.mp3', vol: 0.9 }], palette, 40, collectMoments(plan));
    if (out.length !== 0) { fails++; console.log(`  FAIL D silent-overlay-${mg}: emitted ${out.length}`); }
}

// (E) off-moment placement is dropped (sync guard)
{
    checks++;
    const out = toClips([{ at: 50, file: 'sfx-whip.mp3', vol: 0.9 }], palette, 12, collectMoments(cutPlan('whip-left')));
    if (out.length !== 0) { fails++; console.log(`  FAIL E off-moment not dropped: emitted ${out.length}`); }
}

// (F) whoosh lead syncs to the move midpoint (startTime ≈ boundary − txDur/2)
{
    checks++;
    const out = toClips([{ at: 5, file: 'sfx-mg-chime.mp3', vol: 0.5 }], palette, 12, collectMoments(cutPlan('push-left')));
    const st = out[0] && out[0].startTime;
    if (!out[0] || Math.abs(st - (5 - 0.25)) > 0.02) { fails++; console.log(`  FAIL F push sync: startTime=${st} want ~4.75`); }
}

console.log(`\n${checks} checks, ${skipped} skipped (file not on disk).`);
console.log(fails ? `\n❌ ${fails} FAILURES` : `\n✅ ALL SFX MATCHING / GATE / SILENCE / SYNC CHECKS PASSED`);
process.exit(fails ? 1 : 0);
