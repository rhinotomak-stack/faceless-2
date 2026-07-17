/**
 * pacing-verify.js — narration-cue pacing verifier (OPENMONTAGE-BORROW-PLAN #8).
 *
 * All our sync is FORWARD-PLANNING (the planner places events near the naming
 * word); nothing ASSERTS they actually landed. This walks the finished plan and
 * checks, deterministically (no AI, no ffmpeg):
 *   1. word/scene sync — each scene's WhisperX words fall inside its time window
 *      (drift = the visual timeline desynced from the narration)
 *   2. cue landing — word-synced visuals (icon moments, MGs) fire inside the
 *      scene they belong to
 *   3. underfill / dead-air — a long static scene (still image, no icon/MG
 *      activity) that just sits frozen while narration keeps going
 *
 * Consumed by final-review. All findings are advisory.
 */
'use strict';

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function verifyPacing(plan, opts = {}) {
    const findings = [];
    const scenes = (plan && Array.isArray(plan.scenes)) ? plan.scenes : [];
    const mgs = (plan && Array.isArray(plan.motionGraphics)) ? plan.motionGraphics : [];
    const EPS = 0.6;                 // tolerance for a word straddling a boundary
    const UNDERFILL_SEC = num(opts.underfillSec, 12);  // static scene longer than this = dead-air risk
    const CUE_TOL = num(opts.cueTolSec, 1.0);           // a cue must land within 1s of its window

    let driftScenes = 0, staticScenes = 0, strayCues = 0;

    for (const s of scenes) {
        if (!s || (s.trackId && s.trackId !== 'video-track-1')) continue;
        const st = num(s.startTime), en = num(s.endTime, st + num(s.duration));
        if (!(en > st)) continue;

        // (1) word/scene sync drift
        const words = Array.isArray(s.words) ? s.words : [];
        if (words.length >= 4) {
            let outside = 0;
            for (const w of words) {
                const ws = num(w.start, num(w.startTime));
                const we = num(w.end, num(w.endTime, ws));
                if (we < st - EPS || ws > en + EPS) outside++;
            }
            const frac = outside / words.length;
            if (frac > 0.25) {
                driftScenes++;
                findings.push({
                    severity: frac > 0.5 ? 'fail' : 'warn',
                    code: 'word_scene_drift',
                    message: `Scene ${s.index ?? '?'} (${st.toFixed(1)}–${en.toFixed(1)}s): ${outside}/${words.length} narration words fall outside the scene window — visual/narration desync.`,
                });
            }
        }

        // (2) cue landing — icon moments fire at a SCENE-RELATIVE offset (`at` is
        // seconds from scene start, not absolute), so validate against [0, duration].
        const dur0 = en - st;
        const icons = Array.isArray(s._iconMoments) ? s._iconMoments : [];
        for (const ic of icons) {
            const at = num(ic.at, NaN);
            if (Number.isFinite(at) && (at < -CUE_TOL || at > dur0 + CUE_TOL)) {
                strayCues++;
                findings.push({
                    severity: 'warn',
                    code: 'cue_out_of_window',
                    message: `Scene ${s.index ?? '?'}: icon "${ic.concept || ic.kind || 'moment'}" fires ${at.toFixed(1)}s into a ${dur0.toFixed(1)}s scene — past its end.`,
                });
            }
        }

        // (3) underfill / dead-air — long static scene with no visual activity
        const dur = en - st;
        const isStill = (s.mediaType === 'image') || /\.(png|jpe?g|webp|gif|avif)$/i.test(String(s.mediaExtension || s.mediaFile || ''));
        const hasActivity = icons.length > 0 || mgs.some((m) => num(m.sceneIndex, -1) === num(s.index, -2));
        if (isStill && dur > UNDERFILL_SEC && !hasActivity) {
            staticScenes++;
            findings.push({
                severity: 'warn',
                code: 'static_scene_deadair',
                message: `Scene ${s.index ?? '?'} holds one still image for ${dur.toFixed(1)}s with no motion graphic or icon — likely dead air / slideshow feel.`,
            });
        }
    }

    // (2b) MG scheduling — mg.startTime is ABSOLUTE, but mg.sceneIndex is an
    // original/stale index (scenes get reordered), so match by TIME containment,
    // not by index. Only flag an MG scheduled in a gap or past the end.
    const total = num(plan.totalDuration, 0)
        || scenes.reduce((mx, s) => Math.max(mx, num(s.endTime, num(s.startTime) + num(s.duration))), 0);
    const windows = scenes
        .map((s) => [num(s.startTime), num(s.endTime, num(s.startTime) + num(s.duration))])
        .filter(([a, b]) => b > a)
        .sort((x, y) => x[0] - y[0]);
    const inSomeScene = (t) => windows.some(([a, b]) => t >= a - CUE_TOL && t <= b + CUE_TOL);
    for (const mg of mgs) {
        const mgStart = num(mg.startTime, NaN);
        if (!Number.isFinite(mgStart)) continue;
        if (mgStart < -CUE_TOL || (total > 0 && mgStart > total + CUE_TOL)) {
            strayCues++;
            findings.push({ severity: 'warn', code: 'mg_past_end', message: `MG "${mg.type || mg.id || '?'}" is scheduled at ${mgStart.toFixed(1)}s, past the ${total.toFixed(1)}s video end.` });
        } else if (windows.length && !inSomeScene(mgStart)) {
            strayCues++;
            findings.push({ severity: 'warn', code: 'mg_in_gap', message: `MG "${mg.type || mg.id || '?'}" at ${mgStart.toFixed(1)}s falls in a gap between scenes (no scene covers that moment).` });
        }
    }

    return {
        findings,
        metrics: { driftScenes, staticScenes, strayCues, scenesChecked: scenes.length },
    };
}

module.exports = { verifyPacing };
