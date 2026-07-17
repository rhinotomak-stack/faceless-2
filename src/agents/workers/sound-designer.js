/**
 * Sound Designer Worker — the agentic half of the SFX system.
 *
 * ONE batch reasoning call that reads the video's full timeline (scene cuts +
 * their narration, transition types, MG reveals, theme, niche, pacing) and
 * SCORES a motivated, sparse sound-effects track from the real SFX palette —
 * the way a human sound designer scores a cut, matched to TONE and BEAT, not a
 * mechanical transition-type→file lookup. Most cuts stay SILENT on purpose;
 * sounds are spent only where the story earns them, tone-matched to the theme
 * (crime = tense hits/film-burn/static, nature = soft organic leaks, tech =
 * glitch/riser, luxury = refined chimes), and never stacked.
 *
 * Output → plan.sfxClips = [{ file, startTime, duration, volume }] — the exact
 * contract the HyperFrames bridge (audio tags) and export muxer consume. The
 * mechanical build-video placement remains the graceful-degradation floor: the
 * designer only OVERRIDES on success.
 *
 * Flag: HF_SOUND_DESIGNER=0 disables. Cost: 1 AI call per build, disk-cached
 * (.hf-sfx-cache.json) like the Transition/FX directors.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../../brain/ai-provider');
const { SILENT_MG, IMPACT_MG_TYPES, MOTIVATED_TRANSITIONS, ROLE, DENSITY, SALIENCE, normTx, TX_CANON_SFX, MG_CANON_SFX } = require('./sfx-rules');

const SFX_DIR = path.join(__dirname, '..', '..', '..', 'assets', 'sfx');

// Palette metadata: role + one-line description + default clip duration + a
// default volume for that role (the final mix is loudnorm-normalized, so these
// are RELATIVE levels). Only files that actually exist on disk are offered to
// the model, so a missing download can never produce a dead <audio> tag.
const PALETTE_META = {
    // ── whoosh: transition MOVEMENT (kinetic cuts) ──
    'sfx-whip.mp3':       { role: 'whoosh', desc: 'fast whip-pan swoosh (snappy, aggressive)', dur: 0.32, vol: 0.32 },
    'sfx-slide.mp3':      { role: 'whoosh', desc: 'clean slide swoosh', dur: 0.4, vol: 0.3 },
    'sfx-pan.mp3':        { role: 'whoosh', desc: 'smooth camera pan swoosh', dur: 0.4, vol: 0.3 },
    'sfx-wipe.mp3':       { role: 'whoosh', desc: 'quick screen wipe', dur: 0.3, vol: 0.3 },
    'sfx-zoom.mp3':       { role: 'whoosh', desc: 'zoom / punch-in whoosh', dur: 0.45, vol: 0.32 },
    'sfx-spin.mp3':       { role: 'whoosh', desc: 'spinning rotational swoosh', dur: 0.5, vol: 0.3 },
    'sfx-blur.mp3':       { role: 'whoosh', desc: 'soft airy defocus whoosh', dur: 0.45, vol: 0.28 },
    'sfx-flare.mp3':      { role: 'whoosh', desc: 'bright lens-flare shimmer whoosh', dur: 0.5, vol: 0.3 },
    'sfx-warm-leak.mp3':  { role: 'whoosh', desc: 'warm golden light-leak shimmer (nostalgic)', dur: 0.55, vol: 0.28 },
    'sfx-cool-leak.mp3':  { role: 'whoosh', desc: 'cool icy shimmer whoosh', dur: 0.55, vol: 0.28 },
    // ── impact: a HIT / accent on a reveal or hard beat ──
    'sfx-flash.mp3':      { role: 'impact', desc: 'bright flash pop (punchy)', dur: 0.3, vol: 0.44 },
    'sfx-camera-flash.mp3': { role: 'impact', desc: 'camera shutter snap (photo beat)', dur: 0.3, vol: 0.42 },
    'sfx-shutter.mp3':    { role: 'impact', desc: 'mechanical shutter click', dur: 0.3, vol: 0.4 },
    'sfx-bounce.mp3':     { role: 'impact', desc: 'elastic bounce pop (playful)', dur: 0.4, vol: 0.4 },
    'sfx-diamond.mp3':    { role: 'impact', desc: 'geometric sparkle reveal', dur: 0.4, vol: 0.4 },
    // ── texture: ATMOSPHERE / tension bed / cinematic grit (use sparingly) ──
    'sfx-filmburn.mp3':   { role: 'texture', desc: 'film-burn crackle (vintage / dramatic / crime)', dur: 0.6, vol: 0.24 },
    'sfx-static.mp3':     { role: 'texture', desc: 'TV static burst (tension / news / glitchy)', dur: 0.55, vol: 0.22 },
    'sfx-glitch.mp3':     { role: 'texture', desc: 'digital glitch stutter (tech / corruption)', dur: 0.4, vol: 0.28 },
    'sfx-ink.mp3':        { role: 'texture', desc: 'ink / liquid spread (soft organic)', dur: 0.6, vol: 0.22 },
    'sfx-ripple.mp3':     { role: 'texture', desc: 'water ripple shimmer (calm / nature)', dur: 0.6, vol: 0.22 },
    'sfx-dissolve.mp3':   { role: 'texture', desc: 'airy shimmer dissolve (soft time-passing)', dur: 0.5, vol: 0.22 },
    'sfx-prism.mp3':      { role: 'texture', desc: 'crystal shimmer chime (elegant / luxury)', dur: 0.5, vol: 0.26 },
    'sfx-fade.mp3':       { role: 'texture', desc: 'soft neutral whoosh (gentle, understated)', dur: 0.5, vol: 0.24 },
    'sfx-blinds.mp3':     { role: 'texture', desc: 'venetian blinds shutter', dur: 0.4, vol: 0.28 },
    // ── accent: MG / UI reveal chirps (graphics, counters, CTAs) ──
    'sfx-mg-pop.mp3':     { role: 'accent', desc: 'quick UI pop-in (headline / card)', dur: 0.25, vol: 0.36 },
    'sfx-mg-tick.mp3':    { role: 'accent', desc: 'single counter tick (stat / number)', dur: 0.15, vol: 0.34 },
    'sfx-mg-swoosh.mp3':  { role: 'accent', desc: 'UI swoosh slide-in (panel / card reveal)', dur: 0.3, vol: 0.2 },
    'sfx-mg-ding.mp3':    { role: 'accent', desc: 'bright bell ding (chart / data reveal)', dur: 0.4, vol: 0.22 },
    'sfx-mg-type.mp3':    { role: 'accent', desc: 'code/terminal reveal keys', dur: 0.2, vol: 0.18 },
    'sfx-mg-rise.mp3':    { role: 'accent', desc: 'ascending riser (timeline / build-up)', dur: 0.6, vol: 0.36 },
    'sfx-mg-chime.mp3':   { role: 'accent', desc: 'two-tone chime (subscribe / CTA)', dur: 0.5, vol: 0.38 },
    // ── sound-design primitives (present only if downloaded; safe if absent) ──
    'sfx-impact.mp3':     { role: 'impact', desc: 'deep cinematic boom hit (big reveal / gut-punch)', dur: 0.6, vol: 0.5 },
    'sfx-riser.mp3':      { role: 'riser', desc: 'tension riser / uplifter INTO a beat (build-up)', dur: 1.2, vol: 0.34 },
    'sfx-boom.mp3':       { role: 'impact', desc: 'sub boom / braam (heavy dramatic hit)', dur: 0.8, vol: 0.5 },
};

// ROLE (per-role volume clamp + lead) now comes from sfx-rules.js (single source
// of truth, shared with the build-video floor and mirrored in the app).

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_SOUND_DESIGNER || '').trim());
}
function toSec(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Palette of SFX files that actually exist on disk right now. */
function livePalette() {
    const out = {};
    for (const [file, meta] of Object.entries(PALETTE_META)) {
        try { if (fs.existsSync(path.join(SFX_DIR, file))) out[file] = meta; } catch (_) { /* skip */ }
    }
    return out;
}

/** Ordered list of scoreable moments (cuts + MG reveals + hook/CTA beats). */
function collectMoments(plan) {
    const moments = [];
    const scenes = (plan.scenes || []).filter(s => s && !s.isMGScene && s.mediaFile)
        .slice().sort((a, b) => toSec(a.startTime) - toSec(b.startTime));
    for (let i = 1; i < scenes.length; i++) {
        const prev = scenes[i - 1], cur = scenes[i];
        if (Math.abs(toSec(cur.startTime) - toSec(prev.endTime)) > 0.35) continue; // gap, not a real cut
        const txObj = (cur.transition && typeof cur.transition === 'object') ? cur.transition : null;
        const tx = txObj ? txObj.type : cur.transition;
        moments.push({
            kind: 'cut', at: toSec(cur.startTime),
            tx: tx || 'cut',
            txDur: txObj ? toSec(txObj.duration, 0) : 0, // real transition length → whoosh lead/tail sync
            text: String(cur.text || '').replace(/\s+/g, ' ').slice(0, 90),
            cls: cur.sceneClass || '',
        });
    }
    const pushMg = (mg) => {
        if (!mg || mg.disabled) return;
        const t = String(mg.type || mg.templateType || 'graphic');
        // Persistent reading aids (lower-thirds/captions/focus words/bullets…) are
        // NOT beats — they must never be scoreable. Only genuine data/story reveals
        // that PUNCH in earn an accent. The AI can't even see the rest.
        if (SILENT_MG.has(t)) return;
        if (!IMPACT_MG_TYPES.has(t)) return;
        moments.push({
            kind: 'reveal', at: toSec(mg.startTime), mg: t,
            text: String(mg.templateText || mg.text || mg.sceneText || '').replace(/\s+/g, ' ').slice(0, 70),
        });
    };
    (plan.motionGraphics || []).forEach(pushMg);
    (plan.mgScenes || []).forEach(pushMg);
    (plan.templateScenes || []).forEach(pushMg);
    return moments.sort((a, b) => a.at - b.at);
}

function buildPrompt(palette, moments, sc, totalDuration) {
    const byRole = {};
    for (const [file, m] of Object.entries(palette)) (byRole[m.role] = byRole[m.role] || []).push(`${file} — ${m.desc}`);
    const paletteText = Object.entries(byRole).map(([role, list]) => `${role.toUpperCase()}:\n  ${list.join('\n  ')}`).join('\n');
    const momText = moments.map(mo => mo.kind === 'cut'
        ? `  ${mo.at.toFixed(1)}s CUT tx=${mo.tx}${mo.cls ? ' [' + mo.cls + ']' : ''} → "${mo.text}"`
        : `  ${mo.at.toFixed(1)}s REVEAL ${mo.mg}${mo.text ? ' "' + mo.text + '"' : ''}`
    ).join('\n');
    return `You are the SOUND DESIGNER for a faceless YouTube video (theme "${sc.themeId || 'standard'}", niche "${sc.nicheId || ''}", pacing "${sc.pacing || 'normal'}", length ${Math.round(totalDuration)}s).
Score a SPARSE, MOTIVATED sound-effects track over the cut. You choose ONLY from the SFX palette below (use the exact filenames).

SFX PALETTE (role: files):
${paletteText}

MOMENTS you may score (times are absolute seconds). MOST of these must stay SILENT — restraint is the craft:
${momText}

HOW A REAL SOUND DESIGNER WORKS (motivated · subordinate · sparse):
- RESTRAINT is the craft. Target 3-6 sounds PER MINUTE, never two within 4 seconds. Whole calm sections stay SILENT — contrast is what makes the one big reveal land. Wall-to-wall SFX is the #1 amateur tell.
- WHOOSH only on KINETIC cuts (whip / push / slide / zoom-punch / spin / wipe). Crossfades, dissolves, soft fades and plain cuts get NOTHING (a soft blend has no motion to sound).
- GRAPHICS ARE SILENT BY DEFAULT. A stat card, chart, counter, comparison, key-takeaway, timeline, map or quote card is punctuated by its OWN count-up / reveal ANIMATION — do NOT put a ding/chime/tick on it. Reflexively sounding UI cards is the #1 amateur tell. The MOMENTS list already excludes them, so you will only ever see the subscribe CTA as a scoreable graphic — score it a soft two-tone chime.
- A genuinely dramatic SPOKEN reveal (a shock number, a gut-punch line) is punctuated by the MOTIVATED TRANSITION on that cut (a zoom-punch or dip-black already carries the sound) — not by a sound on the card itself. Reserve a standalone IMPACT for at most ONE such beat in the whole video, landing in a 2-3s narration GAP, never over words or over a routine on-screen number.
- SUBORDINATE: every sound sits UNDER the narration. Volumes — whoosh ~0.24, accent ~0.2, impact ~0.42 (rare), texture bed ~0.12, riser ramps ~0.12→0.38.
- LAYERING: at most 1-2 times in the WHOLE video, only on the single biggest reveal — a riser leading INTO the beat + an impact landing ON it. Place impact/riser payoffs in the 2-3s narration GAP after a key line, not over words.
- TONE matches theme/niche: crime/history → tense film-burn / static / deep impact; nature → soft ripple / ink / warm-leak, very sparse; tech → glitch / riser / zoom; luxury → prism chime, refined; news → clean whoosh + crisp impact.

Respond with ONLY JSON:
{"sfx":[{"at":26.4,"file":"sfx-whip.mp3","vol":0.3,"why":"kinetic push into the demo"},{"at":169.4,"file":"sfx-impact.mp3","vol":0.48,"why":"the $2000 reveal"}]}`;
}

function parse(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '').trim();
    const s = t.indexOf('{'), e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { const o = JSON.parse(t.slice(s, e + 1)); return Array.isArray(o.sfx) ? o.sfx : null; } catch (_) { return null; }
}

/** Turn validated designer events into plan.sfxClips (clamped, deduped, sorted). */
function toClips(events, palette, totalDuration, moments = []) {
    const minGap = Number(process.env.SFX_MIN_GAP_SEC || DENSITY.minGapSec);
    const SNAP = 0.6; // an AI event must sit on a real moment; off-moment placements drop (sync guard)
    const cuts = moments.filter(m => m.kind === 'cut');
    const reveals = moments.filter(m => m.kind === 'reveal');
    const nearest = (arr, at) => { let b = null, bd = SNAP; for (const m of arr) { const d = Math.abs(toSec(m.at) - at); if (d <= bd) { bd = d; b = m; } } return b; };
    const onDisk = (list) => { for (const f of (list || [])) if (palette[f]) return f; return null; };
    const clean = [];
    for (const ev of events) {
        if (!ev) continue;
        const at = toSec(ev.at, -1);
        if (at < 0 || (totalDuration && at > totalDuration + 0.5)) continue;

        // ── FAMILY + MOTIVATED-GATE + SYNC enforcement ──────────────────────────
        // The AI owns WHEN a sound fires + its volume/rhythm; this code owns WHAT
        // family plays and WHETHER a moment may sound — so a push can NEVER get a
        // fire-burn crackle, and a plain cut / soft dissolve can NEVER get a whoosh.
        let file = null, txDur = 0, isReveal = false;
        const cut = nearest(cuts, at), rev = nearest(reveals, at);
        const useCut = cut && (!rev || Math.abs(toSec(cut.at) - at) <= Math.abs(toSec(rev.at) - at));
        if (useCut) {
            const k = normTx(cut.tx);
            if (!MOTIVATED_TRANSITIONS.has(k)) continue;   // plain cut / crossfade / soft blend → SILENT
            if (TX_CANON_SFX[k] === null) continue;        // explicit soft-blend guard
            file = onDisk(TX_CANON_SFX[k]);                // GUARANTEED the transition's own family
            txDur = toSec(cut.txDur, 0);
        } else if (rev) {
            if (!IMPACT_MG_TYPES.has(rev.mg)) continue;    // reading aid → SILENT
            file = onDisk(MG_CANON_SFX[rev.mg]);           // right accent family for this graphic
            isReveal = true;
        } else {
            continue;                                      // off-moment placement → drop (sync guard)
        }
        if (!file || !palette[file]) continue;             // family unavailable on disk → SILENT, never wrong-family

        const meta = palette[file];
        const role = ROLE[meta.role] || ROLE.accent;
        const vol = Math.max(role.vmin, Math.min(role.vmax, toSec(ev.vol, meta.vol))); // re-clamp to the COERCED file's role
        // SYNC: a whoosh leads to the move's midpoint and can't outlive the move.
        let lead = role.lead, dur = meta.dur;
        if (meta.role === 'whoosh') {
            lead = txDur > 0 ? Math.max(0.05, Math.min(0.30, txDur * 0.5)) : 0.20;
            if (txDur > 0) dur = Math.min(meta.dur, txDur + 0.15);
        }
        // A reveal hit lands on the graphic's settle frame (~+0.12s), not entrance frame 0.
        if (isReveal && (meta.role === 'impact' || meta.role === 'accent')) lead = role.lead - 0.12;
        clean.push({ at, file, role: meta.role, dur, lead, vol });
    }
    // Place in SALIENCE order so the important sound wins a crowded window (an
    // impact/riser reveal beats a whoosh or a texture bed).
    clean.sort((a, b) => (SALIENCE[b.role] || 0) - (SALIENCE[a.role] || 0) || b.vol - a.vol || a.at - b.at);
    // Edge-to-edge interval so a lead-in (riser/whoosh) can't silently overlap a
    // neighbour; exempt ONE riser|texture + impact "lead→land" pair on a beat.
    const span = (c) => { const s = c.at - c.lead; return [s, s + c.dur]; };
    const tooClose = (c, kept) => {
        const [cs, ce] = span(c);
        return kept.some(k => {
            const [ks, ke] = span(k);
            const apart = (cs - ke >= minGap) || (ks - ce >= minGap);
            if (apart) return false;
            const pair = (c.role === 'impact' && (k.role === 'riser' || k.role === 'texture'))
                      || (k.role === 'impact' && (c.role === 'riser' || c.role === 'texture'));
            return !pair;
        });
    };
    const kept = [];
    for (const c of clean) {
        if (tooClose(c, kept)) continue;
        // Rolling per-minute density cap: free up to maxPerMin, then only genuine
        // beats (impact/riser) may exceed it, hard-stop at hardCapPerMin.
        const inWin = kept.filter(k => Math.abs(k.at - c.at) < 60).length;
        if (inWin >= DENSITY.hardCapPerMin) continue;
        if (inWin >= DENSITY.maxPerMin && (SALIENCE[c.role] || 0) < 3) continue;
        kept.push(c);
    }
    // Same-file de-repetition: never fire the identical sound twice within N sec.
    kept.sort((a, b) => a.at - b.at);
    const out = [];
    for (const c of kept) {
        if (out.some(k => k.file === c.file && Math.abs(k.at - c.at) < DENSITY.dedupeSameFileSec)) continue;
        out.push(c);
    }
    return out.map(c => ({
        file: c.file,
        startTime: Math.max(0, +(c.at - c.lead).toFixed(3)),
        duration: c.dur,
        volume: +c.vol.toFixed(3),
    }));
}

/**
 * Design the SFX track for a plan. Returns { clips, designed, cached?, skipped?, failed? }.
 * On any failure returns { clips: null } so the caller keeps its mechanical floor.
 */
async function designSound(plan, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    if (!plan || isDisabled()) return { clips: null, designed: 0, skipped: true };

    const palette = livePalette();
    if (Object.keys(palette).length === 0) { log('  🔇 [Sound Designer] no SFX files on disk — skipping'); return { clips: null, designed: 0, skipped: true }; }

    const moments = collectMoments(plan);
    if (moments.length < 2) return { clips: null, designed: 0, skipped: true };

    const sc = plan.scriptContext || {};
    const totalDuration = toSec(plan.totalDuration, moments[moments.length - 1].at + 5);

    const hash = crypto.createHash('sha1')
        .update(JSON.stringify({
            v: 3, // ruleset v3 (family-enforced + sync) — bust stale caches
            m: moments.map(mo => [mo.kind, mo.at.toFixed(1), mo.tx || mo.mg, mo.txDur || 0, (mo.text || '').slice(0, 40)]),
            t: sc.themeId, n: sc.nicheId, p: sc.pacing,
            pal: Object.keys(palette).sort(),
        }))
        .digest('hex').slice(0, 16);
    const cachePath = opts.projectDir ? path.join(opts.projectDir, '.hf-sfx-cache.json') : null;

    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached && cached.hash === hash && Array.isArray(cached.events)) {
                const clips = toClips(cached.events, palette, totalDuration, moments);
                if (clips.length) { log(`  🔊 [Sound Designer] ${clips.length} SFX loaded from cache (0 AI calls)`); return { clips, designed: clips.length, cached: true }; }
            }
        } catch (_) { /* stale — recompute */ }
    }

    let events = null;
    try {
        const text = await callAI(
            buildPrompt(palette, moments, sc, totalDuration),
            { maxTokens: 2400, temperature: 0.5, taskType: 'brain' }
        );
        events = parse(text);
    } catch (e) {
        log(`  ⚠️ [Sound Designer] AI call failed: ${String(e.message || e).slice(0, 110)} — keeping mechanical SFX`);
        return { clips: null, designed: 0, failed: true };
    }
    if (!events) { log('  ⚠️ [Sound Designer] unparseable response — keeping mechanical SFX'); return { clips: null, designed: 0, failed: true }; }

    const clips = toClips(events, palette, totalDuration, moments);
    if (!clips.length) { log('  ⚠️ [Sound Designer] no usable placements — keeping mechanical SFX'); return { clips: null, designed: 0, failed: true }; }

    if (cachePath) { try { fs.writeFileSync(cachePath, JSON.stringify({ hash, events })); } catch (_) { /* non-fatal */ } }
    const perMin = (clips.length / Math.max(1, totalDuration / 60)).toFixed(1);
    log(`  🔊 [Sound Designer] scored ${clips.length} SFX across ${Math.round(totalDuration)}s (${perMin}/min, tone: ${sc.themeId || 'standard'}, 1 AI call)`);
    return { clips, designed: clips.length };
}

module.exports = { designSound, PALETTE_META, livePalette, collectMoments, toClips };
