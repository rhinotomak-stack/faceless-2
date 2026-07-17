// Cheap ffmpeg pre-screen: runs in ~1-2s on a downloaded video to detect
// black/frozen/slideshow content before paying ~12-25s of Qwen-VL scoring.
//
// Uses freezedetect + blackdetect filters which are purpose-built for these
// checks. Parses stderr metadata. Returns { acceptable, reason }.
//
// Toggle: CLIP_PRESCREEN=off
//
// Thresholds (env-overridable):
//   CLIP_PRESCREEN_FREEZE_FRAC (default 0.55) — reject if frozen >55% of probe window
//   CLIP_PRESCREEN_BLACK_FRAC  (default 0.30) — reject if black  >30% of probe window
//   CLIP_PRESCREEN_PROBE_SEC   (default 5)    — seconds of footage to inspect

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../settings/config');

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mkv', '.mov']);

function _isVideoFile(filePath) {
    return VIDEO_EXTS.has(path.extname(filePath || '').toLowerCase());
}

function _ffmpegPath() {
    return config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
}

function _envFloat(name, def) {
    const v = parseFloat(process.env[name] || '');
    return Number.isFinite(v) && v > 0 ? v : def;
}

function _envInt(name, def) {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) && v > 0 ? v : def;
}

async function prescreenClip(filePath, opts = {}) {
    if (String(process.env.CLIP_PRESCREEN || 'on').toLowerCase() === 'off') {
        return { acceptable: true, reason: 'prescreen disabled', skipped: true };
    }
    if (!filePath || !fs.existsSync(filePath)) {
        return { acceptable: true, reason: 'no file', skipped: true };
    }
    if (!_isVideoFile(filePath)) {
        return { acceptable: true, reason: 'not a video', skipped: true };
    }

    const probeSec = _envFloat('CLIP_PRESCREEN_PROBE_SEC', 5);
    const freezeFrac = _envFloat('CLIP_PRESCREEN_FREEZE_FRAC', 0.55);
    const blackFrac = _envFloat('CLIP_PRESCREEN_BLACK_FRAC', 0.30);

    // Frame-quality metrics (blur/brightness/contrast) piggy-back on the SAME
    // pass via signalstats+blurdetect (OPENMONTAGE-BORROW-PLAN #17) — reject
    // blurry/dark/blown/flat clips BEFORE spending finite Qwen-VL quota.
    // Conservative thresholds (only clearly-bad clips) so soft/moody footage
    // still reaches vision. Disable with CLIP_PRESCREEN_QUALITY=off.
    const qualityOn = String(process.env.CLIP_PRESCREEN_QUALITY || 'on').toLowerCase() !== 'off';
    const vf = 'freezedetect=n=0.001:d=1,blackdetect=d=0.8:pic_th=0.95,scdet=threshold=10'
        + (qualityOn ? ',signalstats,metadata=print,blurdetect' : '');

    const ffmpeg = _ffmpegPath();
    const args = [
        '-hide_banner', '-loglevel', 'info',
        '-t', String(probeSec),
        '-i', filePath,
        '-vf', vf,
        '-map', '0:v:0',
        '-an',
        '-f', 'null', '-',
    ];

    let stderr = '';
    await new Promise((resolve) => {
        const child = execFile(ffmpeg, args, { timeout: 9000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (_err, _stdout, errOut) => {
            stderr = String(errOut || '');
            resolve();
        });
        // Hard kill if it overruns
        child.on('error', () => resolve());
    });

    if (!stderr) {
        return { acceptable: true, reason: 'no stats (ffmpeg silent)', skipped: true };
    }

    // freezedetect emits: "[freezedetect @ x] lavfi.freezedetect.freeze_duration: 2.3"
    // blackdetect emits:  "[blackdetect @ x] black_start:0 black_end:1.5 black_duration:1.5"
    let freezeTotal = 0;
    for (const m of stderr.matchAll(/freeze_duration:\s*([0-9.]+)/g)) {
        freezeTotal += parseFloat(m[1]) || 0;
    }
    let blackTotal = 0;
    for (const m of stderr.matchAll(/black_duration:\s*([0-9.]+)/g)) {
        blackTotal += parseFloat(m[1]) || 0;
    }

    const freezeRatio = freezeTotal / probeSec;
    const blackRatio = blackTotal / probeSec;

    // Real resolution + aspect — parsed from the SAME ffmpeg stderr at zero extra
    // cost (-loglevel info prints "Video: …, 1280x720 …"). Catches two junk classes
    // that metadata lies about and that would otherwise burn ~12-25s of deep vision:
    //   • fake-HD / upscaled / low-itag clips (a "1080p" that's really 320x240)
    //   • portrait phone clips dropped into a landscape build (wrong orientation)
    // Fail-safe: unparseable dimensions → keep. Disable aspect with CLIP_PRESCREEN_ASPECT=off.
    if (String(process.env.CLIP_PRESCREEN_RES || 'on').toLowerCase() !== 'off') {
        const dim = stderr.match(/Video:.*?\b(\d{2,5})x(\d{2,5})\b/);
        if (dim) {
            const w = parseInt(dim[1], 10);
            const h = parseInt(dim[2], 10);
            if (w > 0 && h > 0) {
                const minW = _envInt('CLIP_PRESCREEN_MIN_WIDTH', 320);
                const minH = _envInt('CLIP_PRESCREEN_MIN_HEIGHT', 240);
                if (w < minW || h < minH) {
                    return { acceptable: false, reason: `low resolution ${w}x${h} (below ${minW}x${minH}) — upscaled/low-quality source`, freezeRatio, blackRatio, width: w, height: h };
                }
                const aspectGate = String(process.env.CLIP_PRESCREEN_ASPECT || 'on').toLowerCase() !== 'off';
                const targetAspect = Number(opts.targetAspect) > 0 ? Number(opts.targetAspect) : _envFloat('CLIP_PRESCREEN_TARGET_ASPECT', 16 / 9);
                const aspect = w / h;
                if (aspectGate && targetAspect >= 1 && aspect < 0.95) {
                    return { acceptable: false, reason: `portrait clip ${w}x${h} (aspect ${aspect.toFixed(2)}) in a landscape build`, freezeRatio, blackRatio, width: w, height: h };
                }
                if (aspectGate && targetAspect < 1 && aspect > 1.05) {
                    return { acceptable: false, reason: `landscape clip ${w}x${h} in a portrait build`, freezeRatio, blackRatio, width: w, height: h };
                }
            }
        }
    }

    // fps + scene-change + audio — all parsed from the SAME ffmpeg run. These sharpen
    // slideshow/low-quality detection beyond freeze alone (fail-safe: unparseable → keep):
    //   • fps < 12  → choppy/GIF-style, never real B-roll
    //   • 0 scene changes over the probe + mostly static → a single held image, not video
    //   • silent + mostly static → low-effort slideshow (a SILENT but MOVING clip is fine —
    //     stock B-roll is often muted — so audio only tightens the bar when already static)
    const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps\b/);
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
    const minFps = _envFloat('CLIP_PRESCREEN_MIN_FPS', 12);
    if (String(process.env.CLIP_PRESCREEN_FPS || 'on').toLowerCase() !== 'off' && fps > 0 && fps < minFps) {
        return { acceptable: false, reason: `low frame rate ${fps}fps (below ${minFps}) — choppy/slideshow, not real footage`, freezeRatio, blackRatio, fps };
    }
    const sceneChanges = (stderr.match(/lavfi\.scd\.(?:score|time)|scene_score|scdet.*score/gi) || []).length;
    const hasAudio = /\bAudio:\s/.test(stderr);
    if (String(process.env.CLIP_PRESCREEN_MOTION || 'on').toLowerCase() !== 'off'
        && sceneChanges === 0 && freezeRatio >= 0.35) {
        return { acceptable: false, reason: `no scene motion (0 cuts, ${Math.round(freezeRatio * 100)}% frozen) — held still image, not video`, freezeRatio, blackRatio, sceneChanges };
    }
    if (String(process.env.CLIP_PRESCREEN_AUDIO || 'on').toLowerCase() !== 'off'
        && !hasAudio && freezeRatio >= 0.40) {
        return { acceptable: false, reason: `silent + ${Math.round(freezeRatio * 100)}% static — low-effort slideshow`, freezeRatio, blackRatio, hasAudio };
    }

    // Frame-quality gate (#17): blur / brightness / contrast from signalstats +
    // blurdetect (same pass). blurdetect prints an aggregate "blur mean" where
    // HIGHER = blurrier (verified: sharp ~5-10, heavy blur ~30+).
    if (qualityOn) {
        const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
        const blurM = stderr.match(/blur mean:\s*([0-9.]+)/i);
        const blur = blurM ? parseFloat(blurM[1]) : NaN;
        const yavgs = [...stderr.matchAll(/signalstats\.YAVG=([0-9.]+)/g)].map(m => parseFloat(m[1])).filter(Number.isFinite);
        const ylows = [...stderr.matchAll(/signalstats\.YLOW=([0-9.]+)/g)].map(m => parseFloat(m[1])).filter(Number.isFinite);
        const yhighs = [...stderr.matchAll(/signalstats\.YHIGH=([0-9.]+)/g)].map(m => parseFloat(m[1])).filter(Number.isFinite);
        const brightness = avg(yavgs);
        const n = Math.min(ylows.length, yhighs.length);
        const contrast = n ? avg(Array.from({ length: n }, (_, i) => yhighs[i] - ylows[i])) : NaN;
        const maxBlur = _envFloat('CLIP_PRESCREEN_MAX_BLUR', 26);
        const minBright = _envFloat('CLIP_PRESCREEN_MIN_BRIGHT', 18);
        const maxBright = _envFloat('CLIP_PRESCREEN_MAX_BRIGHT', 240);
        const minContrast = _envFloat('CLIP_PRESCREEN_MIN_CONTRAST', 18);
        if (Number.isFinite(blur) && blur > maxBlur) {
            return { acceptable: false, reason: `blurry footage (blur ${blur.toFixed(1)} > ${maxBlur}) — out of focus/upscaled`, freezeRatio, blackRatio, blur };
        }
        if (Number.isFinite(brightness) && brightness < minBright) {
            return { acceptable: false, reason: `too dark (avg luma ${brightness.toFixed(0)} < ${minBright}) — underexposed/unusable`, freezeRatio, blackRatio, brightness };
        }
        if (Number.isFinite(brightness) && brightness > maxBright) {
            return { acceptable: false, reason: `blown out (avg luma ${brightness.toFixed(0)} > ${maxBright}) — overexposed`, freezeRatio, blackRatio, brightness };
        }
        if (Number.isFinite(contrast) && contrast < minContrast) {
            return { acceptable: false, reason: `flat/washed-out (luma range ${contrast.toFixed(0)} < ${minContrast}) — foggy/low-contrast`, freezeRatio, blackRatio, contrast };
        }
    }

    if (freezeRatio >= freezeFrac) {
        return {
            acceptable: false,
            reason: `frozen ${freezeTotal.toFixed(1)}s of ${probeSec}s probe (${Math.round(freezeRatio * 100)}%) — likely slideshow/static`,
            freezeRatio,
            blackRatio,
        };
    }
    if (blackRatio >= blackFrac) {
        return {
            acceptable: false,
            reason: `black ${blackTotal.toFixed(1)}s of ${probeSec}s probe (${Math.round(blackRatio * 100)}%)`,
            freezeRatio,
            blackRatio,
        };
    }

    return {
        acceptable: true,
        reason: `freeze=${Math.round(freezeRatio * 100)}% black=${Math.round(blackRatio * 100)}%`,
        freezeRatio,
        blackRatio,
    };
}

module.exports = { prescreenClip };
