'use strict';
/**
 * sfx-rules.js — SINGLE SOURCE OF TRUTH for SFX gating & levels.
 *
 * Grounded in professional sound-design practice for faceless documentary /
 * explainer video: SFX are MOTIVATED (something moved/arrived/changed),
 * SUBORDINATE (always under the voiceover) and SPARSE (contrast, not density).
 * A sound on every cut or every lower-third is the #1 amateur tell — so most
 * transitions and ALL persistent text overlays stay SILENT.
 *
 * Imported by:
 *   - sound-designer.js  (authoritative AI placer)
 *   - build-video.js     (mechanical graceful-degradation floor)
 * Mirrored (kept in sync) by:
 *   - ui/js/app.js        (editor-side floor — renderer sandbox can't require())
 */

// Transitions that EARN a sound (normalized via normTx: lowercase, strip
// -_/space and trailing direction/pan). Kinetic moves + hard/textural cuts.
// Everything else — cut, crossfade, dissolve, fade, blur, luma, morph, ripple,
// ink, reveal — is SILENT (a soft blend has no motion to sound).
const MOTIVATED_TRANSITIONS = new Set([
    'whip', 'whippan', 'zoompunch', 'zoomrotate', 'dipblack', 'fadetoblack', 'flash',
    'cameraflash', 'glitch', 'datamosh', 'rgbsplit', 'static', 'filmburn', 'spin',
    'prismshift', 'shutterslice', 'pixelate', 'mosaic', 'push', 'slide', 'swipe', 'bounce',
    'lensflare', 'fireburn', 'lightsweep', 'wipe',
]);

// MG / overlay types whose REVEAL may earn a sound. DELIBERATELY MINIMAL.
//
// A stat card, chart, counter, comparison, key-takeaway, timeline, map or quote
// card is punctuated by its OWN count-up / reveal ANIMATION — it does NOT need a
// bell/ding on top. Reflexively sounding every UI graphic ("why does my stat
// card go *ding*") is the #1 AI-editing tell, so ALL of those are SILENT here.
// A type-based rule also can't tell a shocking $2000 reveal from a routine $300
// card, so it must not reflexively sound either — a genuinely dramatic beat is
// carried by the MOTIVATED TRANSITION on that cut (zoom-punch / dip-black, which
// already sound) or by an explicit per-scene creator directive, not by the card.
//
// The ONLY graphic that earns its own sound is the subscribe CTA: a two-tone
// chime is a universal, expected, once-per-video viewer-action cue.
const IMPACT_MG_TYPES = new Set([
    'subscribeCTA',
]);
// (Silent by design: statCard, statCounter, barChart, donutChart, comparisonCard,
// keyTakeaway, rankingList, timeline, timelineCard, chapterCard, locationCard,
// mapChart, infographic, quoteCard, headline — their reveal animation is the beat.)

// Structurally SILENT overlays — persistent reading aids, never beats. A sound
// on these is the exact "why does my lower-third have a swoosh" amateur tell.
// The AI placer must not even SEE these as scoreable.
const SILENT_MG = new Set([
    'lowerThird', 'callout', 'focusWord', 'kineticText', 'caption', 'subtitle',
    'bulletList', 'typewriter', 'tag', 'eyebrow', 'explainer', 'progressBar',
    'progressTracker', 'listicleCounter', 'personIntro', 'imageShowcase',
    'listicleGrid', 'splitScreen',
]);

// Density gates (documentary/explainer band — NOT hype/challenge content).
const DENSITY = {
    minGapSec: 4.0,        // ≥4s between event SFX (whoosh/impact/accent)
    maxPerMin: 6,          // target ceiling for tasteful explainer
    hardCapPerMin: 8,      // never exceed regardless of AI enthusiasm
    dedupeSameFileSec: 15, // same file may not fire twice within 15s
};

// Per-role level (linear multiplier vs VO=1.0 @ -16 LUFS) + lead (how far the
// sound starts BEFORE its anchor). SFX always sit UNDER narration.
const ROLE = {
    whoosh:  { vmin: 0.30, vmax: 0.46, lead: 0.05 },   // clearly present, under VO
    impact:  { vmin: 0.46, vmax: 0.56, lead: 0.0 },    // the punch (loudest, rare) — capped so a riser+impact stack stays under FS
    texture: { vmin: 0.12, vmax: 0.18, lead: 0.06 },   // ambience bed, low + sustained (un-ducked → sits lower)
    accent:  { vmin: 0.24, vmax: 0.36, lead: 0.0 },    // UI reveal tick — audible, not shrill
    riser:   { vmin: 0.18, vmax: 0.40, lead: 1.0 },    // ramps into its paired impact (won't mask VO)
};

// ── Canonical family map: GUARANTEES the right sound per transition, no matter
// what the AI freely picked. Keyed by normTx() output. Ordered fallback — the
// first file present on disk wins, so a missing sound (e.g. sfx-boom) degrades
// to a softer real file instead of emitting dead audio. null = soft blend that
// must stay SILENT (belt-and-suspenders with the MOTIVATED_TRANSITIONS gate).
const TX_CANON_SFX = {
    push: ['sfx-slide.mp3', 'sfx-pan.mp3'], slide: ['sfx-slide.mp3', 'sfx-pan.mp3'],
    swipe: ['sfx-wipe.mp3'], wipe: ['sfx-wipe.mp3'],
    whip: ['sfx-whip.mp3'], whippan: ['sfx-whip.mp3'],
    zoompunch: ['sfx-zoom.mp3'], zoompull: ['sfx-zoom.mp3'], zoom: ['sfx-zoom.mp3'],
    spin: ['sfx-spin.mp3'], spinsettle: ['sfx-spin.mp3'], zoomrotate: ['sfx-spin.mp3'],
    fireburn: ['sfx-filmburn.mp3'], filmburn: ['sfx-filmburn.mp3'],
    lensflare: ['sfx-flare.mp3'], flare: ['sfx-flare.mp3'],
    lightsweep: ['sfx-warm-leak.mp3', 'sfx-flare.mp3'],
    flash: ['sfx-flash.mp3'], flashwhite: ['sfx-flash.mp3'],
    cameraflash: ['sfx-camera-flash.mp3', 'sfx-flash.mp3'],
    dipblack: ['sfx-boom.mp3', 'sfx-impact.mp3', 'sfx-fade.mp3'],   // deep drop; degrades to soft fade until boom is downloaded
    fadetoblack: ['sfx-boom.mp3', 'sfx-impact.mp3', 'sfx-fade.mp3'],
    glitch: ['sfx-glitch.mp3'], datamosh: ['sfx-glitch.mp3'], rgbsplit: ['sfx-glitch.mp3'],
    pixelate: ['sfx-glitch.mp3'], mosaic: ['sfx-glitch.mp3'],
    static: ['sfx-static.mp3'], scanline: ['sfx-static.mp3'],
    prismshift: ['sfx-prism.mp3'], shutterslice: ['sfx-shutter.mp3'], bounce: ['sfx-bounce.mp3'],
    // soft blends → MUST stay silent
    crossfade: null, fade: null, dissolve: null, cut: null, none: null, hardcut: null,
    blur: null, luma: null, morph: null, ripple: null, ink: null, reveal: null, pan: null,
};
// MG reveal → accent family. Only the subscribe CTA earns a graphic sound now
// (see IMPACT_MG_TYPES); every data/UI card is silent — its reveal animation is
// the punctuation. Kept as a map (not inlined) so re-enabling a type later is a
// one-line change AND is still gated by IMPACT_MG_TYPES.
const MG_CANON_SFX = {
    subscribeCTA: ['sfx-mg-chime.mp3'],
};

// Salience for de-stacking a crowded window: keep the important sound.
const SALIENCE = { impact: 3, riser: 3, whoosh: 2, accent: 2, texture: 1 };

function normTx(t) {
    const base = String(t || '').toLowerCase().replace(/[-_\s]/g, '');
    return base.replace(/(left|right|up|down|pan)$/g, '') || base;
}

module.exports = { MOTIVATED_TRANSITIONS, IMPACT_MG_TYPES, SILENT_MG, DENSITY, ROLE, SALIENCE, normTx, TX_CANON_SFX, MG_CANON_SFX };
