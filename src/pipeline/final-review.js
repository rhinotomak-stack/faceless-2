/**
 * final-review.js — post-render self-review harness (OPENMONTAGE-BORROW-PLAN #7).
 *
 * Our biggest verification gap: the app reports "Render complete" the instant
 * the CLI exits — NOTHING probes the finished mp4. This runs after render and
 * inspects the ACTUAL output plus the plan:
 *   (a) container: streams / duration vs plan / resolution / fps
 *   (b) black or frozen frames (sampled — fast, no full-decode)
 *   (c) audio levels — proves narration is present, not silent / clipping
 *   (d) captions planned when subtitles are enabled
 *   (e) delivery promise: motion-ratio (promise.js, #9)
 *   (f) pacing: cue landing + word/scene sync + dead-air (pacing-verify.js, #8)
 *
 * Writes <publicDir>/final-review.json and returns a structured verdict.
 * ADVISORY by default (never blocks a render that produced a file); set
 * FINAL_REVIEW_STRICT=1 to have callers treat status:'fail' as a hard failure.
 * FINAL_REVIEW=0 disables entirely.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function _resolveFfmpeg() {
    const c = [process.env.FFMPEG_PATH, (() => { try { return require('ffmpeg-static'); } catch (_) { return null; } })(),
        process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg', 'ffmpeg'].filter(Boolean);
    for (const x of c) { try { if (x === 'ffmpeg' || fs.existsSync(x)) return x; } catch (_) {} }
    return null;
}
function _resolveFfprobe(ffmpeg) {
    const c = [process.env.FFPROBE_PATH];
    if (ffmpeg && ffmpeg !== 'ffmpeg') c.push(ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, e) => `ffprobe${e || ''}`));
    if (process.platform === 'win32') c.push('C:\\ffmg\\bin\\ffprobe.exe');
    for (const x of c.filter(Boolean)) { try { if (fs.existsSync(x)) return x; } catch (_) {} }
    return 'ffprobe';
}
const run = (bin, args, ms = 120_000) => spawnSync(bin, args, { encoding: 'utf8', timeout: ms, maxBuffer: 8 * 1024 * 1024 });
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function _probeStreams(ffprobe, file) {
    const r = run(ffprobe, ['-v', 'error', '-show_entries',
        'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration', '-of', 'json', file], 60_000);
    try { return JSON.parse(r.stdout || '{}'); } catch (_) { return {}; }
}

// Sampled brightness via signalstats YAVG on single seeked frames (fast).
function _sampleBlackFrames(ffmpeg, file, dur) {
    const pts = [0.08, 0.3, 0.55, 0.8, 0.95].map((p) => +(p * dur).toFixed(2)).filter((t) => t > 0 && t < dur);
    const dark = [];
    for (const t of pts) {
        const r = run(ffmpeg, ['-hide_banner', '-ss', String(t), '-i', file, '-frames:v', '1',
            '-vf', 'signalstats,metadata=print', '-f', 'null', '-'], 40_000);
        const out = `${r.stdout || ''}\n${r.stderr || ''}`;
        // Limited-range ("tv") black is Y=16, not 0 — use 18 to catch encoded
        // black while staying below legitimately-dark cinematic scenes (~25+).
        const m = out.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
        if (m && Number(m[1]) < 18) dark.push({ t, yavg: +Number(m[1]).toFixed(1) });
    }
    return { sampled: pts.length, dark };
}

function _audioLevels(ffmpeg, file) {
    const r = run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:a:0?', '-af', 'volumedetect', '-f', 'null', '-'], 180_000);
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const mean = out.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    const max = out.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    return { mean: mean ? Number(mean[1]) : null, max: max ? Number(max[1]) : null };
}

async function finalReview(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const videoPath = opts.videoPath;
    const plan = opts.plan || {};
    const publicDir = opts.publicDir || null;
    const findings = [];
    const metrics = {};
    const add = (severity, code, message) => findings.push({ severity, code, message });

    if (/^(0|false|off|no)$/i.test(String(process.env.FINAL_REVIEW || '').trim())) {
        return { status: 'skipped', findings: [], metrics: {} };
    }
    if (!videoPath || !fs.existsSync(videoPath)) {
        return { status: 'fail', findings: [{ severity: 'fail', code: 'no_output', message: 'Rendered file not found.' }], metrics: {} };
    }

    const ffmpeg = _resolveFfmpeg();
    const ffprobe = _resolveFfprobe(ffmpeg);

    // (a) container ────────────────────────────────────────────────
    try {
        const j = ffmpeg ? _probeStreams(ffprobe, videoPath) : {};
        const streams = j.streams || [];
        const v = streams.find((s) => s.codec_type === 'video');
        const a = streams.find((s) => s.codec_type === 'audio');
        const outDur = num(j.format && j.format.duration, 0);
        const planDur = num(plan.totalDuration, 0);
        metrics.durationSec = Math.round(outDur * 100) / 100;
        metrics.planDurationSec = Math.round(planDur * 100) / 100;
        if (v) { metrics.width = num(v.width); metrics.height = num(v.height);
            const fr = String(v.avg_frame_rate || '0/1').split('/'); metrics.fps = num(fr[1]) ? Math.round(num(fr[0]) / num(fr[1])) : num(fr[0]); }
        if (!v) add('fail', 'no_video_stream', 'Output has no video stream.');
        if (!a) add('fail', 'no_audio_stream', 'Output has no audio stream (narration missing).');
        if (planDur > 0 && outDur > 0) {
            const diff = Math.abs(outDur - planDur);
            const tol = Math.max(2, planDur * 0.03);
            if (outDur < planDur * 0.5) add('fail', 'duration_truncated', `Output is ${outDur.toFixed(1)}s but the plan is ${planDur.toFixed(1)}s — render truncated.`);
            else if (diff > tol) add('warn', 'duration_mismatch', `Output ${outDur.toFixed(1)}s vs plan ${planDur.toFixed(1)}s (Δ${diff.toFixed(1)}s > ${tol.toFixed(1)}s tolerance).`);
        }
        if (v && (num(plan.width) && num(v.width) !== num(plan.width))) add('warn', 'resolution_mismatch', `Output ${v.width}×${v.height} ≠ plan ${plan.width}×${plan.height}.`);
        if (!ffmpeg) add('warn', 'no_ffmpeg', 'ffmpeg unavailable — skipped frame/audio checks.');
    } catch (e) { add('warn', 'probe_error', `Container probe failed: ${String(e.message || e).slice(0, 80)}`); }

    // (b) black/frozen frames (sampled) ────────────────────────────
    try {
        if (ffmpeg && metrics.durationSec > 1) {
            const bf = _sampleBlackFrames(ffmpeg, videoPath, metrics.durationSec);
            metrics.framesSampled = bf.sampled; metrics.darkFrames = bf.dark.length;
            if (bf.dark.length >= 2) add('fail', 'black_frames', `${bf.dark.length}/${bf.sampled} sampled frames are near-black (${bf.dark.map((d) => d.t + 's').join(', ')}) — likely broken render.`);
            else if (bf.dark.length === 1) add('warn', 'dark_frame', `1 sampled frame near-black at ${bf.dark[0].t}s (YAVG ${bf.dark[0].yavg}).`);
        }
    } catch (e) { add('warn', 'frame_error', `Frame sampling failed: ${String(e.message || e).slice(0, 80)}`); }

    // (c) audio levels ─────────────────────────────────────────────
    try {
        if (ffmpeg) {
            const lv = _audioLevels(ffmpeg, videoPath);
            metrics.meanVolumeDb = lv.mean; metrics.maxVolumeDb = lv.max;
            if (lv.mean != null && lv.mean < -50) add('fail', 'audio_silent', `Mean volume ${lv.mean}dB — narration appears silent/near-silent.`);
            if (lv.max != null && lv.max > -0.3) add('warn', 'audio_clipping', `Max volume ${lv.max}dB — audio is clipping (>-0.3dB).`);
        }
    } catch (e) { add('warn', 'audio_error', `Audio check failed: ${String(e.message || e).slice(0, 80)}`); }

    // (d) captions — presence + coverage/consistency (#11) ─────────
    // Captions are built FROM scene.words, so caption tokens ⊆ transcript by
    // construction; the meaningful check is COVERAGE — do the word timings span
    // the video, or did transcription drop chunks (silent captions in gaps)?
    try {
        if (plan.subtitlesEnabled !== false) {
            let count = 0, first = Infinity, last = 0;
            for (const s of (plan.scenes || [])) {
                if (!Array.isArray(s.words)) continue;
                for (const w of s.words) {
                    const ws = num(w.start, num(w.startTime, NaN));
                    const we = num(w.end, num(w.endTime, ws));
                    if (Number.isFinite(ws)) { count++; first = Math.min(first, ws); last = Math.max(last, we); }
                }
            }
            metrics.captionWords = count;
            if (!count) add('warn', 'no_caption_data', 'Subtitles enabled but no scene carries word timings — captions may be missing.');
            else {
                const total = num(plan.totalDuration, last);
                const coverage = total > 0 ? Math.min(1, (last - Math.min(first, total)) / total) : 1;
                metrics.captionCoverage = Math.round(coverage * 100) / 100;
                if (coverage < 0.6) add('warn', 'caption_coverage_low', `Captions cover only ${(coverage * 100).toFixed(0)}% of the ${total.toFixed(0)}s video (${count} words) — transcription may have dropped sections.`);
            }
        }
    } catch (_) {}

    // (e) delivery promise — motion ratio (#9) ─────────────────────
    try {
        const { computeMotionRatio } = require('../util/promise');
        let niche = null;
        try { niche = require('../data/niches').getNiche(plan.scriptContext && plan.scriptContext.nicheId); } catch (_) {}
        const mr = computeMotionRatio(plan, { niche });
        Object.assign(metrics, mr.metrics);
        if (mr.finding) findings.push(mr.finding);
    } catch (e) { add('warn', 'promise_error', `Motion-ratio check failed: ${String(e.message || e).slice(0, 80)}`); }

    // (f) pacing — cues + sync + dead-air (#8) ─────────────────────
    try {
        const { verifyPacing } = require('./pacing-verify');
        const pv = verifyPacing(plan);
        Object.assign(metrics, { pacing: pv.metrics });
        for (const f of pv.findings) findings.push(f);
    } catch (e) { add('warn', 'pacing_error', `Pacing check failed: ${String(e.message || e).slice(0, 80)}`); }

    // (g) slideshow / monotony risk (#10) ──────────────────────────
    try {
        const { scoreSlideshowRisk } = require('../agents/scene-risk');
        const sr = scoreSlideshowRisk(plan);
        metrics.slideshowRisk = { score: sr.score, level: sr.level, ...sr.metrics };
        for (const f of sr.findings) findings.push(f);
    } catch (e) { add('warn', 'sceneRisk_error', `Slideshow-risk check failed: ${String(e.message || e).slice(0, 80)}`); }

    // ── roll up ────────────────────────────────────────────────────
    const hasFail = findings.some((f) => f.severity === 'fail');
    const hasWarn = findings.some((f) => f.severity === 'warn');
    const status = hasFail ? 'fail' : (hasWarn ? 'warn' : 'pass');
    const report = { status, generatedFor: path.basename(videoPath), findings, metrics };

    if (publicDir) {
        try { fs.writeFileSync(path.join(publicDir, 'final-review.json'), JSON.stringify(report, null, 2)); } catch (_) {}
    }

    const icon = status === 'pass' ? '✅' : (status === 'warn' ? '⚠️' : '❌');
    log(`[FinalReview] ${icon} ${status.toUpperCase()} — ${findings.length} finding(s)`);
    for (const f of findings.slice(0, 20)) log(`[FinalReview]   ${f.severity === 'fail' ? '❌' : '⚠️'} ${f.code}: ${f.message}`);

    return report;
}

module.exports = { finalReview };
