const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');

let themeRuntime = {};
let mgRegistryRuntime = {};
let agenticCompositionRuntime = {};
try {
    themeRuntime = require('../data/themes');
} catch (_) {
    themeRuntime = {};
}
try {
    mgRegistryRuntime = require('./mg-registry');
} catch (_) {
    mgRegistryRuntime = {};
}
try {
    agenticCompositionRuntime = require('./agentic-composition');
} catch (_) {
    agenticCompositionRuntime = {};
}
let mapHfBuilder = null;
try {
    mapHfBuilder = require('../map/map-hf-builder');
} catch (_) {
    mapHfBuilder = null;
}
let hfEffects = null;
try {
    hfEffects = require('./hf-effects');
} catch (_) {
    hfEffects = null;
}

const {
    getThemeTokens = () => ({}),
    getMGStylePreset = () => ({}),
    MG_THEME_OVERRIDES = {},
    TEMPLATE_THEME_OVERRIDES = {},
} = themeRuntime;

const {
    MG_REGISTRY = {},
    resolveSubType: resolveRegistrySubType = null,
    resolveAnimation: resolveRegistryAnimation = null,
} = mgRegistryRuntime;

const {
    normalizeAgenticCompositionSpec = null,
} = agenticCompositionRuntime;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg']);

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanName(value, fallback = 'asset') {
    const base = String(value == null || value === '' ? fallback : value)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 90);
    return base || fallback;
}

function classToken(value, fallback = 'item') {
    return cleanName(value, fallback)
        .replace(/[^a-z0-9_-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || fallback;
}

function html(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function css(value) {
    return String(value == null ? '' : value).replace(/[\\"]/g, '\\$&');
}

function toSeconds(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function getDuration(item, fallback = 3) {
    const explicit = toSeconds(item?.duration, NaN);
    const start = toSeconds(item?.startTime, 0);
    const end = toSeconds(item?.endTime, NaN);
    const span = Number.isFinite(end) && end > start ? end - start : NaN;
    if (Number.isFinite(span) && span > 0 && span < 3600) return span;
    if (Number.isFinite(explicit) && explicit > 0 && explicit < 3600) {
        // Some plan entries store duration in frames. Without an endTime span,
        // convert obvious frame counts to seconds instead of treating them as
        // multi-minute visual durations.
        return explicit > 90 ? explicit / 30 : explicit;
    }
    return fallback;
}

function renderDuration(value, fallback = 3) {
    return Math.max(0.033, Math.max(0.033, toSeconds(value, fallback)) - 0.002);
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return NaN;
}

function findFfmpeg() {
    const candidates = [
        process.env.FFMPEG_PATH,
        process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : null,
        'ffmpeg',
    ].filter(Boolean);
    for (const candidate of candidates) {
        if (candidate === 'ffmpeg') return candidate;
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch (_) {
            // Try the next candidate.
        }
    }
    return 'ffmpeg';
}

function findFfprobe() {
    const ff = findFfmpeg();
    if (ff === 'ffmpeg') return 'ffprobe';
    const probe = ff.replace(/ffmpeg(\.exe)?$/i, (_m, ext) => `ffprobe${ext || ''}`);
    try {
        if (fs.existsSync(probe)) return probe;
    } catch (_) { /* fall through */ }
    return 'ffprobe';
}

function probeVideoDurationSec(src) {
    try {
        const out = execFileSync(findFfprobe(), [
            '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', src,
        ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const d = parseFloat(out);
        return Number.isFinite(d) && d > 0 ? d : 0;
    } catch (_) {
        return 0;
    }
}

// A valid encoded clip is always well over a few KB. A ~261-byte file is an empty
// MKV/MP4 container ffmpeg writes when a seek lands past the end of the source
// (0 frames). Such a file has NO video stream and makes the HyperFrames renderer
// hard-fail with "[FFmpeg] No video stream found", killing the whole render.
const MIN_VALID_VIDEO_BYTES = 4096;

function fileSizeSafe(p) {
    try { return fs.statSync(p).size; } catch (_) { return 0; }
}

function transcodeVideoForHyperframes(src, outPath, duration, startOffset = 0) {
    const ffmpeg = findFfmpeg();
    // +0.65s tail: a motion transition slides/scales the OUT-going clip for up to
    // ~0.6s AFTER its on-screen window ends. The renderer keeps seeking the video
    // during that slide, so the clip must carry real footage past its window or
    // the exiting frame goes black mid-transition. The extra tail is cheap and the
    // GSAP container opacity still governs when the scene actually disappears.
    const targetDuration = Math.max(0.5, toSeconds(duration, 3) + 0.65);
    let offset = Math.max(0, toSeconds(startOffset, 0));

    // Continuity-fallback scenes reuse a neighbouring clip and stagger the offset
    // (8/12/16/20s) so each looks different — but the reused clip can be far
    // shorter (e.g. 7s) than those offsets. Seeking past the end produces a
    // frameless, ~261-byte file. Clamp the offset into the real clip so the trim
    // always lands on actual frames.
    const srcDuration = probeVideoDurationSec(src);
    if (srcDuration > 0 && offset + 0.3 >= srcDuration) {
        offset = Math.max(0, srcDuration - targetDuration);
    }

    const buildArgs = (off) => {
        const a = ['-y', '-hide_banner', '-loglevel', 'error'];
        if (off > 0) a.push('-ss', off.toFixed(3));
        a.push(
            '-i', src,
            '-t', targetDuration.toFixed(3),
            '-map', '0:v:0',
            '-an',
            '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '18',
            '-r', '30',
            '-g', '30',
            '-keyint_min', '30',
            '-sc_threshold', '0',
            '-movflags', '+faststart',
            outPath
        );
        return a;
    };

    execFileSync(ffmpeg, buildArgs(offset), { stdio: ['ignore', 'ignore', 'pipe'] });

    // Belt-and-suspenders: if the encode still produced an empty file, re-encode
    // from the very start of the clip. If THAT is still empty, throw so the caller
    // skips the clip entirely rather than emitting a file the renderer can't read.
    if (fileSizeSafe(outPath) < MIN_VALID_VIDEO_BYTES && offset > 0) {
        console.warn(`[HyperFrames] Empty transcode at offset ${offset.toFixed(1)}s for ${path.basename(src)} — retrying from clip start.`);
        execFileSync(ffmpeg, buildArgs(0), { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    if (fileSizeSafe(outPath) < MIN_VALID_VIDEO_BYTES) {
        try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
        throw new Error(`transcode produced no usable video stream for ${path.basename(src)}`);
    }
}

function getLookupDirs(dirs) {
    if (Array.isArray(dirs)) return dirs.filter(Boolean);
    if (dirs && Array.isArray(dirs.lookupDirs)) return dirs.lookupDirs.filter(Boolean);
    return [];
}

function resolveMaybeFile(ref, dirs) {
    if (!ref) return null;
    let clean = String(ref);
    if (/^file:\/\//i.test(clean)) {
        try {
            clean = fileURLToPath(clean);
        } catch (_) {
            clean = clean.replace(/^file:\/+/i, '');
        }
    }
    try {
        clean = decodeURIComponent(clean);
    } catch (_) {
        // Keep raw value.
    }
    if (path.isAbsolute(clean) && fs.existsSync(clean)) return clean;
    for (const dir of getLookupDirs(dirs)) {
        const direct = path.join(dir, clean);
        if (fs.existsSync(direct)) return direct;
        const byBase = path.join(dir, path.basename(clean));
        if (fs.existsSync(byBase)) return byBase;
    }
    return null;
}

function listMediaFiles(dirs) {
    const out = [];
    const seen = new Set();
    for (const dir of getLookupDirs(dirs)) {
        try {
            if (!dir || !fs.existsSync(dir)) continue;
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                if (seen.has(full)) continue;
                const stat = fs.statSync(full);
                if (!stat.isFile()) continue;
                const ext = path.extname(name).toLowerCase();
                if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue;
                seen.add(full);
                out.push(full);
            }
        } catch (_) {
            // Ignore unreadable lookup folders.
        }
    }
    return out;
}

function looksLikeLocalMediaRef(value, keyHint = '') {
    if (!value || typeof value !== 'string') return false;
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) return false;
    const hint = String(keyHint || '').toLowerCase();
    const hasMediaKey = /(file|path|asset|media|image|video|background|template|src|url)/i.test(hint);
    const clean = value.split(/[?#]/)[0];
    const hasMediaExt = /\.(mp4|mov|m4v|webm|png|jpe?g|webp|gif|svg)$/i.test(clean);
    const hasPathShape = /^[a-z]:[\\/]/i.test(clean) || /^file:\/\//i.test(clean) || clean.includes('\\') || clean.includes('/');
    return hasMediaExt || (hasMediaKey && hasPathShape);
}

function collectFileRefsFromObject(value, refs = [], depth = 0, keyHint = '') {
    if (!value || depth > 5) return refs;
    if (typeof value === 'string') {
        if (looksLikeLocalMediaRef(value, keyHint)) refs.push(value);
        return refs;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectFileRefsFromObject(item, refs, depth + 1, keyHint);
        return refs;
    }
    if (typeof value !== 'object') return refs;
    for (const [key, item] of Object.entries(value)) {
        const nextHint = keyHint ? `${keyHint}.${key}` : key;
        collectFileRefsFromObject(item, refs, depth + 1, nextHint);
    }
    return refs;
}

function uniqueRefs(refs) {
    const seen = new Set();
    const out = [];
    for (const ref of refs.filter(Boolean)) {
        const key = String(ref);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(ref);
    }
    return out;
}

function copyAsset(src, mediaDir, name, assetCache, options = {}) {
    if (!src || !fs.existsSync(src)) return null;
    ensureDir(mediaDir);
    const ext = path.extname(src).toLowerCase();
    const normalizeVideo = options.normalizeVideo && VIDEO_EXTS.has(ext);
    const outExt = normalizeVideo ? '.mp4' : (ext || '.bin');
    const outName = `${cleanName(name)}${outExt}`;
    const outPath = path.join(mediaDir, outName);
    const key = normalizeVideo
        ? `${path.resolve(src)}|video|${toSeconds(options.duration, 3).toFixed(3)}|${toSeconds(options.startOffset, 0).toFixed(3)}`
        : `${path.resolve(src)}|copy`;
    if (assetCache?.has(key)) return assetCache.get(key);
    try {
        if (normalizeVideo) {
            // Disk cache: a previous open/refresh already normalized this exact source with
            // the same duration/offset (the `key`). Reuse it instead of re-transcoding every
            // time. A sidecar `.normmeta` stores the key so we still re-normalize when the
            // duration/offset actually changes (e.g. after the user trims the clip).
            const metaPath = outPath + '.normmeta';
            let reuse = false;
            try {
                reuse = fs.existsSync(outPath)
                    && fs.statSync(outPath).size > 0
                    && fs.existsSync(metaPath)
                    && fs.readFileSync(metaPath, 'utf8') === key;
            } catch (_) { reuse = false; }
            if (reuse) {
                console.log(`[HyperFrames] Reusing normalized video ${outName} (cached)`);
            } else {
                console.log(`[HyperFrames] Normalizing video ${path.basename(src)} -> ${outName} (${toSeconds(options.duration, 3).toFixed(1)}s, offset ${toSeconds(options.startOffset, 0).toFixed(1)}s)`);
                transcodeVideoForHyperframes(src, outPath, options.duration, options.startOffset);
                try { fs.writeFileSync(metaPath, key); } catch (_) {}
            }
        } else if (!fs.existsSync(outPath)) {
            fs.copyFileSync(src, outPath);
        }
        const rel = `media/${outName}`;
        assetCache?.set(key, rel);
        return rel;
    } catch (err) {
        console.warn(`[HyperFrames] Failed to prepare media ${src}: ${err.message}`);
        return null;
    }
}

function displayValue(...values) {
    for (const value of values) {
        if (typeof value === 'string' || typeof value === 'number') {
            const text = String(value).trim();
            if (text && !/^(?:true|false|null|undefined)$/i.test(text)) return text;
        }
    }
    return '';
}

function stringValue(value) {
    return displayValue(value);
}

function templateTypeFromHint(value) {
    const text = stringValue(value);
    return text ? text.split(':')[0].trim() : '';
}

function normalizeType(value, fallback = 'graphic') {
    const raw = stringValue(value);
    if (!raw) return fallback;
    const simple = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .toLowerCase();
    const aliases = {
        lowerthird: 'lower-third',
        'lower-third': 'lower-third',
        headline: 'headline',
        callout: 'callout',
        statcounter: 'stat-counter',
        'stat-counter': 'stat-counter',
        focusword: 'focus-word',
        'focus-word': 'focus-word',
        progressbar: 'progress-bar',
        'progress-bar': 'progress-bar',
        barchart: 'bar-chart',
        'bar-chart': 'bar-chart',
        donutchart: 'donut-chart',
        'donut-chart': 'donut-chart',
        rankinglist: 'ranking-list',
        'ranking-list': 'ranking-list',
        timeline: 'timeline',
        comparisoncard: 'comparison-card',
        'comparison-card': 'comparison-card',
        bulletlist: 'bullet-list',
        'bullet-list': 'bullet-list',
        mapchart: 'map-chart',
        map: 'map-chart',
        'map-chart': 'map-chart',
        explainer: 'explainer',
        kinetictext: 'kinetic-text',
        'kinetic-text': 'kinetic-text',
        typewriter: 'typewriter',
        subscribecta: 'subscribe-cta',
        'subscribe-cta': 'subscribe-cta',
        listiclecounter: 'listicle-counter',
        'listicle-counter': 'listicle-counter',
        progresstracker: 'progress-tracker',
        'progress-tracker': 'progress-tracker',
        listiclegrid: 'listicle-grid',
        'listicle-grid': 'listicle-grid',
        chaptercard: 'chapter-card',
        'chapter-card': 'chapter-card',
        titlecard: 'title-card',
        'title-card': 'title-card',
        locationcard: 'location-card',
        'location-card': 'location-card',
        quotecard: 'quote-card',
        'quote-card': 'quote-card',
        keytakeaway: 'key-takeaway',
        'key-takeaway': 'key-takeaway',
        timelinecard: 'timeline-card',
        'timeline-card': 'timeline-card',
        factcard: 'fact-card',
        'fact-card': 'fact-card',
        imageshowcase: 'image-showcase',
        'image-showcase': 'image-showcase',
        statcard: 'stat-card',
        'stat-card': 'stat-card',
        personintro: 'person-intro',
        'person-intro': 'person-intro',
        splitscreen: 'split-screen',
        'split-screen': 'split-screen',
        infographic: 'infographic',
        fullscreenmg: 'headline',
        'full-screen-mg': 'headline',
        template: 'chapter-card',
        graphic: fallback || 'graphic',
    };
    return aliases[simple] || aliases[simple.replace(/-/g, '')] || simple || fallback;
}

function visualTypeCandidate(value, kind = 'graphic') {
    const text = stringValue(value);
    if (!text) return '';
    const normalized = normalizeType(text, '');
    if (!normalized || /^(?:true|false|null|undefined)$/i.test(normalized)) return '';
    if (kind === 'template' && normalized === 'template') return 'chapter-card';
    return normalized;
}

function resolveVisualType(mg, kind = 'graphic') {
    const candidates = kind === 'template'
        ? [mg?.type, mg?.mgType, mg?.templateKind, mg?.templateName, typeof mg?.templateType === 'string' ? mg.templateType : '', templateTypeFromHint(mg?.templateHint), templateTypeFromHint(mg?.keyword)]
        : [mg?.type, mg?.mgType, mg?.templateType, mg?.templateKind, templateTypeFromHint(mg?.templateHint), mg?._hfKind];
    for (const candidate of candidates) {
        const value = visualTypeCandidate(candidate, kind || 'graphic');
        if (value) return value;
    }
    return normalizeType(kind || 'graphic');
}

function camelRegistryKey(type) {
    const normalized = normalizeType(type, '');
    if (!normalized) return '';
    return normalized.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function templateRegistryKey(type) {
    const key = camelRegistryKey(type);
    return key === 'titleCard' ? 'chapterCard' : key;
}

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function normalizeMotionSpeed(value, fallback = 1) {
    if (value == null || value === '') return fallback;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.max(0.25, Math.min(3, numeric));
    const raw = classToken(value, 'normal');
    if (raw.includes('very-slow')) return 0.55;
    if (raw.includes('slow') || raw.includes('calm') || raw.includes('gentle')) return 0.75;
    if (raw.includes('rapid') || raw.includes('snappy')) return 1.6;
    if (raw.includes('fast') || raw.includes('quick') || raw.includes('energetic')) return 1.35;
    if (raw.includes('normal') || raw.includes('standard') || raw.includes('medium')) return 1;
    return fallback;
}

function themeOverrideFor(type, themeId, tokens) {
    const key = camelRegistryKey(type);
    return tokens?.chrome?.mgOverrides?.[key]
        || MG_THEME_OVERRIDES?.[themeId]?.[key]
        || null;
}

function templateOverrideFor(type, themeId, tokens) {
    const key = templateRegistryKey(type);
    return tokens?.templates?.overrides?.[key]
        || TEMPLATE_THEME_OVERRIDES?.[themeId]?.[key]
        || null;
}

function firstExistingVariant(type, explicitVariant, themeOverride, stylePreset) {
    const regKey = camelRegistryKey(type);
    const reg = MG_REGISTRY?.[regKey];
    if (!reg?.types) return explicitVariant || 'standard';

    if (explicitVariant && reg.types[explicitVariant]) return explicitVariant;
    if (themeOverride?.style && reg.types[themeOverride.style]) return themeOverride.style;

    if (regKey === 'lowerThird' && stylePreset?.lowerThirdStyle && reg.types[stylePreset.lowerThirdStyle]) {
        return stylePreset.lowerThirdStyle;
    }

    if (resolveRegistrySubType) {
        try {
            const resolved = resolveRegistrySubType({ type: regKey, subType: explicitVariant }, themeOverride, stylePreset);
            if (resolved && reg.types[resolved]) return resolved;
        } catch (_) {
            // Fall through to the registry rotation below.
        }
    }

    const avoid = new Set(Array.isArray(themeOverride?.variantAvoid) ? themeOverride.variantAvoid : []);
    const allowed = Object.keys(reg.types).filter(key => !avoid.has(key));
    return allowed[0] || reg.defaultType || Object.keys(reg.types)[0] || 'standard';
}

function templateDefault(type) {
    const key = templateRegistryKey(type);
    const defaults = {
        chapterCard: { variant: 'standard', animation: 'fadeSlide' },
        titleCard: { variant: 'standard', animation: 'fadeSlide' },
        locationCard: { variant: 'standard', animation: 'slideLeft' },
        quoteCard: { variant: 'standard', animation: 'popUp' },
        keyTakeaway: { variant: 'standard', animation: 'springScale' },
        comparisonCard: { variant: 'standard', animation: 'staggerSlide' },
        timelineCard: { variant: 'standard', animation: 'cascade' },
        factCard: { variant: 'splitPanel', animation: 'slideRight' },
        imageShowcase: { variant: 'standard', animation: 'slideOpposite' },
        statCard: { variant: 'sideBySide', animation: 'countUp' },
        personIntro: { variant: 'standard', animation: 'slideRight' },
        splitScreen: { variant: 'standard', animation: 'slideOpposite' },
        infographic: { variant: 'standard', animation: 'staggerSlide' },
    };
    return defaults[key] || { variant: 'standard', animation: 'fadeSlide' };
}

function normalizeCssColor(value, fallback) {
    const text = displayValue(value);
    return text || fallback;
}

function resolveHyperframeVisual(mg, kind, type, plan = {}) {
    const themeId = cleanName(displayValue(
        mg?.themeId,
        mg?.mgData?.themeId,
        plan?.themeId,
        plan?.scriptContext?.themeId,
        plan?.theme,
        'standard'
    ), 'standard');
    const tokens = getThemeTokens(themeId) || {};
    const themeOverride = themeOverrideFor(type, themeId, tokens);
    const templateOverride = kind === 'template' ? templateOverrideFor(type, themeId, tokens) : null;
    const styleName = cleanName(displayValue(
        mg?.styleName,
        mg?.style,
        mg?.mgStyle,
        mg?.visualStyle,
        mg?.themeStyle,
        mg?.templateStyle,
        mg?.mgData?.styleName,
        mg?.mgData?.style,
        mg?.mgData?.visualStyle,
        themeOverride?.styleName,
        plan?.mgStyle,
        tokens?.mgStyle,
        'clean'
    ), 'clean');
    const stylePreset = getMGStylePreset(styleName) || {};
    const explicitVariant = displayValue(
        mg?.subType,
        mg?.variant,
        mg?.variantName,
        mg?.templateVariant,
        mg?.templateSubType,
        mg?.mgData?.subType,
        mg?.mgData?.variant,
        mg?.mgData?.variantName,
    );
    const fallbackTemplate = templateDefault(type);
    const variant = cleanName(kind === 'template'
        ? displayValue(explicitVariant, templateOverride?.variant, fallbackTemplate.variant)
        : firstExistingVariant(type, explicitVariant, themeOverride, stylePreset), 'standard');
    const explicitAnimation = displayValue(
        mg?.animation,
        mg?.animationName,
        mg?.animationType,
        mg?.templateAnimation,
        mg?.templateAnimationType,
        mg?.mgData?.animation,
        mg?.mgData?.animationName,
        mg?.mgData?.animationType,
    );
    let animation = '';
    if (kind === 'template') {
        animation = displayValue(explicitAnimation, templateOverride?.animation, fallbackTemplate.animation);
    } else {
        const regKey = camelRegistryKey(type);
        const reg = MG_REGISTRY?.[regKey];
        if (explicitAnimation) {
            animation = explicitAnimation;
        } else if (resolveRegistryAnimation) {
            try {
                animation = resolveRegistryAnimation({ type: regKey }, variant, themeOverride);
            } catch (_) {
                animation = '';
            }
        }
        animation = displayValue(
            animation,
            themeOverride?.animation,
            themeOverride?.anim,
            reg?.types?.[variant]?.animation,
            regKey === 'lowerThird' ? stylePreset?.lowerThirdAnimation : '',
            reg?.animations?.[0],
            'fadeSlide'
        );
    }

    const colors = tokens?.colors || {};
    const overrideColors = themeOverride?.colors || {};
    const typography = tokens?.typography || {};
    const speed = clampNumber(firstFiniteNumber(
        mg?.animationSpeed,
        mg?._animationSpeed,
        mg?.mgData?.animationSpeed,
        plan?.scriptContext?.mgAnimationSpeed,
        plan?.mgAnimationSpeed
    ), 0.25, 3, 1);
    const shadowStrength = clampNumber(firstFiniteNumber(
        mg?.overlayShadowStrength,
        mg?.mgData?.overlayShadowStrength,
        plan?.scriptContext?.mgOverlayShadow,
        plan?.mgOverlayShadow
    ), 0, 1, 0.55);

    return {
        themeId,
        type,
        kind,
        styleName,
        variant,
        animation: cleanName(animation, 'fadeSlide'),
        speed,
        shadowStrength,
        cardStyle: cleanName(stylePreset?.cardStyle || 'filled', 'filled'),
        chrome: {
            bg: normalizeCssColor(overrideColors.bgFill, stylePreset?.bg || colors.surface || 'rgba(2,6,23,0.78)'),
            radius: clampNumber(stylePreset?.borderRadius, 0, 40, 12),
            strokeWidth: clampNumber(stylePreset?.strokeWidth, 0, 8, 2),
            shadowBlur: clampNumber(stylePreset?.shadowBlur, 0, 60, 18),
            shadowOffsetY: clampNumber(stylePreset?.shadowOffsetY, 0, 24, 4),
            glow: !!stylePreset?.glow,
        },
        colors: {
            primary: normalizeCssColor(overrideColors.primaryFill || overrideColors.accentFill, colors.mgPrimary || colors.primary || '#22d3ee'),
            accent: normalizeCssColor(overrideColors.accentFill, colors.mgAccent || colors.accent || '#8b5cf6'),
            text: normalizeCssColor(overrideColors.textFill, colors.textPrimary || '#f8fafc'),
            textMuted: normalizeCssColor(colors.textSecondary, 'rgba(226,232,240,0.88)'),
            surface: normalizeCssColor(overrideColors.cardFill, colors.surface || stylePreset?.bg || 'rgba(2,6,23,0.78)'),
            shadow: normalizeCssColor(colors.shadow, 'rgba(0,0,0,0.46)'),
            background: normalizeCssColor(colors.background, '#050505'),
        },
        fonts: {
            heading: displayValue(typography.headingFont, 'Inter, Arial, Helvetica, sans-serif'),
            body: displayValue(typography.bodyFont, 'Inter, Arial, Helvetica, sans-serif'),
            caption: displayValue(typography.captionFont, typography.bodyFont, 'Inter, Arial, Helvetica, sans-serif'),
        },
    };
}

function hyperframeStyleVars(visual) {
    const v = visual || resolveHyperframeVisual({}, 'graphic', 'headline', {});
    const blur = Math.round((v.chrome.shadowBlur || 18) * (0.35 + v.shadowStrength));
    const alpha = Math.max(0, Math.min(0.78, 0.18 + v.shadowStrength * 0.5));
    const vars = {
        '--hf-primary': v.colors.primary,
        '--hf-accent': v.colors.accent,
        '--hf-text': v.colors.text,
        '--hf-muted': v.colors.textMuted,
        '--hf-surface': v.colors.surface,
        '--hf-bg': v.chrome.bg,
        '--hf-shadow-color': v.colors.shadow,
        '--hf-shadow': `0 ${v.chrome.shadowOffsetY || 4}px ${blur}px rgba(0,0,0,${alpha.toFixed(2)})`,
        '--hf-radius': `${v.chrome.radius}px`,
        '--hf-stroke': `${v.chrome.strokeWidth}px`,
        '--hf-heading-font': v.fonts.heading,
        '--hf-body-font': v.fonts.body,
        '--hf-caption-font': v.fonts.caption,
        '--hf-speed': String(v.speed),
    };
    return Object.entries(vars)
        .map(([key, value]) => `${key}: ${String(value).replace(/;/g, '')}`)
        .join('; ');
}

function resolveSceneMedia(scene, dirs) {
    const refs = uniqueRefs([
        scene?.mediaFile,
        scene?.mediaPath,
        scene?.file,
        scene?.path,
        scene?.assetFile,
        scene?.assetPath,
        scene?.templateMediaFile,
        scene?.templateBgFile,
        scene?.backgroundMediaFile,
        scene?.backgroundImageFile,
        scene?.imageFile,
        scene?.videoFile,
        scene?.renderedMedia,
        scene?.finalAsset,
        scene?.asset?.file,
        scene?.asset?.path,
        ...collectFileRefsFromObject(scene?.renderAssets),
        ...collectFileRefsFromObject(scene?.template),
        ...collectFileRefsFromObject(scene?.background),
        ...collectFileRefsFromObject(scene?.media),
        ...collectFileRefsFromObject(scene?.asset),
    ]);
    for (const ref of refs) {
        const found = resolveMaybeFile(ref, dirs);
        if (found) return found;
    }
    return null;
}

function parseTrackIndex(trackId, fallback = 0) {
    const n = Number(String(trackId || '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? Math.max(0, n - 1) : fallback;
}

function getSceneVideoOffset(scene) {
    const offset = firstFiniteNumber(
        scene?.mediaOffset,
        scene?.templateMediaOffset,
        scene?.clipOffset,
        scene?.sourceOffset,
        scene?.sourceStart,
        scene?.trimStart,
        scene?.mediaStart,
        scene?.videoStart,
        scene?.startOffset
    );
    return Number.isFinite(offset) && offset > 0 ? offset : 0;
}

function getMgText(mg) {
    return displayValue(
        mg?.text,
        mg?.title,
        mg?.headline,
        mg?.label,
        mg?.keyword,
        mg?.templateText,
        mg?.templateTitle,
        mg?.mgData?.text,
        mg?.mgData?.title
    );
}

function getMgSubtext(mg) {
    return displayValue(
        mg?.subtext,
        mg?.subText,
        mg?.subtitle,
        mg?.caption,
        mg?.description,
        mg?.templateSubtext,
        mg?.templateSubtitle,
        mg?.visualIntent,
        mg?.mgData?.subtext,
        mg?.mgData?.subtitle
    );
}

function normalizeItem(item, index) {
    if (item == null) return null;
    if (typeof item === 'string' || typeof item === 'number') {
        const label = String(item).trim();
        return label ? { label, value: String(index + 1) } : null;
    }
    const label = displayValue(item.label, item.title, item.name, item.text, item.caption, item.keyword);
    const value = displayValue(item.value, item.number, item.stat, item.rank, item.year, item.prefix);
    const subtext = displayValue(item.subtext, item.subtitle, item.description, item.note);
    if (!label && !value && !subtext) return null;
    return { label: label || subtext || `Item ${index + 1}`, value: value || String(index + 1), subtext };
}

function parseItemsFromText(value) {
    const text = String(value || '').trim();
    if (!text) return [];
    return text
        .split(/\s*;\s*|\n+|\s+\|\s+/)
        .map(part => part.trim())
        .filter(Boolean)
        .map((part, index) => {
            const kv = part.match(/^([^:=-]{1,52})\s*[:=-]\s*(.+)$/);
            if (!kv) return { label: part, value: String(index + 1) };
            const left = kv[1].trim();
            const right = kv[2].trim();
            const leftLooksValue = /^(?:#?\d+(?:[,.]\d+)?(?:%|x|m|bn|b)?|\d{4}|Q[1-4])$/i.test(left);
            return leftLooksValue ? { label: right, value: left } : { label: left, value: right || String(index + 1) };
        });
}

function itemsFromMg(mg, text, subtext) {
    const sources = [
        mg?.items,
        mg?._items,
        mg?.templateItems,
        mg?._listicleItems,
        mg?.mgData?.items,
        mg?.mgData?._items,
        // The Motion Director writes structured list/data entries here — wire them
        // to the dedicated renderers (bullet-list/ranking/timeline/comparison) so a
        // data MG isn't rendered with just its title as a single fake item.
        mg?.agenticComposition?.items,
        mg?.mgData?.agenticComposition?.items,
    ];
    for (const source of sources) {
        if (!source) continue;
        const arr = Array.isArray(source) ? source : parseItemsFromText(source);
        const normalized = arr.map(normalizeItem).filter(Boolean);
        if (normalized.length) return normalized.slice(0, 8);
    }
    const parsedSubtext = parseItemsFromText(subtext);
    if (parsedSubtext.length >= 2) return parsedSubtext.slice(0, 8);
    const parsedText = parseItemsFromText(text);
    if (parsedText.length >= 3) return parsedText.slice(0, 8);
    return [];
}

function renderItemList(items, className = 'hf-items') {
    return `<div class="${className}">${items.map((item, i) => `
        <div class="hf-item" style="--i:${i}">
          <span class="hf-item-value">${html(item.value || String(i + 1))}</span>
          <span class="hf-item-label">${html(item.label || '')}</span>
          ${item.subtext ? `<span class="hf-item-subtext">${html(item.subtext)}</span>` : ''}
        </div>`).join('')}</div>`;
}

function templateKicker(_type, mg = null) {
    // LOOK HUMAN rule (June 2026, user mandate): the small all-caps category
    // label above a stage-visual title ("KEY TAKEAWAY", "KEY CHOKEPOINT") is
    // the #1 AI-design tell — banned on ALL templates + fullscreen MGs.
    // person-intro keeps its label (a real role/title, not a category).
    // Overlay MGs are untouched (kicker there carries functional info).
    if (isStageVisual(mg?._hfKind || 'graphic', _type) && _type !== 'person-intro') return '';
    const explicit = displayValue(
        mg?.kicker,
        mg?.eyebrow,
        mg?.categoryLabel,
        mg?.templateLabel,
        mg?.mgData?.kicker,
        mg?.mgData?.eyebrow
    );
    const generic = new Set([
        'chapter',
        'location',
        'quote',
        'key takeaway',
        'timeline',
        'fact',
        'image study',
        'data point',
        'profile',
        'contrast',
        'breakdown',
        'the list',
    ]);
    if (explicit && !generic.has(explicit.trim().toLowerCase())) return explicit;
    return '';
}

const SUPPORTED_HF_TYPES = new Set([
    'headline', 'lower-third', 'callout', 'stat-counter', 'focus-word',
    'progress-bar', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
    'comparison-card', 'bullet-list', 'map-chart', 'explainer', 'kinetic-text',
    'typewriter', 'subscribe-cta', 'listicle-counter', 'progress-tracker',
    'listicle-grid', 'chapter-card', 'title-card', 'location-card', 'quote-card',
    'key-takeaway', 'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
    'person-intro', 'split-screen', 'infographic', 'graphic',
]);

function typeSupportsFullscreen(type) {
    return new Set([
        'map-chart', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
        'comparison-card', 'bullet-list', 'chapter-card', 'title-card',
        'listicle-grid', 'location-card', 'quote-card', 'key-takeaway',
        'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
        'person-intro', 'split-screen', 'infographic',
    ]).has(type);
}

function isStageVisual(kind, type) {
    return kind === 'template' || kind === 'fullscreen' || typeSupportsFullscreen(type);
}

function templateBackgroundMode(mg = {}) {
    const fields = [
        mg.mgBackground,
        mg.background,
        mg.templateBackground,
        mg.templateBg,
        mg.backgroundMode,
        mg.mgData?.mgBackground,
        mg.mgData?.background,
        mg.mgData?.templateBackground,
        mg.mgData?.templateBg,
        mg.mgData?.backgroundMode,
    ];
    const explicitTransparent = fields.find(value => {
        if (typeof value !== 'string') return false;
        const mode = value.trim().toLowerCase();
        return mode === 'none' || mode === 'transparent' || (mode.includes('transparent') && !mode.startsWith('gradient:') && !mode.startsWith('image:'));
    });
    if (explicitTransparent) return explicitTransparent.trim();
    for (const value of fields) {
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

function isTransparentTemplateBackground(mg = {}) {
    const mode = templateBackgroundMode(mg).toLowerCase();
    if (!mode) return false;
    if (mode === 'none' || mode === 'transparent') return true;
    if (mode.includes('transparent') && !mode.startsWith('gradient:') && !mode.startsWith('image:')) return true;
    return false;
}

function typeUsesDedicatedRenderer(type) {
    return typeSupportsFullscreen(type) || new Set([
        'map-chart', 'bar-chart', 'donut-chart', 'ranking-list', 'timeline',
        'comparison-card', 'bullet-list', 'chapter-card', 'title-card',
        'listicle-grid', 'location-card', 'quote-card', 'key-takeaway',
        'timeline-card', 'fact-card', 'image-showcase', 'stat-card',
        'person-intro', 'split-screen', 'infographic',
    ]).has(type);
}

const MIN_VISUAL_DURATION = 0.5;
const TIMING_GUARD_GAP = 0.08;

function getSceneWindow(scene) {
    if (!scene) return null;
    const start = toSeconds(scene.startTime, toSeconds(scene.start, NaN));
    const end = toSeconds(scene.endTime, toSeconds(scene.end, NaN));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return { start: Math.max(0, start), end: Math.max(0, end), duration: Math.max(MIN_VISUAL_DURATION, end - start) };
    }
    const duration = getDuration(scene, NaN);
    if (Number.isFinite(start) && Number.isFinite(duration) && duration > 0) {
        return { start: Math.max(0, start), end: Math.max(0, start + duration), duration: Math.max(MIN_VISUAL_DURATION, duration) };
    }
    return null;
}

function getExplicitVisualSpan(mg) {
    const start = toSeconds(mg?.startTime, toSeconds(mg?.start, toSeconds(mg?.at, NaN)));
    const end = toSeconds(mg?.endTime, toSeconds(mg?.end, NaN));
    const duration = firstFiniteNumber(
        toSeconds(mg?.durationSeconds, NaN),
        toSeconds(mg?.displayDuration, NaN),
        toSeconds(mg?.templateDuration, NaN),
        toSeconds(mg?.visualDuration, NaN),
        toSeconds(mg?.duration, NaN)
    );
    const hasExplicitStart = Number.isFinite(start);
    const hasExplicitEnd = hasExplicitStart && Number.isFinite(end) && end > start;
    return {
        start: hasExplicitStart ? Math.max(0, start) : 0,
        end: hasExplicitEnd ? Math.max(0, end) : NaN,
        duration: hasExplicitEnd
            ? Math.max(MIN_VISUAL_DURATION, end - start)
            : (Number.isFinite(duration) && duration > 0 && duration < 3600 ? duration : NaN),
        hasExplicitStart,
        hasExplicitEnd,
    };
}

function maxVisualDuration(kind, type, mg) {
    if (mg?.allowLongDuration || mg?.persistent || mg?.isPersistent) return Infinity;
    if (kind === 'overlay') return 5.8;
    if (isStageVisual(kind, type)) {
        const span = getExplicitVisualSpan(mg);
        return span.hasExplicitEnd ? Infinity : 8.2;
    }
    if (type === 'lower-third' || type === 'focus-word' || type === 'callout') return 5.8;
    return 6.5;
}

function getVisualTiming(mg, kind, type) {
    const stageVisual = isStageVisual(kind, type);
    const explicitSpan = getExplicitVisualSpan(mg);
    const rawStart = explicitSpan.hasExplicitStart ? explicitSpan.start : toSeconds(mg?.startTime, 0);
    const rawDuration = Number.isFinite(explicitSpan.duration) ? explicitSpan.duration : getDuration(mg, 3);
    const sceneWindow = getSceneWindow(mg?._hfOwnerScene);
    const maxDuration = maxVisualDuration(kind, type, mg);
    let start = Math.max(0, rawStart);
    let duration = Math.max(MIN_VISUAL_DURATION, rawDuration);

    // An overlay with an explicit (word-synced) start owns its timeline position —
    // never move it. Only anchor overlays that have NO explicit start, and stage
    // visuals, to the scene window.
    const overlayExplicit = kind === 'overlay' && explicitSpan.hasExplicitStart;
    if (sceneWindow && !stageVisual) {
        if (kind !== 'overlay' || !explicitSpan.hasExplicitStart) start = sceneWindow.start;
        if (!overlayExplicit && (start < sceneWindow.start - 0.2 || start > sceneWindow.end + 0.2)) start = sceneWindow.start;
        const remainingScene = Math.max(MIN_VISUAL_DURATION, sceneWindow.end - start);
        if (!overlayExplicit) duration = Math.min(duration, remainingScene);
    } else if (sceneWindow && !explicitSpan.hasExplicitStart) {
        start = sceneWindow.start;
        const remainingScene = Math.max(MIN_VISUAL_DURATION, sceneWindow.end - start);
        duration = Math.min(duration, remainingScene);
    }

    if (Number.isFinite(maxDuration)) duration = Math.min(duration, maxDuration);
    duration = Math.max(MIN_VISUAL_DURATION, duration);
    return {
        start,
        duration,
        rawStart,
        rawDuration,
        clamped: Math.abs(start - Math.max(0, rawStart)) > 0.01 || Math.abs(duration - Math.max(MIN_VISUAL_DURATION, rawDuration)) > 0.01,
    };
}

function visualOverlapGroup(mg, type) {
    const kind = mg?._hfKind || 'graphic';
    if (isStageVisual(kind, type)) {
        const directScene = graphicSceneIndex(mg);
        const ownerScene = graphicSceneIndex(mg?._hfOwnerScene);
        const scene = Number.isFinite(directScene) ? directScene : ownerScene;
        if (Number.isFinite(scene)) return `stage:${scene}`;
        return `stage:${Math.round(toSeconds(mg?.startTime, 0) * 10) / 10}`;
    }
    if (kind === 'overlay') {
        const visual = mg?._hfVisual || {};
        const zone = normalizeType(visual.safeZone || visual.layout || mg?.safeZone || mg?.position || mg?.layout, 'overlay');
        return `overlay:${zone}`;
    }
    return `graphic:${type || kind}`;
}

function applyVisualTimingGuards(graphics, totalDuration) {
    const report = { total: graphics.length, clamped: [], groups: {} };
    const withTiming = graphics.map((mg) => {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        const timing = getVisualTiming(mg, mg?._hfKind, type);
        return { ...mg, _hfTiming: timing, _hfTimingType: type, _hfTimingGroup: visualOverlapGroup(mg, type) };
    });

    const groups = new Map();
    for (const mg of withTiming) {
        const group = mg._hfTimingGroup || 'graphic';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(mg);
    }

    for (const [group, items] of groups.entries()) {
        items.sort((a, b) => a._hfTiming.start - b._hfTiming.start);
        report.groups[group] = items.length;
        for (let i = 0; i < items.length; i++) {
            const current = items[i];
            const next = items[i + 1];
            const original = { ...current._hfTiming };
            if (next && current._hfTiming.start + current._hfTiming.duration > next._hfTiming.start - TIMING_GUARD_GAP) {
                current._hfTiming.duration = Math.max(MIN_VISUAL_DURATION, next._hfTiming.start - current._hfTiming.start - TIMING_GUARD_GAP);
            }
            if (Number.isFinite(totalDuration) && current._hfTiming.start + current._hfTiming.duration > totalDuration) {
                current._hfTiming.duration = Math.max(MIN_VISUAL_DURATION, totalDuration - current._hfTiming.start);
            }
            if (current._hfTiming.clamped || Math.abs(current._hfTiming.duration - original.duration) > 0.01) {
                report.clamped.push({
                    group,
                    kind: current._hfKind || 'graphic',
                    type: current._hfTimingType,
                    start: Number(current._hfTiming.start.toFixed(3)),
                    rawDuration: Number(original.rawDuration.toFixed ? original.rawDuration.toFixed(3) : original.rawDuration),
                    duration: Number(current._hfTiming.duration.toFixed(3)),
                    reason: next ? 'scene/window or overlap guard' : 'scene/window guard',
                });
            }
        }
    }

    return { graphics: withTiming, report };
}

function looseSceneIndex(value) {
    if (value == null) return NaN;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value);
    const match = text.match(/(?:scene|s)?\s*#?\s*(\d+)/i);
    return match ? Number(match[1]) : NaN;
}

function graphicSceneIndex(mg) {
    return firstFiniteNumber(
        looseSceneIndex(mg?.sceneIndex),
        looseSceneIndex(mg?.sourceSceneIndex),
        looseSceneIndex(mg?.targetSceneIndex),
        looseSceneIndex(mg?.sceneId),
        looseSceneIndex(mg?.scene),
        looseSceneIndex(mg?._sceneIndex),
        looseSceneIndex(mg?._ownerSceneIndex),
        looseSceneIndex(mg?.index)
    );
}

function findOwnerSceneForGraphic(scenes, mg) {
    if (!Array.isArray(scenes) || !scenes.length || !mg) return null;
    const start = toSeconds(mg?.startTime, NaN);
    const byTime = () => {
        if (!Number.isFinite(start)) return null;
        return scenes.find((scene) => {
            const s = toSeconds(scene?.startTime, toSeconds(scene?.start, NaN));
            const e = toSeconds(scene?.endTime, toSeconds(scene?.end, NaN));
            if (Number.isFinite(s) && Number.isFinite(e) && e >= s) return start >= s - 0.25 && start <= e + 0.25;
            return Number.isFinite(s) && Math.abs(s - start) < 0.75;
        }) || null;
    };
    // Overlay MGs are word-synced to an ABSOLUTE time, so their startTime is
    // authoritative — match the scene ACTIVE AT THAT TIME. A stored sceneIndex can
    // be stale after scenes are renumbered/reordered/merged, and matching it would
    // teleport the overlay to a different scene's window (the bug where a
    // statCounter labelled @71.3s rendered @82.9s). Stage visuals (fullscreen/
    // template) stay tied to their scene index.
    if ((mg?._hfKind || '') === 'overlay') {
        const t = byTime();
        if (t) return t;
    }
    const wanted = graphicSceneIndex(mg);
    if (Number.isFinite(wanted)) {
        const byIndex = scenes.find((scene) => looseSceneIndex(scene?.index) === wanted || looseSceneIndex(scene?.sceneIndex) === wanted);
        if (byIndex) return byIndex;
    }
    return byTime();
}

function graphicDedupeText(mg) {
    const raw = [
        getMgText(mg),
        getMgSubtext(mg),
        mg?.templateText,
        mg?.templateHint,
        mg?.sceneText,
        mg?.title,
        mg?.label,
    ].filter(Boolean).join(' ');
    return String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .slice(0, 110);
}

function graphicDedupeKey(mg) {
    const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
    const directScene = graphicSceneIndex(mg);
    const ownerScene = graphicSceneIndex(mg?._hfOwnerScene);
    const scene = Number.isFinite(directScene) ? directScene : ownerScene;
    const start = Math.round(toSeconds(mg?.startTime, toSeconds(mg?.start, 0)) * 20) / 20;
    const text = graphicDedupeText(mg) || classToken(type, 'visual');
    return [
        type,
        Number.isFinite(scene) ? `scene-${scene}` : `start-${start}`,
        start,
        text,
    ].join('|');
}

function graphicDedupeScore(mg) {
    const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
    const kindScore = mg?._hfKind === 'template' ? 40 : (mg?._hfKind === 'fullscreen' ? 32 : 20);
    const assetScore = mgAssetRefs(mg, type).some(Boolean) ? 10 : 0;
    const endScore = Number.isFinite(toSeconds(mg?.endTime, NaN)) ? 3 : 0;
    const textScore = graphicDedupeText(mg) ? 2 : 0;
    return kindScore + assetScore + endScore + textScore;
}

function dedupeGraphics(graphics) {
    const kept = new Map();
    const removed = [];
    for (const mg of graphics) {
        const key = graphicDedupeKey(mg);
        const score = graphicDedupeScore(mg);
        const current = kept.get(key);
        if (!current || score > current.score) {
            if (current) {
                removed.push({
                    key,
                    keptKind: mg?._hfKind || 'graphic',
                    removedKind: current.item?._hfKind || 'graphic',
                    type: resolveVisualType(mg, mg?._hfKind || 'graphic'),
                    startTime: toSeconds(mg?.startTime, 0),
                    text: graphicDedupeText(mg),
                });
            }
            kept.set(key, { item: mg, score });
        } else {
            removed.push({
                key,
                keptKind: current.item?._hfKind || 'graphic',
                removedKind: mg?._hfKind || 'graphic',
                type: resolveVisualType(mg, mg?._hfKind || 'graphic'),
                startTime: toSeconds(mg?.startTime, 0),
                text: graphicDedupeText(mg),
            });
        }
    }
    return {
        graphics: Array.from(kept.values()).map(entry => entry.item)
            .sort((a, b) => toSeconds(a.startTime, 0) - toSeconds(b.startTime, 0)),
        report: {
            before: graphics.length,
            after: kept.size,
            removed,
        },
    };
}

function mgAssetRefs(mg, type) {
    const refs = [];
    if (type === 'map-chart') {
        refs.push(
            mg?.mapImageFile,
            mg?.mapImagePath,
            mg?.mapImage,
            mg?.renderAssets?.mapImageFile,
            mg?._mapScene?.renderAssets?.mapImageFile,
            mg?._mapScene?.mapImageFile
        );
    }
    refs.push(
        mg?.templateMediaFile,
        mg?.templateBgFile,
        mg?._templateMediaUrl,
        mg?.backgroundMediaFile,
        mg?.backgroundImageFile,
        mg?.backgroundVideoFile,
        mg?.templateBackgroundFile,
        mg?.templateBackgroundMediaFile,
        mg?.templateBackgroundImageFile,
        mg?.templateBackgroundVideoFile,
        mg?._templateMediaFile,
        mg?.imageFile,
        mg?.imagePath,
        mg?.videoFile,
        mg?.videoPath,
        mg?.mediaFile,
        mg?.mediaPath,
        mg?.assetFile,
        mg?.assetPath,
        mg?.file,
        mg?.path,
        mg?._hfOwnerScene?.mediaFile,
        mg?._hfOwnerScene?.mediaPath,
        mg?._hfOwnerScene?.backgroundMediaFile,
        mg?._hfOwnerScene?.backgroundImageFile,
        mg?._hfOwnerScene?.imageFile,
        mg?._hfOwnerScene?.videoFile,
        mg?._hfOwnerScene?.assetFile,
        mg?._hfOwnerScene?.file,
        mg?._hfOwnerScene?.path,
        ...collectFileRefsFromObject(mg?.renderAssets),
        ...collectFileRefsFromObject(mg?._mapScene?.renderAssets),
        ...collectFileRefsFromObject(mg?.template),
        ...collectFileRefsFromObject(mg?.background),
        ...collectFileRefsFromObject(mg?.media),
        ...collectFileRefsFromObject(mg?.asset),
        ...collectFileRefsFromObject(mg?.mgData),
        ...collectFileRefsFromObject(mg?._hfOwnerScene)
    );
    return uniqueRefs(refs);
}

function indexedMediaCandidates(mg, type, dirs) {
    if (type !== 'map-chart' && !typeSupportsFullscreen(type)) return [];

    const indices = [
        graphicSceneIndex(mg),
        looseSceneIndex(mg?._hfOwnerScene?.index),
        looseSceneIndex(mg?._hfOwnerScene?.sourceSceneIndex),
        looseSceneIndex(mg?._hfOwnerScene?.sceneIndex),
        looseSceneIndex(mg?._hfOwnerScene?.id),
    ].filter(Number.isFinite);
    if (!indices.length) return [];

    const wanted = new Set(indices.map(n => String(Math.max(0, Math.round(n)))));
    const isMap = type === 'map-chart';
    const prefersVideo = typeSupportsFullscreen(type) && !isMap;
    const files = listMediaFiles(dirs).filter((file) => {
        const base = path.basename(file).toLowerCase();
        if (isMap && /^map[-_]/.test(base)) return true;
        return [...wanted].some(idx => base === `scene-${idx}${path.extname(base)}` || base.startsWith(`scene-${idx}.`) || base.startsWith(`scene-${idx}-`));
    });
    return files.sort((a, b) => {
        const extA = path.extname(a).toLowerCase();
        const extB = path.extname(b).toLowerCase();
        const aVideo = VIDEO_EXTS.has(extA);
        const bVideo = VIDEO_EXTS.has(extB);
        if (prefersVideo && aVideo !== bVideo) return aVideo ? -1 : 1;
        if (isMap && baseScore(a) !== baseScore(b)) return baseScore(a) - baseScore(b);
        return path.basename(a).localeCompare(path.basename(b));
    });

    function baseScore(file) {
        const base = path.basename(file).toLowerCase();
        if (base.startsWith('map-satellite')) return 0;
        if (base.startsWith('map-')) return 1;
        return 2;
    }
}

function copyMgAsset(mg, type, dirs, mediaDir, assetCache, id) {
    const explicitRefs = mgAssetRefs(mg, type)
        .map(ref => resolveMaybeFile(ref, dirs))
        .filter(Boolean);
    const candidates = uniqueRefs([...explicitRefs, ...indexedMediaCandidates(mg, type, dirs)]);
    for (const found of candidates) {
        if (!found) continue;
        const ext = path.extname(found).toLowerCase();
        const isVideo = VIDEO_EXTS.has(ext);
        const rel = copyAsset(found, mediaDir, `${id}-${path.basename(found, ext)}`, assetCache, {
            normalizeVideo: isVideo,
            duration: getDuration(mg, 5),
            startOffset: getSceneVideoOffset(mg) || getSceneVideoOffset(mg?._hfOwnerScene),
        });
        if (rel) return { rel, isVideo, ext };
    }
    return null;
}

function hasResolvedMgAsset(mg, type, dirs) {
    return mgAssetRefs(mg, type).some(ref => resolveMaybeFile(ref, dirs)) || indexedMediaCandidates(mg, type, dirs).length > 0;
}

function mapLabelsFromMg(mg) {
    const labels = [];
    const explicit = mg?._mapScene?.annotationPlan?.labels || mg?.annotationPlan?.labels || [];
    for (const label of explicit) {
        const text = displayValue(label?.text, label?.name, label?.subjectId);
        if (text && !labels.includes(text)) labels.push(text);
    }
    const pins = mg?._mapScene?.geometry?.pins || mg?.geometry?.pins || mg?._mapPins || [];
    for (const pin of pins) {
        const text = displayValue(pin?.name, pin?.fullName, pin?.label);
        if (text && !labels.includes(text)) labels.push(text);
    }
    return labels.slice(0, 6);
}

let COUNTRY_GEOJSON_CACHE = null;

function loadCountryGeoJSON(dirs) {
    if (COUNTRY_GEOJSON_CACHE) return COUNTRY_GEOJSON_CACHE;
    const candidates = [
        dirs?.appRoot ? path.join(dirs.appRoot, 'assets', 'geo', 'countries-slim.json') : null,
        path.join(process.cwd(), 'assets', 'geo', 'countries-slim.json'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            COUNTRY_GEOJSON_CACHE = JSON.parse(fs.readFileSync(candidate, 'utf8'));
            return COUNTRY_GEOJSON_CACHE;
        } catch (_) {
            // Try the next candidate.
        }
    }
    COUNTRY_GEOJSON_CACHE = { features: [] };
    return COUNTRY_GEOJSON_CACHE;
}

function normalizePlaceName(value) {
    return String(value || '')
        .replace(/\([^)]*\)/g, ' ')
        .replace(/\b(?:port|city|region|province|state|strait|route|shipping|map|satellite|border|borders)\b/gi, ' ')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}

function collectMapNames(mg) {
    const names = [...mapLabelsFromMg(mg)];
    const sources = [
        mg?._mapScene?.subjects,
        mg?.subjects,
        mg?._mapScene?.renderAssets?.waypoints,
        mg?.renderAssets?.waypoints,
        mg?._mapWaypoints,
        mg?._mapScene?.geometry?.pins,
        mg?.geometry?.pins,
        mg?._mapPins,
    ];
    for (const source of sources) {
        const arr = Array.isArray(source) ? source : [];
        for (const item of arr) {
            const text = displayValue(item?.name, item?.fullName, item?.label, item?.title, item?.country, item?.iso, item);
            if (text && !names.includes(text)) names.push(text);
        }
    }
    return names.slice(0, 10);
}

function countryFeatureName(feature) {
    return displayValue(
        feature?.properties?.name,
        feature?.properties?.nameLong,
        feature?.properties?.sov,
        feature?.properties?.iso
    );
}

function findCountryFeatures(names, dirs) {
    const geo = loadCountryGeoJSON(dirs);
    const features = Array.isArray(geo?.features) ? geo.features : [];
    const selected = [];
    const used = new Set();
    for (const rawName of names) {
        const needle = normalizePlaceName(rawName);
        if (!needle) continue;
        const found = features.find((feature) => {
            const props = feature?.properties || {};
            const values = [props.name, props.nameLong, props.sov, props.iso].filter(Boolean);
            return values.some((value) => {
                const hay = normalizePlaceName(value);
                return hay && (hay === needle || hay.includes(needle) || needle.includes(hay));
            });
        });
        const key = countryFeatureName(found);
        if (found && key && !used.has(key)) {
            used.add(key);
            selected.push(found);
        }
    }
    return selected.slice(0, 6);
}

function geometryRings(geometry) {
    if (!geometry) return [];
    if (geometry.type === 'Polygon') return geometry.coordinates || [];
    if (geometry.type === 'MultiPolygon') return (geometry.coordinates || []).flat();
    return [];
}

function ringBounds(ring, bounds) {
    for (const point of ring || []) {
        const lon = Number(point?.[0]);
        const lat = Number(point?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        bounds.minLon = Math.min(bounds.minLon, lon);
        bounds.maxLon = Math.max(bounds.maxLon, lon);
        bounds.minLat = Math.min(bounds.minLat, lat);
        bounds.maxLat = Math.max(bounds.maxLat, lat);
    }
}

function featureBounds(features) {
    const bounds = { minLon: Infinity, maxLon: -Infinity, minLat: Infinity, maxLat: -Infinity };
    for (const feature of features) {
        for (const ring of geometryRings(feature?.geometry)) ringBounds(ring, bounds);
    }
    if (!Number.isFinite(bounds.minLon)) return null;
    const lonPad = Math.max(0.5, (bounds.maxLon - bounds.minLon) * 0.16);
    const latPad = Math.max(0.5, (bounds.maxLat - bounds.minLat) * 0.16);
    return {
        minLon: bounds.minLon - lonPad,
        maxLon: bounds.maxLon + lonPad,
        minLat: bounds.minLat - latPad,
        maxLat: bounds.maxLat + latPad,
    };
}

function projectLonLat(lon, lat, bounds, width = 1600, height = 900, pad = 90) {
    const safeLonSpan = Math.max(0.001, bounds.maxLon - bounds.minLon);
    const safeLatSpan = Math.max(0.001, bounds.maxLat - bounds.minLat);
    return {
        x: pad + ((lon - bounds.minLon) / safeLonSpan) * (width - pad * 2),
        y: pad + ((bounds.maxLat - lat) / safeLatSpan) * (height - pad * 2),
    };
}

function ringToPath(ring, bounds) {
    if (!Array.isArray(ring) || ring.length < 2) return '';
    const step = Math.max(1, Math.ceil(ring.length / 520));
    const parts = [];
    for (let i = 0; i < ring.length; i += step) {
        const lon = Number(ring[i]?.[0]);
        const lat = Number(ring[i]?.[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const p = projectLonLat(lon, lat, bounds);
        parts.push(`${parts.length ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
    }
    return parts.length ? `${parts.join(' ')} Z` : '';
}

function featurePath(feature, bounds) {
    return geometryRings(feature?.geometry)
        .map((ring) => ringToPath(ring, bounds))
        .filter(Boolean)
        .join(' ');
}

function featureCenter(feature) {
    const bounds = featureBounds([feature]);
    if (!bounds) return null;
    return {
        lon: (bounds.minLon + bounds.maxLon) * 0.5,
        lat: (bounds.minLat + bounds.maxLat) * 0.5,
    };
}

function buildCountryBorderMap(mg, labels, dirs) {
    const names = collectMapNames(mg);
    const features = findCountryFeatures(names, dirs);
    if (!features.length) return '';
    const bounds = featureBounds(features);
    if (!bounds) return '';
    const paths = features.map((feature, index) => {
        const name = countryFeatureName(feature);
        const d = featurePath(feature, bounds);
        return d ? `<path class="hf-country-fill" style="--i:${index}" d="${d}" data-name="${html(name)}"></path><path class="hf-country-line" style="--i:${index}" d="${d}"></path>` : '';
    }).join('');
    const centers = features.map((feature) => {
        const center = featureCenter(feature);
        return center ? { ...center, name: countryFeatureName(feature) } : null;
    }).filter(Boolean);
    const routePoints = centers.map((center) => projectLonLat(center.lon, center.lat, bounds));
    const route = routePoints.length > 1
        ? `<path class="hf-country-route" d="${routePoints.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')}"></path>`
        : '';
    const pins = centers.map((center, index) => {
        const p = projectLonLat(center.lon, center.lat, bounds);
        const label = labels[index] || center.name;
        return `<g class="hf-country-pin" style="--i:${index}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle r="10"></circle><text x="18" y="5">${html(label)}</text></g>`;
    }).join('');
    return `
      <svg class="hf-country-map" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Animated country border map">
        <rect class="hf-map-water" x="0" y="0" width="1600" height="900"></rect>
        ${paths}
        ${route}
        ${pins}
      </svg>`;
}

function splitStatText(text) {
    const raw = String(text || '').trim();
    const m = raw.match(/^([~]?[\s\d,.]+(?:\s*[-]\s*[\d,.]+)?\s*(?:%|m|bn|b|million|billion|trillion|x)?)(?:\s+(.+))?$/i);
    if (!m) return { value: raw, label: '' };
    return { value: m[1].trim(), label: (m[2] || '').trim() };
}

function buildTitleBits(text, subtext, options = {}) {
    const kicker = displayValue(options.kicker);
    return `
      ${kicker ? `<div class="hf-kicker">${html(kicker)}</div>` : ''}
      ${text ? `<div class="hf-title">${html(text)}</div>` : ''}
      ${subtext ? `<div class="hf-subtitle">${html(subtext)}</div>` : ''}`;
}

function buildFallbackMap(labels, mg, dirs) {
    const countryMap = buildCountryBorderMap(mg, labels, dirs);
    if (countryMap) return countryMap;
    const chips = labels.length ? labels : ['Map data'];
    return `
      <div class="hf-fallback-map">
        <div class="hf-map-grid"></div>
        <div class="hf-map-route"></div>
        <div class="hf-map-fallback-labels">${chips.map(label => `<span>${html(label)}</span>`).join('')}</div>
      </div>`;
}

function buildVisualDiagnostics(graphics, dirs) {
    const report = {
        total: graphics.length,
        byType: {},
        byStyle: {},
        byVariant: {},
        byAnimation: {},
        byComposition: {},
        byLayout: {},
        resolved: [],
        unsupported: [],
        fallbacks: [],
        missingMapAssets: [],
        missingTemplateMedia: [],
    };
    const templateNeedsMedia = new Set(['chapter-card', 'title-card', 'location-card', 'fact-card', 'stat-card', 'image-showcase', 'person-intro', 'split-screen', 'infographic']);
    for (const mg of graphics) {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        const visual = mg?._hfVisual || resolveHyperframeVisual(mg, mg?._hfKind || 'graphic', type, {});
        const text = getMgText(mg);
        const subtext = getMgSubtext(mg);
        const items = itemsFromMg(mg, text, subtext);
        const spec = getAgenticCompositionSpec(mg, {
            kind: mg?._hfKind || 'graphic',
            type,
            visual,
            text,
            subtext,
            items,
            kicker: templateKicker(type, mg),
            hasAsset: hasResolvedMgAsset(mg, type, dirs),
        });
        const compositionMode = spec?.mode || 'legacy';
        const compositionLayout = spec?.layout || 'legacy';
        const effectiveAnimation = displayValue(spec?.motion?.entrance, visual.animation, 'fadeSlide');
        const effectiveSpeed = normalizeMotionSpeed(spec?.motion?.speed, visual.speed);
        report.byType[type] = (report.byType[type] || 0) + 1;
        report.byStyle[visual.styleName] = (report.byStyle[visual.styleName] || 0) + 1;
        report.byVariant[`${type}:${visual.variant}`] = (report.byVariant[`${type}:${visual.variant}`] || 0) + 1;
        report.byAnimation[effectiveAnimation] = (report.byAnimation[effectiveAnimation] || 0) + 1;
        report.byComposition[compositionMode] = (report.byComposition[compositionMode] || 0) + 1;
        report.byLayout[compositionLayout] = (report.byLayout[compositionLayout] || 0) + 1;
        report.resolved.push({
            type,
            kind: mg?._hfKind || 'graphic',
            sceneIndex: mg?.sceneIndex ?? mg?.index ?? null,
            startTime: toSeconds(mg?.startTime, 0),
            compositionMode,
            layout: spec?.layout || '',
            safeZone: spec?.safeZone || '',
            compositionSource: spec?.source || '',
            mediaTreatment: spec?.media?.treatment || '',
            themeId: visual.themeId,
            styleName: visual.styleName,
            variant: visual.variant,
            animation: effectiveAnimation,
            speed: effectiveSpeed,
            motionReason: spec?.motion?.reason || '',
            shadowStrength: visual.shadowStrength,
            text: text.slice(0, 120),
        });
        if (!SUPPORTED_HF_TYPES.has(type)) {
            report.unsupported.push({ type, sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), text: getMgText(mg).slice(0, 120) });
            continue;
        }
        if (type === 'map-chart' && !hasResolvedMgAsset(mg, type, dirs) && !findCountryFeatures(collectMapNames(mg), dirs).length) {
            report.missingMapAssets.push({ sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), text: getMgText(mg).slice(0, 120) });
        }
        if (templateNeedsMedia.has(type) && !hasResolvedMgAsset(mg, type, dirs)) {
            report.missingTemplateMedia.push({ type, sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), text: getMgText(mg).slice(0, 120) });
        }
        if (!text && !subtext && items.length === 0) {
            report.fallbacks.push({ type, sceneIndex: mg?.sceneIndex ?? mg?.index ?? null, startTime: toSeconds(mg?.startTime, 0), reason: 'no display text/items' });
        }
    }
    return report;
}

function renderAssetFill(asset, id, start, duration, track, options = {}) {
    if (!asset) return '';
    const bgId = `${id}-bg`;
    const trackIndex = Math.max(0, track - 1);
    const preRoll = Math.max(0, Number(options.preRoll || 0));
    const startNum = Number(start) || 0;
    const durationNum = Number(duration) || 0;
    const clipStart = Math.max(0, startNum - preRoll);
    const clipDuration = Math.max(0.05, durationNum + (startNum - clipStart));
    const extraClass = options.template ? ' hf-template-bg-media' : '';
    const markLoaded = `document.getElementById('${id}')?.classList.add('hf-bg-loaded')`;
    const markError = `document.getElementById('${id}')?.classList.add('hf-bg-error')`;
    if (asset.isVideo) {
        return `<video id="${bgId}" class="clip hf-bg-media${extraClass}" data-hf-anim="${bgId}" data-start="${clipStart.toFixed(3)}" data-duration="${clipDuration.toFixed(3)}" data-track-index="${trackIndex}" src="${html(asset.rel)}" muted playsinline preload="auto" onloadeddata="${markLoaded}" oncanplay="${markLoaded}" onerror="${markError}"></video>`;
    }
    return `<img id="${bgId}" class="clip hf-bg-media${extraClass}" data-hf-anim="${bgId}" data-start="${clipStart.toFixed(3)}" data-duration="${clipDuration.toFixed(3)}" data-track-index="${trackIndex}" src="${html(asset.rel)}" alt="" onload="${markLoaded}" onerror="${markError}">`;
}

function renderTemplateFallbackBg(id, type, text) {
    const label = html(String(text || type || 'visual')
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 96));
    return `
      <div class="hf-template-fallback-bg" aria-hidden="true">
        <div class="hf-template-fallback-field"></div>
        <div class="hf-template-fallback-lines"></div>
        ${label ? `<div class="hf-template-fallback-label">${label}</div>` : ''}
      </div>`;
}

function agenticClasses(spec) {
    if (!spec) return '';
    return [
        'hf-agentic',
        `hf-agentic-role-${classToken(spec.role, 'graphic')}`,
        `hf-agentic-layout-${classToken(spec.layout, 'freeform')}`,
        `hf-agentic-safe-${classToken(spec.safeZone, 'center')}`,
        `hf-agentic-density-${classToken(spec.density, 'standard')}`,
        `hf-agentic-motion-${classToken(spec.motion?.entrance, 'fade-slide')}`,
        `hf-agentic-emphasis-${classToken(spec.motion?.emphasis, 'none')}`,
        `hf-agentic-text-${classToken(spec.textStrategy, 'headline')}`,
        `hf-agentic-media-${classToken(spec.media?.treatment, 'cinematic-background')}`,
        `hf-agentic-source-${classToken(spec.source, 'derived')}`,
    ].join(' ');
}

function buildAgenticItems(items = []) {
    if (!items.length) return '';
    return `<div class="hf-agentic-items">${items.map((item, i) => `
        <div class="hf-agentic-item hf-agentic-item-${classToken(item.kind || 'item', 'item')}" style="--i:${i}">
          ${item.value ? `<span class="hf-agentic-item-value">${html(item.value)}</span>` : ''}
          ${item.label ? `<span class="hf-agentic-item-label">${html(item.label)}</span>` : ''}
          ${item.subtext ? `<span class="hf-agentic-item-subtext">${html(item.subtext)}</span>` : ''}
        </div>`).join('')}</div>`;
}

function buildAgenticMarkup({ mg, id, baseAttrs, spec, asset, fallbackMarkup = '', start, duration, track, text, subtext, kicker, type }) {
    const title = displayValue(spec?.title, text, mg?.text, mg?.templateText, mg?.keyword) || 'Motion Graphic';
    const subtitle = displayValue(spec?.subtitle, subtext, mg?.subtext, mg?.templateSubtext) || '';
    // Same LOOK HUMAN gate as templateKicker — the spec/mg fallbacks here
    // must not resurrect a banned category eyebrow on stage visuals.
    const eyebrowBanned = isStageVisual(mg?._hfKind || 'graphic', type) && type !== 'person-intro';
    const eyebrow = eyebrowBanned ? '' : (displayValue(spec?.kicker, kicker, mg?.kicker, mg?.eyebrow) || '');
    const items = Array.isArray(spec?.items) ? spec.items : [];
    const isData = ['data-focus', 'split-panel', 'evidence-board', 'map-explainer'].includes(spec?.layout);
    const meta = spec?.motion?.reason ? `<div class="hf-agentic-reason">${html(spec.motion.reason)}</div>` : '';
    const transparentTemplateBg = mg?._hfKind === 'template' && isTransparentTemplateBackground(mg);
    const bg = transparentTemplateBg ? '' : renderAssetFill(asset, id, start, duration, track, {
        template: mg?._hfKind === 'template',
        preRoll: mg?._hfKind === 'template' ? 0.12 : 0,
    });
    const mediaTreatment = classToken(spec?.media?.treatment, 'cinematic-background');
    // Kinetic text: split the headline into per-word spans so the runtime can
    // stagger them in (real kinetic typography) instead of fading the whole
    // line as one block (which reads as a static headline).
    const isKinetic = type === 'kinetic-text';
    const titleInner = isKinetic
        ? String(title).split(/\s+/).filter(Boolean).slice(0, 14).map(w => `<span class="hf-agentic-word">${html(w)}</span>`).join(' ')
        : html(title);
    const titleClass = isKinetic ? 'hf-agentic-title hf-agentic-kinetic' : 'hf-agentic-title hf-agentic-part';
    return `
    ${bg}
    <div ${baseAttrs} data-hf-composition="agentic" data-hf-layout="${html(spec.layout)}" data-hf-safe-zone="${html(spec.safeZone)}" data-hf-media-treatment="${html(mediaTreatment)}" data-hf-text-strategy="${html(spec?.textStrategy || '')}" data-hf-motion-emphasis="${html(spec?.motion?.emphasis || '')}" data-hf-motion-exit="${html(spec?.motion?.exit || '')}" data-hf-composition-source="${html(spec?.source || '')}">
      ${fallbackMarkup || ''}
      <div class="hf-agentic-shade hf-agentic-media-${mediaTreatment}"></div>
      <div class="hf-agentic-stage">
        <div class="hf-agentic-rule"></div>
        <div class="hf-agentic-copy">
          ${eyebrow ? `<div class="hf-agentic-kicker hf-agentic-part">${html(eyebrow)}</div>` : ''}
          <div class="${titleClass}">${titleInner}</div>
          ${subtitle ? `<div class="hf-agentic-subtitle hf-agentic-part">${html(subtitle)}</div>` : ''}
          ${isData ? buildAgenticItems(items) : ''}
          ${meta}
        </div>
        ${!isData ? buildAgenticItems(items) : ''}
      </div>
    </div>`;
}

function getAgenticCompositionSpec(mg, context = {}) {
    if (!normalizeAgenticCompositionSpec) return null;
    return normalizeAgenticCompositionSpec(mg, {
        kind: context.kind || mg?._hfKind || 'graphic',
        type: context.type || resolveVisualType(mg, context.kind || mg?._hfKind || 'graphic'),
        visual: context.visual || mg?._hfVisual || {},
        text: context.text ?? getMgText(mg),
        subtext: context.subtext ?? getMgSubtext(mg),
        items: context.items || itemsFromMg(mg, context.text ?? getMgText(mg), context.subtext ?? getMgSubtext(mg)),
        kicker: context.kicker ?? templateKicker(context.type || resolveVisualType(mg, context.kind || mg?._hfKind || 'graphic'), mg),
        hasAsset: Boolean(context.hasAsset),
    });
}

function allocateGraphicTrack(isFull, order = 0) {
    const index = Number.isFinite(Number(order)) ? Math.max(0, Math.floor(Number(order))) : 0;
    const base = isFull ? 500 : 100;
    return base + index;
}

function buildMgMarkup(mg, id, kind, dirs, mediaDir, assetCache, visual = null, order = 0) {
    const type = resolveVisualType(mg, kind || 'graphic');
    const resolvedVisual = visual || mg?._hfVisual || resolveHyperframeVisual(mg, kind || 'graphic', type, {});
    const text = getMgText(mg);
    const subtext = getMgSubtext(mg);
    const items = itemsFromMg(mg, text, subtext);
    const variant = cleanName(resolvedVisual.variant || 'standard', 'standard');
    const variantClass = classToken(variant, 'standard');
    const styleClass = classToken(resolvedVisual.styleName || 'clean', 'clean');
    const themeClass = classToken(resolvedVisual.themeId || 'standard', 'standard');
    const cardClass = classToken(resolvedVisual.cardStyle || 'filled', 'filled');
    const position = mg?.position || 'center';
    const isTemplateKind = kind === 'template';
    const isFull = isStageVisual(kind, type);
    const timing = mg?._hfTiming || getVisualTiming(mg, kind, type);
    const start = timing.start.toFixed(3);
    const duration = timing.duration.toFixed(3);
    const track = allocateGraphicTrack(isFull, order);
    // Overlay MGs float text/graphics over the live scene footage — they must NOT
    // render their own full-frame background media. Doing so re-draws (often the
    // scene's own) footage on a separate layer that scales/fades on enter+exit,
    // producing the visible "distortion" glitch over the clip. Only stage visuals
    // (fullscreen / template / map) fill with media.
    const transparentTemplateBg = isTemplateKind && isTransparentTemplateBackground(mg);
    const asset = isFull && !transparentTemplateBg ? copyMgAsset(mg, type, dirs, mediaDir, assetCache, id) : null;
    const kicker = templateKicker(type, mg);
    const agenticSpec = getAgenticCompositionSpec(mg, {
        kind: kind || 'graphic',
        type,
        visual: resolvedVisual,
        text,
        subtext,
        items,
        kicker,
        hasAsset: Boolean(asset),
    });
    const useAgenticRenderer = Boolean(agenticSpec && !typeUsesDedicatedRenderer(type));
    const effectiveAnimation = displayValue(useAgenticRenderer ? agenticSpec?.motion?.entrance : null, resolvedVisual.animation, 'fadeSlide');
    const effectiveSpeed = normalizeMotionSpeed(useAgenticRenderer ? agenticSpec?.motion?.speed : null, resolvedVisual.speed);
    const animationClass = classToken(effectiveAnimation, 'fadeSlide');
    const extra = `${isTemplateKind ? ' hf-template' : ''}${isFull ? ' hf-fullscreen' : ''}${transparentTemplateBg ? ' hf-transparent-bg' : ''}${asset ? ' hf-has-bg' : ' hf-no-bg'}${useAgenticRenderer ? ` ${agenticClasses(agenticSpec)}` : ''}`;
    const baseAttrs = `id="${id}" data-start="${start}" data-duration="${duration}" data-track-index="${track}" class="clip hf-mg hf-type-${classToken(type, 'graphic')}${extra} hf-theme-${themeClass} hf-style-${styleClass} hf-card-${cardClass} hf-variant-${variantClass} hf-anim-${animationClass} pos-${classToken(position, 'center')}" data-hf-anim="${id}" data-hf-type="${html(type)}" data-hf-style="${html(resolvedVisual.styleName)}" data-hf-theme="${html(resolvedVisual.themeId)}" data-hf-variant="${html(variant)}" data-hf-animation="${html(effectiveAnimation)}" data-hf-speed="${effectiveSpeed}" style="${html(hyperframeStyleVars({ ...resolvedVisual, speed: effectiveSpeed }))}"`;

    // ── Agent-authored composition path (composition-author worker) ──
    // HIGHEST-priority renderer: any MG (template, fullscreen, overlay) that
    // carries a validated `_authoredComposition` renders the agent's bespoke
    // html/css and feeds its GSAP fragment into the master timeline. This
    // MUST come before the agentic-spec early return — overlay types take
    // that path and were silently losing their authored comps.
    const authored = mg._authoredComposition;
    const authoredOverlay = kind === 'overlay';
    if (authored && authored.html && authored.timeline && (isFull || authoredOverlay)) {
        // v9 asset pipe: the author wrote __HF_ASSET_i__ tokens; substitute
        // the real copied media paths. A used token that can't resolve means
        // the comp was designed around a missing photo — fall through to the
        // fixed renderer instead of shipping a broken-image frame.
        let aHtml = authored.html;
        let aCss = authored.css || '';
        let assetsOk = true;
        const authoredAssets = Array.isArray(mg._authoredAssets) ? mg._authoredAssets : [];
        authoredAssets.forEach((a, i) => {
            if (!assetsOk || !a) return;
            const token = a.token || `__HF_ASSET_${i}__`;
            if (!aHtml.includes(token) && !aCss.includes(token)) return; // author didn't use it
            const found = resolveMaybeFile(a.path || a, dirs);
            const rel = found ? copyAsset(found, mediaDir, `${id}-auth${i}-${path.basename(found, path.extname(found))}`, assetCache, {}) : null;
            if (!rel) { assetsOk = false; return; }
            aHtml = aHtml.split(token).join(rel);
            aCss = aCss.split(token).join(rel);
        });
        if (assetsOk) {
            // ── Author-owned film finish ──
            // The Composition Author prescribed this scene's cinematic FX (grain/leak/
            // grade/era look) in the SAME creative act as the layout + motion. Realize it
            // from the hf-effects registry here: the grade filter rides an #id CSS rule
            // (no layout impact), the texture/light layers append as overlays, and the FX
            // GSAP fragment joins the authored timeline (relative offset=0 → it rides the
            // same `__master.add(tl, offset)` injection). Fullscreen comps only — overlay
            // comps annotate live footage that already carries the footage director's grade.
            let fxHtml = '';
            let authoredTimeline = authored.timeline;
            if (isFull && Array.isArray(authored.effects) && authored.effects.length && hfEffects && typeof hfEffects.buildSceneEffects === 'function') {
                try {
                    const fx = hfEffects.buildSceneEffects({ _effectRecipe: authored.effects }, id, 0, Math.max(1, timing.duration), { framed: false });
                    if (fx) {
                        if (fx.filter) aCss += `\n#${id}{filter:${fx.filter};}`;
                        if (fx.html) fxHtml = fx.html;
                        if (fx.timelineJS) authoredTimeline = `${authored.timeline}\n${fx.timelineJS}`;
                    }
                } catch (_) { /* FX are optional polish — never break a validated composition */ }
            }
            mg._hfAuthoredTimeline = authoredTimeline;
            mg._hfAuthoredOffset = timing.start;
            mg._authoredRendered = true;
            // Authored comps are designed on the full 1920×1080 canvas — the
            // hf-authored-overlay class breaks the container out of the
            // positioned pos-* boxes overlay MGs normally live in.
            return `
    <div ${baseAttrs}${authoredOverlay ? ' data-hf-authored-overlay="1"' : ''} data-hf-composition="authored">
      <style>${aCss}</style>
      ${aHtml}
      ${fxHtml}
    </div>`;
        }
        console.log(`  ⚠️ [HyperFrames] authored comp ${mg._authoredNs || id} dropped — referenced asset missing; using fixed renderer`);
    }

    if (useAgenticRenderer) {
        const fallbackMarkup = type === 'map-chart' ? `<div class="hf-map-backup">${buildFallbackMap(mapLabelsFromMg(mg), mg, dirs)}</div>` : '';
        return buildAgenticMarkup({ mg, id, baseAttrs, spec: agenticSpec, asset, fallbackMarkup, start, duration, track, text, subtext, kicker, type });
    }

    if (type === 'map-chart') {
        // ── Map builder path (map-hf-builder): real basemap + projected OSM
        // border SVG + GSAP camera. The animated-map system — legacy static
        // markup below survives only as the graceful-degradation floor when
        // the MapScene/renderAssets are missing or the builder is disabled.
        const mapBuilderOff = /^(0|false|off|no)$/i.test(String(process.env.HF_MAP_BUILDER || '').trim());
        const mapScene = mg._mapScene || mg.mgData?._mapScene || null;
        const mapRa = mapScene && mapScene.renderAssets;
        if (mapHfBuilder && !mapBuilderOff && mapRa && mapRa.mapView) {
            let basemapRel = '';
            const baseAbs = resolveMaybeFile(mapRa.mapImageFile, dirs);
            if (baseAbs) basemapRel = copyAsset(baseAbs, mediaDir, `${id}-basemap`, assetCache) || '';
            const built = mapHfBuilder.buildMapHF(mapScene, {
                id,
                duration: timing.duration,
                style: mg.mapStyle || mapScene.mapStyle || THEME_DEFAULT_MAP_STYLE[resolvedVisual.themeId] || 'satellite',
                basemapRel,
            });
            if (built && built.ok) {
                // Collected by buildComposition after the graphics loop and
                // injected into the page's GSAP timeline at the MG's offset.
                mg._hfMapAnim = built.anim;
                mg._hfMapOffset = timing.start;
                return `
    <div ${baseAttrs}>
      ${built.html}
      <div class="hf-map-vignette"></div>
    </div>`;
            }
            console.warn(`[HyperFrames] map builder failed for ${id} — falling back to static map markup`);
        }
        const labels = mapLabelsFromMg(mg);
        const labelChips = labels.map(label => `<span>${html(label)}</span>`).join('');
        return `
    ${renderAssetFill(asset, id, start, duration, track, { template: isTemplateKind, preRoll: isTemplateKind ? 0.12 : 0 })}
    <div ${baseAttrs}>
      <div class="hf-map-backup">${buildFallbackMap(labels, mg, dirs)}</div>
      <div class="hf-map-vignette"></div>
      ${labelChips ? `<div class="hf-map-labels">${labelChips}</div>` : ''}
      ${(text || subtext) ? `<div class="hf-map-caption">${buildTitleBits(text, subtext)}</div>` : ''}
    </div>`;
    }

    if (type === 'bar-chart') {
        const bars = items.length ? items : parseItemsFromText(subtext || text).slice(0, 6);
        return `
    <div ${baseAttrs}>
      <div class="hf-data-stage">
        <div class="hf-data-header">${buildTitleBits(text, subtext)}</div>
        <div class="hf-bar-chart">${bars.slice(0, 6).map((item, i) => {
            const raw = parseFloat(String(item.value || '').replace(/[^\d.-]/g, ''));
            const width = Number.isFinite(raw) ? Math.max(18, Math.min(100, raw)) : (92 - i * 11);
            return `<div class="hf-bar-row" style="--w:${width}%; --i:${i}"><span>${html(item.label)}</span><b>${html(item.value)}</b><i></i></div>`;
        }).join('')}</div>
      </div>
    </div>`;
    }

    if (type === 'donut-chart') {
        const first = items[0] || splitStatText(text);
        const value = parseFloat(String(first.value || first.label || '').replace(/[^\d.-]/g, ''));
        const pct = Number.isFinite(value) ? Math.max(5, Math.min(96, value)) : 67;
        return `
    <div ${baseAttrs}>
      <div class="hf-donut-stage">
        <div class="hf-donut" style="--pct:${pct}"><span>${html(first.value || `${pct}%`)}</span></div>
        <div class="hf-donut-copy">${buildTitleBits(text, subtext)}</div>
      </div>
    </div>`;
    }

    if (type === 'ranking-list' || type === 'bullet-list' || type === 'timeline') {
        const list = items.length ? items : parseItemsFromText(subtext || text).slice(0, 7);
        return `
    <div ${baseAttrs}>
      <div class="hf-list-stage hf-list-${type}">
        <div class="hf-list-header">${buildTitleBits(text, subtext)}</div>
        ${renderItemList(list.length ? list : [{ label: text, value: '01' }], type === 'timeline' ? 'hf-timeline-items' : 'hf-ranked-items')}
      </div>
    </div>`;
    }

    if (type === 'stat-counter') {
        const stat = splitStatText(text);
        return `
    <div ${baseAttrs}>
      <div class="hf-stat-card">
        <div class="hf-stat-value">${html(stat.value)}</div>
        ${stat.label ? `<div class="hf-stat-label">${html(stat.label)}</div>` : ''}
        ${subtext ? `<div class="hf-subtitle">${html(subtext)}</div>` : ''}
      </div>
    </div>`;
    }

    if (type === 'comparison-card') {
        const parts = String(text || '').split(/\s+(?:vs\.?|versus)\s+/i).map(s => s.trim()).filter(Boolean);
        return `
    <div ${baseAttrs}>
      <div class="hf-comparison-wrap">
        ${parts.length >= 2 ? `<div class="hf-compare-side">${html(parts[0])}</div><div class="hf-compare-vs">VS</div><div class="hf-compare-side">${html(parts.slice(1).join(' vs '))}</div>` : buildTitleBits(text, '')}
      </div>
      ${subtext ? `<div class="hf-comparison-note">${html(subtext)}</div>` : ''}
    </div>`;
    }

    if (type === 'listicle-grid') {
        const gridItems = items.length ? items : parseItemsFromText(subtext || text);
        return `
    <div ${baseAttrs}>
      <div class="hf-grid-stage">
        <div class="hf-grid-title">${buildTitleBits(text, subtext, { kicker })}</div>
        ${renderItemList(gridItems.slice(0, 8), 'hf-listicle-grid-items')}
      </div>
    </div>`;
    }

    if (type === 'chapter-card' || type === 'title-card') {
        return `
    ${renderAssetFill(asset, id, start, duration, track, { template: isTemplateKind, preRoll: isTemplateKind ? 0.12 : 0 })}
    <div ${baseAttrs}>
      ${asset || transparentTemplateBg ? '' : renderTemplateFallbackBg(id, type, text || subtext)}
      <div class="hf-template-shade"></div>
      <div class="hf-chapter-rule"></div>
      <div class="hf-chapter-copy">${buildTitleBits(text, subtext, { kicker })}</div>
    </div>`;
    }

    if (['image-showcase', 'split-screen', 'infographic', 'person-intro', 'location-card', 'quote-card', 'key-takeaway', 'timeline-card', 'fact-card', 'stat-card'].includes(type)) {
        const itemDrivenTemplate = ['image-showcase', 'split-screen', 'infographic', 'timeline-card', 'fact-card', 'stat-card'].includes(type);
        const list = items.length
            ? items
            : (itemDrivenTemplate ? parseItemsFromText(subtext || text).slice(0, 6) : []);
        const stage = type.replace(/-card$/, '').replace(/-/g, '-');
        return `
    ${renderAssetFill(asset, id, start, duration, track, { template: isTemplateKind, preRoll: isTemplateKind ? 0.12 : 0 })}
    <div ${baseAttrs}>
      ${asset || transparentTemplateBg ? '' : renderTemplateFallbackBg(id, type, text || subtext)}
      <div class="hf-template-shade"></div>
      <div class="hf-template-stage hf-template-stage-${stage}">
        ${type === 'person-intro' && kicker ? `<div class="hf-person-label">${html(kicker)}</div>` : ''}
        ${buildTitleBits(text, subtext, { kicker: type === 'person-intro' ? '' : kicker })}
        ${list.length ? renderItemList(list, 'hf-template-items') : ''}
      </div>
    </div>`;
    }

    if (type === 'typewriter') {
        const lines = String(text || '').split(/\s+/).filter(Boolean).slice(0, 10);
        return `
    <div ${baseAttrs}>
      <div class="hf-typewriter-line">${lines.map(word => `<span>${html(word)}</span>`).join(' ')}</div>
      ${subtext ? `<div class="hf-subtitle">${html(subtext)}</div>` : ''}
    </div>`;
    }

    if (type === 'kinetic-text') {
        const words = String(text || '').split(/\s+/).filter(Boolean).slice(0, 12);
        return `
    <div ${baseAttrs}>
      <div class="hf-kinetic-line">${words.map(word => `<span>${html(word)}</span>`).join(' ')}</div>
    </div>`;
    }

    if (type === 'progress-bar' || type === 'progress-tracker') {
        const pct = Math.max(5, Math.min(100, toSeconds(mg?.percent ?? mg?.progress, 72)));
        return `
    <div ${baseAttrs}>
      <div class="hf-progress-shell">${buildTitleBits(text, subtext)}<div class="hf-progress-rail"><span style="--pct:${pct}%"></span></div></div>
    </div>`;
    }

    if (type === 'listicle-counter') {
        const number = displayValue(mg?.number, mg?.rank, mg?.value) || '01';
        return `
    <div ${baseAttrs}>
      <div class="hf-listicle-counter-badge"><span>${html(number)}</span><b>${html(text)}</b></div>
    </div>`;
    }

    return `
    <div ${baseAttrs}>
      <div class="hf-copy-shell">${buildTitleBits(text || subtext || type, text ? subtext : '')}</div>
    </div>`;
}

const TRANSITION_PALETTE = ['crossfade', 'wipe-left', 'zoom-blur', 'light-leak', 'push-left', 'glitch', 'luma-fade', 'dip-black'];

// Scene-MOTION transitions animate the actual outgoing/incoming footage
// containers (push, wipe, whip-pan, zoom-through, blur-dissolve). Overlay
// transitions keep the slab/flare element swept over the cut.
const MOTION_TRANSITION_TYPES = new Set([
    'push-left', 'push-right', 'push-up',
    'wipe-left', 'wipe-right', 'wipe-up',
    'whip-left', 'whip-right',
    'zoom-punch', 'zoom-pull', 'blur-dissolve', 'spin-settle',
]);
// New themes pick a matching basemap look unless the user/scene chose one.
const THEME_DEFAULT_MAP_STYLE = { 'warm-editorial': 'light', nature: 'natural', luxury: 'dark' };
const OVERLAY_TRANSITION_TYPES = new Set(['flash-white', 'dip-black', 'light-sweep', 'glitch', 'fire-burn', 'lens-flare']);

function canonicalTransitionType(value) {
    const raw = normalizeType(value, '');
    // Hard cuts / "none" must produce NO transition overlay — they are instant.
    // (Bug fix: previously 'cut' fell through to the default crossfade slab +
    // white flare, flashing a dark dip on every hard cut.)
    if (!raw || ['auto', 'random', 'transition', 'cut', 'none', 'hard', 'hard-cut', 'hardcut', 'straight-cut'].includes(raw)) return '';
    // Already-canonical names pass straight through.
    if (MOTION_TRANSITION_TYPES.has(raw) || OVERLAY_TRANSITION_TYPES.has(raw) || raw === 'crossfade') return raw;
    // Legacy pipeline names (panLeft, slideUp, whipPan, fade_to_black,
    // lightLeak, …) map onto the canonical vocabulary, PRESERVING the
    // direction instead of flattening everything to *-left.
    const dir = raw.includes('right') ? 'right' : (raw.includes('up') || raw.includes('down')) ? 'up' : 'left';
    if (raw.includes('whip')) return `whip-${dir === 'up' ? 'left' : dir}`;
    if (raw.includes('wipe') || raw.includes('swipe') || raw.includes('slide')) return `wipe-${dir}`;
    if (raw.includes('push') || raw.includes('pan')) return `push-${dir}`;
    if (raw.includes('zoom')) return (raw.includes('out') || raw.includes('pull')) ? 'zoom-pull' : 'zoom-punch';
    if (raw.includes('spin') || raw.includes('rotate') || raw.includes('roll')) return 'spin-settle';
    if (raw.includes('blur') || raw.includes('luma')) return 'blur-dissolve';
    if (raw.includes('glitch') || raw.includes('rgb') || raw.includes('digital')) return 'glitch';
    // Anamorphic lens streak — check BEFORE 'flare' (lens-flare contains "flare").
    if (raw.includes('lens') || raw.includes('anamorphic') || raw.includes('streak')) return 'lens-flare';
    // Fire / film-burn — check BEFORE 'light'/'leak' so warm fiery names land here.
    if (raw.includes('fire') || raw.includes('flame') || raw.includes('burn') || raw.includes('ember')) return 'fire-burn';
    if (raw.includes('light') || raw.includes('leak') || raw.includes('flare')) return 'light-sweep';
    if (raw.includes('flash') || raw.includes('white')) return 'flash-white';
    if (raw.includes('black') || raw.includes('dip')) return 'dip-black';
    if (raw.includes('shape') || raw.includes('circle') || raw.includes('iris') || raw.includes('diamond') || raw.includes('blind') || raw.includes('rect') || raw.includes('stripe')) return 'wipe-left';
    if (raw.includes('camera') || raw.includes('shake')) return 'whip-left';
    // Soft, shapeless legacy names (morph/ripple/dream/ink/reveal/warp) become a
    // blur-dissolve — a real soft move — instead of falling through to a dead slab.
    if (raw.includes('morph') || raw.includes('ripple') || raw.includes('dream') || raw.includes('ink') || raw.includes('warp') || raw.includes('reveal')) return 'blur-dissolve';
    if (raw.includes('fade') || raw.includes('cross') || raw.includes('dissolve')) return 'crossfade';
    // Unknown / legacy name with no implemented move → clean crossfade (which
    // collectTransitionOverlays skips) rather than a background-less overlay
    // slab that consumes the boundary while flashing nothing.
    return 'crossfade';
}

function transitionTypeName(value) {
    // Return '' (no overlay) when there is no real visible transition. Do NOT
    // invent one from the palette — that put a slab/flare on plain cuts.
    return canonicalTransitionType(value);
}

function collectTransitionOverlays(sceneAnims, plan) {
    const planTransitions = Array.isArray(plan?.transitions) ? plan.transitions : [];
    const overlays = [];
    // i=0 included: when the video OPENS with graphics/maps, the first
    // footage scene still has a real boundary (e.g. at 26.9s) — the old
    // i=1 start silently dropped its transition.
    for (let i = 0; i < sceneAnims.length; i++) {
        const scene = sceneAnims[i];
        const boundary = toSeconds(scene.start, 0);
        if (boundary <= 0.05) continue;
        // Talking-head hold: a continuation beat inside a presenter span must NOT get a
        // visible transition — it's the same held image, so a plain cut is invisible while
        // any slide/wipe would flicker between identical frames. Force a cut (no item).
        if (scene._presenterContinuation) continue;
        const explicit = planTransitions.find(t => Math.abs(toSeconds(t?.startTime ?? t?.at, -9999) - boundary) < 0.75);
        // scene.transition is an object { type, duration } in the saved plan — pull
        // its .type out (older code passed the whole object to normalizeType and got
        // nothing, silently dropping every transition).
        const sceneTx = (scene.transition && typeof scene.transition === 'object') ? scene.transition : null;
        const rawType = explicit?.type || scene.transitionIn || (sceneTx ? sceneTx.type : scene.transition) || scene.transitionType;
        const type = transitionTypeName(rawType);
        // Only real transitions produce an item. Cuts ('' type) and plain
        // dissolves (crossfade) need none — the per-scene opacity fades
        // already cross-dissolve them. This is what removes the dark-dip +
        // white flash that appeared between scenes on hard cuts.
        if (!type || type === 'crossfade') continue;
        const duration = Math.min(0.75, Math.max(0.34, toSeconds(explicit?.duration ?? (sceneTx ? sceneTx.duration : undefined), 0.46)));
        // Scene-motion transitions animate the actual footage containers.
        // They need the outgoing scene to be ADJACENT (no template/map gap
        // between) — otherwise the stage-visual takeover owns the boundary
        // and we soften to incoming-only motion.
        if (MOTION_TRANSITION_TYPES.has(type)) {
            const prev = sceneAnims[i - 1];
            const prevEnd = prev ? toSeconds(prev.start, 0) + toSeconds(prev.duration, 0) : -1;
            const adjacent = prev && Math.abs(prevEnd - boundary) < 0.35;
            overlays.push({
                id: `tx-${i}-${type}`,
                start: Math.max(0, boundary - duration * 0.5),
                duration, type, mode: 'motion',
                outId: adjacent ? prev.id : null,
                inId: scene.id,
                boundary,
            });
            continue;
        }
        overlays.push({ id: `tx-${i}-${type}`, start: Math.max(0, boundary - duration * 0.5), duration, type, mode: 'overlay' });
    }
    return overlays;
}

function collectGraphics(plan) {
    const graphics = [];
    const scenes = Array.isArray(plan?.scenes) ? plan.scenes : [];
    for (const mg of plan.motionGraphics || []) {
        if (!mg || mg.disabled) continue;
        graphics.push({ ...mg, _hfOwnerScene: findOwnerSceneForGraphic(scenes, mg), _hfKind: 'overlay' });
    }
    for (const mg of plan.mgScenes || []) {
        if (!mg || mg.disabled) continue;
        graphics.push({
            ...mg,
            type: mg.type || mg.mgType || 'fullscreenMG',
            text: getMgText(mg) || mg.sceneText || '',
            subtext: getMgSubtext(mg) || '',
            _hfOwnerScene: findOwnerSceneForGraphic(scenes, mg),
            _hfKind: 'fullscreen',
        });
    }
    for (const mg of plan.templateScenes || []) {
        if (!mg || mg.disabled) continue;
        graphics.push({
            ...mg,
            type: resolveVisualType(mg, 'template'),
            text: getMgText(mg) || mg.templateText || mg.templateHint || mg.sceneText || '',
            subtext: getMgSubtext(mg) || mg.templateSubtext || '',
            _hfOwnerScene: findOwnerSceneForGraphic(scenes, mg),
            _hfKind: 'template',
        });
    }
    return graphics.sort((a, b) => toSeconds(a.startTime, 0) - toSeconds(b.startTime, 0));
}

function clamp01(n) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; }

// ── Local font embedding ──
// The render browser has no network fonts: without @font-face every theme
// font (Oswald, Barlow Condensed, Fjalla One…) silently falls back to a
// generic face — final videos shipped with wrong typography (renderer lint:
// font_family_without_font_face). Copy assets/fonts/* into media/fonts and
// emit @font-face for each. Family name derives from the CamelCase filename
// ("BarlowCondensed-700.woff2" → "Barlow Condensed", weight 700).
function buildFontFaces(dirs, mediaDir) {
    try {
        const srcDir = path.join(dirs.appRoot || process.cwd(), 'assets', 'fonts');
        if (!fs.existsSync(srcDir)) return '';
        const outDir = path.join(mediaDir, 'fonts');
        ensureDir(outDir);
        const SPECIAL = { NotoSansKR: 'Noto Sans KR', BlackHanSans: 'Black Han Sans' };
        const rules = [];
        for (const file of fs.readdirSync(srcDir)) {
            if (!/\.(woff2?|ttf|otf)$/i.test(file)) continue;
            const base = file.replace(/\.(woff2?|ttf|otf)$/i, '');
            const m = base.match(/^([A-Za-z]+)[-_]?(\d{3}|Regular|VariableFont.*)?$/);
            if (!m) continue;
            const famKey = m[1];
            const family = SPECIAL[famKey] || famKey.replace(/([a-z])([A-Z])/g, '$1 $2');
            const weight = /^\d{3}$/.test(m[2] || '') ? m[2] : '400';
            const fmt = /woff2$/i.test(file) ? 'woff2' : (/woff$/i.test(file) ? 'woff' : 'truetype');
            try { fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file)); } catch (_) { continue; }
            rules.push(`@font-face { font-family: "${family}"; src: url("media/fonts/${file}") format("${fmt}"); font-weight: ${weight}; font-style: normal; font-display: block; }`);
        }
        if (rules.length) console.log(`[HyperFrames] Embedded ${rules.length} @font-face rule(s) from assets/fonts`);
        return rules.join('\n    ');
    } catch (err) {
        console.warn(`[HyperFrames] font embedding skipped: ${err.message}`);
        return '';
    }
}

// Film-grain texture. We deliberately do NOT use an SVG <feTurbulence> filter for
// grain: the headless render browser re-rasterizes it every frame and leaks GPU
// memory, which crashed the capture ("Target closed") mid-render. Instead bake a
// tiny static grayscale noise PNG once and tile it (a flat raster is cheap + stable).
let _grainTextureWritten = null;
function writeGrainTexture(mediaDir) {
    try {
        const out = path.join(mediaDir, '_grain.png');
        if (_grainTextureWritten === out && fs.existsSync(out)) return 'media/_grain.png';
        if (fs.existsSync(out)) { _grainTextureWritten = out; return 'media/_grain.png'; }
        const zlib = require('zlib');
        const W = 96, H = 96;
        const crc32 = (buf) => { let c = ~0 >>> 0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1); } return (~c) >>> 0; };
        const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0); const t = Buffer.from(type, 'ascii'); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0); return Buffer.concat([len, t, data, c]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; // 8-bit grayscale
        const raw = Buffer.alloc((W + 1) * H);
        let seed = 1337; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; for (let x = 0; x < W; x++) raw[y * (W + 1) + 1 + x] = Math.floor(rnd() * 256); }
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
        fs.writeFileSync(out, png);
        _grainTextureWritten = out;
        return 'media/_grain.png';
    } catch (_) {
        return null;
    }
}

// The AI pipeline emits a per-scene cinematic grade in scene.effectOverrides
// (grain / blurVignette / colorGrade / chromatic) that the old WebGL compositor
// rendered as shaders. HyperFrames is HTML/CSS, so we approximate the same look
// with a CSS `filter` on the footage + blend-mode overlay layers on top of it.
function sceneEffectTreatment(scene) {
    const ov = scene?.effectOverrides || {};
    const filters = [];
    const layers = [];

    const cg = ov.colorGrade;
    if (cg && cg.enabled !== false) {
        const desat = clamp01(cg.desaturation);
        if (desat > 0.001) filters.push(`saturate(${(1 - desat).toFixed(3)})`);
        const r = Math.round(clamp01(cg.tintR ?? 1) * 255);
        const g = Math.round(clamp01(cg.tintG ?? 1) * 255);
        const b = Math.round(clamp01(cg.tintB ?? 1) * 255);
        const ts = clamp01(cg.tintStrength) * 0.6;
        if (ts > 0.01) layers.push(`<div class="hf-scene-fx hf-scene-tint" style="background:rgb(${r},${g},${b});opacity:${ts.toFixed(3)};"></div>`);
    }

    const bv = ov.blurVignette;
    if (bv && bv.enabled !== false) {
        const intensity = clamp01(bv.intensity);
        if (intensity > 0.01) {
            const inner = Math.round(26 + clamp01(bv.radius ?? 0.5) * 34);
            const a = (0.12 + intensity * 0.7).toFixed(3);
            layers.push(`<div class="hf-scene-fx hf-scene-vignette" style="background:radial-gradient(ellipse at 50% 50%, transparent ${inner}%, rgba(0,0,0,${a}) 100%);"></div>`);
        }
    }

    // Plain vignette (theme key "vignette") — same look as blurVignette but a
    // theme may define one or the other.
    const vig = ov.vignette;
    if (vig && vig.enabled !== false) {
        const intensity = clamp01(vig.intensity);
        if (intensity > 0.01) {
            const inner = Math.round(24 + clamp01(vig.radius ?? 0.4) * 34);
            const a = (0.12 + intensity * 0.7).toFixed(3);
            layers.push(`<div class="hf-scene-fx hf-scene-vignette" style="background:radial-gradient(ellipse at 50% 50%, transparent ${inner}%, rgba(0,0,0,${a}) 100%);"></div>`);
        }
    }

    const grain = ov.grain;
    if (grain && grain.enabled !== false) {
        const intensity = clamp01(grain.intensity);
        if (intensity > 0.005) layers.push(`<div class="hf-scene-fx hf-scene-grain" style="opacity:${Math.min(0.55, intensity * 3.2).toFixed(3)};"></div>`);
    }

    // Dust — sparse speckle: reuse the grain texture, larger tile + lower opacity.
    const dust = ov.dust;
    if (dust && dust.enabled !== false) {
        const intensity = clamp01(dust.intensity);
        const density = clamp01(dust.density ?? 0.3);
        if (intensity > 0.005) layers.push(`<div class="hf-scene-fx hf-scene-dust" style="opacity:${Math.min(0.4, intensity * (1 + density)).toFixed(3)};"></div>`);
    }

    // Light leak — soft warm diagonal sweep (screen blend). Warmth shifts hue.
    const leak = ov.lightLeak;
    if (leak && leak.enabled !== false) {
        const intensity = clamp01(leak.intensity);
        const warmth = clamp01(leak.warmth ?? 0.6);
        if (intensity > 0.01) {
            const a = (intensity * 0.85).toFixed(3);
            const warm = `rgba(255, ${Math.round(180 + warmth * 50)}, ${Math.round(120 - warmth * 70)}, ${a})`;
            layers.push(`<div class="hf-scene-fx hf-scene-leak" style="background:linear-gradient(115deg, ${warm} 0%, transparent 42%);"></div>`);
        }
    }

    // chromatic ({intensity,angle}) is intentionally not rendered — at theme
    // intensities (~0.006) it is visually negligible and a true RGB-split is
    // expensive/unstable in the headless render browser.

    return { filter: filters.join(' '), layers: layers.join('\n        ') };
}

// Base (static) transform for a scene frame: floating framing + manual clip edits
// (scale / posX / posY) the editor lets the user set. Ken Burns is layered on the
// inner media separately so the two never fight.
function sceneBaseTransform(scene) {
    const framing = String(scene?.framing || 'fullscreen').toLowerCase();
    const parts = [];
    const posX = Number(scene?.posX) || 0;
    const posY = Number(scene?.posY) || 0;
    if (posX || posY) parts.push(`translate(${posX}px, ${posY}px)`);
    let scale = Number(scene?.scale);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    if (framing === 'floating' && scale === 1) scale = 0.5;
    if (scale !== 1) parts.push(`scale(${scale.toFixed(4)})`);
    return { transform: parts.join(' '), framing, scale, offset: !!(posX || posY) };
}

// Ken Burns (slow zoom/drift) — applied to still images so they don't sit dead on
// screen. Video footage already moves, so leave it alone. Deterministic direction
// from the scene index so it's stable across renders.
function kenBurnsFor(scene, isImage) {
    if (!isImage || scene?.kenBurns === false) return null;
    // Floating clips normally sit still (the card element itself carries the motion),
    // but a floating PRESENTER still (talking-head framed insert) needs subtle idle
    // life so a held photo isn't dead. Normal floating clips stay still.
    if (scene?.framing === 'floating' && !scene?.presenterInsert) return null;
    // Presenter HOLD: one CONTINUOUS slow push across the whole span so multiple
    // beats of the same held image don't pop back on every inner cut. Each beat
    // renders its slice of the span-wide 1.05→1.13 zoom (consistent pan direction).
    const span = scene && scene._presenterSpan;
    if (scene?.presenterInsert && span && Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start) {
        const total = span.end - span.start;
        const cs = Number(scene.startTime ?? scene.start ?? span.start);
        const ce = Number(scene.endTime ?? scene.end ?? span.end);
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const f0 = clamp01((cs - span.start) / total);
        const f1 = clamp01((ce - span.start) / total);
        const S = (f) => 1.05 + 0.08 * f;   // 1.05 → 1.13 across the whole hold
        const X = (f) => -1.2 + 2.4 * f;    // -1.2% → +1.2%, single continuous direction
        return { fromScale: +S(f0).toFixed(4), toScale: +S(f1).toFixed(4), fromX: +X(f0).toFixed(3), toX: +X(f1).toFixed(3) };
    }
    const idx = Number(scene?.index) || 0;
    const dir = idx % 2 === 0 ? 1 : -1;
    // COVERAGE RULE: a ±X% pan needs scale ≥ 1 + 2*X/100 at ALL times or the
    // media edge enters the frame. The old fromScale 1.0 with ±1.6% pan
    // exposed a ~30px black strip at every image scene start that slowly
    // closed as the zoom reached 1.09 — "the image animates but the black
    // box doesn't". 1.06 covers ±3% pan with margin from frame one.
    return { fromScale: 1.06, toScale: 1.15, fromX: -dir * 1.6, toX: dir * 1.6 };
}

// Word-timed captions. The pipeline aligns scene.words[] = {word,start,end} to the
// narration; group them into short phrases and emit one timed clip per phrase.
// Gated on plan.subtitlesEnabled (the UI toggle) — off = no caption track.
function buildCaptionCues(plan) {
    if (!plan || !plan.subtitlesEnabled) return [];
    // Karaoke (word-by-word highlight) is OPT-IN. Default OFF → cues are exactly
    // as before (no `words` field), so caption markup/animation are unchanged.
    const karaoke = /^(1|true|on|yes)$/i.test(String(process.env.KARAOKE_CAPTIONS || '').trim());
    const cues = [];
    let idx = 0;
    for (const scene of plan.scenes || []) {
        if (!scene || scene.disabled) continue;
        const words = Array.isArray(scene.words) ? scene.words : [];
        if (!words.length) continue;
        let group = [];
        const flush = () => {
            if (!group.length) return;
            const start = toSeconds(group[0].start, 0);
            const end = toSeconds(group[group.length - 1].end, start + 1);
            const text = group.map(w => String(w.word ?? w.text ?? '').trim()).filter(Boolean).join(' ').trim();
            if (text) {
                const cue = { id: `cap-${idx++}`, start, duration: Math.max(0.4, end - start), text };
                if (karaoke) {
                    cue.words = group
                        .map(w => ({ w: String(w.word ?? w.text ?? '').trim(), t: toSeconds(w.start, start) }))
                        .filter(x => x.w);
                }
                cues.push(cue);
            }
            group = [];
        };
        for (const w of words) {
            group.push(w);
            const txt = String(w.word ?? w.text ?? '');
            const span = toSeconds(w.end, 0) - toSeconds(group[0].start, 0);
            if (group.length >= 7 || span >= 3.2 || /[.!?]$/.test(txt)) flush();
        }
        flush();
    }
    return cues;
}

function buildComposition({ plan, dirs, projectDir, options = {} }) {
    const mediaDir = path.join(projectDir, 'media');
    ensureDir(mediaDir);
    const grainTextureRel = writeGrainTexture(mediaDir) || '';
    const fontFacesCss = buildFontFaces(dirs, mediaDir);
    const assetCache = new Map();
    let graphics = collectGraphics(plan).map((mg) => {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        return { ...mg, _hfVisual: resolveHyperframeVisual(mg, mg?._hfKind || 'graphic', type, plan) };
    });
    const sceneDuration = Math.max(1, ...(plan.scenes || []).map(s => toSeconds(s.endTime, toSeconds(s.end, 0))));
    const totalDuration = toSeconds(plan.totalDuration, 0) || sceneDuration;
    const dedupe = dedupeGraphics(graphics);
    graphics = dedupe.graphics;
    const timingGuard = applyVisualTimingGuards(graphics, totalDuration);
    timingGuard.report.deduped = dedupe.report;
    graphics = timingGuard.graphics;
    fs.writeFileSync(path.join(projectDir, 'hyperframes-timing-report.json'), JSON.stringify(timingGuard.report, null, 2), 'utf8');
    if (dedupe.report.removed.length > 0) {
        console.warn(`[HyperFrames] Dedupe removed ${dedupe.report.removed.length} duplicate visual item(s) before timing`);
    }
    if (timingGuard.report.clamped.length > 0) {
        console.warn(`[HyperFrames] Timing guard clamped ${timingGuard.report.clamped.length} runaway/overlapping visual item(s)`);
    }
    const visualReport = buildVisualDiagnostics(graphics, dirs);
    fs.writeFileSync(path.join(projectDir, 'hyperframes-visual-report.json'), JSON.stringify(visualReport, null, 2), 'utf8');
    fs.writeFileSync(path.join(projectDir, 'hyperframes-style-report.json'), JSON.stringify({
        total: visualReport.total,
        byStyle: visualReport.byStyle,
        byVariant: visualReport.byVariant,
        byAnimation: visualReport.byAnimation,
        byComposition: visualReport.byComposition,
        byLayout: visualReport.byLayout,
        resolved: visualReport.resolved,
    }, null, 2), 'utf8');

    const issueCount = visualReport.unsupported.length + visualReport.missingMapAssets.length + visualReport.missingTemplateMedia.length + visualReport.fallbacks.length;
    const typeSummary = Object.entries(visualReport.byType).map(([type, count]) => `${type}:${count}`).join(', ') || 'none';
    const styleSummary = Object.entries(visualReport.byStyle).map(([style, count]) => `${style}:${count}`).join(', ') || 'none';
    const animationSummary = Object.entries(visualReport.byAnimation).map(([animation, count]) => `${animation}:${count}`).join(', ') || 'none';
    const compositionSummary = Object.entries(visualReport.byComposition).map(([mode, count]) => `${mode}:${count}`).join(', ') || 'none';
    const layoutSummary = Object.entries(visualReport.byLayout).map(([layout, count]) => `${layout}:${count}`).join(', ') || 'none';
    console.log(`[HyperFrames] Visual bridge: ${visualReport.total} graphic/template/map item(s) (${typeSummary})`);
    console.log(`[HyperFrames] Styles: ${styleSummary}`);
    console.log(`[HyperFrames] Animations: ${animationSummary}`);
    console.log(`[HyperFrames] Compositions: ${compositionSummary}`);
    console.log(`[HyperFrames] Layouts: ${layoutSummary}`);
    if (issueCount > 0) {
        console.warn(`[HyperFrames] Visual bridge diagnostics: unsupported=${visualReport.unsupported.length}, missingMaps=${visualReport.missingMapAssets.length}, missingTemplateMedia=${visualReport.missingTemplateMedia.length}, fallbacks=${visualReport.fallbacks.length}`);
    }

    const sceneTags = [];
    const sceneAnims = [];
    const sceneHoldSources = [];
    const fxTimelines = []; // hf-effects GSAP fragments, injected after graphic anims
    const iconAnims = []; // explainer icon moments (icon-director) — pop/float/exit
    const explainAnims = []; // talking-head presenter-stage explanation images — slide in beside the host, then out
    const glowAnims = []; // keyword-glow word-emphasis overlays (#18) — pop/glow/exit

    // ── Video background pack (ONE per video) ──
    // Scenes whose upstream background choice is FLAT (gradient:*/soft-*/
    // style) render the video's designed background pack instead of the old
    // generic tint. The duplicate-blur backdrop stays the default lane.
    // Pack chosen by the effects director (plan._hfBackgroundPack) with a
    // theme-default fallback. HF_BACKGROUND_PACKS=0 reverts to legacy tints.
    let bgPack = null;
    let bgPackCss = '';
    if (!/^(0|false|off|no)$/i.test(String(process.env.HF_BACKGROUND_PACKS || '').trim())) {
        try {
            const { buildBackgroundPack, resolvePackId } = require('./hf-background-packs');
            const planThemeId = cleanName(displayValue(plan?.scriptContext?.themeId, plan?.themeId, plan?.theme, 'standard'), 'standard');
            const packId = resolvePackId(plan?._hfBackgroundPack, planThemeId);
            bgPack = buildBackgroundPack(packId, getThemeTokens(planThemeId) || {});
            bgPackCss = bgPack.css;
            console.log(`[HyperFrames] Background pack: ${bgPack.id} (theme ${planThemeId}${plan?._hfBackgroundPack ? ', director-chosen' : ', theme default'})`);
        } catch (e) {
            console.warn(`[HyperFrames] background packs unavailable: ${String(e.message).slice(0, 80)}`);
        }
    }

    // Accent color for authored SVG explainer icons (currentColor strokes).
    let iconAccent = '#38bdf8';
    try {
        const _it = getThemeTokens(cleanName(displayValue(plan?.scriptContext?.themeId, plan?.themeId, plan?.theme, 'standard'), 'standard')) || {};
        iconAccent = _it.colors?.accent || _it.colors?.primary || iconAccent;
    } catch (_) { /* default accent */ }

    for (const scene of plan.scenes || []) {
        if (!scene || scene.disabled || scene.isMGScene) continue;
        const src = resolveSceneMedia(scene, dirs);
        const start = toSeconds(scene.startTime, 0);
        const duration = getDuration(scene, Math.max(0.5, toSeconds(scene.endTime, start + 3) - start));
        const durationForTimeline = renderDuration(duration, 0.5);
        const id = `scene-${cleanName(scene.index ?? sceneTags.length)}`;
        const trackIndex = parseTrackIndex(scene.trackId, 0);
        const mediaStartOffset = options?.preview ? getSceneVideoOffset(scene) : 0;
        const mediaStartAttr = mediaStartOffset > 0.001 ? ` data-media-start="${mediaStartOffset.toFixed(3)}"` : '';
        const baseAttrs = `id="${id}" data-start="${start.toFixed(3)}" data-duration="${durationForTimeline.toFixed(3)}"${mediaStartAttr} data-track-index="${trackIndex}" data-hf-anim="${id}"`;
        let kenBurns = null;
        // Subject-pan for cover-fit media. Declared at loop scope (like kenBurns) because the
        // sceneAnims.push below runs for EVERY scene — outside the has-media `else` block where
        // `fit` is in scope. Set inside that block once `fit` is known; stays null otherwise.
        let focusPan = null;
        if (!src) {
            sceneTags.push(`
    <div ${baseAttrs} class="clip hf-scene hf-scene-wrap hf-empty">
      <div class="hf-empty-text">${html(scene.text || scene.keyword || 'Missing scene media')}</div>
    </div>`);
        } else {
            const ext = path.extname(src).toLowerCase();
            const isImage = IMAGE_EXTS.has(ext);
            const isVideo = VIDEO_EXTS.has(ext);
            const rel = copyAsset(src, mediaDir, id, assetCache, {
                // Preview opens should be instant-ish. Do not transcode every
                // scene into short MP4s just to show the iframe; the preview
                // runtime seeks with data-media-start instead. Full render keeps
                // normalization so capture gets bounded media windows.
                normalizeVideo: isVideo && !options?.preview,
                duration,
                startOffset: getSceneVideoOffset(scene),
            });
            if (!rel) continue;
            const fit = classToken(scene.fitMode || scene.fit || 'cover', 'cover');
            focusPan = (fit === 'cover' && scene.focusPan) ? scene.focusPan : null;
            const treat = sceneEffectTreatment(scene);
            // ── hf-effects registry: animated effect stack (grain drift, leak
            // sweeps, flicker, breathing vignette…). Takes over layer rendering
            // when it produces a stack; legacy static treat.layers is the
            // fallback. Timeline fragments collect into fxTimelines and join
            // the master timeline at this scene's offset.
            let fxLayers = treat.layers;
            let fxFilter = treat.filter;
            if (hfEffects) {
                try {
                    const _framingStr = String(scene.framing || 'fullscreen').toLowerCase();
                    const _sc = Number(scene.scale);
                    const _framed = _framingStr === 'floating' || _framingStr === 'cinematic'
                        || (Number.isFinite(_sc) && _sc > 0 && _sc < 0.999)
                        || !!(Number(scene.posX) || Number(scene.posY));
                    const fx = hfEffects.buildSceneEffects(scene, id, start, durationForTimeline, { framed: _framed, baseLook: plan._hfBaseLook });
                    if (fx) {
                        fxLayers = fx.html;
                        // SINGLE grade owner: the hf-effects grade (video base look or a
                        // scene's flashback delta) is authoritative. Do NOT also stack the
                        // legacy colorGrade saturate() — two grades fighting = muddy footage.
                        if (fx.filter) fxFilter = fx.filter;
                        if (fx.timelineJS) fxTimelines.push(fx.timelineJS);
                    }
                } catch (fxErr) {
                    console.warn(`[HyperFrames] effects registry failed for ${id}: ${fxErr.message}`);
                }
            }
            const base = sceneBaseTransform(scene);
            const isFloating = base.framing === 'floating';
            const isCinematic = base.framing === 'cinematic';
            // ANY scene whose frame doesn't cover the full canvas needs a
            // backdrop — not just the floating/cinematic framing labels. A
            // fullscreen-framed scene with a manual Scale 0.85 (or a posX/Y
            // nudge) used to get NO backdrop at all: a hard black inset around
            // the footage, with Ken Burns animating the media inside while
            // the black border sat dead. Coverage, not framing label, decides.
            const needsBackdrop = isFloating || isCinematic || base.scale < 0.999 || base.offset;
            kenBurns = kenBurnsFor(scene, isImage);
            const frameStyle = base.transform ? ` style="transform:${base.transform};"` : '';
            // Subject-anchored crop: when the framing worker set a focus point (scene.focusX/Y),
            // drive object-position so a fill-frame (cover) crop keeps the subject's face in view
            // instead of centering and cutting it off. No focus set → CSS default center center.
            const _hasFocus = fit === 'cover' && (Number.isFinite(Number(scene.focusX)) || Number.isFinite(Number(scene.focusY)));
            const _objPos = _hasFocus
                ? `object-position:${(Number(scene.focusX ?? 0.5) * 100).toFixed(1)}% ${(Number(scene.focusY ?? 0.5) * 100).toFixed(1)}%;`
                : '';
            const _mediaCss = `${fxFilter ? `filter:${fxFilter};` : ''}${_objPos}`;
            const mediaStyle = _mediaCss ? ` style="${_mediaCss}"` : '';
            // CRITICAL: video elements need their OWN data-start/data-duration.
            // The HyperFrames render engine only owns playback of TIMED media —
            // an untimed <video> never gets seeked during capture and paints
            // black for its whole window (lint: media_missing_data_start). The
            // preview controller reads the wrapper's dataset, so duplicating
            // the timing on the media element is render-only metadata.
            // Render-window carries a 0.6s tail past the on-screen duration so the
            // clip keeps rendering its real (transcode-tail) footage while a motion
            // transition slides/scales it out — otherwise the renderer stops seeking
            // the video at its window end and the exiting frame goes black. The GSAP
            // container opacity still governs actual visibility, so a non-transition
            // scene is unaffected (its tail renders behind the covering next scene).
            const _videoRenderDur = durationForTimeline + 0.6;
            const mediaTiming = ` data-start="${start.toFixed(3)}" data-duration="${_videoRenderDur.toFixed(3)}"`;
            const mediaTag = isImage
                ? `<img class="hf-scene-media fit-${fit}" src="${html(rel)}" alt=""${mediaStyle}>`
                : `<video class="hf-scene-media fit-${fit}" src="${html(rel)}"${mediaTiming} muted playsinline preload="auto" onerror="this.closest('.hf-scene-wrap')?.classList.add('hf-media-error')"${mediaStyle}></video>`;
            // Backdrop for scaled framings. The CEO (framing worker) sets scene.background:
            // 'blur'/'none'/unspecified → a BLURRED, scaled copy of the footage itself (the
            // rich "blurred fill" a human editor uses — never a black void); 'gradient:*' /
            // 'soft-*' → a flat tinted panel. This honors the CEO's choice AND guarantees a
            // scaled clip never floats on black (the old code drew one fixed dark gradient
            // for every framed scene, which read as "no background").
            let backdropMarkup = '';
            if (needsBackdrop) {
                const bgRaw = String(scene.background || '').trim().toLowerCase();
                const bgKind = bgRaw.split(':')[0];
                const isFlat = bgKind === 'gradient' || bgKind === 'soft' || bgRaw.startsWith('soft-');
                if (isFlat && bgPack) {
                    // Flat background choices land on the VIDEO's designed
                    // background pack (one style per video, director-chosen)
                    // instead of the old generic tint.
                    backdropMarkup = `<div class="hf-scene-floatbg ${bgPack.stageClass}">${bgPack.html}</div>`;
                } else if (isFlat) {
                    // Legacy tint path (HF_BACKGROUND_PACKS=0): flat choices
                    // tint over the blurred media fill instead of replacing it.
                    const flatClass = (bgRaw.startsWith('soft-') || bgKind === 'soft')
                        ? ' hf-floatbg-soft'
                        : (bgRaw.includes('warm') ? ' hf-floatbg-warm' : '');
                    const flatFill = isImage
                        ? `<img class="hf-floatbg-fill" src="${html(rel)}" alt="">`
                        : `<video class="hf-floatbg-fill" src="${html(rel)}"${mediaTiming} muted playsinline preload="auto"></video>`;
                    backdropMarkup = `<div class="hf-scene-floatbg hf-floatbg-media${flatClass}">${flatFill}</div>`;
                } else {
                    const fill = isImage
                        ? `<img class="hf-floatbg-fill" src="${html(rel)}" alt="">`
                        : `<video class="hf-floatbg-fill" src="${html(rel)}"${mediaTiming} muted playsinline preload="auto"></video>`;
                    backdropMarkup = `<div class="hf-scene-floatbg hf-floatbg-media">${fill}</div>`;
                }
            }
            // Explainer icon moments (icon-director): photo cutouts / authored
            // SVGs popping in over the footage, word-synced. Rendered inside
            // the scene wrap so they travel with scene transitions.
            let iconMarkup = '';
            const iconMoments = Array.isArray(scene._iconMoments) ? scene._iconMoments : [];
            // Framed presenter holds render as a "presenter stage" — their icon moments become
            // the explanation images that slide in beside the host (built below), NOT corner icons.
            const isPStage = !!(scene.presenterInsert && scene.presenterInsert.layout === 'framed');
            if (!isPStage) iconMoments.forEach((m, j) => {
                if (!m) return;
                let inner = '';
                let framedClass = '';
                if ((m.kind === 'photo' || m.kind === 'image') && m.src) {
                    const irel = copyAsset(m.src, mediaDir, `${id}-icon-${j}`, assetCache, {});
                    if (!irel) return;
                    inner = `<img src="${html(irel)}" alt="">`;
                    // 'image' = whole photograph in a small frame (no cutout)
                    if (m.kind === 'image') framedClass = ' hf-scene-icon-framed';
                } else if (m.kind === 'svg' && m.svg) {
                    inner = m.svg;
                } else return;
                const iconId = `${id}-icon-${j}`;
                iconMarkup += `
      <div id="${iconId}" class="hf-scene-icon${framedClass} hf-icon-pos-${classToken(m.position, 'top-right')}" style="color:${iconAccent}">${inner}</div>`;
                iconAnims.push({ id: iconId, start: start + toSeconds(m.at, 0.5), duration: Math.max(1, toSeconds(m.dur, 2)) });
            });
            // Keyword-glow overlays (#18) — word-synced emphasis inside the wrap so
            // they travel with scene transitions. Only present when HF_KEYWORD_GLOW set.
            let glowMarkup = '';
            const kwGlows = Array.isArray(scene._keywordGlow) ? scene._keywordGlow : [];
            kwGlows.forEach((g, j) => {
                if (!g || !g.phrase) return;
                const kwId = `${id}-kw-${j}`;
                glowMarkup += `
      <div id="${kwId}" class="hf-kw-glow hf-kw-pos-${classToken(g.position, 'lower-center')}" style="color:${iconAccent}"><span class="hf-kw-glow-fill">${html(g.phrase)}</span><span class="hf-kw-glow-layer" aria-hidden="true">${html(g.phrase)}</span></div>`;
                glowAnims.push({ id: kwId, start: start + toSeconds(g.at, 0.5), duration: Math.max(1, toSeconds(g.dur, 1.8)) });
            });
            // Talking-head corner PiP (rare, HF_PRESENTER_PIP): the presenter rides as a
            // framed inset OVER the B-roll base — INSIDE the scene wrap, so no z-index or
            // backdrop rework. Image now; a per-scene avatar clip (timed video) later.
            let presenterPipMarkup = '';
            const _pip = (scene.presenterInsert && scene.presenterInsert.layout === 'pip') ? scene.presenterInsert : null;
            if (_pip && _pip.mediaFile) {
                const prel = copyAsset(_pip.mediaFile, mediaDir, `${id}-pip`, assetCache, {});
                if (prel) {
                    const pipVid = /\.(mp4|webm|mov|m4v)$/i.test(prel);
                    const pipInner = pipVid
                        ? `<video src="${html(prel)}" data-start="${start.toFixed(3)}" data-duration="${durationForTimeline.toFixed(3)}" muted playsinline preload="auto" onerror="this.style.display='none'"></video>`
                        : `<img src="${html(prel)}" alt="">`;
                    const pipId = `${id}-pip`;
                    const cornerCss = { 'bottom-right': 'right:5%;bottom:8%;', 'bottom-left': 'left:5%;bottom:8%;', 'top-right': 'right:5%;top:8%;', 'top-left': 'left:5%;top:8%;' }[_pip.corner] || 'right:5%;bottom:8%;';
                    presenterPipMarkup = `
      <div id="${pipId}" class="hf-presenter-pip" style="${cornerCss}">${pipInner}</div>`;
                    iconAnims.push({ id: pipId, start: start + 0.2, duration: Math.max(1, durationForTimeline - 0.4) });
                }
            }
            // Talking-head SPLIT SCREEN: presenter on one side, the scene's B-roll on the
            // other — two half-panels replace the normal single-media frame. Presenter half
            // holds while the B-roll half changes across a multi-beat split (no per-beat pop).
            let frameExtraClass = isFloating ? ' is-floating' : '';
            let frameInnerHtml = `${mediaTag}
        ${fxLayers}`;
            const _split = (scene.presenterInsert && scene.presenterInsert.layout === 'split') ? scene.presenterInsert : null;
            if (_split && _split.mediaFile) {
                const presRel = copyAsset(_split.mediaFile, mediaDir, `${id}-splitpres`, assetCache, {});
                if (presRel) {
                    const pVid = /\.(mp4|webm|mov|m4v)$/i.test(presRel);
                    const objPos = `object-position:${(Number(scene.focusX ?? 0.5) * 100).toFixed(0)}% ${(Number(scene.focusY ?? 0.38) * 100).toFixed(0)}%;`;
                    const presTag = pVid
                        ? `<video src="${html(presRel)}" data-start="${start.toFixed(3)}" data-duration="${durationForTimeline.toFixed(3)}" muted playsinline preload="auto" style="${objPos}"></video>`
                        : `<img src="${html(presRel)}" alt="" style="${objPos}">`;
                    const brollPanel = rel ? mediaTag : '';
                    frameExtraClass = ' hf-scene-split' + (_split.side === 'right' ? ' is-right' : '');
                    frameInnerHtml = `
        <div class="hf-split-panel hf-split-presenter">${presTag}</div>
        <div class="hf-split-panel hf-split-broll">${brollPanel}</div>
        ${fxLayers}`;
                }
            }
            // Talking-head PRESENTER STAGE (framed holds): host card on hostSide + an explanation
            // slot on the other side where the scene's word-synced images SLIDE IN and back out.
            // The host holds (same image across a multi-beat span); the explanation images change.
            if (isPStage && rel) {
                const hostSide = scene.presenterInsert.hostSide === 'right' ? 'right' : 'left';
                const objPos = `object-position:${(Number(scene.focusX ?? 0.5) * 100).toFixed(0)}% ${(Number(scene.focusY ?? 0.38) * 100).toFixed(0)}%;`;
                const hostVid = /\.(mp4|webm|mov|m4v)$/i.test(rel);
                const hostTag = hostVid
                    ? `<video src="${html(rel)}" data-start="${start.toFixed(3)}" data-duration="${durationForTimeline.toFixed(3)}" muted playsinline preload="auto" style="${objPos}"></video>`
                    : `<img src="${html(rel)}" alt="" style="${objPos}">`;
                let explainHtml = '';
                iconMoments.forEach((m, j) => {
                    if (!m) return;
                    let inner = '';
                    if ((m.kind === 'photo' || m.kind === 'image') && m.src) {
                        const irel = copyAsset(m.src, mediaDir, `${id}-ex-${j}`, assetCache, {});
                        if (!irel) return;
                        inner = `<img src="${html(irel)}" alt="">`;
                    } else if (m.kind === 'svg' && m.svg) {
                        inner = `<div class="hf-pexplain-svg" style="color:${iconAccent}">${m.svg}</div>`;
                    } else return;
                    const exId = `${id}-ex-${j}`;
                    explainHtml += `
        <div id="${exId}" class="hf-pexplain">${inner}</div>`;
                    explainAnims.push({ id: exId, start: start + toSeconds(m.at, 0.6), duration: Math.max(1.6, toSeconds(m.dur, 2.8)), from: hostSide === 'left' ? 'right' : 'left' });
                });
                frameExtraClass = ' hf-pstage is-host-' + hostSide;
                frameInnerHtml = `
        <div class="hf-pstage-hostcard">${hostTag}</div>
        <div class="hf-pstage-slot">${explainHtml}</div>
        ${fxLayers}`;
            }
            sceneTags.push(`
    <div ${baseAttrs} class="clip hf-scene hf-scene-wrap${isFloating ? ' hf-scene-floating' : ''}${isCinematic ? ' hf-scene-cinematic' : ''}">
      ${backdropMarkup}
      <div class="hf-scene-frame${frameExtraClass}"${frameStyle}>
        ${frameInnerHtml}
      </div>${iconMarkup}${presenterPipMarkup}${glowMarkup}
    </div>`);
            sceneHoldSources.push({
                sourceId: id,
                sourceSceneIndex: scene.index,
                start,
                end: start + durationForTimeline,
                rel,
                isImage,
                fit,
                frameStyle,
                mediaStyle,
                backdropMarkup,
                isFloating,
                isCinematic,
                treatLayers: treat.layers,
                trackIndex,
                kenBurns,
                mediaStartOffset,
                focusPan,
            });
        }
        sceneAnims.push({ id, start, duration: durationForTimeline, kenBurns, transition: scene.transition, transitionType: scene.transitionType, transitionIn: scene.transitionIn, focusPan });
    }

    const transitionOverlays = collectTransitionOverlays(sceneAnims, plan);

    // ── Transition opacity ownership (smoothness / anti-ghost fix) ──
    // A real editor's push / wipe / whip / zoom keeps BOTH frames fully opaque —
    // the geometric move IS the transition. The generic per-scene opacity
    // crossfade (applied in the sceneAnims runtime loop) otherwise fades the
    // incoming up from 0 WHILE it slides/scales in, so during the most visible
    // part of the move you see through it to the outgoing/stage = a mushy
    // double-exposure ("ghosty, not made by an editor"). Precompute which scene
    // is the incoming/outgoing side of a HARD-motion transition and let the
    // motion own opacity there. blur-dissolve/crossfade are TRUE dissolves and
    // deliberately keep the opacity fade (soft = time passing).
    const _HARD_MOTION_TX = new Set([
        'push-left', 'push-right', 'push-up',
        'wipe-left', 'wipe-right', 'wipe-up',
        'whip-left', 'whip-right',
        'zoom-punch', 'zoom-pull', 'spin-settle',
    ]);
    {
        const _sceneById = new Map(sceneAnims.map(s => [s.id, s]));
        for (const ov of transitionOverlays) {
            if (ov.mode !== 'motion' || !_HARD_MOTION_TX.has(ov.type)) continue;
            const inScene = ov.inId ? _sceneById.get(ov.inId) : null;
            if (inScene) inScene._motionIn = true;
            const outScene = ov.outId ? _sceneById.get(ov.outId) : null;
            if (outScene) {
                outScene._motionOut = true;
                // the motion runtime resets the outgoing transform at boundary + duration
                outScene._motionOutSnapAt = (ov.boundary != null ? ov.boundary : ov.start + ov.duration * 0.5) + ov.duration;
            }
        }
        // Plain-cut adjacency: when the next scene begins exactly at this scene's
        // end (back-to-back, same base track), it paints on top — so hold this
        // scene opaque and let the successor dissolve in OVER it. Keeps luminance
        // constant across the cut instead of both clips fading over the dark
        // stage (a repeated ~9% "breath" at every one of the ~200 plain cuts).
        for (let i = 0; i < sceneAnims.length; i++) {
            const s = sceneAnims[i];
            if (s._motionOut) continue;
            const succ = sceneAnims[i + 1];
            if (!succ) continue;
            const end = toSeconds(s.start, 0) + toSeconds(s.duration, 0);
            const succStart = toSeconds(succ.start, 0);
            if (succStart >= toSeconds(s.start, 0) && Math.abs(succStart - end) < 0.05) {
                s._coveredOut = true;
            }
        }
    }

    // Only overlay-mode transitions need a DOM element (slab/flare swept over
    // the cut). Motion-mode transitions animate the scene containers directly.
    const transitionTags = transitionOverlays.filter(item => item.mode !== 'motion').map(item => `
    <div id="${item.id}" data-start="${item.start.toFixed(3)}" data-duration="${item.duration.toFixed(3)}" data-track-index="28" class="clip hf-transition hf-transition-${classToken(item.type, 'crossfade')}" data-hf-anim="${item.id}" data-hf-transition="${html(item.type)}">
      <div class="hf-transition-slab"></div>
      <div class="hf-transition-flare"></div>
    </div>`);

    const captionCues = buildCaptionCues(plan);
    const captionTags = captionCues.map(c => {
        // Karaoke: when the cue carries per-word timings, emit one span per word
        // (highlighted on the timeline). Otherwise render the single text span
        // exactly as before.
        const inner = (Array.isArray(c.words) && c.words.length)
            ? c.words.map((w, i) => `<span class="hf-cap-word" id="${c.id}-w${i}">${html(w.w)}</span>`).join(' ')
            : html(c.text);
        return `
    <div id="${c.id}" data-start="${c.start.toFixed(3)}" data-duration="${c.duration.toFixed(3)}" data-track-index="26" class="clip hf-caption" data-hf-anim="${c.id}">
      <span class="hf-caption-text">${inner}</span>
    </div>`;
    });

    const graphicTags = [];
    const graphicAnims = [];
    // ── Stage-visual chains (June 12): when a template/fullscreen MG is
    // immediately followed by another (gap ≤ 0.35s), the boundary must be
    // SEAMLESS — no container scale-pop out/in. The internal choreography
    // (content exit of A, content entrance of B) carries the swap, so the
    // pair reads as pages of one continuous design. seamOut on A's side,
    // seamIn on B's side; the page runtime consumes the flags.
    const _stageWindows = graphics
        .map((mg, i) => {
            const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
            if (!isStageVisual(mg?._hfKind || 'graphic', type) || type === 'map-chart') return null;
            const timing = mg._hfTiming || getVisualTiming(mg, mg._hfKind, type);
            return { i, start: timing.start, end: timing.start + timing.duration };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start);
    const _seamIn = new Set();
    const _seamOut = new Set();
    for (let w = 1; w < _stageWindows.length; w++) {
        const prev = _stageWindows[w - 1], cur = _stageWindows[w];
        if (cur.start - prev.end <= 0.35 && cur.start - prev.end >= -0.5) {
            _seamOut.add(prev.i);
            _seamIn.add(cur.i);
        }
    }
    graphics.forEach((mg, i) => {
        const type = resolveVisualType(mg, mg?._hfKind || 'graphic');
        const id = `mg-${i}-${cleanName(type || mg._hfKind || 'graphic')}`;
        const timing = mg._hfTiming || getVisualTiming(mg, mg._hfKind, type);
        const visual = mg._hfVisual || resolveHyperframeVisual(mg, mg._hfKind, type, plan);
        const text = getMgText(mg);
        const subtext = getMgSubtext(mg);
        const spec = getAgenticCompositionSpec(mg, {
            kind: mg._hfKind,
            type,
            visual,
            text,
            subtext,
            items: itemsFromMg(mg, text, subtext),
            kicker: templateKicker(type, mg),
            hasAsset: hasResolvedMgAsset(mg, type, dirs),
        });
        const effectiveAnimation = displayValue(spec?.motion?.entrance, visual.animation, 'fadeSlide');
        const effectiveSpeed = normalizeMotionSpeed(spec?.motion?.speed, visual.speed);
        const transparentTemplateBg = mg._hfKind === 'template' && isTransparentTemplateBackground(mg);
        graphicTags.push(buildMgMarkup(mg, id, mg._hfKind, dirs, mediaDir, assetCache, visual, i));
        graphicAnims.push({
            id,
            start: timing.start,
            duration: timing.duration,
            kind: mg._hfKind,
            // set by buildMgMarkup when the authored markup actually rendered
            // (false when it fell back to the fixed renderer)
            authored: Boolean(mg._authoredRendered),
            // seamless stage-visual chain boundaries (no container pop)
            seamIn: _seamIn.has(i),
            seamOut: _seamOut.has(i),
            type,
            compositionMode: spec?.mode || 'legacy',
            layout: spec?.layout || '',
            safeZone: spec?.safeZone || '',
            compositionSource: spec?.source || '',
            textStrategy: spec?.textStrategy || '',
            mediaTreatment: spec?.media?.treatment || '',
            density: spec?.density || '',
            motionEmphasis: spec?.motion?.emphasis || '',
            motionExit: spec?.motion?.exit || '',
            motionStagger: spec?.motion?.stagger || '',
            variant: visual.variant,
            animation: effectiveAnimation,
            speed: effectiveSpeed,
            styleName: visual.styleName,
            themeId: visual.themeId,
            transparentTemplateBg,
        });
    });

    // ── Map builder timelines ──
    // buildMgMarkup attaches _hfMapAnim/_hfMapOffset for every map-chart that
    // took the map-hf-builder path. Serialize their GSAP tweens (camera,
    // border draw-on, route, pins) at each MG's absolute start offset; the
    // block is injected into the page script after the graphic anims loop.
    const mapTimelineScript = mapHfBuilder
        ? graphics
            .filter(g => g && g._hfMapAnim)
            .map(g => mapHfBuilder.buildMapTimelineJS(g._hfMapAnim, g._hfMapOffset || 0))
            .join('\n')
        : '';

    // ── Agent-authored composition timelines ──
    // Each authored fragment runs against its own nested timeline (shadowed
    // `tl` inside the IIFE), then the nested timeline is added to the master
    // at the MG's start offset. The master is passed as a parameter so the
    // inner `var tl` shadow can't hoist over it.
    // Belt-and-suspenders: syntax-check every fragment (vm parse, no exec)
    // before injection — ONE unparseable fragment would otherwise kill the
    // entire page <script>, master timeline included.
    const vm = require('vm');
    let _authoredDropped = 0;
    const authoredTimelineScript = graphics
        .filter(g => g && g._hfAuthoredTimeline)
        .map(g => {
            // prime: GSAP fromTo tweens don't apply their "from" state until
            // first rendered — without this, frame 0 of the scene shows the
            // FINISHED layout (CSS hero state), which then snaps invisible
            // and animates in. progress(1)→progress(0) force-renders every
            // tween so t=0 shows true entrance starting states.
            const wrapped = `(function(__master){ var tl = gsap.timeline();\n${g._hfAuthoredTimeline}\ntry { tl.progress(1, true).progress(0, true); } catch (e) {}\n__master.add(tl, ${(Number(g._hfAuthoredOffset) || 0).toFixed(3)}); })(tl);`;
            try {
                new vm.Script(wrapped);
                return wrapped;
            } catch (e) {
                _authoredDropped++;
                console.warn(`[HyperFrames] dropping authored timeline (syntax error): ${String(e.message).slice(0, 80)}`);
                return '';
            }
        })
        .filter(Boolean)
        .join('\n');

    const fxTimelineScript = fxTimelines.join('\n');
    if (fxTimelines.length) console.log(`[HyperFrames] Effects registry: ${fxTimelines.length} scene(s) with animated effect stacks`);

    // One-line observability for the two new render paths — these are the
    // lines to scan for in app logs after a build.
    const _mapBuilderCount = graphics.filter(g => g && g._hfMapAnim).length;
    const _mapTotal = graphics.filter(g => resolveVisualType(g, g?._hfKind || 'graphic') === 'map-chart').length;
    const _authoredCount = graphics.filter(g => g && g._hfAuthoredTimeline).length;
    console.log(`[HyperFrames] Map builder: ${_mapBuilderCount}/${_mapTotal} map scene(s) via map-hf-builder${_mapTotal > _mapBuilderCount ? ` (${_mapTotal - _mapBuilderCount} legacy fallback)` : ''}`);
    console.log(`[HyperFrames] Authored compositions: ${_authoredCount} rendered${_authoredDropped ? `, ${_authoredDropped} DROPPED at injection (syntax)` : ''}`);
    const _txMotion = transitionOverlays.filter(t => t.mode === 'motion').length;
    console.log(`[HyperFrames] Transitions: ${transitionOverlays.length} visible (${_txMotion} scene-motion, ${transitionOverlays.length - _txMotion} overlay), rest are cuts/crossfades`);
    console.log(`[HyperFrames] Explainer icons: ${iconAnims.length} moment(s) on the page`);

    const coverageSpans = [
        ...sceneHoldSources.map(item => ({ start: item.start, end: item.end })),
        ...graphicAnims
            .filter(item => !item.transparentTemplateBg && (item.kind === 'fullscreen' || item.kind === 'template' || typeSupportsFullscreen(item.type)))
            .map(item => ({ start: item.start, end: item.start + item.duration })),
    ]
        .filter(span => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const mergedCoverage = [];
    for (const span of coverageSpans) {
        const last = mergedCoverage[mergedCoverage.length - 1];
        if (!last || span.start > last.end + 0.05) {
            mergedCoverage.push({ ...span });
        } else {
            last.end = Math.max(last.end, span.end);
        }
    }

    const sortedHoldSources = [...sceneHoldSources].sort((a, b) => a.start - b.start);
    const holdGapAnims = [];
    for (let i = 0; i < mergedCoverage.length - 1; i++) {
        const gapStart = mergedCoverage[i].end;
        const gapEnd = mergedCoverage[i + 1].start;
        const gapDuration = gapEnd - gapStart;
        if (gapDuration <= 0.16) continue;

        const source = [...sortedHoldSources].reverse().find(item => item.start <= gapStart + 0.2);
        if (!source) continue;

        const holdStart = Math.max(0, gapStart - 0.04);
        const holdDuration = renderDuration(gapEnd - holdStart + 0.08, gapDuration);
        const id = `hold-${i}-${cleanName(source.sourceSceneIndex ?? source.sourceId)}`;
        const mediaStartAttr = Number(source.mediaStartOffset || 0) > 0.001 ? ` data-media-start="${Number(source.mediaStartOffset || 0).toFixed(3)}"` : '';
        const mediaTag = source.isImage
            ? `<img class="hf-scene-media fit-${source.fit}" src="${html(source.rel)}" alt=""${source.mediaStyle}>`
            : `<video class="hf-scene-media fit-${source.fit}" src="${html(source.rel)}" data-start="${holdStart.toFixed(3)}" data-duration="${holdDuration.toFixed(3)}"${mediaStartAttr} muted playsinline preload="auto"${source.mediaStyle}></video>`;
        sceneTags.push(`
    <div id="${id}" data-start="${holdStart.toFixed(3)}" data-duration="${holdDuration.toFixed(3)}"${mediaStartAttr} data-track-index="${source.trackIndex}" data-hf-anim="${id}" class="clip hf-scene hf-scene-wrap hf-hold-scene${source.isFloating ? ' hf-scene-floating' : ''}${source.isCinematic ? ' hf-scene-cinematic' : ''}">
      ${source.backdropMarkup}
      <div class="hf-scene-frame${source.isFloating ? ' is-floating' : ''}"${source.frameStyle}>
        ${mediaTag}
        ${source.treatLayers}
      </div>
    </div>`);
        sceneAnims.push({ id, start: holdStart, duration: holdDuration, kenBurns: source.kenBurns, hold: true, focusPan: source.focusPan || null });
        holdGapAnims.push({ start: holdStart, end: holdStart + holdDuration, source: source.sourceSceneIndex ?? source.sourceId });
    }
    if (holdGapAnims.length > 0) {
        console.warn(`[HyperFrames] Filled ${holdGapAnims.length} uncovered visual gap(s) with previous-scene holds`);
    }

    const audioTags = [];
    const audioSrc = resolveMaybeFile(plan.audio, dirs);
    if (audioSrc) {
        const rel = copyAsset(audioSrc, mediaDir, 'voiceover', assetCache);
        audioTags.push(`    <audio id="voiceover" data-start="0" data-duration="${totalDuration.toFixed(3)}" data-track-index="30" class="clip" src="${html(rel)}" data-volume="1"></audio>`);
    }
    for (const [i, sfx] of (plan.sfxClips || []).entries()) {
        if (!sfx || !sfx.file) continue;
        const sfxPath = resolveMaybeFile(sfx.file, [path.join(dirs.appRoot, 'assets', 'sfx'), ...dirs.lookupDirs]);
        if (!sfxPath) continue;
        const rel = copyAsset(sfxPath, mediaDir, `sfx-${i}-${sfx.file}`, assetCache);
        audioTags.push(`    <audio id="sfx-${i}" data-start="${toSeconds(sfx.startTime, 0).toFixed(3)}" data-duration="${getDuration(sfx, 0.5).toFixed(3)}" data-track-index="${31 + i}" class="clip" src="${html(rel)}" data-volume="${toSeconds(sfx.volume, 0.35)}"></audio>`);
    }

    if (glowAnims.length) console.log(`[HyperFrames] Keyword glow: ${glowAnims.length} moment(s) on the page`);
    // glowAnims added ONLY when present so an OFF build's timeline JSON is byte-identical.
    const _timing = { sceneAnims, graphicAnims, transitionAnims: transitionOverlays, captionAnims: captionCues, iconAnims };
    if (glowAnims.length) _timing.glowAnims = glowAnims;
    if (explainAnims.length) _timing.explainAnims = explainAnims;
    const timelineData = JSON.stringify(_timing, null, 2);
    // Global background treatment (user-tuned): a medium edge vignette painted over
    // the WHOLE composition. Footage/packs stay true-color (neutral darken only); the
    // flat cream template cards gain depth instead of reading as stark empty canvas.
    // Edge-weighted (transparent core to 58%), so centered headlines/stats/subtitles
    // are untouched. Disable with HF_BG_VIGNETTE=0; tune with HF_BG_VIGNETTE_ALPHA.
    const __bgVignetteOn = process.env.HF_BG_VIGNETTE !== '0';
    const __bgVignetteAlpha = Math.max(0, Math.min(0.6, parseFloat(process.env.HF_BG_VIGNETTE_ALPHA || '0.34') || 0.34));
    const __bgTreatmentCss = __bgVignetteOn
        ? `\n    #yta-hyperframes::after { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 70; background: radial-gradient(125% 105% at 50% 44%, rgba(28,19,8,0) 0%, rgba(28,19,8,0) 58%, rgba(28,19,8,${__bgVignetteAlpha}) 100%); }`
        : '';

    const __hfHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>YTA HyperFrames Render</title>
  <style>
    /* display:grid centers the fixed 1920x1080 composition when the host
       viewport is larger (the app preview iframe) — without it the comp pins
       top-left and the rest of the iframe reads as a black box. The CLI
       renderer uses an exact 1920x1080 viewport, where centering is a no-op. */
    html, body { margin: 0; width: 100%; height: 100%; background: #050505; overflow: hidden; font-family: Inter, Arial, Helvetica, sans-serif; }
    body { display: grid; place-items: center; }
    #yta-hyperframes { width: 1920px; height: 1080px; position: relative; overflow: hidden; background: radial-gradient(circle at 50% 40%, #111827 0%, #050505 70%); color: #f8fafc; --hf-primary:#22d3ee; --hf-accent:#8b5cf6; --hf-text:#f8fafc; --hf-muted:rgba(226,232,240,0.88); --hf-surface:rgba(2,6,23,0.78); --hf-bg:rgba(2,6,23,0.78); --hf-shadow-color:rgba(0,0,0,0.48); --hf-shadow:0 22px 70px rgba(0,0,0,0.48); --hf-radius:12px; --hf-stroke:2px; --hf-heading-font:Inter,Arial,Helvetica,sans-serif; --hf-body-font:Inter,Arial,Helvetica,sans-serif; --hf-caption-font:Inter,Arial,Helvetica,sans-serif; }
    .hf-scene { position: absolute; inset: 0; width: 100%; height: 100%; object-position: center center; opacity: 0; z-index: 1; }${__bgTreatmentCss}
    .hf-hold-scene { z-index: 0; }
    .hf-media.fit-cover, .hf-bg-media { object-fit: cover; width: 100%; height: 100%; }
    .hf-media.fit-contain { object-fit: contain; background: #050505; }
    /* Scene wrapper: footage + cinematic-treatment layers (grain/vignette/tint) */
    .hf-scene-wrap { overflow: hidden; }
    .hf-scene-frame { overflow: hidden; /* clip KB-scaled media to the frame — footage bleeding past the frame left the fx layers (grain) covering a SMALLER box than the visible media */  position: absolute; inset: 0; transform-origin: center center; }
    .hf-scene-media { position: absolute; inset: 0; width: 100%; height: 100%; object-position: center center; transform-origin: center center; }
    .hf-scene-media.fit-cover { object-fit: cover; }
    .hf-scene-media.fit-contain { object-fit: contain; background: #050505; }
    .hf-scene-fx { position: absolute; inset: 0; pointer-events: none; }
    .hf-scene-tint { mix-blend-mode: soft-light; }
    .hf-scene-vignette { mix-blend-mode: multiply; }
    .hf-scene-grain { mix-blend-mode: overlay; background-size: 220px 220px; background-repeat: repeat; ${grainTextureRel ? `background-image: url("${grainTextureRel}");` : ''} }
    .hf-scene-dust { mix-blend-mode: screen; background-size: 540px 540px; background-repeat: repeat; ${grainTextureRel ? `background-image: url("${grainTextureRel}");` : ''} }
    /* If the scene's media errors out, hide texture FX — grain/dust over a
       dead (black) layer renders as full-frame TV static in the final video. */
    .hf-media-error .hf-scene-fx { display: none; }
    /* hf-effects registry (animated effect stacks) */
${hfEffects ? hfEffects.sharedEffectsCSS(grainTextureRel) : ''}
    /* Local fonts — render browser has no network fonts */
    ${fontFacesCss}
    .hf-scene-leak { mix-blend-mode: screen; }
    .hf-scene-floatbg { position: absolute; inset: 0; overflow: hidden; background: radial-gradient(circle at 50% 38%, #161d2b 0%, #070a11 72%); }
    .hf-scene-floatbg.hf-floatbg-media { background: #070a11; }
    /* brightness 0.5 + a 0.5 edge vignette made the blurred fill read as a
       BLACK box around inset clips (the visible margin ring sits exactly in
       the most-darkened zone). Brighter fill + lighter vignette keeps the
       editorial dim while clearly showing the blurred duplicate. */
    .hf-floatbg-fill { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover; filter: blur(40px) brightness(0.78) saturate(1.15); transform: scale(1.06); will-change: transform; }
    .hf-scene-floatbg.hf-floatbg-media:after { content: ""; position: absolute; inset: 0; background: radial-gradient(circle at 50% 42%, rgba(2,6,23,0) 40%, rgba(2,6,23,0.28) 100%); }
    .hf-scene-floatbg.hf-floatbg-soft { background: linear-gradient(160deg, #2a2f3a, #14171e); }
    .hf-scene-floatbg.hf-floatbg-warm { background: radial-gradient(circle at 50% 40%, #2a2018, #120d09 72%); }
${bgPackCss}
    .hf-scene-frame.is-floating { transform-origin: center center; }
    .hf-scene-frame.is-floating .hf-scene-media { border-radius: 20px; box-shadow: 0 44px 130px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04); overflow: hidden; }
    .hf-empty { display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #111827, #030712); }
    .hf-empty-text { max-width: 1100px; font-size: 54px; line-height: 1.08; color: rgba(248,250,252,0.78); text-align: center; }
    .hf-mg { position: absolute; box-sizing: border-box; opacity: 0; pointer-events: none; z-index: 40; color: var(--hf-text); font-family: var(--hf-body-font); text-shadow: 0 2px 18px rgba(0,0,0,0.42); }
    .hf-title { max-width: 1450px; font-family: var(--hf-heading-font); font-size: 76px; line-height: 0.98; font-weight: 900; letter-spacing: 0; text-wrap: balance; }
    .hf-subtitle { max-width: 1250px; margin-top: 16px; color: var(--hf-muted); font-family: var(--hf-body-font); font-size: 34px; line-height: 1.18; font-weight: 650; text-wrap: balance; }
    .hf-kicker { margin-bottom: 14px; color: var(--hf-accent); font-family: var(--hf-caption-font); font-size: 24px; font-weight: 850; letter-spacing: 0; text-transform: uppercase; }
    .hf-copy-shell { padding: 34px 46px 38px 54px; border-left: 8px solid var(--hf-primary); border-radius: var(--hf-radius); background: linear-gradient(90deg, var(--hf-bg), rgba(15,23,42,0.54)); box-shadow: var(--hf-shadow); backdrop-filter: blur(16px); }
    .hf-agentic { --hf-agentic-pad-x: 120px; --hf-agentic-pad-y: 92px; --hf-agentic-copy-max: 1220px; --hf-agentic-gap: 22px; inset: 0; width: 100%; height: 100%; transform: none; overflow: hidden; }
    .hf-agentic.hf-agentic-layout-center-stack, .hf-agentic.hf-agentic-layout-cinematic-title, .hf-agentic.hf-agentic-layout-evidence-board, .hf-agentic.hf-agentic-layout-data-focus, .hf-agentic.hf-agentic-layout-split-panel, .hf-agentic.hf-agentic-layout-map-explainer, .hf-agentic.hf-agentic-layout-focus-panel { inset: 0; width: 100%; height: 100%; transform: none; }
    .hf-agentic-shade { position: absolute; inset: 0; z-index: 0; background: radial-gradient(circle at 72% 48%, rgba(15,23,42,0.05), rgba(2,6,23,0.34) 64%), linear-gradient(90deg, rgba(2,6,23,0.72), rgba(2,6,23,0.18), rgba(2,6,23,0.04)); pointer-events: none; }
    .hf-agentic.hf-no-bg .hf-agentic-shade { background: radial-gradient(circle at 50% 42%, rgba(30,41,59,0.54), transparent 58%), linear-gradient(110deg, rgba(2,6,23,0.94), rgba(2,6,23,0.66)); }
    .hf-agentic.hf-agentic-media-transparent { background: transparent; }
    .hf-agentic-shade.hf-agentic-media-transparent { display: none; }
    .hf-agentic-media-darken-background { background: linear-gradient(90deg, rgba(2,6,23,0.82), rgba(2,6,23,0.40), rgba(2,6,23,0.08)); }
    .hf-agentic-media-blur-background { background: rgba(2,6,23,0.30); backdrop-filter: blur(18px) saturate(1.08); }
    .hf-agentic-media-image-focus { background: radial-gradient(circle at 62% 44%, rgba(255,255,255,0.04), rgba(2,6,23,0.44) 58%), linear-gradient(90deg, rgba(2,6,23,0.78), rgba(2,6,23,0.16)); }
    .hf-agentic-media-map-focus { background: radial-gradient(circle at 50% 46%, rgba(56,189,248,0.08), rgba(2,6,23,0.28) 52%), linear-gradient(0deg, rgba(2,6,23,0.46), rgba(2,6,23,0.08)); }
    .hf-agentic-media-evidence-board { background: linear-gradient(115deg, rgba(2,6,23,0.82), rgba(15,23,42,0.34), rgba(2,6,23,0.12)); }
    .hf-agentic-media-split-background { background: linear-gradient(90deg, rgba(2,6,23,0.86) 0 48%, rgba(2,6,23,0.16) 48% 100%); }
    .hf-agentic-kinetic { display: flex; flex-wrap: wrap; gap: 0.26em 0.32em; justify-content: inherit; }
    .hf-agentic-safe-center .hf-agentic-kinetic { justify-content: center; }
    .hf-agentic-word { display: inline-block; }
    .hf-agentic-layout-focus-panel .hf-agentic-stage { align-content: center; justify-items: center; text-align: center; }
    .hf-agentic-layout-focus-panel .hf-agentic-rule { display: none; }
    .hf-agentic-layout-focus-panel .hf-agentic-copy { padding: 38px 58px 44px; max-width: 1180px; background: color-mix(in srgb, var(--hf-bg), transparent 12%); border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 42%); border-left: 12px solid var(--hf-primary); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); backdrop-filter: blur(20px) saturate(1.1); }
    .hf-agentic-layout-focus-panel .hf-agentic-kicker { color: var(--hf-primary); letter-spacing: 0.16em; text-transform: uppercase; }
    .hf-agentic-layout-focus-panel .hf-agentic-title { font-size: clamp(50px, 4.8vw, 88px); }
    .hf-agentic-stage { position: absolute; inset: 0; z-index: 2; display: grid; align-content: center; justify-items: start; gap: var(--hf-agentic-gap); padding: var(--hf-agentic-pad-y) var(--hf-agentic-pad-x); box-sizing: border-box; }
    .hf-agentic-safe-center .hf-agentic-stage { align-content: center; justify-items: center; text-align: center; }
    .hf-agentic-safe-center .hf-agentic-copy { justify-items: center; }
    .hf-agentic-rule { width: 8px; min-height: 132px; border-radius: 999px; background: linear-gradient(180deg, var(--hf-primary), var(--hf-accent)); box-shadow: 0 0 34px color-mix(in srgb, var(--hf-primary), transparent 58%); }
    .hf-agentic-copy { display: grid; gap: 12px; max-width: var(--hf-agentic-copy-max); position: relative; }
    .hf-agentic-kicker { color: var(--hf-accent); font-family: var(--hf-caption-font); font-size: 24px; font-weight: 900; text-transform: uppercase; letter-spacing: 0; }
    .hf-agentic-title { font-family: var(--hf-heading-font); font-size: clamp(58px, 5.8vw, 110px); line-height: 0.98; font-weight: 950; letter-spacing: 0; text-wrap: balance; }
    .hf-agentic-subtitle { max-width: 980px; color: var(--hf-muted); font-family: var(--hf-body-font); font-size: 32px; line-height: 1.16; font-weight: 650; text-wrap: balance; }
    .hf-agentic-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; width: min(1320px, 100%); }
    .hf-agentic-item { padding: 18px 22px; border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 68%); border-radius: var(--hf-radius); background: color-mix(in srgb, var(--hf-surface), transparent 18%); box-shadow: 0 16px 44px rgba(0,0,0,0.26); backdrop-filter: blur(14px); }
    .hf-agentic-item-value { display: block; color: var(--hf-primary); font-family: var(--hf-heading-font); font-size: 32px; line-height: 1; font-weight: 950; }
    .hf-agentic-item-label { display: block; margin-top: 8px; font-family: var(--hf-heading-font); font-size: 28px; line-height: 1.08; font-weight: 850; }
    .hf-agentic-item-subtext { display: block; margin-top: 8px; color: var(--hf-muted); font-size: 20px; line-height: 1.2; }
    .hf-agentic-reason { display: none; }
    .hf-agentic.hf-agentic-layout-lower-third { left: 112px; right: 112px; top: auto; bottom: 86px; width: auto; height: auto; transform: none; }
    .hf-agentic-layout-lower-third .hf-agentic-shade { display: none; }
    .hf-agentic-layout-lower-third .hf-agentic-stage { position: relative; inset: auto; padding: 0; grid-template-columns: 9px minmax(0, 1fr); align-items: stretch; gap: 28px; }
    .hf-agentic-layout-lower-third .hf-agentic-rule { width: 9px; min-height: 116px; }
    .hf-agentic-layout-lower-third .hf-agentic-copy { padding: 30px 42px 34px; max-width: 1280px; border-radius: var(--hf-radius); background: linear-gradient(90deg, color-mix(in srgb, var(--hf-bg), transparent 0%), color-mix(in srgb, var(--hf-bg), transparent 24%), transparent); box-shadow: var(--hf-shadow); backdrop-filter: blur(18px); }
    .hf-agentic-layout-lower-third .hf-agentic-title { font-size: clamp(54px, 4.5vw, 84px); }
    .hf-agentic-layout-lower-third .hf-agentic-subtitle { font-size: 27px; max-width: 1120px; }
    .hf-agentic-layout-center-stack .hf-agentic-stage, .hf-agentic-layout-cinematic-title .hf-agentic-stage { align-content: center; justify-items: start; grid-template-columns: 10px minmax(0, 1fr); gap: 34px; }
    .hf-agentic-layout-center-stack .hf-agentic-copy, .hf-agentic-layout-cinematic-title .hf-agentic-copy { align-self: center; }
    .hf-agentic-layout-cinematic-title .hf-agentic-shade { background: radial-gradient(circle at 72% 48%, rgba(2,6,23,0.04), rgba(2,6,23,0.34) 60%), linear-gradient(90deg, rgba(2,6,23,0.70), rgba(2,6,23,0.18), rgba(2,6,23,0.02)); }
    /* Impact-text types (focusWord / kineticText) have a fixed visual identity: one
       big, DEAD-CENTRE punch — never the headline's left-rail layout. This is locked
       by TYPE so the Motion Director's per-item layout choice can't make a focusWord
       look like a lower-third. Placed after center-stack so it wins the cascade. */
    .hf-type-focus-word .hf-agentic-stage, .hf-type-kinetic-text .hf-agentic-stage { justify-items: center; text-align: center; align-content: center; grid-template-columns: minmax(0, 1fr); }
    .hf-type-focus-word .hf-agentic-rule, .hf-type-kinetic-text .hf-agentic-rule { display: none; }
    .hf-type-focus-word .hf-agentic-copy, .hf-type-kinetic-text .hf-agentic-copy { justify-items: center; text-align: center; }
    .hf-type-focus-word .hf-agentic-title { font-size: clamp(96px, 9.5vw, 190px); font-weight: 950; letter-spacing: 0.01em; line-height: 0.95; text-transform: uppercase; }
    .hf-type-kinetic-text .hf-agentic-kinetic { justify-content: center; }
    /* ── Registry VARIANTS, wired to the live agentic markup ──
       Overlays render through .hf-agentic-* (not the old .hf-copy-shell), so the
       per-variant looks the AI picks (mg.subType → hf-variant-X, already on the
       element) were rendering identically. These rules restore each variant's
       distinct identity by targeting the agentic structure. */
    /* lowerThird: bar(default)/box/underline/banner/glass/split */
    .hf-type-lower-third.hf-variant-box .hf-agentic-stage { grid-template-columns: minmax(0, 1fr); }
    .hf-type-lower-third.hf-variant-box .hf-agentic-rule { display: none; }
    .hf-type-lower-third.hf-variant-box .hf-agentic-copy { border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 38%); background: color-mix(in srgb, var(--hf-bg), transparent 6%); }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-stage { grid-template-columns: minmax(0, 1fr); }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-rule { display: none; }
    .hf-type-lower-third.hf-variant-underline .hf-agentic-copy { padding: 16px 6px 18px; background: transparent; box-shadow: none; backdrop-filter: none; border-radius: 0; border-bottom: 7px solid var(--hf-accent); }
    .hf-type-lower-third.hf-variant-banner.hf-agentic-layout-lower-third { left: 0; right: 0; bottom: 74px; }
    .hf-type-lower-third.hf-variant-banner .hf-agentic-stage { grid-template-columns: minmax(0, 1fr); }
    .hf-type-lower-third.hf-variant-banner .hf-agentic-rule { display: none; }
    .hf-type-lower-third.hf-variant-banner .hf-agentic-copy { padding-left: 130px; border-radius: 0; background: linear-gradient(90deg, var(--hf-bg), color-mix(in srgb, var(--hf-bg), transparent 22%), transparent); border-top: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 45%); }
    .hf-type-lower-third.hf-variant-glass .hf-agentic-copy { background: color-mix(in srgb, var(--hf-bg), transparent 26%); border: var(--hf-stroke) solid rgba(255,255,255,0.18); backdrop-filter: blur(28px) saturate(1.18); }
    /* callout: standard(default Quote Box)/minimal/accent — focus-panel layout */
    .hf-type-callout.hf-variant-minimal .hf-agentic-copy { background: transparent; border: 0; border-left: 6px solid var(--hf-accent); border-radius: 0; box-shadow: none; backdrop-filter: none; padding: 12px 30px; }
    .hf-type-callout.hf-variant-accent .hf-agentic-copy { border-left-width: 16px; background: color-mix(in srgb, var(--hf-accent), transparent 86%); }
    /* headline: standard/stamp/typewriter — center-stack layout */
    .hf-type-headline.hf-variant-stamp .hf-agentic-copy { transform: rotate(-2.5deg); }
    .hf-type-headline.hf-variant-stamp .hf-agentic-title { display: inline-block; padding: 14px 32px; border: 6px solid var(--hf-primary); text-transform: uppercase; box-shadow: 0 0 0 4px color-mix(in srgb, var(--hf-bg), transparent 30%); }
    .hf-type-headline.hf-variant-typewriter .hf-agentic-title { font-family: var(--hf-mono-font, var(--hf-body-font)); letter-spacing: 0.02em; text-transform: none; }
    /* statCounter: standard(default)/ticker/ring — data-focus layout */
    .hf-type-stat-counter.hf-variant-ticker .hf-agentic-title { display: inline-block; padding: 10px 30px; border-radius: 14px; background: color-mix(in srgb, var(--hf-bg), transparent 8%); border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 40%); letter-spacing: 0.08em; font-variant-numeric: tabular-nums; }
    .hf-type-stat-counter.hf-variant-ring .hf-agentic-copy { width: 440px; height: 440px; place-content: center; justify-items: center; text-align: center; border-radius: 50%; border: 14px solid color-mix(in srgb, var(--hf-primary), transparent 12%); box-shadow: inset 0 0 0 10px color-mix(in srgb, var(--hf-bg), transparent 30%), 0 0 60px color-mix(in srgb, var(--hf-primary), transparent 60%); background: radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--hf-bg), transparent 10%), color-mix(in srgb, var(--hf-bg), transparent 40%)); }
    .hf-type-stat-counter.hf-variant-ring .hf-agentic-title { font-size: clamp(72px, 7vw, 132px); }
    /* kineticText glitch variant gets a chromatic shadow (other kinetic variants differ via entrance animation) */
    .hf-type-kinetic-text.hf-variant-glitch .hf-agentic-word { text-shadow: 3px 0 color-mix(in srgb, var(--hf-accent), transparent 20%), -3px 0 color-mix(in srgb, var(--hf-primary), transparent 20%); }
    .hf-agentic-layout-evidence-board .hf-agentic-stage { align-content: center; }
    .hf-agentic-layout-evidence-board .hf-agentic-copy { max-width: 1180px; }
    .hf-agentic-layout-evidence-board .hf-agentic-items { margin-top: 10px; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); }
    .hf-agentic-layout-data-focus .hf-agentic-stage { justify-items: center; text-align: center; }
    .hf-agentic-layout-data-focus .hf-agentic-rule { min-height: 8px; width: min(760px, 48vw); }
    .hf-agentic-layout-data-focus .hf-agentic-title { font-size: clamp(80px, 8vw, 154px); color: var(--hf-primary); }
    .hf-agentic-layout-split-panel .hf-agentic-stage { grid-template-columns: minmax(520px, 0.75fr) minmax(500px, 1fr); align-items: center; gap: 52px; }
    .hf-agentic-layout-split-panel .hf-agentic-rule { min-height: 420px; }
    .hf-agentic-layout-split-panel .hf-agentic-items { grid-template-columns: 1fr; }
    .hf-agentic-layout-map-explainer .hf-agentic-stage { align-content: end; padding-bottom: 82px; }
    .hf-agentic-layout-map-explainer .hf-agentic-copy { max-width: 1180px; padding: 24px 34px 28px 42px; background: color-mix(in srgb, var(--hf-bg), transparent 18%); border-left: 7px solid var(--hf-primary); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); backdrop-filter: blur(18px); }
    .hf-agentic-safe-bottom-right .hf-agentic-stage { justify-items: end; text-align: right; }
    .hf-agentic-safe-top-left .hf-agentic-stage { align-content: start; justify-items: start; }
    .hf-agentic-safe-top-right .hf-agentic-stage { align-content: start; justify-items: end; text-align: right; }
    .hf-agentic-safe-center-right .hf-agentic-stage { justify-items: end; text-align: right; }
    .hf-agentic-density-dense .hf-agentic-title, .hf-agentic-density-compact .hf-agentic-title { font-size: clamp(48px, 4.6vw, 82px); }
    .hf-agentic-density-dense .hf-agentic-subtitle, .hf-agentic-density-compact .hf-agentic-subtitle { font-size: 26px; }
    .hf-agentic-text-minimal .hf-agentic-kicker, .hf-agentic-text-minimal .hf-agentic-subtitle, .hf-agentic-text-keyword .hf-agentic-subtitle { display: none; }
    .hf-agentic-text-data .hf-agentic-title { color: var(--hf-primary); }
    .hf-agentic-emphasis-pulse .hf-agentic-title, .hf-agentic-emphasis-glow .hf-agentic-title { text-shadow: 0 0 26px color-mix(in srgb, var(--hf-primary), transparent 52%), 0 8px 38px rgba(0,0,0,0.46); }
    .hf-agentic-emphasis-urgent .hf-agentic-rule { box-shadow: 0 0 42px color-mix(in srgb, var(--hf-accent), transparent 36%); }
    .hf-agentic-emphasis-elegant .hf-agentic-copy { gap: 18px; }
    .hf-card-outline .hf-copy-shell, .hf-card-outline .hf-stat-card, .hf-card-outline .hf-item { background: transparent; border-color: color-mix(in srgb, var(--hf-primary), transparent 38%); box-shadow: none; backdrop-filter: none; }
    .hf-card-glass .hf-copy-shell, .hf-card-glass .hf-stat-card, .hf-card-glass .hf-item { background: color-mix(in srgb, var(--hf-bg), transparent 30%); border-color: rgba(255,255,255,0.18); box-shadow: var(--hf-shadow); backdrop-filter: blur(28px) saturate(1.18); }
    .hf-style-minimal { text-shadow: none; }
    .hf-style-minimal .hf-copy-shell, .hf-style-minimal .hf-template-stage, .hf-style-minimal .hf-grid-stage, .hf-style-minimal .hf-data-stage, .hf-style-minimal .hf-list-stage { background: color-mix(in srgb, var(--hf-bg), transparent 42%); box-shadow: none; }
    .hf-style-bold .hf-title, .hf-style-bold .hf-item-label, .hf-style-bold .hf-stat-value { text-transform: uppercase; }
    .hf-style-neon .hf-copy-shell, .hf-style-neon .hf-stat-card, .hf-style-neon .hf-item { box-shadow: 0 0 0 var(--hf-stroke) color-mix(in srgb, var(--hf-primary), transparent 32%), 0 0 42px color-mix(in srgb, var(--hf-primary), transparent 58%); }
    .hf-style-cinematic .hf-title { letter-spacing: 0; }
    .hf-style-cinematic .hf-template-shade, .hf-style-cinematic .hf-copy-shell { background: linear-gradient(90deg, rgba(2,6,23,0.82), rgba(2,6,23,0.32), rgba(2,6,23,0.06)); }
    .hf-style-elegant .hf-copy-shell, .hf-style-elegant .hf-template-stage { border-color: color-mix(in srgb, var(--hf-accent), transparent 35%); }
    .hf-type-lower-third { left: 126px; right: 126px; bottom: 92px; }
    .hf-type-lower-third .hf-copy-shell { border-left-color: var(--hf-accent); background: linear-gradient(90deg, var(--hf-bg), rgba(15,23,42,0.58), rgba(15,23,42,0.18)); }
    .hf-type-lower-third .hf-title { font-size: 72px; }
    .hf-type-lower-third.hf-variant-underline .hf-copy-shell { padding: 20px 0 18px; border-left: 0; border-bottom: 7px solid var(--hf-accent); border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; }
    .hf-type-lower-third.hf-variant-underline .hf-title { font-size: 68px; }
    .hf-type-lower-third.hf-variant-box { left: 116px; right: auto; width: 980px; }
    .hf-type-lower-third.hf-variant-box .hf-copy-shell { border: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 35%); }
    .hf-type-lower-third.hf-variant-banner { left: 0; right: 0; bottom: 78px; }
    .hf-type-lower-third.hf-variant-banner .hf-copy-shell { padding-left: 160px; border-radius: 0; border-left: 0; border-top: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 45%); background: linear-gradient(90deg, var(--hf-bg), color-mix(in srgb, var(--hf-bg), transparent 20%), transparent); }
    .hf-type-lower-third.hf-variant-glass .hf-copy-shell { background: color-mix(in srgb, var(--hf-bg), transparent 24%); border: var(--hf-stroke) solid rgba(255,255,255,0.18); backdrop-filter: blur(28px) saturate(1.18); }
    .hf-type-lower-third.hf-variant-split .hf-copy-shell { display: grid; grid-template-columns: 12px 1fr; gap: 30px; border-left: 0; background: linear-gradient(90deg, color-mix(in srgb, var(--hf-accent), transparent 12%), var(--hf-bg) 14%, transparent); }
    .hf-type-lower-third.hf-variant-split .hf-copy-shell:before { content: ""; width: 12px; height: 100%; min-height: 108px; background: linear-gradient(180deg, var(--hf-primary), var(--hf-accent)); border-radius: 999px; box-shadow: 0 0 30px color-mix(in srgb, var(--hf-accent), transparent 45%); }
    .hf-type-headline, .hf-type-focus-word, .hf-type-typewriter, .hf-type-stat-counter, .hf-type-kinetic-text { left: 160px; right: 160px; top: 50%; transform: translateY(-50%); text-align: center; }
    .hf-type-headline .hf-copy-shell, .hf-type-focus-word .hf-copy-shell { display: inline-block; min-width: 820px; max-width: 1520px; padding: 48px 70px 54px; border-left: 0; border-bottom: 8px solid var(--hf-primary); background: radial-gradient(circle at 50% 120%, color-mix(in srgb, var(--hf-primary), transparent 78%), transparent 52%), color-mix(in srgb, var(--hf-bg), transparent 18%); }
    .hf-stat-card { display: inline-grid; gap: 12px; padding: 42px 58px; background: var(--hf-bg); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 58%); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); }
    .hf-stat-value { font-family: var(--hf-heading-font); font-size: 120px; line-height: 0.92; font-weight: 950; color: var(--hf-primary); }
    .hf-stat-label { font-family: var(--hf-heading-font); font-size: 42px; font-weight: 850; color: var(--hf-text); }
    .hf-fullscreen { inset: 0; width: 100%; height: 100%; transform: none; }
    .hf-bg-media { position: absolute; inset: 0; opacity: 0; pointer-events: none; z-index: 30; transform-origin: center center; background: #020617; }
    .hf-template { display: grid; place-items: center; overflow: hidden; }
    .hf-template-fallback-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; background: linear-gradient(112deg, #07111f 0%, #0c1728 48%, #111827 100%); }
    .hf-template-fallback-field { position: absolute; inset: -12%; background-image: linear-gradient(rgba(148,163,184,0.13) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.11) 1px, transparent 1px), linear-gradient(115deg, transparent 0 38%, rgba(34,211,238,0.16) 38% 39%, transparent 39% 100%); background-size: 80px 80px, 80px 80px, 340px 340px; transform: rotate(-6deg) scale(1.08); opacity: 0.78; }
    .hf-template-fallback-lines { position: absolute; inset: 0; background: linear-gradient(90deg, transparent 0 9%, rgba(34,211,238,0.50) 9% 9.3%, transparent 9.3% 100%), linear-gradient(0deg, transparent 0 72%, rgba(139,92,246,0.34) 72% 72.4%, transparent 72.4% 100%); opacity: 0.76; }
    .hf-template-fallback-lines:before, .hf-template-fallback-lines:after { content: ""; position: absolute; left: 58%; top: 17%; width: 520px; height: 260px; border: 2px solid rgba(226,232,240,0.13); transform: skewX(-10deg); background: repeating-linear-gradient(0deg, rgba(226,232,240,0.08) 0 3px, transparent 3px 24px); }
    .hf-template-fallback-lines:after { left: 66%; top: 57%; width: 380px; height: 170px; opacity: 0.72; }
    .hf-template-fallback-label { position: absolute; right: 84px; bottom: 70px; max-width: 760px; color: rgba(226,232,240,0.13); font-family: var(--hf-heading-font); font-size: 54px; line-height: 0.96; font-weight: 950; text-transform: uppercase; text-align: right; }
    .hf-template-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(2,6,23,0.58), rgba(2,6,23,0.24), rgba(2,6,23,0.08)); z-index: 0; }
    .hf-has-bg .hf-template-shade { background: radial-gradient(circle at 70% 50%, rgba(2,6,23,0.04), rgba(2,6,23,0.36) 72%), linear-gradient(90deg, rgba(2,6,23,0.50), rgba(2,6,23,0.16), rgba(2,6,23,0.04)); }
    .hf-no-bg .hf-template-shade { background: radial-gradient(circle at 50% 42%, rgba(30,41,59,0.58), transparent 58%), linear-gradient(110deg, rgba(2,6,23,0.88), rgba(2,6,23,0.52)); }
    .hf-chapter-rule { position: absolute; left: 178px; top: 194px; bottom: 300px; width: 9px; background: linear-gradient(180deg, var(--hf-primary), var(--hf-accent)); box-shadow: 0 0 34px color-mix(in srgb, var(--hf-primary), transparent 55%); z-index: 1; }
    .hf-chapter-copy { position: absolute; left: 216px; top: 384px; z-index: 2; max-width: 1040px; }
    .hf-chapter-copy .hf-title { font-size: 92px; line-height: 0.98; }
    .hf-template.hf-variant-minimal .hf-template-shade { background: linear-gradient(90deg, rgba(2,6,23,0.34), rgba(2,6,23,0.06), transparent); }
    .hf-template.hf-variant-minimal .hf-chapter-rule { top: 236px; bottom: 318px; width: 7px; }
    .hf-template.hf-variant-minimal .hf-chapter-copy { top: 420px; max-width: 1180px; }
    .hf-template.hf-variant-minimal .hf-kicker { display: none; }
    .hf-template.hf-variant-cinematic .hf-template-shade { background: radial-gradient(circle at 68% 52%, transparent 0 38%, rgba(2,6,23,0.34) 74%), linear-gradient(90deg, rgba(2,6,23,0.78), rgba(2,6,23,0.26), rgba(2,6,23,0.02)); }
    .hf-template.hf-variant-cinematic .hf-chapter-copy .hf-title { font-size: 104px; max-width: 1280px; }
    .hf-template.hf-variant-cinematic .hf-chapter-rule { top: 170px; bottom: 250px; width: 11px; }
    .hf-template.hf-variant-standard .hf-chapter-copy { top: 382px; }
    .hf-template.hf-variant-overlay .hf-template-stage { align-content: end; padding-bottom: 120px; background: linear-gradient(0deg, rgba(2,6,23,0.76), rgba(2,6,23,0.12) 64%, transparent); }
    .hf-template.hf-variant-sidebar .hf-template-stage { width: 720px; right: auto; padding: 96px 72px; background: color-mix(in srgb, var(--hf-bg), transparent 6%); border-right: var(--hf-stroke) solid color-mix(in srgb, var(--hf-primary), transparent 45%); }
    .hf-template.hf-variant-splitpanel .hf-template-stage, .hf-template.hf-variant-sidebyside .hf-template-stage { grid-template-columns: minmax(520px, 0.72fr) 1fr; align-items: center; }
    .hf-template.hf-variant-numbered .hf-item-value { font-size: 52px; color: var(--hf-accent); }
    .hf-template.hf-variant-collage .hf-template-items { grid-template-columns: repeat(3, minmax(220px, 1fr)); transform: rotate(-1.2deg); }
    .hf-template.hf-variant-collage .hf-item:nth-child(even) { transform: rotate(1.4deg) translateY(18px); }
    .hf-template.hf-variant-stacked .hf-template-stage { align-content: center; justify-items: start; max-width: 1120px; }
    .hf-template.hf-variant-single .hf-template-items { display: none; }
    .hf-template-stage, .hf-grid-stage, .hf-data-stage, .hf-list-stage { position: absolute; inset: 0; z-index: 2; padding: 105px 120px; display: grid; align-content: center; gap: 28px; background: linear-gradient(120deg, rgba(2,6,23,0.54), rgba(2,6,23,0.08)); }
    .hf-has-bg .hf-template-stage, .hf-has-bg .hf-grid-stage, .hf-has-bg .hf-data-stage, .hf-has-bg .hf-list-stage { background: linear-gradient(90deg, rgba(2,6,23,0.46), rgba(2,6,23,0.12), rgba(2,6,23,0)); }
    .hf-transparent-bg .hf-template-shade, .hf-transparent-bg .hf-agentic-shade { display: none; }
    .hf-transparent-bg .hf-template-stage, .hf-transparent-bg .hf-grid-stage, .hf-transparent-bg .hf-data-stage, .hf-transparent-bg .hf-list-stage { background: transparent; }
    .hf-template.hf-transparent-bg.hf-variant-overlay .hf-template-stage, .hf-template.hf-transparent-bg.hf-variant-sidebar .hf-template-stage { background: transparent; border-color: transparent; }
    .hf-transparent-bg .hf-copy-shell, .hf-transparent-bg .hf-stat-card, .hf-transparent-bg .hf-item, .hf-transparent-bg .hf-agentic-copy, .hf-transparent-bg .hf-agentic-item { background: transparent; box-shadow: none; backdrop-filter: none; }
    .hf-template-items, .hf-listicle-grid-items, .hf-ranked-items, .hf-timeline-items { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; max-width: 1500px; }
    .hf-item { padding: 20px 24px; background: color-mix(in srgb, var(--hf-surface), transparent 16%); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 68%); border-radius: var(--hf-radius); box-shadow: 0 14px 40px rgba(0,0,0,0.24); }
    .hf-item-value { display: block; color: var(--hf-primary); font-family: var(--hf-heading-font); font-size: 34px; font-weight: 900; }
    .hf-item-label { display: block; margin-top: 8px; font-family: var(--hf-heading-font); font-size: 28px; font-weight: 800; }
    .hf-item-subtext { display: block; margin-top: 8px; color: var(--hf-muted); font-size: 20px; line-height: 1.25; }
    .hf-type-listicle-grid.hf-variant-strip .hf-listicle-grid-items { grid-template-columns: 1fr; max-width: 1200px; }
    .hf-type-listicle-grid.hf-variant-strip .hf-item { display: grid; grid-template-columns: 120px 1fr; align-items: center; }
    .hf-type-listicle-grid.hf-variant-stack .hf-listicle-grid-items { grid-template-columns: repeat(2, minmax(360px, 1fr)); }
    .hf-type-comparison-card.hf-variant-split .hf-comparison-wrap { grid-template-columns: 1fr 96px 1fr; background: linear-gradient(90deg, color-mix(in srgb, var(--hf-primary), transparent 84%), rgba(2,6,23,0.72), color-mix(in srgb, var(--hf-accent), transparent 84%)); }
    .hf-type-comparison-card.hf-variant-stacked .hf-comparison-wrap { grid-template-columns: 1fr; gap: 18px; }
    .hf-type-comparison-card.hf-variant-stacked .hf-compare-vs { justify-self: center; width: 86px; height: 86px; }
    .hf-type-progress-tracker.hf-variant-dots .hf-progress-rail { display: flex; height: 24px; gap: 16px; background: transparent; overflow: visible; }
    .hf-type-progress-tracker.hf-variant-dots .hf-progress-rail:before { content: ""; display: block; width: 24px; height: 24px; border-radius: 50%; background: var(--hf-primary); box-shadow: 54px 0 0 color-mix(in srgb, var(--hf-primary), transparent 18%), 108px 0 0 color-mix(in srgb, var(--hf-primary), transparent 36%), 162px 0 0 color-mix(in srgb, var(--hf-primary), transparent 54%); }
    .hf-type-progress-tracker.hf-variant-fraction .hf-progress-rail { height: 6px; }
    .hf-type-map-chart { overflow: hidden; background: #05080f; }
    .hf-map-world { position: absolute; top: 0; left: 0; will-change: transform; transform-origin: 0 0; z-index: 0; }
    .hf-map-base { width: 100%; height: 100%; display: block; }
    .hf-map-svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; }
    .hf-map-image { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #07111f; z-index: 0; }
    .hf-map-vignette { position: absolute; inset: 0; background: radial-gradient(circle at 50% 50%, transparent 36%, rgba(2,6,23,0.44) 100%); z-index: 1; }
    .hf-map-labels { position: absolute; left: 104px; top: 84px; display: flex; flex-wrap: wrap; gap: 14px; z-index: 2; }
    .hf-map-labels span { padding: 10px 16px; background: var(--hf-bg); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 45%); color: var(--hf-text); font-weight: 850; font-size: 24px; }
    .hf-map-caption { position: absolute; left: 104px; right: 104px; bottom: 86px; z-index: 3; padding: 26px 34px; background: var(--hf-bg); border-left: 8px solid var(--hf-primary); }
    .hf-map-caption .hf-title { font-size: 58px; }
    .hf-map-backup { position: absolute; inset: 0; z-index: 0; opacity: 1; pointer-events: none; transition: opacity 0.16s linear; }
    .hf-bg-loaded .hf-map-backup { opacity: 0; }
    .hf-bg-error .hf-map-backup { opacity: 1; }
    .hf-fallback-map { position: absolute; inset: 0; background: radial-gradient(circle at 50% 50%, rgba(34,211,238,0.24), transparent 56%), #07111f; overflow: hidden; }
    .hf-map-grid { position: absolute; inset: -20%; background-image: linear-gradient(rgba(148,163,184,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.14) 1px, transparent 1px); background-size: 72px 72px; transform: rotate(-8deg); }
    .hf-map-route { position: absolute; left: 12%; right: 12%; top: 50%; height: 7px; background: linear-gradient(90deg, transparent, #22d3ee, #8b5cf6, transparent); box-shadow: 0 0 40px rgba(34,211,238,0.45); }
    .hf-map-fallback-labels { position: absolute; left: 120px; bottom: 120px; display: flex; gap: 14px; flex-wrap: wrap; }
    .hf-map-fallback-labels span { padding: 12px 18px; background: rgba(15,23,42,0.74); border: 1px solid rgba(255,255,255,0.14); font-size: 26px; font-weight: 850; }
    .hf-country-map { position: absolute; inset: 0; width: 100%; height: 100%; background: radial-gradient(circle at 50% 48%, rgba(56,189,248,0.16), transparent 60%), #07111f; z-index: 0; }
    .hf-map-water { fill: #07111f; }
    .hf-country-fill { fill: rgba(20,184,166,0.30); stroke: none; transform-box: fill-box; transform-origin: center; }
    .hf-country-line { fill: none; stroke: rgba(226,232,240,0.66); stroke-width: 2.2; vector-effect: non-scaling-stroke; }
    .hf-country-route { fill: none; stroke: var(--hf-primary); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 900; stroke-dashoffset: 900; filter: drop-shadow(0 0 16px color-mix(in srgb, var(--hf-primary), transparent 42%)); }
    .hf-country-pin circle { fill: #ef4444; stroke: #fff; stroke-width: 3; filter: drop-shadow(0 0 14px rgba(239,68,68,0.66)); }
    .hf-country-pin text { fill: #f8fafc; font-size: 30px; font-weight: 900; paint-order: stroke; stroke: rgba(2,6,23,0.88); stroke-width: 7px; stroke-linejoin: round; text-transform: uppercase; }
    .hf-comparison-wrap { position: absolute; inset: 0; display: grid; grid-template-columns: 1fr 130px 1fr; align-items: center; gap: 24px; padding: 120px; background: linear-gradient(90deg, rgba(2,6,23,0.88), rgba(15,23,42,0.45)); }
    .hf-compare-side { min-height: 360px; display: grid; place-items: center; padding: 38px; font-size: 58px; font-weight: 900; background: rgba(15,23,42,0.72); border: 1px solid rgba(255,255,255,0.16); text-align: center; }
    .hf-compare-vs { display: grid; place-items: center; width: 118px; height: 118px; border-radius: 50%; background: linear-gradient(135deg, var(--hf-primary), var(--hf-accent)); font-size: 38px; font-weight: 950; }
    .hf-comparison-note { position: absolute; left: 120px; right: 120px; bottom: 86px; font-size: 30px; line-height: 1.2; color: #e2e8f0; }
    .hf-typewriter-line, .hf-kinetic-line { display: flex; justify-content: center; flex-wrap: wrap; gap: 18px; font-size: 92px; line-height: 0.92; font-weight: 950; text-align: center; text-transform: uppercase; }
    .hf-typewriter-line span, .hf-kinetic-line span { display: inline-block; }
    .hf-progress-shell { max-width: 1180px; padding: 28px 34px; background: var(--hf-bg); border-left: 8px solid var(--hf-primary); }
    .hf-progress-rail { margin-top: 26px; height: 18px; overflow: hidden; background: rgba(148,163,184,0.22); }
    .hf-progress-rail span { display: block; width: var(--pct); height: 100%; background: linear-gradient(90deg, var(--hf-primary), var(--hf-accent)); transform-origin: left center; }
    .hf-listicle-counter-badge { display: inline-grid; grid-template-columns: 118px 1fr; gap: 24px; align-items: center; max-width: 1080px; padding: 26px 34px; background: var(--hf-bg); border: 1px solid color-mix(in srgb, var(--hf-primary), transparent 58%); border-radius: var(--hf-radius); box-shadow: var(--hf-shadow); }
    .hf-listicle-counter-badge span { display: grid; place-items: center; width: 100px; height: 100px; background: linear-gradient(135deg, var(--hf-primary), var(--hf-accent)); font-size: 50px; font-weight: 950; }
    .hf-type-listicle-counter.hf-variant-pill .hf-listicle-counter-badge { border-radius: 999px; }
    .hf-type-listicle-counter.hf-variant-ribbon .hf-listicle-counter-badge { border-radius: 0; border-left: 12px solid var(--hf-accent); }
    .hf-type-listicle-counter.hf-variant-minimal .hf-listicle-counter-badge { background: transparent; box-shadow: none; border: 0; }
    .pos-top, .pos-top-left, .pos-top-right { top: 88px; bottom: auto; }
    .pos-center { top: 50%; bottom: auto; transform: translateY(-50%); }
    .pos-bottom, .pos-bottom-left, .pos-bottom-right { bottom: 95px; }
    .pos-top-left, .pos-bottom-left { left: 126px; right: auto; width: 1460px; }
    .pos-top-right, .pos-bottom-right { left: auto; right: 126px; width: 1180px; }
    .hf-fullscreen.pos-top, .hf-fullscreen.pos-top-left, .hf-fullscreen.pos-top-right, .hf-fullscreen.pos-center, .hf-fullscreen.pos-center-left, .hf-fullscreen.pos-center-right, .hf-fullscreen.pos-bottom, .hf-fullscreen.pos-bottom-left, .hf-fullscreen.pos-bottom-right { inset: 0; width: 100%; height: 100%; transform: none; }
    /* Authored overlays are designed on the full 1920x1080 canvas (the comp
       anchors itself in its position zone) — break out of the pos-* boxes.
       transform locked: their container enter is opacity-only by design. */
    .hf-mg[data-hf-authored-overlay] { inset: 0 !important; width: 100% !important; height: 100% !important; transform: none !important; }
    /* Explainer icons (icon-director): small word-synced visuals over footage */
    .hf-scene-icon { position: absolute; width: 260px; height: 260px; display: flex; align-items: center; justify-content: center; opacity: 0; visibility: hidden; z-index: 6; pointer-events: none; filter: drop-shadow(0 16px 32px rgba(0,0,0,0.55)); }
    .hf-scene-icon img { max-width: 100%; max-height: 100%; object-fit: contain; }
    .hf-scene-icon svg { width: 84%; height: 84%; }
    /* framed image kind: the whole photograph as a small picture card */
    .hf-scene-icon-framed { width: 400px; height: 270px; transform: rotate(-1.6deg); }
    .hf-scene-icon-framed img { width: 100%; height: 100%; object-fit: cover; border-radius: 10px; border: 4px solid rgba(255,255,255,0.92); box-shadow: 0 22px 48px rgba(0,0,0,0.5); }
    /* Talking-head corner PiP: presenter card over B-roll. opacity/visibility hidden = frame-0 safe (revealed by iconAnims). */
    .hf-presenter-pip { position: absolute; width: 30%; aspect-ratio: 16 / 9; opacity: 0; visibility: hidden; z-index: 8; pointer-events: none; border-radius: 14px; overflow: hidden; border: 3px solid rgba(255,255,255,0.9); box-shadow: 0 18px 50px rgba(0,0,0,0.55); }
    .hf-presenter-pip img, .hf-presenter-pip video { width: 100%; height: 100%; object-fit: cover; }
    /* Talking-head SPLIT SCREEN: presenter half + B-roll half (static, frame-0 safe). */
    .hf-scene-frame.hf-scene-split { display: flex; flex-direction: row; }
    .hf-scene-frame.hf-scene-split.is-right { flex-direction: row-reverse; }
    .hf-split-panel { position: relative; width: 50%; height: 100%; overflow: hidden; background: #0a0d13; }
    .hf-split-panel > img, .hf-split-panel > video { width: 100%; height: 100%; object-fit: cover; }
    .hf-split-presenter { box-shadow: 0 0 40px rgba(0,0,0,0.5); z-index: 1; }
    /* Talking-head PRESENTER STAGE: host card on one side + explanation slot (sliding images) on the other. */
    .hf-scene-frame.hf-pstage { background: radial-gradient(130% 110% at 28% 18%, #1b2231, #0a0d13); }
    .hf-pstage .hf-pstage-hostcard { position: absolute; top: 12%; width: 40%; height: 76%; border-radius: 18px; overflow: hidden; box-shadow: 0 26px 70px rgba(0,0,0,0.6); }
    .hf-pstage.is-host-left .hf-pstage-hostcard { left: 5%; }
    .hf-pstage.is-host-right .hf-pstage-hostcard { right: 5%; }
    .hf-pstage .hf-pstage-hostcard > img, .hf-pstage .hf-pstage-hostcard > video { width: 100%; height: 100%; object-fit: cover; }
    .hf-pstage .hf-pstage-slot { position: absolute; top: 16%; width: 46%; height: 68%; }
    .hf-pstage.is-host-left .hf-pstage-slot { right: 4%; }
    .hf-pstage.is-host-right .hf-pstage-slot { left: 4%; }
    .hf-pexplain { position: absolute; inset: 0; opacity: 0; visibility: hidden; border-radius: 14px; overflow: hidden; border: 3px solid rgba(255,255,255,0.92); box-shadow: 0 18px 50px rgba(0,0,0,0.55); background: #0a0d13; }
    .hf-pexplain > img { width: 100%; height: 100%; object-fit: cover; }
    .hf-pexplain-svg { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
    .hf-pexplain-svg svg { width: 70%; height: 70%; }
    /* Keyword glow (#18): word-synced emphasis phrase. opacity/visibility default hidden = frame-0 safe. */
    .hf-kw-glow { position: absolute; opacity: 0; visibility: hidden; z-index: 7; pointer-events: none; font-family: var(--hf-heading-font, Inter, sans-serif); font-weight: 900; font-size: 64px; letter-spacing: -0.01em; text-transform: uppercase; white-space: nowrap; }
    .hf-kw-glow .hf-kw-glow-fill { position: relative; z-index: 2; color: #ffffff; text-shadow: 0 3px 22px rgba(0,0,0,0.8); }
    .hf-kw-glow .hf-kw-glow-layer { position: absolute; left: 0; top: 0; z-index: 1; color: currentColor; opacity: 0; text-shadow: 0 0 18px currentColor, 0 0 40px currentColor; }
    .hf-kw-pos-lower-center { left: 50%; bottom: 190px; transform: translateX(-50%); text-align: center; }
    .hf-kw-pos-upper-center { left: 50%; top: 150px; transform: translateX(-50%); text-align: center; }
    .hf-kw-pos-lower-left { left: 90px; bottom: 200px; }
    .hf-kw-pos-lower-right { right: 90px; bottom: 200px; text-align: right; }
    .hf-icon-pos-top-left { left: 110px; top: 110px; }
    .hf-icon-pos-top-right { right: 110px; top: 110px; }
    .hf-icon-pos-bottom-left { left: 110px; bottom: 150px; }
    .hf-icon-pos-bottom-right { right: 110px; bottom: 150px; }
    .hf-icon-pos-center-left { left: 110px; top: 50%; margin-top: -130px; }
    .hf-icon-pos-center-right { right: 110px; top: 50%; margin-top: -130px; }
    .hf-transition { position: absolute; inset: 0; overflow: hidden; pointer-events: none; opacity: 0; z-index: 80; }
    .hf-transition-slab, .hf-transition-flare { position: absolute; inset: 0; pointer-events: none; }
    .hf-transition-flare { background: radial-gradient(circle at 50% 50%, rgba(255,255,255,0.45), transparent 48%); opacity: 0; mix-blend-mode: screen; }
    .hf-transition-wipe-left .hf-transition-slab, .hf-transition-push-left .hf-transition-slab { background: linear-gradient(90deg, rgba(2,6,23,0), rgba(56,189,248,0.72), rgba(2,6,23,0)); transform: translateX(-110%); }
    .hf-transition-zoom-blur .hf-transition-slab { background: radial-gradient(circle, rgba(255,255,255,0.24), rgba(15,23,42,0.68)); transform: scale(0.86); }
    .hf-transition-light-leak .hf-transition-slab { background: linear-gradient(105deg, rgba(255,110,20,0), rgba(255,150,40,0.82), rgba(255,90,10,0.5), rgba(255,190,70,0.9), rgba(255,110,20,0)); transform: translateX(-120%); mix-blend-mode: screen; filter: saturate(1.25); }
    .hf-transition-glitch .hf-transition-slab { background: repeating-linear-gradient(0deg, rgba(255,255,255,0.16) 0 2px, transparent 2px 8px), linear-gradient(90deg, rgba(239,68,68,0.18), rgba(34,211,238,0.18)); }
    .hf-transition-luma-fade .hf-transition-slab, .hf-transition-dip-black .hf-transition-slab, .hf-transition-crossfade .hf-transition-slab { background: rgba(2,6,23,0.92); }
    .hf-transition-flash-white .hf-transition-slab { background: rgba(255,255,255,0.96); }
    /* Amped light-sweep: hotter orange/amber glow (blue tail dropped), brighter core — reads as a warm fire-glow flare. */
    .hf-transition-light-sweep .hf-transition-slab { background: linear-gradient(105deg, rgba(255,110,20,0), rgba(255,150,40,0.82), rgba(255,90,10,0.5), rgba(255,190,70,0.9), rgba(255,110,20,0)); transform: translateX(-120%); mix-blend-mode: screen; filter: saturate(1.25); }
    .hf-transition-light-sweep .hf-transition-flare { background: radial-gradient(circle at 50% 50%, rgba(255,190,90,0.55), rgba(255,120,30,0.25) 34%, transparent 58%); }
    /* Fire burn: hot flame band (deep red → orange → yellow core) sweeps across, screen-blended; the flare becomes a warm ember-glow core. */
    .hf-transition-fire-burn .hf-transition-slab { background: linear-gradient(100deg, rgba(60,6,0,0) 20%, rgba(190,40,0,0.78) 40%, rgba(255,110,20,0.97) 50%, rgba(255,210,90,0.92) 60%, rgba(120,20,0,0) 80%); transform: translateX(-120%); mix-blend-mode: screen; filter: saturate(1.4) contrast(1.1); }
    .hf-transition-fire-burn .hf-transition-flare { background: radial-gradient(circle at 50% 58%, rgba(255,160,50,0.6), rgba(255,80,10,0.28) 32%, transparent 58%); }
    /* Anamorphic lens flare: a bright vertical light core streaks across; the flare is a thin horizontal blue-white streak flashing through the middle. */
    .hf-transition-lens-flare .hf-transition-slab { background: radial-gradient(ellipse 11% 92% at 50% 50%, rgba(255,255,255,0.98), rgba(150,200,255,0.5) 42%, transparent 70%); transform: translateX(-130%); mix-blend-mode: screen; }
    .hf-transition-lens-flare .hf-transition-flare { background: linear-gradient(0deg, transparent 47%, rgba(120,180,255,0.5) 49%, rgba(255,255,255,0.96) 50%, rgba(120,180,255,0.5) 51%, transparent 53%); mix-blend-mode: screen; }
    .hf-caption { position: absolute; left: 7%; right: 7%; bottom: 92px; display: flex; justify-content: center; align-items: flex-end; text-align: center; opacity: 0; z-index: 60; pointer-events: none; }
    .hf-caption-text { display: inline-block; padding: 10px 28px 12px; background: rgba(4,8,16,0.64); border-radius: 14px; color: #ffffff; font-family: Inter, 'Segoe UI', Arial, sans-serif; font-weight: 800; font-size: 46px; line-height: 1.22; letter-spacing: -0.01em; text-shadow: 0 2px 16px rgba(0,0,0,0.7); max-width: 1560px; }
    /* Karaoke word spans (KARAOKE_CAPTIONS opt-in; inert when captions are single-span). Active word lit by the timeline. */
    .hf-cap-word { display: inline; opacity: 0.5; }
  </style>
</head>
<body>
  <div id="yta-hyperframes" data-composition-id="yta-hyperframes" data-width="1920" data-height="1080" data-start="0" data-duration="${totalDuration.toFixed(3)}">
${sceneTags.join('\n')}
${transitionTags.join('\n')}
${graphicTags.join('\n')}
${captionTags.join('\n')}
${audioTags.join('\n')}
  </div>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    const timing = ${timelineData};
    const tl = gsap.timeline({ paused: true });

    for (const item of timing.sceneAnims) {
      const sel = '#' + CSS.escape(item.id);
      // True crossfade between back-to-back scenes: fade IN over the first 0.2s, and
      // fade OUT STARTING AT the scene's end (overlapping the next scene's fade-in)
      // — NOT before the end. The old code faded out over the last 0.14s while the
      // next faded in over its first 0.12s with no overlap, so at every cut both were
      // ~0 opacity for an instant = a black flash between clips.
      // ── Opacity ownership (transition smoothness) ──
      // IN: a HARD-motion incoming (push/wipe/whip/zoom/spin) arrives FULLY
      // OPAQUE — the geometric move is the transition, so no see-through slide.
      // The 1ms fromTo (not a bare set) guarantees opacity 0 for every frame
      // before the boundary (frame-0 / pre-boundary safe). Everything else keeps
      // the soft 0.2s fade-in.
      if (item._motionIn) {
        // Appear EXACTLY when the incoming video becomes active (its window start),
        // never before — an opaque container over a not-yet-seeked (black) video
        // paints a 1-frame black flash at the leading edge of the move.
        hfFromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.001, ease: 'none' }, item.start);
      } else {
        hfFromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'power1.out' }, item.start);
      }
      // OUT: hold the outgoing footage opaque BENEATH the incoming move/dissolve,
      // then hard-cut once it is fully covered — constant luminance, no premature
      // fade during a slide/wipe/zoom, no dark "breath" at plain cuts.
      if (item._motionOut) {
        hfSet(sel, { opacity: 0 }, (item._motionOutSnapAt != null ? item._motionOutSnapAt : item.start + item.duration));
      } else if (item._coveredOut) {
        hfSet(sel, { opacity: 0 }, item.start + item.duration + 0.24);
      } else if (item.duration > 0.4) {
        // gap before the next scene, or the final scene → keep the graceful fade
        hfTo(sel, { opacity: 0, duration: 0.24, ease: 'power1.inOut' }, item.start + item.duration);
      }
      // Ken Burns (slow zoom/drift) on still-image scenes so they don't sit dead.
      if (item.kenBurns) {
        const kb = item.kenBurns;
        hfFromTo(sel + ' .hf-scene-media',
          { scale: kb.fromScale, xPercent: kb.fromX, yPercent: kb.fromY || 0 },
          { scale: kb.toScale, xPercent: kb.toX, yPercent: kb.toY || 0, duration: item.duration, ease: 'none' },
          item.start);
      }
      // Subject-follow pan (#16): gently ease the cover-crop object-position from→to
      // so a moving subject stays framed. Static "from" is already set inline (frame-0
      // safe); this animates on the master timeline (separate channel from Ken Burns).
      if (item.focusPan) {
        const fp = item.focusPan;
        hfFromTo(sel + ' .hf-scene-media',
          { objectPosition: (fp.fromX * 100).toFixed(1) + '% ' + (fp.fromY * 100).toFixed(1) + '%' },
          { objectPosition: (fp.toX * 100).toFixed(1) + '% ' + (fp.toY * 100).toFixed(1) + '%', duration: item.duration, ease: 'sine.inOut' },
          item.start);
      }
    }

    for (const item of (timing.captionAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      hfFromTo(sel, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out' }, item.start);
      if (item.duration > 0.3) hfTo(sel, { opacity: 0, duration: 0.14, ease: 'power1.in' }, item.start + item.duration - 0.1);
      // Karaoke: dim all words, then light each one at its absolute start time.
      // Timeline-driven so it seeks correctly under frame capture. Only runs when
      // the cue carries per-word timings (KARAOKE_CAPTIONS opt-in).
      if (Array.isArray(item.words) && item.words.length) {
        for (let i = 0; i < item.words.length; i++) {
          const wsel = sel + '-w' + i;
          if (!hfHas(wsel)) continue;
          hfSet(wsel, { opacity: 0.5 }, item.start);
          hfTo(wsel, { opacity: 1, duration: 0.12, ease: 'power1.out' }, Math.max(item.start, Number(item.words[i].t) || item.start));
        }
      }
    }

    // ── Explainer icons (icon-director): pop in on the trigger word, float
    // gently while alive, exit before the moment ends ──
    for (const item of (timing.iconAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      if (!hfHas(sel)) continue;
      hfSet(sel, { visibility: 'visible' }, Math.max(0, item.start - 0.01));
      hfFromTo(sel, { opacity: 0, scale: 0.45, y: 22 }, { opacity: 1, scale: 1, y: 0, duration: 0.5, ease: 'back.out(2.2)' }, item.start);
      const floatDur = Math.max(0.6, (item.duration - 0.95) / 2);
      hfTo(sel, { y: -8, duration: floatDur, ease: 'sine.inOut', yoyo: true, repeat: 1 }, item.start + 0.55);
      hfTo(sel, { opacity: 0, scale: 0.82, y: -16, duration: 0.3, ease: 'power2.in' }, item.start + item.duration - 0.3);
      hfSet(sel, { visibility: 'hidden' }, item.start + item.duration + 0.02);
    }

    // ── Talking-head presenter-stage explanation images: slide in from the outer edge,
    // hold beside the host, slide back out. Seek-safe GSAP (no CSS animation). ──
    for (const item of (timing.explainAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      if (!hfHas(sel)) continue;
      const dx = item.from === 'left' ? -70 : 70; // slide in from that side (% of its own box)
      hfSet(sel, { visibility: 'visible' }, Math.max(0, item.start - 0.01));
      hfFromTo(sel, { opacity: 0, xPercent: dx }, { opacity: 1, xPercent: 0, duration: 0.5, ease: 'power3.out' }, item.start);
      hfTo(sel, { opacity: 0, xPercent: dx * 0.5, duration: 0.35, ease: 'power2.in' }, item.start + item.duration - 0.35);
      hfSet(sel, { visibility: 'hidden' }, item.start + item.duration + 0.02);
    }

    // ── Keyword glow (#18): pop the phrase in on the trigger word, hold with a
    // glow, exit. Seek-safe (no onUpdate/random). Absent unless HF_KEYWORD_GLOW. ──
    for (const item of (timing.glowAnims || [])) {
      const sel = '#' + CSS.escape(item.id);
      if (!hfHas(sel)) continue;
      const layer = sel + ' .hf-kw-glow-layer';
      hfSet(sel, { visibility: 'visible' }, Math.max(0, item.start - 0.01));
      hfFromTo(sel, { opacity: 0, scale: 0.86, y: 10 }, { opacity: 1, scale: 1.06, y: 0, duration: 0.18, ease: 'back.out(2.4)' }, item.start);
      hfSet(layer, { opacity: 0 }, item.start);
      hfTo(layer, { opacity: 0.95, duration: 0.18, ease: 'power2.out' }, item.start);
      const sustain = Math.max(0.3, item.duration - 0.45);
      hfTo(sel, { scale: 1.0, duration: sustain, ease: 'sine.inOut' }, item.start + 0.18);
      hfTo(sel, { opacity: 0, scale: 0.94, duration: 0.27, ease: 'power2.in' }, item.start + item.duration - 0.27);
      hfTo(layer, { opacity: 0, duration: 0.27, ease: 'power2.in' }, item.start + item.duration - 0.27);
      hfSet(sel, { visibility: 'hidden' }, item.start + item.duration + 0.02);
    }

    function hfAnimName(item) {
      return String(item.animation || 'fadeSlide').replace(/[^a-z0-9]/gi, '').toLowerCase();
    }
    function hfSpeed(item) {
      const raw = item.speed == null ? 1 : item.speed;
      const speed = Number(raw);
      if (Number.isFinite(speed)) return Math.max(0.25, Math.min(3, speed));
      const text = String(raw || 'normal').toLowerCase();
      if (text.includes('very-slow')) return 0.55;
      if (text.includes('slow') || text.includes('calm') || text.includes('gentle')) return 0.75;
      if (text.includes('rapid') || text.includes('snappy')) return 1.6;
      if (text.includes('fast') || text.includes('quick') || text.includes('energetic')) return 1.35;
      return 1;
    }
    function hfStagger(item, fallback) {
      const raw = Number(item.motionStagger);
      const base = Number.isFinite(raw) ? raw : fallback;
      return Math.max(0.01, Math.min(0.22, base)) / hfSpeed(item);
    }
    function hfDuration(base, item, min = 0.08, max = 1.6) {
      return Math.max(min, Math.min(max, base / hfSpeed(item)));
    }
    function hfEnterState(item) {
      const anim = hfAnimName(item);
      if (anim.includes('wipe')) return { opacity: 1, clipPath: 'inset(0 100% 0 0)' };
      if (anim.includes('flip')) return { opacity: 0, rotateX: -48, y: 24, transformPerspective: 900, transformOrigin: 'center center' };
      if (anim.includes('scatter')) return { opacity: 0, y: -70, scale: 1.08, rotate: -2 };
      if (anim.includes('spring') || anim.includes('pop')) return { opacity: 0, y: 16, scale: 0.82 };
      if (anim.includes('right') && !anim.includes('opposite')) return { opacity: 0, x: 76, scale: 0.99 };
      if (anim.includes('left') || anim.includes('opposite')) return { opacity: 0, x: -76, scale: 0.99 };
      if (anim.includes('up')) return { opacity: 0, y: 72, scale: 0.99 };
      if (anim.includes('scale')) return { opacity: 0, scale: 0.9 };
      if ((item.type || '') === 'map-chart') return { opacity: 0, scale: 1.025 };
      // Stage visuals (templates / fullscreen graphics): cinematic takeover —
      // the composition scales in over the still-visible footage. No overlay,
      // no dip, no box: the template itself IS the transition.
      if (item.kind === 'fullscreen' || item.kind === 'template') return { opacity: 0, scale: 0.94, y: 14 };
      return { opacity: 0, y: 38, scale: 0.985 };
    }
    function hfShowState(item) {
      const anim = hfAnimName(item);
      const isTemplate = item.kind === 'template';
      const duration = hfDuration(isTemplate ? 0.38 : 0.46, item, 0.12, 1.1);
      const show = { opacity: 1, x: 0, y: 0, rotate: 0, rotateX: 0, scale: 1, clipPath: 'inset(0 0% 0 0)', duration, ease: 'power3.out' };
      if (anim.includes('spring') || anim.includes('pop')) show.ease = 'back.out(1.65)';
      if (anim.includes('flip')) show.ease = 'back.out(1.25)';
      if (anim.includes('wipe')) show.ease = 'power2.inOut';
      if ((item.kind === 'fullscreen' || item.kind === 'template') && !anim.includes('wipe') && !anim.includes('flip')) {
        Object.assign(show, { duration: hfDuration(0.55, item, 0.2, 1.1), ease: 'power3.out' });
      }
      if ((item.type || '') === 'map-chart') Object.assign(show, { duration: hfDuration(0.58, item, 0.18, 1.2), ease: 'power2.out' });
      return show;
    }
    function hfExitState(item) {
      const anim = hfAnimName(item);
      if (anim.includes('wipe')) return { opacity: 1, clipPath: 'inset(0 0 0 100%)', duration: hfDuration(0.28, item), ease: 'power2.in' };
      if (anim.includes('left') || anim.includes('opposite')) return { opacity: 0, x: -34, duration: hfDuration(0.28, item), ease: 'power2.in' };
      if (anim.includes('right')) return { opacity: 0, x: 34, duration: hfDuration(0.28, item), ease: 'power2.in' };
      // Stage visuals exit by growing slightly past the camera while fading —
      // the inverse of the scale-in takeover, hands the frame back smoothly.
      if (item.kind === 'fullscreen' || item.kind === 'template') return { opacity: 0, scale: 1.035, duration: hfDuration(0.34, item), ease: 'power2.in' };
      return { opacity: 0, y: item.kind === 'template' ? -12 : -22, scale: 0.995, duration: hfDuration(0.28, item), ease: 'power2.in' };
    }
    function hfChildEnterState(item) {
      const anim = hfAnimName(item);
      if (anim.includes('scatter')) return { opacity: 0, y: -48, scale: 1.08, rotate: -4 };
      if (anim.includes('cascade')) return { opacity: 0, y: 34, scale: 0.98 };
      if (anim.includes('flip')) return { opacity: 0, rotateY: -38, transformPerspective: 800 };
      if (anim.includes('opposite')) return { opacity: 0, x: 44 };
      return { opacity: 0, y: 28, scale: 0.985 };
    }
    function hfChildShowState(item) {
      const anim = hfAnimName(item);
      return {
        opacity: 1,
        x: 0,
        y: 0,
        rotate: 0,
        rotateY: 0,
        scale: 1,
        duration: hfDuration(0.34, item, 0.1, 0.8),
        stagger: hfStagger(item, anim.includes('cascade') ? 0.085 : 0.055),
        ease: anim.includes('spring') || anim.includes('scatter') ? 'back.out(1.4)' : 'power3.out'
      };
    }
    // Per-variant kinetic typography — each kineticText subType gets its OWN
    // signature word motion, the way a human motion designer would author it,
    // instead of every variant sharing one generic stagger. Keyed off the
    // variant (mg.subType) first, then the animation name as fallback.
    function hfKineticMotion(item) {
      const v = String(item.variant || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      const a = hfAnimName(item);
      const key = (v && v !== 'standard') ? v : a;
      const sp = hfSpeed(item);
      const d = (base) => hfDuration(base, item, 0.12, 1.0);
      const stg = (each, from) => ({ each: Math.max(0.012, each / sp), from: from || 'start' });
      if (/rise|slideup|^up$|up$/.test(key))
        return { from: { opacity: 0, y: 96, scale: 0.97 }, to: { opacity: 1, y: 0, scale: 1, duration: d(0.52), ease: 'back.out(1.9)', stagger: stg(0.06) } };
      if (/cascade/.test(key))
        return { from: { opacity: 0, y: -56, scale: 0.98, rotate: -2 }, to: { opacity: 1, y: 0, scale: 1, rotate: 0, duration: d(0.46), ease: 'power2.out', stagger: stg(0.09, 'start') } };
      if (/punch/.test(key))
        return { from: { opacity: 0, scale: 1.75 }, to: { opacity: 1, scale: 1, duration: d(0.32), ease: 'power4.out', stagger: stg(0.045) } };
      if (/stamp/.test(key))
        return { from: { opacity: 0, scale: 1.9, rotate: -4, y: -14 }, to: { opacity: 1, scale: 1, rotate: 0, y: 0, duration: d(0.4), ease: 'back.out(2.6)', stagger: stg(0.08) } };
      if (/glitch/.test(key))
        return { from: { opacity: 0, x: -10, skewX: 10 }, to: { opacity: 1, x: 0, skewX: 0, duration: d(0.16), ease: 'steps(3)', stagger: stg(0.05) } };
      if (/wave/.test(key))
        return { from: { opacity: 0, y: 56 }, to: { opacity: 1, y: 0, duration: d(0.5), ease: 'sine.out', stagger: stg(0.085) } };
      if (/pop|spring|scatter/.test(key))
        return { from: { opacity: 0, scale: 0.18 }, to: { opacity: 1, scale: 1, duration: d(0.44), ease: 'back.out(3)', stagger: stg(0.05) } };
      // centered / fade / default — calm elegant rise
      return { from: { opacity: 0, y: 34, scale: 0.96 }, to: { opacity: 1, y: 0, scale: 1, duration: d(0.44), ease: 'power3.out', stagger: stg(0.05) } };
    }
    function hfHas(selector) {
      try { return !!selector && document.querySelectorAll(selector).length > 0; } catch (e) { return false; }
    }
    function hfFromTo(selector, fromVars, toVars, at) {
      if (hfHas(selector)) tl.fromTo(selector, fromVars, toVars, at);
    }
    function hfTo(selector, vars, at) {
      if (hfHas(selector)) tl.to(selector, vars, at);
    }
    function hfSet(selector, vars, at) {
      if (hfHas(selector)) tl.set(selector, vars, at);
    }

    for (const item of timing.graphicAnims) {
      const sel = '#' + CSS.escape(item.id);
      const bgSel = '#' + CSS.escape(item.id + '-bg');
      const isTemplate = item.kind === 'template';
      if (hfHas(bgSel)) {
        hfSet(bgSel, { visibility: 'visible', pointerEvents: 'none' }, Math.max(0, item.start - (isTemplate ? 0.08 : 0.01)));
        if (isTemplate) {
          // Template backgrounds are the visual bed. They must be present on
          // frame one so the title/card can animate over media, not over black.
          hfSet(bgSel, { opacity: 1, scale: 1.0 }, Math.max(0, item.start - 0.08));
        } else {
          hfFromTo(bgSel, { opacity: 0, scale: 1.035 }, { opacity: 1, scale: 1.0, duration: hfDuration(0.34, item), ease: 'power2.out' }, item.start);
        }
        if (!isTemplate && item.duration > 0.75) {
          hfTo(bgSel, { opacity: 0, scale: 1.01, duration: hfDuration(0.24, item), ease: 'power1.in' }, item.start + item.duration - hfDuration(0.24, item));
        }
      }
      if (!hfHas(sel)) continue;
      const type = item.type || 'graphic';
      hfSet(sel, { visibility: 'visible', pointerEvents: 'none' }, Math.max(0, item.start - 0.01));
      if (item.authored && item.kind === 'overlay') {
        // Authored overlays bring their own internal choreography — the
        // container only gates visibility with a quick opacity ramp so the
        // default slide/scale enter can't fight the authored motion (the
        // full-frame container is also transform-locked in CSS).
        hfFromTo(sel, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: 'power1.out' }, item.start);
        if (item.duration > 0.6) hfTo(sel, { opacity: 0, duration: 0.2, ease: 'power1.in' }, item.start + item.duration - 0.2);
        hfSet(sel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, item.start + item.duration + 0.025);
        continue;
      }
      if (item.seamIn) {
        // Seamless chain boundary: the previous stage visual hands off to
        // this one with NO container pop — the canvas holds steady and the
        // internal choreography (content entrance) carries the swap.
        hfSet(sel, { opacity: 1, x: 0, y: 0, scale: 1 }, item.start);
      } else {
        hfFromTo(sel, hfEnterState(item), hfShowState(item), item.start);
      }
      if (hfHas(sel + '.hf-agentic')) {
        if (hfHas(sel + ' .hf-agentic-rule')) {
          hfFromTo(sel + ' .hf-agentic-rule', { opacity: 0, scaleY: 0.2, transformOrigin: '50% 100%' }, { opacity: 1, scaleY: 1, duration: hfDuration(0.38, item), ease: 'power3.out' }, item.start + 0.08);
        }
        if (hfHas(sel + ' .hf-agentic-part')) {
          hfFromTo(sel + ' .hf-agentic-part', hfChildEnterState(item), hfChildShowState(item), item.start + 0.14);
        }
        if (hfHas(sel + ' .hf-agentic-item')) {
          hfFromTo(sel + ' .hf-agentic-item', hfChildEnterState(item), hfChildShowState(item), item.start + 0.22);
        }
      }
      if (type === 'typewriter') {
        hfFromTo(sel + ' .hf-typewriter-line span', { clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)', duration: hfDuration(Math.min(1.4, Math.max(0.45, item.duration * 0.35)), item, 0.18, 1.4), ease: 'steps(18)' }, item.start + 0.12);
      }
      if (type === 'kinetic-text') {
        // Agentic markup splits the headline into .hf-agentic-word spans; each
        // variant gets its own signature word motion (rise/cascade/punch/stamp/
        // glitch/wave/pop/centered). (Legacy .hf-kinetic-line span kept for the
        // dedicated renderer path.)
        const km = hfKineticMotion(item);
        hfFromTo(sel + ' .hf-agentic-word', km.from, km.to, item.start + 0.1);
        hfFromTo(sel + ' .hf-kinetic-line span', km.from, km.to, item.start + 0.1);
      }
      if (type === 'stat-counter') {
        hfFromTo(sel + ' .hf-stat-value', { opacity: 0, y: 18, scale: 0.84 }, { opacity: 1, y: 0, scale: 1, duration: hfDuration(0.42, item), ease: 'back.out(1.8)' }, item.start + 0.12);
      }
      if (type === 'map-chart') {
        if (hfHas(sel + ' .hf-map-image')) {
          hfFromTo(sel + ' .hf-map-image', { scale: 1.045 }, { scale: 1.005, duration: Math.max(0.8, item.duration - 0.2), ease: 'none' }, item.start + 0.05);
        }
        if (hfHas(sel + ' .hf-country-fill')) {
          hfFromTo(sel + ' .hf-country-fill', { opacity: 0, scale: 0.985 }, { opacity: 1, scale: 1, duration: hfDuration(0.48, item), stagger: 0.06 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.12);
        }
        if (hfHas(sel + ' .hf-country-line')) {
          hfFromTo(sel + ' .hf-country-line', { opacity: 0 }, { opacity: 1, duration: hfDuration(0.42, item), stagger: 0.04 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.18);
        }
        if (hfHas(sel + ' .hf-country-route')) {
          hfTo(sel + ' .hf-country-route', { strokeDashoffset: 0, duration: hfDuration(Math.min(1.5, Math.max(0.6, item.duration * 0.32)), item, 0.24, 1.5), ease: 'power2.inOut' }, item.start + 0.26);
        }
        if (hfHas(sel + ' .hf-country-pin')) {
          hfFromTo(sel + ' .hf-country-pin', { opacity: 0, scale: 0.65 }, { opacity: 1, scale: 1, duration: hfDuration(0.3, item), stagger: 0.08 / hfSpeed(item), ease: 'back.out(1.8)' }, item.start + 0.48);
        }
        if (hfHas(sel + ' .hf-map-labels span')) {
          hfFromTo(sel + ' .hf-map-labels span', { opacity: 0, y: -14 }, { opacity: 1, y: 0, duration: hfDuration(0.32, item), stagger: 0.05 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.34);
        }
      }
      if (type === 'bar-chart') {
        hfFromTo(sel + ' .hf-bar-row', { opacity: 0, x: -32 }, { opacity: 1, x: 0, duration: hfDuration(0.34, item), stagger: 0.07 / hfSpeed(item), ease: 'power2.out' }, item.start + 0.18);
        hfFromTo(sel + ' .hf-bar-row i', { scaleX: 0 }, { scaleX: 1, duration: hfDuration(0.72, item), stagger: 0.07 / hfSpeed(item), ease: 'power3.out' }, item.start + 0.28);
      }
      if (type === 'progress-bar' || type === 'progress-tracker') {
        hfFromTo(sel + ' .hf-progress-rail span', { scaleX: 0 }, { scaleX: 1, duration: hfDuration(0.72, item), ease: 'power3.out' }, item.start + 0.22);
      }
      if (hfHas(sel + ' .hf-item') && (type.includes('card') || type === 'listicle-grid' || type === 'infographic' || type === 'image-showcase' || type === 'split-screen' || type === 'person-intro' || type === 'ranking-list' || type === 'bullet-list' || type === 'timeline')) {
        hfFromTo(sel + ' .hf-item', hfChildEnterState(item), hfChildShowState(item), item.start + 0.18);
      }
      if (item.duration > 0.75 && !item.seamOut) {
        const exit = hfExitState(item);
        hfTo(sel, exit, item.start + item.duration - exit.duration);
      }
      const clampAt = item.start + item.duration + 0.025;
      hfSet(sel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, clampAt);
      if (hfHas(bgSel)) {
        hfSet(bgSel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, clampAt);
      }
    }

    // ── Map compositions (map-hf-builder GSAP timelines) ──
${mapTimelineScript}

    // ── Agent-authored compositions (composition-author worker) ──
${authoredTimelineScript}

    // ── Scene effect stacks (hf-effects registry) ──
${fxTimelineScript}

    // ── Transitions ──
    // Motion mode: choreograph the ACTUAL scene containers (outgoing exits
    // with intent, incoming arrives with momentum) — the broadcast feel.
    // Overlay mode: slab/flare element swept over the cut (flash/sweep/glitch).
    for (const item of timing.transitionAnims || []) {
      const type = item.type || 'crossfade';
      if (item.mode === 'motion') {
        const inSel = item.inId ? '#' + CSS.escape(item.inId) : null;
        const outSel = item.outId ? '#' + CSS.escape(item.outId) : null;
        if (!inSel || !hfHas(inSel)) continue;
        const hasOut = outSel && hfHas(outSel);
        const d = Math.max(0.3, Math.min(0.85, item.duration));
        const b = item.boundary != null ? item.boundary : (item.start + d * 0.5);
        const inAt = b - 0.02; // incoming starts a hair early — opacity still 0, transform pre-positions
        const dirX = type.endsWith('right') ? -1 : 1; // push-left = content travels left
        if (type.indexOf('push-') === 0) {
          const axis = type === 'push-up' ? 'yPercent' : 'xPercent';
          const from = {}; from[axis] = (type === 'push-up' ? 1 : dirX) * 26;
          const to = {}; to[axis] = 0;
          hfFromTo(inSel, from, Object.assign(to, { duration: d * 0.9, ease: 'power3.out' }), inAt);
          if (hasOut) {
            const outTo = {}; outTo[axis] = (type === 'push-up' ? 1 : dirX) * -20;
            hfTo(outSel, Object.assign(outTo, { duration: d * 0.7, ease: 'power2.in' }), b - d * 0.45);
            hfSet(outSel, type === 'push-up' ? { yPercent: 0 } : { xPercent: 0 }, b + d);
          }
        } else if (type.indexOf('wipe-') === 0) {
          const fromClip = type === 'wipe-up'
            ? 'inset(100% 0% 0% 0%)'
            : (type === 'wipe-right' ? 'inset(0% 0% 0% 100%)' : 'inset(0% 100% 0% 0%)');
          hfSet(inSel, { clipPath: fromClip }, inAt);
          hfTo(inSel, { clipPath: 'inset(0% 0% 0% 0%)', duration: d * 0.85, ease: 'power3.inOut' }, inAt);
          hfSet(inSel, { clipPath: 'none' }, inAt + d);
        } else if (type.indexOf('whip-') === 0) {
          hfFromTo(inSel, { xPercent: dirX * 46, filter: 'blur(14px)' },
            { xPercent: 0, filter: 'blur(0px)', duration: d * 0.62, ease: 'power3.out' }, inAt);
          hfSet(inSel, { filter: 'none' }, inAt + d * 0.62); // clear the blur layer once sharp
          if (hasOut) {
            hfTo(outSel, { xPercent: dirX * -38, filter: 'blur(12px)', duration: d * 0.5, ease: 'power2.in' }, b - d * 0.4);
            hfSet(outSel, { xPercent: 0, filter: 'none' }, b + d);
          }
        } else if (type === 'zoom-punch') {
          hfFromTo(inSel, { scale: 0.86 }, { scale: 1, duration: d * 0.9, ease: 'power3.out' }, inAt);
          if (hasOut) {
            hfTo(outSel, { scale: 1.16, duration: d * 0.7, ease: 'power2.in' }, b - d * 0.45);
            hfSet(outSel, { scale: 1 }, b + d);
          }
        } else if (type === 'zoom-pull') {
          hfFromTo(inSel, { scale: 1.14 }, { scale: 1, duration: d * 0.9, ease: 'power3.out' }, inAt);
          if (hasOut) {
            hfTo(outSel, { scale: 0.93, duration: d * 0.7, ease: 'power2.in' }, b - d * 0.45);
            hfSet(outSel, { scale: 1 }, b + d);
          }
        } else if (type === 'blur-dissolve') {
          hfFromTo(inSel, { filter: 'blur(12px)' }, { filter: 'blur(0px)', duration: d * 0.8, ease: 'power2.out' }, inAt);
          hfSet(inSel, { filter: 'none' }, inAt + d * 0.8); // clear the blur layer once sharp
          if (hasOut) {
            hfTo(outSel, { filter: 'blur(12px)', duration: d * 0.6, ease: 'power2.in' }, b - d * 0.4);
            hfSet(outSel, { filter: 'none' }, b + d);
          }
        } else if (type === 'spin-settle') {
          hfFromTo(inSel, { rotation: dirX * 1.8, scale: 1.06 }, { rotation: 0, scale: 1, duration: d, ease: 'power3.out' }, inAt);
        }
        continue;
      }
      const sel = '#' + CSS.escape(item.id);
      const slab = sel + ' .hf-transition-slab';
      const flare = sel + ' .hf-transition-flare';
      if (!hfHas(sel)) continue;
      hfSet(sel, { opacity: 1, visibility: 'visible', pointerEvents: 'none' }, item.start);
      if (type.includes('fire') || type.includes('burn')) {
        // Hot flame band sweeps across; a warm ember-glow core blooms with it.
        hfFromTo(slab, { xPercent: -120, opacity: 0.25 }, { xPercent: 120, opacity: 1, duration: item.duration, ease: 'power2.inOut' }, item.start);
        hfFromTo(flare, { opacity: 0, scale: 0.7 }, { opacity: 0.85, scale: 1.35, duration: item.duration * 0.5, yoyo: true, repeat: 1, ease: 'power2.out' }, item.start);
      } else if (type.includes('lens') || type.includes('anamorphic') || type.includes('streak')) {
        // Bright vertical light core whips across fast; horizontal streak flashes through.
        hfFromTo(slab, { xPercent: -130, opacity: 0.3 }, { xPercent: 130, opacity: 1, duration: item.duration, ease: 'power3.inOut' }, item.start);
        hfFromTo(flare, { opacity: 0, scaleX: 0.5 }, { opacity: 0.95, scaleX: 1.35, duration: item.duration * 0.45, yoyo: true, repeat: 1, ease: 'power2.out' }, item.start + item.duration * 0.18);
      } else if (type.includes('light') || type.includes('sweep') || type.includes('leak')) {
        hfFromTo(slab, { xPercent: -120, opacity: 0.1 }, { xPercent: 120, opacity: 1, duration: item.duration, ease: 'power2.inOut' }, item.start);
      } else if (type.includes('glitch')) {
        hfFromTo(slab, { opacity: 0, x: -8 }, { opacity: 0.5, x: 8, duration: 0.09, ease: 'steps(2)', yoyo: true, repeat: Math.min(3, Math.max(2, Math.floor(item.duration / 0.09))) }, item.start);
      } else {
        // flash-white / dip-black / legacy names: a quick opacity dip/flash.
        // dip-black goes nearly to full black so an act break reads as a real
        // cut-to-black, not a grey veil.
        const peak = (type.includes('flash') || type.includes('white')) ? 0.9 : (type.includes('dip') || type.includes('black')) ? 0.96 : 0.78;
        hfFromTo(slab, { opacity: 0 }, { opacity: peak, duration: item.duration * 0.5, yoyo: true, repeat: 1, ease: 'power1.inOut' }, item.start);
      }
      // Generic white flare bloom for light/sweep/leak/flash. fire-burn & lens-flare
      // drive their OWN (warm / streak) flare above, so they're excluded here.
      if (type.includes('light') || type.includes('sweep') || type.includes('leak') || type.includes('flash')) {
        hfFromTo(flare, { opacity: 0, scale: 0.8 }, { opacity: 0.5, scale: 1.2, duration: item.duration * 0.5, yoyo: true, repeat: 1, ease: 'power2.out' }, item.start);
      }
      hfSet(sel, { opacity: 0, visibility: 'hidden', pointerEvents: 'none' }, item.start + item.duration + 0.025);
    }

    window.__timelines['yta-hyperframes'] = tl;
    window.__HF_DURATION__ = ${totalDuration.toFixed(3)};
    /*HF_PREVIEW_START*/
    (function initYtaHyperframesPreviewRuntime() {
      const params = new URLSearchParams(window.location.search || '');
      if (!params.has('preview')) return;
      const root = document.getElementById('yta-hyperframes');
      const compositionWidth = Number(root?.dataset.width || 1920);
      const compositionHeight = Number(root?.dataset.height || 1080);
      if (root) {
        root.style.position = 'absolute';
        root.style.left = '0';
        root.style.top = '0';
        root.style.transformOrigin = 'top left';
      }
      document.documentElement.style.background = '#050505';
      document.body.style.margin = '0';
      document.body.style.width = '100vw';
      document.body.style.height = '100vh';
      document.body.style.overflow = 'hidden';

      function fitPreviewRoot() {
        if (!root) return;
        const viewportWidth = Math.max(1, window.innerWidth || compositionWidth);
        const viewportHeight = Math.max(1, window.innerHeight || compositionHeight);
        const scale = Math.min(viewportWidth / compositionWidth, viewportHeight / compositionHeight);
        const left = Math.max(0, (viewportWidth - compositionWidth * scale) / 2);
        const top = Math.max(0, (viewportHeight - compositionHeight * scale) / 2);
        root.style.transform = 'translate(' + left + 'px, ' + top + 'px) scale(' + scale + ')';
      }

      window.addEventListener('resize', fitPreviewRoot);
      fitPreviewRoot();

      const clips = Array.from(document.querySelectorAll('.clip')).map((el) => {
        const timelineManaged = el.classList.contains('hf-scene')
          || el.classList.contains('hf-mg')
          || el.classList.contains('hf-bg-media')
          || el.classList.contains('hf-transition')
          || el.classList.contains('hf-caption');
        // Scene footage now lives inside a wrapper (.hf-scene-wrap > .hf-scene-frame
        // > video), so the media element is no longer the .clip itself — find it.
        // The MAIN scene media carries .hf-scene-media; the blurred backdrop carries
        // .hf-floatbg-fill and sits FIRST in DOM — so a naive querySelector('video')
        // would grab the backdrop. Select the main media explicitly, then drive the
        // backdrop video off the same clock.
        const mediaEl = (el.tagName === 'VIDEO' || el.tagName === 'AUDIO')
          ? el
          : (el.querySelector('video.hf-scene-media, audio.hf-scene-media')
             || el.querySelector('.hf-scene-frame video, .hf-scene-frame audio')
             || el.querySelector('video, audio'));
        const bgMediaEl = el.querySelector ? el.querySelector('video.hf-floatbg-fill') : null;
        return {
          el,
          mediaEl,
          bgMediaEl,
          start: Number(el.dataset.start || 0),
          duration: Number(el.dataset.duration || 0),
          mediaStart: Number(el.dataset.mediaStart || 0),
          isMedia: !!mediaEl,
          manualVisibility: !timelineManaged || (!!mediaEl && mediaEl.tagName === 'AUDIO'),
        };
      });
      let playing = false;
      let lastTime = 0;
      let previewTimer = null;
      let lastTickMs = 0;

      function emitPreviewState() {
        window.parent?.postMessage({
          type: 'hf-preview-time',
          time: lastTime,
          duration: Number(window.__HF_DURATION__ || 0),
          playing
        }, '*');
      }

      function stopLoop() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = null;
      }

      function startLoop() {
        if (previewTimer) return;
        lastTickMs = performance.now();
        previewTimer = setTimeout(tick, 33);
      }

      function tick() {
        previewTimer = null;
        if (!playing) return;
        const now = performance.now();
        const duration = Number(window.__HF_DURATION__ || 0);
        const delta = Math.min(0.1, Math.max(0, (now - lastTickMs) / 1000));
        lastTickMs = now;
        let nextTime = lastTime + delta;
        if (duration > 0 && nextTime >= duration) {
          nextTime = duration;
          playing = false;
          seek(nextTime, false);
          return;
        }
        seek(nextTime, true);
        if (playing) startLoop();
      }

      clips.forEach((clip) => {
        clip.el.style.pointerEvents = 'none';
        if (clip.isMedia && clip.mediaEl) {
          clip.mediaEl.muted = true;
          clip.mediaEl.playsInline = true;
          clip.mediaEl.pause();
        }
      });

      function syncMedia(clip, localTime) {
        if (!clip.isMedia || !clip.mediaEl) return;
        try {
          const media = clip.mediaEl;
          const desired = Math.max(0, localTime + clip.mediaStart);
          const maxTime = Number.isFinite(media.duration) && media.duration > 0
            ? Math.max(0, media.duration - 0.05)
            : desired;
          const target = Math.min(desired, maxTime);
          if (Math.abs((media.currentTime || 0) - target) > 0.18) {
            media.currentTime = target;
          }
          if (playing && media.tagName === 'VIDEO') {
            media.play().catch(() => {});
          } else if (!playing && !media.paused) {
            media.pause();
          }
          // Keep the blurred backdrop video in step with the foreground.
          const bg = clip.bgMediaEl;
          if (bg && bg.tagName === 'VIDEO') {
            try {
              if (Math.abs((bg.currentTime || 0) - target) > 0.25) bg.currentTime = target;
              if (playing) { bg.muted = true; bg.play().catch(() => {}); }
              else if (!bg.paused) bg.pause();
            } catch (_) {}
          }
        } catch (_) {}
      }

      function seek(time, shouldPlay) {
        const duration = Number(window.__HF_DURATION__ || 0);
        const t = Math.max(0, Math.min(Number(time) || 0, duration));
        lastTime = t;
        if (typeof shouldPlay === 'boolean') playing = shouldPlay;
        const timeline = window.__timelines && window.__timelines['yta-hyperframes'];
        if (timeline) {
          if (typeof timeline.time === 'function') timeline.time(t, false);
          if (typeof timeline.pause === 'function') timeline.pause();
        }
        clips.forEach((clip) => {
          const clipDuration = Math.max(0.033, Number(clip.duration) || 0);
          const active = t >= clip.start && t < clip.start + clipDuration;
          if (clip.manualVisibility) {
            clip.el.style.visibility = active ? 'visible' : 'hidden';
          } else {
            clip.el.style.visibility = '';
          }
          if (clip.isMedia && active) {
            syncMedia(clip, t - clip.start);
          } else if (clip.isMedia && clip.mediaEl && !clip.mediaEl.paused) {
            clip.mediaEl.pause();
          }
        });
        if (root) root.setAttribute('data-preview-time', t.toFixed(3));
        if (playing) startLoop();
        else stopLoop();
        emitPreviewState();
      }

      window.__HF_PREVIEW__ = {
        fit: fitPreviewRoot,
        seek,
        play() { playing = true; seek(lastTime, true); },
        pause() { playing = false; seek(lastTime, false); },
      };

      window.addEventListener('message', (event) => {
        const msg = event.data || {};
        if (msg.type === 'hf-preview-seek') seek(msg.time, msg.playing);
        if (msg.type === 'hf-preview-play') window.__HF_PREVIEW__.play();
        if (msg.type === 'hf-preview-pause') window.__HF_PREVIEW__.pause();
      });

      seek(Number(params.get('t') || 0), false);
      window.parent?.postMessage({ type: 'hf-preview-ready' }, '*');
    })();
    /*HF_PREVIEW_END*/
  </script>
</body>
</html>`;
    // The preview controller above uses performance.now()/setTimeout for live
    // scrubbing in the iframe. HyperFrames' RENDER validator statically scans the
    // composition source and HARD-FAILS on non-deterministic calls (performance.now)
    // even though the block self-guards on ?preview. So strip the entire preview
    // runtime from the render build — HyperFrames drives the GSAP timeline itself,
    // frame-accurate and deterministic.
    if (options && options.preview) return __hfHtml;
    return __hfHtml.replace(/\/\*HF_PREVIEW_START\*\/[\s\S]*?\/\*HF_PREVIEW_END\*\//, '');
}

function writeDesign(projectDir, plan) {
    const theme = plan?.scriptContext?.theme || plan?.theme || 'standard';
    const title = plan?.scriptContext?.title || plan?.title || 'YTA video';
    const design = `# Design

## Style Prompt
Premium documentary motion graphics for "${title}". Clean editorial typography, high contrast, rich dark canvas, crisp animated overlays, and smooth full-frame title cards.

## Colors
- Background: #050505
- Panel: #0f172a
- Text: #f8fafc
- Muted text: #cbd5e1
- Accent: #7c3aed
- Secondary accent: #0ea5e9

## Current Theme
${theme}
`;
    fs.writeFileSync(path.join(projectDir, 'DESIGN.md'), design, 'utf8');
}

function generateHyperframesProject({ plan, projectDir, appRoot, tempDir, publicDir, inputDir, outputRoot, options = {} }) {
    if (!plan || typeof plan !== 'object') throw new Error('Missing video plan');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const root = outputRoot || path.join(projectDir, 'hyperframes');
    ensureDir(root);
    const hfDir = path.join(root, `yta-hf-${stamp}`);
    ensureDir(hfDir);

    // Auto-prune older generated projects. Each yta-hf-* dir carries a full
    // copy of all scene media (~hundreds of MB); a busy project accumulated
    // 85+ of them (16 GB) and filled the disk mid-render (ENOSPC killed the
    // parallel capture). Keep the newest N (HF_KEEP_PROJECTS, default 3).
    try {
        const keepN = Math.max(1, parseInt(process.env.HF_KEEP_PROJECTS || '3', 10) || 3);
        const siblings = fs.readdirSync(root)
            .filter(name => /^yta-hf-/.test(name) && name !== `yta-hf-${stamp}`)
            .sort()
            .reverse();
        for (const old of siblings.slice(Math.max(0, keepN - 1))) {
            fs.rmSync(path.join(root, old), { recursive: true, force: true });
        }
        if (siblings.length > keepN - 1) {
            console.log(`[HyperFrames] Pruned ${siblings.length - (keepN - 1)} old project dir(s) (keeping newest ${keepN})`);
        }
    } catch (pruneErr) {
        console.warn(`[HyperFrames] project prune skipped: ${pruneErr.message}`);
    }

    // ── Disk-space pre-flight (turn a cryptic mid-write crash into graceful handling).
    // buildComposition() below re-encodes EVERY scene + MG into hfDir/media (often
    // 300-600 MB) then writes a multi-MB plan snapshot. On a near-full disk those
    // writes die halfway with "cannot write to disk", leaving a broken half-project.
    // So when space is tight: reclaim hard (drop ALL older project dirs, keeping only
    // this run) so the build can still finish; if it's STILL critically low, fail NOW
    // with an actionable message instead of after 30 min of normalizing. statfs is
    // wrapped — if unavailable, this whole block no-ops and behaviour is unchanged.
    // Tunables: HF_MIN_FREE_GB (comfort, default 3), HF_HARD_MIN_FREE_GB (floor, 1.2).
    const _freeGB = (p) => {
        try { const s = fs.statfsSync(p); return (s.bavail * s.bsize) / (1024 ** 3); }
        catch (_) { return null; }
    };
    const minFreeGB = Math.max(0.5, parseFloat(process.env.HF_MIN_FREE_GB || '3') || 3);
    const hardMinGB = Math.max(0.3, parseFloat(process.env.HF_HARD_MIN_FREE_GB || '1.2') || 1.2);
    let freeGB = _freeGB(root);
    if (freeGB !== null && freeGB < minFreeGB) {
        try {
            const stale = fs.readdirSync(root).filter(name => /^yta-hf-/.test(name) && name !== `yta-hf-${stamp}`);
            for (const old of stale) fs.rmSync(path.join(root, old), { recursive: true, force: true });
            if (stale.length) console.warn(`[HyperFrames] Low disk (${freeGB.toFixed(1)} GB free) — reclaimed ALL ${stale.length} old project dir(s) to make room.`);
        } catch (e) { console.warn(`[HyperFrames] low-disk reclaim skipped: ${e.message}`); }
        freeGB = _freeGB(root);
        if (freeGB !== null && freeGB < hardMinGB) {
            const drive = path.parse(root).root || root;
            throw new Error(`Not enough free disk space to render this video: only ${freeGB.toFixed(1)} GB free on ${drive} (need ~${minFreeGB} GB). Free up space — empty the Recycle Bin, clear old Downloads, or delete old projects — then build again.`);
        }
        if (freeGB !== null) console.warn(`[HyperFrames] Proceeding with ${freeGB.toFixed(1)} GB free (below the ${minFreeGB} GB comfort margin) — keep an eye on disk.`);
    }

    const dirs = {
        appRoot,
        lookupDirs: [
            tempDir,
            publicDir,
            inputDir,
            projectDir,
            path.join(projectDir, 'output'),
        ].filter(Boolean),
    };

    const indexHtml = buildComposition({ plan, dirs, projectDir: hfDir, options });
    fs.writeFileSync(path.join(hfDir, 'index.html'), indexHtml, 'utf8');
    fs.writeFileSync(path.join(hfDir, 'video-plan.snapshot.json'), JSON.stringify(plan, null, 2), 'utf8');
    fs.writeFileSync(path.join(hfDir, 'package.json'), JSON.stringify({
        scripts: {
            lint: 'npx --yes hyperframes lint',
            inspect: 'npx --yes hyperframes inspect',
            preview: 'npx --yes hyperframes preview',
            render: 'npx --yes hyperframes render --gpu --workers 2 --browser-gpu',
        },
        devDependencies: {},
    }, null, 2), 'utf8');
    writeDesign(hfDir, plan);

    return {
        success: true,
        projectDir: hfDir,
        indexPath: path.join(hfDir, 'index.html'),
        mediaDir: path.join(hfDir, 'media'),
    };
}

module.exports = { generateHyperframesProject, buildCaptionCues };
