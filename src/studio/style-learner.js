/**
 * Style Learner — Reference Video Analysis (v2)
 *
 * Takes YouTube URLs or local video files, sends to Gemini for full multimodal
 * analysis, and extracts structured JSON style profiles capturing:
 *   pacing (per-section), footage, MG placement patterns, transitions, effects,
 *   color palette (hex), audio analysis, typography, hook, CTA, system notes
 *
 * v2 enhancements:
 *   - Multi-video learning: analyze 3-5 videos → merge into channel profile
 *   - Per-section pacing: intro/body/conclusion rhythms captured separately
 *   - Color palette extraction: actual hex codes, not just warm/cool
 *   - MG placement patterns: WHERE MGs appear relative to narration beats
 *   - Audio analysis: music style, SFX density, voice-to-music ratio
 *   - Comparison mode: side-by-side "reference did X, your build did Y"
 */

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const config = require('../settings/config');
const vertex = require('../brain/vertex-auth');
const { getYtdlpCookieArgs } = require('../media/providers/ytdlp-utils');

// ============ LOGGING ============

function _log(msg) {
    console.log(`[StyleLearner] ${msg}`);
}

// ============ GEMINI KEY POOL (shared pattern with qa-studio-agent.js) ============

let _keyIndex = 0;
const _keyExhausted = new Map();

function _getKeys() {
    const keys = config.gemini?.apiKeys || (config.gemini?.apiKey ? [config.gemini.apiKey] : []);
    if (!keys.length) throw new Error('[StyleLearner] No Gemini API key configured');
    return keys;
}

function _getNextKey() {
    const keys = _getKeys();
    const now = Date.now();
    for (let offset = 0; offset < keys.length; offset++) {
        const idx = (_keyIndex + offset) % keys.length;
        const exh = _keyExhausted.get(idx);
        if (exh === true) continue;
        if (typeof exh === 'number') {
            if (exh > now) continue;
            _keyExhausted.delete(idx);
        }
        _keyIndex = idx;
        return { key: keys[idx], index: idx };
    }
    return null;
}

function _markExhausted(idx, kind) {
    if (kind === 'rate_limited') {
        _keyExhausted.set(idx, Date.now() + 60_000);
    } else {
        _keyExhausted.set(idx, true);
    }
}

function _isQuotaError(err) {
    const status = err.response?.status;
    if (status === 403) return 'exhausted';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'rate_limited'; // server overloaded → treat as cooldown
    return null;
}

function _getModel() {
    return config.gemini?.visionModel || 'gemini-2.0-flash';
}

// ============ YT-DLP BINARY DISCOVERY ============

let _ytdlpPath = null;
let _ytdlpChecked = false;

function _findYtdlp() {
    if (_ytdlpChecked) return _ytdlpPath;
    _ytdlpChecked = true;

    const projectRoot = path.join(__dirname, '..', '..');
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const candidates = [
        config.youtube?.ytdlpPath || null,
        path.join(projectRoot, 'yt-dlp', bin),
        path.join(projectRoot, bin),
    ].filter(Boolean);

    // First pass: check if file exists on disk (no execution — avoids PyInstaller issues)
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            _ytdlpPath = candidate;
            _log(`yt-dlp found (file exists): ${candidate}`);
            return _ytdlpPath;
        }
    }

    // Second pass: try 'yt-dlp' from system PATH
    try {
        execFileSync('yt-dlp', ['--version'], {
            timeout: 5000,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        _ytdlpPath = 'yt-dlp';
        _log('yt-dlp found in system PATH');
        return _ytdlpPath;
    } catch (e) {
        // not in PATH
    }

    _log('yt-dlp not found — YouTube URL input will fail');
    return null;
}

function _resetYtdlpCache() {
    _ytdlpChecked = false;
    _ytdlpPath = null;
}

// ============ FFMPEG DISCOVERY ============

let _ffmpegDir = null;
let _ffmpegChecked = false;

function _findFfmpegDir() {
    if (_ffmpegChecked) return _ffmpegDir;
    _ffmpegChecked = true;

    const candidates = [
        'C:\\ffmg\\bin',
        'C:\\ffmpeg\\bin',
        path.join(__dirname, '..', '..', 'ffmpeg'),
        path.join(__dirname, '..', '..', 'ffmpeg', 'bin'),
    ];
    for (const dir of candidates) {
        const exe = path.join(dir, 'ffmpeg.exe');
        if (fs.existsSync(exe)) {
            _ffmpegDir = dir;
            _log(`ffmpeg found: ${dir}`);
            return _ffmpegDir;
        }
    }
    // Try system PATH
    try {
        execFileSync('ffmpeg', ['-version'], { timeout: 3000, stdio: 'pipe', windowsHide: true });
        _ffmpegDir = null; // in PATH, no need for --ffmpeg-location
        _log('ffmpeg found in system PATH');
        return null;
    } catch (e) {}

    _log('ffmpeg not found — download-sections truncation will be skipped');
    return null;
}

// ============ YOUTUBE DOWNLOAD ============

/**
 * Create a unique temp env for yt-dlp spawns.
 * PyInstaller-based yt-dlp.exe extracts DLLs to TEMP — concurrent spawns collide.
 * Each call gets its own temp dir, created on disk so PyInstaller can use it.
 */
function _makeYtdlpEnv() {
    const tmpBase = require('os').tmpdir();
    const unique = path.join(tmpBase, `ytdlp-sl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    try { fs.mkdirSync(unique, { recursive: true }); } catch (e) {}
    return { ...process.env, TEMP: unique, TMP: unique, TMPDIR: unique };
}

/**
 * Download a YouTube video for style analysis. For long videos (>25min), only
 * downloads the first 20 minutes — enough to capture the hook, body
 * pacing rhythm, and MG patterns without burning bandwidth.
 */
async function _downloadYouTube(url, outputPath, onProgress) {
    const ytdlp = _findYtdlp();
    if (!ytdlp) throw new Error('yt-dlp not installed. See https://github.com/yt-dlp/yt-dlp');

    // First, get duration so we know whether to truncate
    let duration = 0;
    let title = 'reference';
    try {
        const metaEnv = _makeYtdlpEnv();
        const cookieArgs = getYtdlpCookieArgs() || [];
        const meta = execFileSync(ytdlp, [
            ...cookieArgs,
            '--print', '%(duration)s',
            '--print', '%(title)s',
            '--no-warnings',
            url,
        ], { timeout: 30000, encoding: 'utf8', windowsHide: true, env: metaEnv });
        const lines = meta.trim().split('\n');
        duration = parseInt(lines[0]) || 0;
        title = (lines[1] || 'reference').replace(/[^\w\s-]/g, '').trim() || 'reference';
        _log(`Video metadata: "${title}" (${duration}s)`);
        // Cleanup temp dir
        try { fs.rmSync(metaEnv.TEMP, { recursive: true, force: true }); } catch (e) {}
    } catch (e) {
        _log(`Could not fetch metadata: ${e.message}`);
    }

    // Locate ffmpeg for --download-sections and --merge-output-format
    const ffmpegDir = _findFfmpegDir();

    const dlCookieArgs = getYtdlpCookieArgs() || [];
    const args = [
        ...dlCookieArgs,
        url,
        '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
        '--merge-output-format', 'mp4',
        '--max-filesize', '200M',
        '-o', outputPath,
        '--no-playlist',
        '--no-warnings',
        '--quiet',
    ];

    if (ffmpegDir) args.push('--ffmpeg-location', ffmpegDir);

    // Truncate long videos: keep first 20 minutes
    if (duration > 1500) {
        if (ffmpegDir) {
            args.push('--download-sections', '*0-1200');
            _log(`Video > 25min, downloading first 20 minutes only`);
        } else {
            _log(`Video > 25min but no ffmpeg found — downloading full video (truncation requires ffmpeg)`);
        }
    }

    if (onProgress) onProgress(15, `Downloading reference video...`);

    const spawnEnv = _makeYtdlpEnv();

    return new Promise((resolve, reject) => {
        const proc = spawn(ytdlp, args, { windowsHide: true, env: spawnEnv });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            // Cleanup temp dir
            try { fs.rmSync(spawnEnv.TEMP, { recursive: true, force: true }); } catch (e) {}
            if (code === 0 && fs.existsSync(outputPath)) {
                const sizeMB = fs.statSync(outputPath).size / 1024 / 1024;
                _log(`Downloaded: ${outputPath} (${sizeMB.toFixed(1)}MB)`);
                resolve({ path: outputPath, title, duration: Math.min(duration || 1200, 1200) });
            } else {
                reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(-300)}`));
            }
        });
        proc.on('error', reject);
    });
}

// ============ FILE UPLOAD (Vertex AI → GCS, Regular → Gemini Files API) ============

async function _uploadToGemini(filePath, apiKey) {
    const mimeType = filePath.endsWith('.webm') ? 'video/webm' : 'video/mp4';
    const displayName = path.basename(filePath);
    const fileSizeMB = fs.statSync(filePath).size / 1024 / 1024;

    // ── Vertex AI path: upload to GCS ──
    if (vertex.isVertexEnabled()) {
        _log(`Uploading ${displayName} (${fileSizeMB.toFixed(1)}MB) to GCS (Vertex AI)...`);
        const gcs = await vertex.uploadToGCS(filePath, mimeType);
        _log(`Uploaded: ${gcs.gsUri}`);
        return { fileUri: gcs.gsUri, fileName: gcs.objectName, mimeType, isGCS: true };
    }

    // ── Regular Gemini Files API path ──
    const fileData = fs.readFileSync(filePath);

    _log(`Uploading ${displayName} (${fileSizeMB.toFixed(1)}MB) to Gemini Files API...`);

    const boundary = `boundary_${Date.now()}`;
    const metaJson = JSON.stringify({ file: { display_name: displayName } });

    const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${metaJson}\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        fileData,
        Buffer.from(`\r\n--${boundary}--`),
    ]);

    const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`;
    const uploadResp = await axios.post(uploadUrl, body, {
        headers: {
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': body.length,
        },
        timeout: 300000,
        maxBodyLength: 2 * 1024 * 1024 * 1024,
        maxContentLength: 2 * 1024 * 1024 * 1024,
    });

    const file = uploadResp.data?.file;
    if (!file?.uri) throw new Error(`No file URI in upload response`);

    _log(`Uploaded — waiting for ACTIVE state...`);

    // Poll until ACTIVE (full videos take longer than QA clips — up to 60s)
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const stateResp = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${apiKey}`,
            { timeout: 10000 }
        );
        const state = stateResp.data?.state;
        if (state === 'ACTIVE') {
            return { fileUri: file.uri, fileName: file.name, mimeType };
        }
        if (state === 'FAILED') throw new Error('File processing failed on Gemini side');
    }
    throw new Error('Timed out waiting for file to become ACTIVE');
}

async function _deleteGeminiFile(fileName, apiKey, isGCS) {
    if (isGCS) {
        await vertex.deleteFromGCS(fileName);
        _log(`Deleted GCS object: ${fileName}`);
        return;
    }
    try {
        await axios.delete(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
            { timeout: 10000 }
        );
    } catch (e) {
        _log(`Could not delete remote file: ${e.message}`);
    }
}

// ============ EXTRACTION PROMPT ============

function _buildExtractionPrompt() {
    // Gather system capabilities so Gemini knows what we can and can't do
    const EFFECT_PRESETS = require('../render/effect-presets');
    const presetNames = Object.keys(EFFECT_PRESETS).filter(k => k !== 'none');
    const MG_REGISTRY = require('../render/mg-registry').MG_REGISTRY || require('../render/mg-registry');
    const mgTypes = Object.keys(MG_REGISTRY).filter(k => !['listicleCounter', 'progressTracker', 'listicleGrid', 'subscribeCTA'].includes(k));

    return `You are a professional video editor analyzing the EDITING STYLE of a reference video.
Your goal is to extract a detailed style profile that our automated video generation system can use as INSPIRATION for pacing, footage choices, and visual treatment.

IMPORTANT CONTEXT — OUR SYSTEM'S CAPABILITIES:
You must understand what our system CAN do so you can map what you see in the reference video to our features, and flag things we CAN'T do yet.

MOTION GRAPHICS we support (overlay = on top of footage, fullscreen = replaces footage):
  ${mgTypes.join(', ')}
  — If the reference video uses MG styles we don't have, describe them in systemNotes.

EFFECT PRESETS we support:
  ${presetNames.join(', ')}
  Available shader effects: grain, dust, vignette, blurVignette, chromatic, lightLeak, scratch, colorGrade, scanLine, flicker, filmFrame
  — Map what you see to our closest preset. If none match, describe what's missing in systemNotes.

TRANSITIONS we support:
  cut, crossfade, crossBlur, dissolve, morph, ripple, ink, fade, dreamFade, lightLeak, fade_to_black, wipe, flash, zoom
  — Map what you see to these. If the reference uses transitions we don't have, note it.

FRAMING modes: fullscreen (default), cinematic (pulled back with blurred bg), floating (small with shadow + soft bg)

THEMES: crime, history, modern, minimal, standard — each has its own color palette, fonts, and effect pool.

NICHE CATEGORIES: explainer.* (nature, crime, business, luxury, sport, history, motivation, food, diy, military, politics, tech) and news.* (politics, celebrity, military, economy, tech, sport). Each niche controls which MG types are allowed and footage priority.

MAP SYSTEM: We can show animated maps with waypoints, zoom/tilt/orbit camera, icon badges on pins, flight arcs, boundary polygons. If the reference uses maps or geographic visuals, note the style.

Watch the entire video carefully. Then output a STRUCTURED JSON style profile.

ANALYZE THESE ASPECTS:

1. PACING (overall + per-section + segments)
   - Count scene cuts. Estimate average scene duration in seconds.
   - Calculate cuts per minute.
   - Is the rhythm consistent, varied, or accelerating?
   - How long is the hook (attention-grabbing opening)?
   - How long is the CTA/outro?
   - PER-SECTION PACING: Divide the video into 3 sections (intro/body/conclusion).
     For each: estimate avg scene duration and energy level (high/medium/low).
     Intro = first 15-20%, body = middle 60-70%, conclusion = last 15-20%.
   - PACING SEGMENTS: Identify 3-8 segments where the pacing noticeably changes.
     A segment is a stretch of the video where the pacing (cuts per minute, energy, scene duration) stays roughly consistent before shifting.
     For each segment: note the start/end time, average cuts/min in that window, energy level, and a short label describing what's happening (e.g., "fast montage", "slow explanation", "dramatic buildup", "data breakdown").
     This captures HOW pacing fluctuates through the video — some videos have steady pacing, others shift dramatically based on the script content.
     If the pacing is truly consistent throughout, you can report just 1-2 segments.

2. FOOTAGE
   - Is this stock footage, real/original footage, or mixed?
   - Estimate the ratio of: aerial shots, closeups, wide shots, medium shots (must sum to ~1.0)
   - B-roll pattern: illustrative (shows what's described), literal (matching actions), or abstract
   - Ratio of video clips vs static images

3. MOTION GRAPHICS — TEXT & DATA OVERLAYS
   - Density: none, low, medium, or high
   - Which types from OUR SUPPORTED LIST appear most?
   - Frequency per minute
   - Placement timing: on-beat (synced to narration), regular (evenly spaced), or sparse
   - Text animation speed: fast, moderate, or slow
   - Average duration each MG stays on screen
   - PLACEMENT PATTERN: Where do MGs typically appear relative to narration?
     Options: "with-statement" (appears right when narrator says the data/fact),
     "after-statement" (appears 0.5-1s after narrator mentions it),
     "pre-statement" (appears slightly before to prime the viewer),
     "continuous" (MGs are always on screen, cycling)
   - DENSITY BY SECTION: Does MG density change throughout? E.g., "low in intro, high in body, none in conclusion"
   - If the video uses MG styles we DON'T support, describe them in systemNotes

4. TRANSITIONS
   - Estimate ratios (must sum to ~1.0): hard cuts, crossfades, other
   - Average transition duration in seconds
   - Map to our supported transition types

5. EFFECTS (color grade, grain, vignette)
   - Which of our EFFECT PRESETS best matches the look? Pick the closest one.
   - Color temperature: warm, neutral, cool
   - Contrast level: low, normal, high
   - What % of scenes have visible effects?
   - If the look doesn't match any preset, describe what's different in systemNotes

6. COLOR PALETTE — Extract the dominant visual colors used in the video
   - Primary color: the most prominent background/overlay color (hex code, e.g. "#1a1a2e")
   - Secondary color: second most used color (hex code)
   - Accent color: highlight/emphasis color used in MGs, text highlights, etc. (hex code)
   - Text color: primary text color (hex code)
   - Text shadow/outline color if used (hex code or "none")
   - Overall palette mood: dark-moody, light-clean, warm-earthy, cool-tech, vibrant-bold, muted-desaturated

7. TYPOGRAPHY
   - Size style: large-bold, medium, small-clean
   - Animation type: pop, slide, fade, typewriter
   - How long does text stay on screen?
   - Colors: describe the text color scheme (white on dark, colored accents, etc.)
   - Font feel: modern/sans-serif, serif/elegant, handwritten, monospace, bold/impact
   - Describe any distinctive text formatting: outlined text, gradient fills, drop shadows, glow effects

8. AUDIO — Listen carefully to the audio mix
   - Has background music? What style/genre? (cinematic, electronic, ambient, corporate, none)
   - Music energy: high (driving beat), medium (atmospheric), low (barely there), none
   - Voice-to-music ratio estimate: how loud is narration vs music? (voice-dominant, balanced, music-heavy)
   - Sound effects (SFX): whoosh transitions, impact sounds, UI clicks, ambient/environmental, none?
   - SFX density: none, sparse (1-2/min), moderate (3-5/min), heavy (6+/min)
   - Does music change between sections? (same throughout, shifts for emphasis, different per section)

9. HOOK (first 5-15 seconds)
   - Style: cold-open, question, dramatic-statement, montage
   - Duration in seconds
   - Does it use motion graphics?

10. CTA (last 10-20 seconds)
    - Style: subscribe-prompt, fade-out, call-to-action, none
    - Duration in seconds

11. SYSTEM NOTES — CRITICAL
    For each note, describe:
    - What the reference video does that our system doesn't support yet
    - What MG styles, animations, color schemes, or visual techniques are missing
    - What fonts or typography treatments we'd need to add
    - Whether our map system would need enhancements
    - Any color/palette suggestions that could improve our themes
    - Rate each note: "nice-to-have" or "important" for matching this style
    Keep notes actionable and specific. Example: "Reference uses animated bar charts that grow in real-time synced to narration — our barChart MG only has staggerBars animation, would need a 'liveGrow' variant."

OUTPUT — Return ONLY valid JSON matching this exact schema (no markdown, no commentary):

{
  "summary": "<one paragraph describing the overall editing style in 2-3 sentences>",
  "videoDuration": <total video duration in seconds>,
  "pacing": {
    "avgSceneDuration": <number, seconds>,
    "cutsPerMinute": <number>,
    "rhythm": "consistent" | "varied" | "accelerating",
    "hookDuration": <number, seconds>,
    "ctaDuration": <number, seconds>,
    "sections": {
      "intro": { "avgSceneDuration": <number>, "energy": "high" | "medium" | "low", "durationPercent": <0-1> },
      "body":  { "avgSceneDuration": <number>, "energy": "high" | "medium" | "low", "durationPercent": <0-1> },
      "conclusion": { "avgSceneDuration": <number>, "energy": "high" | "medium" | "low", "durationPercent": <0-1> }
    },
    "segments": [
      {
        "startTime": <number, seconds>,
        "endTime": <number, seconds>,
        "cutsPerMinute": <number>,
        "avgSceneDuration": <number, seconds>,
        "energy": "high" | "medium" | "low",
        "label": "<short description, e.g. 'fast montage', 'slow explanation', 'dramatic buildup'>"
      }
    ]
  },
  "footage": {
    "stockVsReal": "stock-heavy" | "real-heavy" | "mixed",
    "aerialRatio": <0-1>,
    "closeupRatio": <0-1>,
    "wideRatio": <0-1>,
    "mediumRatio": <0-1>,
    "brollPattern": "illustrative" | "literal" | "abstract",
    "videoToImageRatio": <0-1>
  },
  "motionGraphics": {
    "density": "none" | "low" | "medium" | "high",
    "preferredTypes": ["<from our supported list only>"],
    "avoidTypes": [],
    "frequencyPerMinute": <number>,
    "placementTiming": "on-beat" | "regular" | "sparse",
    "textAnimationSpeed": "fast" | "moderate" | "slow",
    "avgDurationOnScreen": <number, seconds>,
    "placementPattern": "with-statement" | "after-statement" | "pre-statement" | "continuous",
    "densityBySection": "<e.g. 'low in intro, high in body, medium in conclusion'>"
  },
  "transitions": {
    "cutRatio": <0-1>,
    "crossfadeRatio": <0-1>,
    "otherRatio": <0-1>,
    "preferredTypes": ["<from our supported list>"],
    "avgTransitionDuration": <number, seconds>
  },
  "effects": {
    "closestPreset": "<name of our closest effect preset, or 'none'>",
    "colorTemperature": "warm" | "neutral" | "cool",
    "contrastLevel": "low" | "normal" | "high",
    "effectCoverage": <0-1>
  },
  "colorPalette": {
    "primary": "<hex, e.g. '#1a1a2e'>",
    "secondary": "<hex>",
    "accent": "<hex>",
    "text": "<hex>",
    "textShadow": "<hex or 'none'>",
    "mood": "dark-moody" | "light-clean" | "warm-earthy" | "cool-tech" | "vibrant-bold" | "muted-desaturated"
  },
  "typography": {
    "sizeStyle": "large-bold" | "medium" | "small-clean",
    "animationType": "pop" | "slide" | "fade" | "typewriter",
    "durationOnScreen": <number, seconds>,
    "colorScheme": "<describe: e.g. 'white text on dark overlays with yellow accents'>",
    "fontFeel": "modern-sans" | "serif-elegant" | "bold-impact" | "monospace" | "handwritten",
    "formatting": "<describe: e.g. 'outlined white text with dark drop shadow, no glow'>"
  },
  "audio": {
    "musicStyle": "cinematic" | "electronic" | "ambient" | "corporate" | "hip-hop" | "orchestral" | "none",
    "musicEnergy": "high" | "medium" | "low" | "none",
    "voiceToMusicRatio": "voice-dominant" | "balanced" | "music-heavy",
    "sfxTypes": ["<whoosh, impact, click, ambient, none>"],
    "sfxDensity": "none" | "sparse" | "moderate" | "heavy",
    "musicChanges": "same-throughout" | "shifts-for-emphasis" | "different-per-section"
  },
  "hook": {
    "style": "cold-open" | "question" | "dramatic-statement" | "montage",
    "duration": <number, seconds>,
    "usesMG": <boolean>
  },
  "cta": {
    "style": "subscribe-prompt" | "fade-out" | "call-to-action" | "none",
    "duration": <number, seconds>
  },
  "systemNotes": [
    {
      "area": "<motionGraphics|effects|transitions|typography|maps|framing|audio|colorPalette|other>",
      "observation": "<what the reference video does>",
      "gap": "<what our system is missing or could improve>",
      "priority": "important" | "nice-to-have"
    }
  ]
}`;
}

// ============ GEMINI CALL ============

async function _analyzeWithGemini(videoPath, onProgress) {
    const fileSizeMB = fs.statSync(videoPath).size / 1024 / 1024;
    const model = _getModel();
    const prompt = _buildExtractionPrompt();
    const useVertex = vertex.isVertexEnabled();

    const keys = useVertex ? ['vertex'] : _getKeys(); // Vertex doesn't rotate API keys
    let lastError = null;

    for (let attempt = 0; attempt < keys.length; attempt++) {
        let apiKey, keyIdx;
        if (useVertex) {
            apiKey = null;
            keyIdx = 0;
        } else {
            const next = _getNextKey();
            if (!next) break;
            apiKey = next.key;
            keyIdx = next.index;
        }

        let uploadedFile = null;
        try {
            let videoPart;
            if (fileSizeMB < 15) {
                if (onProgress) onProgress(40, `Encoding video (inline)...`);
                const base64 = fs.readFileSync(videoPath).toString('base64');
                const mimeType = videoPath.endsWith('.webm') ? 'video/webm' : 'video/mp4';
                videoPart = { inline_data: { mime_type: mimeType, data: base64 } };
                _log(`Using inline video (${fileSizeMB.toFixed(1)}MB)${useVertex ? ' via Vertex AI' : ` with key #${keyIdx + 1}`}`);
            } else {
                if (onProgress) onProgress(40, `Uploading video to ${useVertex ? 'GCS' : 'Gemini'}...`);
                uploadedFile = await _uploadToGemini(videoPath, apiKey);
                videoPart = { file_data: { mime_type: uploadedFile.mimeType, file_uri: uploadedFile.fileUri } };
            }

            if (onProgress) onProgress(65, `Analyzing style with ${useVertex ? 'Vertex AI' : 'Gemini'}...`);

            const body = {
                contents: [{ parts: [{ text: prompt }, videoPart] }],
                generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
            };

            let url, headers;
            if (useVertex) {
                const auth = await vertex.getVertexAuth(model);
                url = auth.url;
                headers = auth.headers;
            } else {
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                headers = { 'Content-Type': 'application/json' };
            }

            const resp = await axios.post(url, body, { headers, timeout: 300000 });
            const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            _log(`${useVertex ? 'Vertex AI' : 'Gemini'} response: ${text.length} chars`);

            // Cleanup uploaded file
            if (uploadedFile) {
                await _deleteGeminiFile(uploadedFile.fileName, apiKey, !!uploadedFile.isGCS);
            }

            return text;

        } catch (err) {
            lastError = err;
            if (useVertex) {
                // Vertex AI: no key rotation, fail directly
                if (uploadedFile) {
                    try { await _deleteGeminiFile(uploadedFile.fileName, apiKey, !!uploadedFile.isGCS); } catch (e) {}
                }
                throw err;
            }
            const quotaKind = _isQuotaError(err);
            if (quotaKind) {
                _markExhausted(keyIdx, quotaKind);
                const status = err.response?.status || '?';
                _log(`Key #${keyIdx + 1} ${quotaKind} (HTTP ${status}) — trying next key`);
                if (uploadedFile) {
                    try { await _deleteGeminiFile(uploadedFile.fileName, apiKey); } catch (e) {}
                }
                // 503 = server overload — wait 10s before trying next key
                if (status === 503) {
                    _log('Waiting 10s for Gemini server recovery...');
                    await new Promise(r => setTimeout(r, 10000));
                }
                continue;
            }
            // Non-quota error — fail fast
            if (uploadedFile) {
                try { await _deleteGeminiFile(uploadedFile.fileName, apiKey); } catch (e) {}
            }
            throw err;
        }
    }

    throw lastError || new Error('All Gemini keys exhausted');
}

// ============ JSON PARSING ============

function _parseProfileJSON(text) {
    if (!text) return null;

    // Try direct parse first
    try {
        return JSON.parse(text.trim());
    } catch (e) {
        // Fall through to extraction
    }

    // Extract JSON block between first { and last }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return null;
    }
    const jsonStr = text.substring(firstBrace, lastBrace + 1);

    try {
        return JSON.parse(jsonStr);
    } catch (e) {
        _log(`JSON parse failed: ${e.message}`);
        // Try to clean common issues: trailing commas, code fences
        const cleaned = jsonStr
            .replace(/```json\s*/g, '')
            .replace(/```\s*/g, '')
            .replace(/,(\s*[}\]])/g, '$1');
        try {
            return JSON.parse(cleaned);
        } catch (e2) {
            _log(`Cleaned JSON parse also failed: ${e2.message}`);
            return null;
        }
    }
}

// ============ PROFILE STORAGE ============

function _sanitizeFilename(name) {
    return (name || 'untitled')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 60)
        .toLowerCase() || 'untitled';
}

function loadStyleProfile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!data || typeof data !== 'object') return null;
        return data;
    } catch (e) {
        _log(`Failed to load profile from ${filePath}: ${e.message}`);
        return null;
    }
}

function saveStyleProfile(profile, dir, overridePath) {
    if (!profile || !dir) throw new Error('saveStyleProfile: profile and dir required');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const fullPath = overridePath
        ? overridePath
        : path.join(dir, `${_sanitizeFilename(profile.name)}.style.json`);
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(profile, null, 2), 'utf8');
    _log(`Saved profile: ${fullPath}`);
    return fullPath;
}

// ============ STYLE BLOCK BUILDER (the key function for prompt injection) ============

/**
 * Convert a structured style profile into a human-readable text block that
 * gets prepended to AI prompts in the build pipeline. This is the ONLY function
 * that converts profile data → prompt text, so the schema can evolve without
 * touching pipeline files.
 */
function buildStyleBlock(profile) {
    if (!profile || typeof profile !== 'object') return '';

    const lines = [`=== STYLE INSPIRATION: "${profile.name || 'Reference'}" ===`];
    if (profile.mergedFrom) {
        lines.push(`Merged from ${profile.mergedFrom} reference videos — represents channel-level style.`);
    }
    lines.push(`Use this as INSPIRATION — it does NOT override niche rules, theme settings, or MG allowlists.`);
    lines.push(`Focus on: pacing feel, footage variety, shot composition, and overall energy.`);
    lines.push('');

    // Pacing — this is where style reference has the strongest influence
    if (profile.pacing) {
        const p = profile.pacing;
        const parts = [];
        if (p.avgSceneDuration) parts.push(`reference averaged ~${p.avgSceneDuration.toFixed(1)}s per scene`);
        if (p.cutsPerMinute) parts.push(`~${p.cutsPerMinute} cuts/min`);
        if (p.rhythm) parts.push(`${p.rhythm} rhythm`);
        if (p.hookDuration) parts.push(`hook: ~${p.hookDuration}s`);
        if (p.ctaDuration) parts.push(`CTA: ~${p.ctaDuration}s`);
        if (parts.length) lines.push(`PACING INSPIRATION: ${parts.join('. ')}. Aim for similar energy.`);

        // Per-section pacing
        if (p.sections) {
            const secParts = [];
            for (const [sec, data] of Object.entries(p.sections)) {
                if (!data) continue;
                const bits = [];
                if (data.avgSceneDuration) bits.push(`~${data.avgSceneDuration.toFixed(1)}s/scene`);
                if (data.energy) bits.push(`${data.energy} energy`);
                if (bits.length) secParts.push(`${sec}: ${bits.join(', ')}`);
            }
            if (secParts.length) lines.push(`  Section pacing: ${secParts.join(' → ')}`);
        }

        // Pacing segments — shows how pacing fluctuates through the video
        if (Array.isArray(p.segments) && p.segments.length > 0) {
            lines.push(`  Pacing flow: ${p.segments.map(s => {
                const dur = `${Math.round(s.startTime || 0)}-${Math.round(s.endTime || 0)}s`;
                const cpm = s.cutsPerMinute ? ` ${s.cutsPerMinute}cpm` : '';
                return `[${dur}${cpm} ${s.energy || '?'}] ${s.label || ''}`;
            }).join(' → ')}`);
        }
    }

    // Footage — strong influence on shot composition and media choices
    if (profile.footage) {
        const f = profile.footage;
        const parts = [];
        if (f.stockVsReal) parts.push(`${f.stockVsReal} footage`);
        if (typeof f.videoToImageRatio === 'number') {
            const vp = Math.round(f.videoToImageRatio * 100);
            parts.push(`${vp}% video / ${100 - vp}% image`);
        }
        const shots = [];
        if (f.wideRatio)    shots.push(`${Math.round(f.wideRatio * 100)}% wide`);
        if (f.closeupRatio) shots.push(`${Math.round(f.closeupRatio * 100)}% closeup`);
        if (f.mediumRatio)  shots.push(`${Math.round(f.mediumRatio * 100)}% medium`);
        if (f.aerialRatio)  shots.push(`${Math.round(f.aerialRatio * 100)}% aerial`);
        if (shots.length) parts.push(shots.join(', '));
        if (f.brollPattern) parts.push(`B-roll: ${f.brollPattern}`);
        if (parts.length) lines.push(`FOOTAGE INSPIRATION: ${parts.join('. ')}.`);
    }

    // Motion Graphics — soft hint, niche allowedMGs takes priority
    if (profile.motionGraphics) {
        const m = profile.motionGraphics;
        const parts = [];
        if (m.density) parts.push(`${m.density} density`);
        if (m.preferredTypes && m.preferredTypes.length) parts.push(`reference used: ${m.preferredTypes.join(', ')}`);
        if (m.placementTiming) parts.push(`${m.placementTiming} placement`);
        if (m.textAnimationSpeed) parts.push(`${m.textAnimationSpeed} text animation`);
        if (m.placementPattern) parts.push(`MGs appear ${m.placementPattern} relative to narration`);
        if (parts.length) lines.push(`MG STYLE (hint only — niche allowlist takes priority): ${parts.join('. ')}.`);
        if (m.densityBySection) lines.push(`  MG density by section: ${m.densityBySection}`);
    }

    // Transitions — soft hint
    if (profile.transitions) {
        const t = profile.transitions;
        const parts = [];
        if (typeof t.cutRatio === 'number') parts.push(`${Math.round(t.cutRatio * 100)}% hard cuts`);
        if (typeof t.crossfadeRatio === 'number' && t.crossfadeRatio > 0.02) parts.push(`${Math.round(t.crossfadeRatio * 100)}% crossfade`);
        if (parts.length) lines.push(`TRANSITIONS: ${parts.join(', ')}.`);
    }

    // Effects — map to our presets
    if (profile.effects) {
        const e = profile.effects;
        const parts = [];
        if (e.closestPreset && e.closestPreset !== 'none') {
            parts.push(`closest preset: "${e.closestPreset}"`);
        }
        if (!e.closestPreset) {
            if (e.grain && e.grain !== 'none') parts.push(`${e.grain} grain`);
            if (e.vignette && e.vignette !== 'none') parts.push(`${e.vignette} vignette`);
        }
        if (e.colorTemperature && e.colorTemperature !== 'neutral') parts.push(`${e.colorTemperature} color`);
        if (e.contrastLevel && e.contrastLevel !== 'normal') parts.push(`${e.contrastLevel} contrast`);
        if (parts.length) lines.push(`EFFECTS INSPIRATION: ${parts.join(', ')}.`);
    }

    // Color Palette
    if (profile.colorPalette) {
        const cp = profile.colorPalette;
        const parts = [];
        if (cp.primary) parts.push(`primary: ${cp.primary}`);
        if (cp.secondary) parts.push(`secondary: ${cp.secondary}`);
        if (cp.accent) parts.push(`accent: ${cp.accent}`);
        if (cp.text) parts.push(`text: ${cp.text}`);
        if (cp.mood) parts.push(`mood: ${cp.mood}`);
        if (parts.length) lines.push(`COLOR PALETTE: ${parts.join(', ')}.`);
        if (cp.textShadow && cp.textShadow !== 'none') lines.push(`  Text shadow: ${cp.textShadow}`);
    }

    // Typography
    if (profile.typography) {
        const ty = profile.typography;
        const parts = [];
        if (ty.sizeStyle) parts.push(`${ty.sizeStyle} text`);
        if (ty.animationType) parts.push(`${ty.animationType} animation`);
        if (ty.fontFeel) parts.push(`${ty.fontFeel} font style`);
        if (ty.colorScheme) parts.push(`colors: ${ty.colorScheme}`);
        if (parts.length) lines.push(`TYPOGRAPHY: ${parts.join(', ')}.`);
        if (ty.formatting) lines.push(`  Text formatting: ${ty.formatting}`);
    }

    // Audio
    if (profile.audio) {
        const a = profile.audio;
        const parts = [];
        if (a.musicStyle && a.musicStyle !== 'none') parts.push(`${a.musicStyle} music`);
        if (a.musicEnergy && a.musicEnergy !== 'none') parts.push(`${a.musicEnergy} energy`);
        if (a.voiceToMusicRatio) parts.push(`${a.voiceToMusicRatio} voice-to-music mix`);
        if (a.sfxDensity && a.sfxDensity !== 'none') parts.push(`${a.sfxDensity} SFX`);
        if (a.sfxTypes && a.sfxTypes.length && a.sfxTypes[0] !== 'none') parts.push(`SFX types: ${a.sfxTypes.join(', ')}`);
        if (a.musicChanges && a.musicChanges !== 'same-throughout') parts.push(`music ${a.musicChanges}`);
        if (parts.length) lines.push(`AUDIO STYLE: ${parts.join(', ')}.`);
    }

    // Hook
    if (profile.hook && profile.hook.style) {
        const h = profile.hook;
        const parts = [`${h.style} style`];
        if (h.duration) parts.push(`~${h.duration}s`);
        if (h.usesMG) parts.push(`with motion graphics`);
        lines.push(`HOOK: ${parts.join(', ')}.`);
    }

    // CTA
    if (profile.cta && profile.cta.style) {
        const c = profile.cta;
        const parts = [`${c.style}`];
        if (c.duration) parts.push(`~${c.duration}s`);
        lines.push(`CTA: ${parts.join(', ')}.`);
    }

    if (profile.summary) {
        lines.push('');
        lines.push(`OVERALL FEEL: ${profile.summary}`);
    }

    // System notes — only important ones
    if (Array.isArray(profile.systemNotes)) {
        const important = profile.systemNotes.filter(n => n.priority === 'important');
        if (important.length > 0) {
            lines.push('');
            lines.push('KEY GAPS (features the reference uses that our system lacks):');
            for (const n of important.slice(0, 5)) {
                lines.push(`  - [${n.area}] ${n.observation} → ${n.gap}`);
            }
        }
    }

    lines.push(`=== END STYLE INSPIRATION ===`);
    return lines.join('\n');
}

// ============ MAIN: analyzeStyle ============

/**
 * Analyze a reference video and extract a structured style profile.
 *
 * @param {string} input - YouTube URL OR local video file path
 * @param {object} options
 *   - name: profile name (defaults to video title or filename)
 *   - saveDir: directory to save .style.json (required)
 *   - onProgress: function(percent, message) for UI updates
 * @returns {Promise<StyleProfile>}
 */
async function analyzeStyle(input, options = {}) {
    if (!input) throw new Error('analyzeStyle: input required (YouTube URL or file path)');
    if (!options.saveDir) throw new Error('analyzeStyle: options.saveDir required');

    const onProgress = options.onProgress || (() => {});
    const isYouTubeUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(input);

    let videoPath = input;
    let title = options.name || '';
    let videoDuration = 0;
    let cleanupTempFile = false;

    onProgress(5, 'Starting analysis...');

    try {
        // Step 1: Download if YouTube URL
        if (isYouTubeUrl) {
            const tempDir = path.join(options.saveDir, '..', 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const tempFile = path.join(tempDir, `style-ref-${Date.now()}.mp4`);
            const dl = await _downloadYouTube(input, tempFile, onProgress);
            videoPath = dl.path;
            title = options.name || dl.title;
            videoDuration = dl.duration;
            cleanupTempFile = true;
        } else {
            if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);
            title = options.name || path.basename(input, path.extname(input));
        }

        // Step 2: Analyze with Gemini
        const responseText = await _analyzeWithGemini(videoPath, onProgress);

        // Step 3: Parse JSON
        onProgress(85, 'Parsing style profile...');
        const parsed = _parseProfileJSON(responseText);
        if (!parsed) {
            throw new Error('Failed to parse Gemini response as JSON. Response: ' + responseText.substring(0, 500));
        }

        // Step 4: Build profile
        const profile = {
            version: 2,
            name: title,
            sourceUrl: isYouTubeUrl ? input : null,
            sourceFile: isYouTubeUrl ? null : input,
            createdAt: new Date().toISOString(),
            ...parsed,
            videoDuration: videoDuration || parsed.videoDuration || 0,
        };

        // Step 5: Save
        onProgress(95, 'Saving style profile...');
        const savedPath = saveStyleProfile(profile, options.saveDir);
        profile.savedPath = savedPath;

        onProgress(100, 'Done');
        return profile;

    } finally {
        // Cleanup temp video
        if (cleanupTempFile && fs.existsSync(videoPath)) {
            try { fs.unlinkSync(videoPath); } catch (e) {}
        }
    }
}

// ============ MULTI-VIDEO LEARNING ============

/**
 * Analyze multiple reference videos and merge into a single channel-level profile.
 * Useful for learning a channel's editing style from 3-5 representative videos.
 *
 * @param {string[]} inputs - Array of YouTube URLs and/or local file paths
 * @param {object} options
 *   - name: merged profile name (e.g. "Channel XYZ Style")
 *   - saveDir: directory to save .style.json
 *   - onProgress: function(percent, message)
 * @returns {Promise<StyleProfile>} merged profile
 */
async function analyzeMultiple(inputs, options = {}) {
    if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
        throw new Error('analyzeMultiple: provide at least one input');
    }
    if (!options.saveDir) throw new Error('analyzeMultiple: options.saveDir required');

    const onProgress = options.onProgress || (() => {});
    const profiles = [];
    const total = inputs.length;

    for (let i = 0; i < total; i++) {
        const input = inputs[i].trim();
        if (!input) continue;

        const pctBase = Math.round((i / total) * 90);
        const pctEnd = Math.round(((i + 1) / total) * 90);

        onProgress(pctBase, `Analyzing video ${i + 1}/${total}...`);

        try {
            const profile = await analyzeStyle(input, {
                saveDir: options.saveDir,
                onProgress: (pct, msg) => {
                    const scaled = pctBase + Math.round((pct / 100) * (pctEnd - pctBase));
                    onProgress(scaled, `[${i + 1}/${total}] ${msg}`);
                },
            });
            profiles.push(profile);
            _log(`Video ${i + 1}/${total} analyzed: "${profile.name}"`);
        } catch (e) {
            _log(`Video ${i + 1}/${total} failed: ${e.message} — skipping`);
        }
    }

    if (profiles.length === 0) {
        throw new Error('All video analyses failed — no profiles to merge');
    }

    if (profiles.length === 1) {
        _log('Only 1 video succeeded — returning as-is (no merge needed)');
        return profiles[0];
    }

    onProgress(92, `Merging ${profiles.length} profiles...`);
    const merged = mergeProfiles(profiles, options.name || 'Channel Style');

    onProgress(96, 'Saving merged profile...');
    const savedPath = saveStyleProfile(merged, options.saveDir);
    merged.savedPath = savedPath;

    onProgress(100, `Merged ${profiles.length} videos into channel profile`);
    return merged;
}

/**
 * Merge multiple style profiles into one by averaging numeric fields,
 * combining arrays (with frequency ranking), and taking majority for enums.
 */
function mergeProfiles(profiles, name) {
    if (!profiles || profiles.length === 0) return null;
    if (profiles.length === 1) return { ...profiles[0], name: name || profiles[0].name };

    const merged = {
        version: 2,
        name: name || 'Merged Style',
        sourceUrls: profiles.map(p => p.sourceUrl || p.sourceFile).filter(Boolean),
        mergedFrom: profiles.length,
        createdAt: new Date().toISOString(),
    };

    // Average numeric fields helper (rounded to 2 decimal places)
    function avgField(getter) {
        const vals = profiles.map(getter).filter(v => typeof v === 'number' && !isNaN(v));
        if (vals.length === 0) return null;
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        return Math.round(avg * 100) / 100;
    }

    // Majority vote for string enum fields
    function majorityField(getter) {
        const counts = {};
        for (const p of profiles) {
            const v = getter(p);
            if (v) counts[v] = (counts[v] || 0) + 1;
        }
        let best = null, bestCount = 0;
        for (const [v, c] of Object.entries(counts)) {
            if (c > bestCount) { best = v; bestCount = c; }
        }
        return best;
    }

    // Ranked union of arrays (by frequency across profiles)
    function rankedUnion(getter) {
        const counts = {};
        for (const p of profiles) {
            const arr = getter(p);
            if (!Array.isArray(arr)) continue;
            for (const v of arr) {
                if (v) counts[v] = (counts[v] || 0) + 1;
            }
        }
        return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(e => e[0]);
    }

    // First non-null value
    function firstVal(getter) {
        for (const p of profiles) {
            const v = getter(p);
            if (v != null) return v;
        }
        return null;
    }

    // Summary — concatenate unique summaries
    const summaries = [...new Set(profiles.map(p => p.summary).filter(Boolean))];
    merged.summary = summaries.length <= 1
        ? (summaries[0] || '')
        : `Merged from ${profiles.length} videos. Common traits: ${summaries[0]}`;

    merged.videoDuration = avgField(p => p.videoDuration);

    // Pacing
    merged.pacing = {
        avgSceneDuration: avgField(p => p.pacing?.avgSceneDuration),
        cutsPerMinute: avgField(p => p.pacing?.cutsPerMinute),
        rhythm: majorityField(p => p.pacing?.rhythm),
        hookDuration: avgField(p => p.pacing?.hookDuration),
        ctaDuration: avgField(p => p.pacing?.ctaDuration),
        sections: _mergeSections(profiles),
        segments: _mergeSegments(profiles),
    };

    // Footage
    merged.footage = {
        stockVsReal: majorityField(p => p.footage?.stockVsReal),
        aerialRatio: avgField(p => p.footage?.aerialRatio),
        closeupRatio: avgField(p => p.footage?.closeupRatio),
        wideRatio: avgField(p => p.footage?.wideRatio),
        mediumRatio: avgField(p => p.footage?.mediumRatio),
        brollPattern: majorityField(p => p.footage?.brollPattern),
        videoToImageRatio: avgField(p => p.footage?.videoToImageRatio),
    };

    // Motion Graphics
    const mgPreferred = rankedUnion(p => p.motionGraphics?.preferredTypes);
    const mgPreferredSet = new Set(mgPreferred);
    merged.motionGraphics = {
        density: majorityField(p => p.motionGraphics?.density),
        preferredTypes: mgPreferred,
        avoidTypes: rankedUnion(p => p.motionGraphics?.avoidTypes).filter(t => !mgPreferredSet.has(t)),
        frequencyPerMinute: avgField(p => p.motionGraphics?.frequencyPerMinute),
        placementTiming: majorityField(p => p.motionGraphics?.placementTiming),
        textAnimationSpeed: majorityField(p => p.motionGraphics?.textAnimationSpeed),
        avgDurationOnScreen: avgField(p => p.motionGraphics?.avgDurationOnScreen),
        placementPattern: majorityField(p => p.motionGraphics?.placementPattern),
        densityBySection: firstVal(p => p.motionGraphics?.densityBySection),
    };

    // Transitions
    merged.transitions = {
        cutRatio: avgField(p => p.transitions?.cutRatio),
        crossfadeRatio: avgField(p => p.transitions?.crossfadeRatio),
        otherRatio: avgField(p => p.transitions?.otherRatio),
        preferredTypes: rankedUnion(p => p.transitions?.preferredTypes),
        avgTransitionDuration: avgField(p => p.transitions?.avgTransitionDuration),
    };

    // Effects
    merged.effects = {
        closestPreset: majorityField(p => p.effects?.closestPreset),
        colorTemperature: majorityField(p => p.effects?.colorTemperature),
        contrastLevel: majorityField(p => p.effects?.contrastLevel),
        effectCoverage: avgField(p => p.effects?.effectCoverage),
    };

    // Color Palette — average hex colors
    merged.colorPalette = _mergeColorPalettes(profiles);

    // Typography
    merged.typography = {
        sizeStyle: majorityField(p => p.typography?.sizeStyle),
        animationType: majorityField(p => p.typography?.animationType),
        durationOnScreen: avgField(p => p.typography?.durationOnScreen),
        colorScheme: firstVal(p => p.typography?.colorScheme),
        fontFeel: majorityField(p => p.typography?.fontFeel),
        formatting: firstVal(p => p.typography?.formatting),
    };

    // Audio
    merged.audio = {
        musicStyle: majorityField(p => p.audio?.musicStyle),
        musicEnergy: majorityField(p => p.audio?.musicEnergy),
        voiceToMusicRatio: majorityField(p => p.audio?.voiceToMusicRatio),
        sfxTypes: rankedUnion(p => p.audio?.sfxTypes),
        sfxDensity: majorityField(p => p.audio?.sfxDensity),
        musicChanges: majorityField(p => p.audio?.musicChanges),
    };

    // Hook
    merged.hook = {
        style: majorityField(p => p.hook?.style),
        duration: avgField(p => p.hook?.duration),
        usesMG: profiles.filter(p => p.hook?.usesMG).length >= profiles.length / 2,
    };

    // CTA
    merged.cta = {
        style: majorityField(p => p.cta?.style),
        duration: avgField(p => p.cta?.duration),
    };

    // System Notes — collect all unique
    const allNotes = [];
    const seenObs = new Set();
    for (const p of profiles) {
        if (!Array.isArray(p.systemNotes)) continue;
        for (const note of p.systemNotes) {
            const key = `${note.area}:${note.observation}`.substring(0, 120);
            if (!seenObs.has(key)) {
                seenObs.add(key);
                allNotes.push(note);
            }
        }
    }
    merged.systemNotes = allNotes;

    return merged;
}

function _mergeSections(profiles) {
    const sections = {};
    for (const sec of ['intro', 'body', 'conclusion']) {
        const durations = profiles.map(p => p.pacing?.sections?.[sec]?.avgSceneDuration).filter(v => typeof v === 'number');
        const energies = profiles.map(p => p.pacing?.sections?.[sec]?.energy).filter(Boolean);
        const dPcts = profiles.map(p => p.pacing?.sections?.[sec]?.durationPercent).filter(v => typeof v === 'number');

        const energyCounts = {};
        for (const e of energies) energyCounts[e] = (energyCounts[e] || 0) + 1;
        let topEnergy = 'medium', topCount = 0;
        for (const [e, c] of Object.entries(energyCounts)) {
            if (c > topCount) { topEnergy = e; topCount = c; }
        }

        sections[sec] = {
            avgSceneDuration: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 100) / 100 : null,
            energy: topEnergy,
            durationPercent: dPcts.length ? Math.round((dPcts.reduce((a, b) => a + b, 0) / dPcts.length) * 100) / 100 : null,
        };
    }
    return sections;
}

/**
 * Merge pacing segments from multiple profiles.
 * Segments are positional (start/end times), so we normalize them to percentages
 * of video duration, then cluster similar positions and average the values.
 * If videos have very different segment patterns, we take the one with the most segments.
 */
function _mergeSegments(profiles) {
    const allSegments = profiles
        .map(p => p.pacing?.segments)
        .filter(s => Array.isArray(s) && s.length > 0);

    if (allSegments.length === 0) return [];
    if (allSegments.length === 1) return allSegments[0];

    // For merge: normalize to % of video, average CPM/energy across similar labels,
    // then take the profile with the richest segment data as the base structure
    const richest = allSegments.reduce((a, b) => a.length >= b.length ? a : b);

    // Average CPM and duration across all profiles' segments by position
    return richest.map((seg, i) => {
        const matching = allSegments.map(segs => segs[i]).filter(Boolean);
        const avgCPM = matching.reduce((s, m) => s + (m.cutsPerMinute || 0), 0) / matching.length;
        const avgDur = matching.reduce((s, m) => s + (m.avgSceneDuration || 0), 0) / matching.length;

        const energyCounts = {};
        for (const m of matching) {
            if (m.energy) energyCounts[m.energy] = (energyCounts[m.energy] || 0) + 1;
        }
        let topEnergy = seg.energy || 'medium';
        let topCount = 0;
        for (const [e, c] of Object.entries(energyCounts)) {
            if (c > topCount) { topEnergy = e; topCount = c; }
        }

        return {
            startTime: seg.startTime,
            endTime: seg.endTime,
            cutsPerMinute: Math.round(avgCPM * 100) / 100,
            avgSceneDuration: Math.round(avgDur * 100) / 100,
            energy: topEnergy,
            label: seg.label,
        };
    });
}

function _hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return null;
    hex = hex.replace(/^#/, '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return null;
    const n = parseInt(hex, 16);
    if (isNaN(n)) return null;
    return { r: (n >> 16) & 0xFF, g: (n >> 8) & 0xFF, b: n & 0xFF };
}

function _rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(c => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');
}

function _avgHexColors(hexArr) {
    const rgbs = hexArr.map(_hexToRgb).filter(Boolean);
    if (rgbs.length === 0) return null;
    const avg = { r: 0, g: 0, b: 0 };
    for (const c of rgbs) { avg.r += c.r; avg.g += c.g; avg.b += c.b; }
    return _rgbToHex(avg.r / rgbs.length, avg.g / rgbs.length, avg.b / rgbs.length);
}

function _mergeColorPalettes(profiles) {
    const palettes = profiles.map(p => p.colorPalette).filter(Boolean);
    if (palettes.length === 0) return null;
    if (palettes.length === 1) return palettes[0];

    const moods = {};
    for (const p of palettes) { if (p.mood) moods[p.mood] = (moods[p.mood] || 0) + 1; }
    let topMood = 'dark-moody', topCount = 0;
    for (const [m, c] of Object.entries(moods)) { if (c > topCount) { topMood = m; topCount = c; } }

    return {
        primary:    _avgHexColors(palettes.map(p => p.primary)) || palettes[0].primary,
        secondary:  _avgHexColors(palettes.map(p => p.secondary)) || palettes[0].secondary,
        accent:     _avgHexColors(palettes.map(p => p.accent)) || palettes[0].accent,
        text:       _avgHexColors(palettes.map(p => p.text)) || palettes[0].text,
        textShadow: palettes.find(p => p.textShadow && p.textShadow !== 'none')?.textShadow || 'none',
        mood: topMood,
    };
}

// ============ COMPARISON MODE ============

/**
 * Compare a style profile against an actual built video plan.
 * Returns a structured report showing: reference did X → build did Y → delta.
 *
 * @param {object} profile - Style profile (from analyzeStyle or loadStyleProfile)
 * @param {object} videoPlan - The video-plan.json content
 * @returns {object} comparison report
 */
function compareWithBuild(profile, videoPlan) {
    if (!profile || !videoPlan) return { error: 'Profile and videoPlan required' };

    const scenes = videoPlan.scenes || [];
    const mgScenes = videoPlan.mgScenes || [];
    const transitions = videoPlan.transitions || [];
    const templateScenes = videoPlan.templateScenes || [];
    const totalDuration = scenes.length > 0
        ? Math.max(...scenes.map(s => s.endTime || 0))
        : 0;

    const report = { sections: [], overallScore: 0, totalChecks: 0, matchCount: 0 };

    function _check(category, field, refValue, buildValue, tolerance) {
        const entry = { category, field, reference: refValue, build: buildValue, match: false, delta: null };
        report.totalChecks++;

        if (refValue == null || buildValue == null) {
            entry.match = true; // can't compare — skip
            report.matchCount++;
        } else if (typeof refValue === 'number' && typeof buildValue === 'number') {
            entry.delta = buildValue - refValue;
            const pctDiff = refValue > 0 ? Math.abs(entry.delta) / refValue : Math.abs(entry.delta);
            entry.match = pctDiff <= (tolerance || 0.3);
            if (entry.match) report.matchCount++;
        } else if (typeof refValue === 'string' && typeof buildValue === 'string') {
            entry.match = refValue.toLowerCase() === buildValue.toLowerCase();
            if (entry.match) report.matchCount++;
        }

        report.sections.push(entry);
        return entry;
    }

    // --- Pacing ---
    if (profile.pacing && scenes.length > 0) {
        const durations = scenes.map(s => (s.endTime || 0) - (s.startTime || 0)).filter(d => d > 0);
        const buildAvgDuration = durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
        const buildCPM = totalDuration > 0 ? (scenes.length / totalDuration) * 60 : 0;

        _check('pacing', 'avgSceneDuration', profile.pacing.avgSceneDuration, +buildAvgDuration.toFixed(1), 0.35);
        _check('pacing', 'cutsPerMinute', profile.pacing.cutsPerMinute, +buildCPM.toFixed(1), 0.35);
    }

    // --- MG Density ---
    if (profile.motionGraphics) {
        const allMGs = [...mgScenes, ...templateScenes];
        const buildMGPerMin = totalDuration > 0 ? (allMGs.length / totalDuration) * 60 : 0;
        _check('motionGraphics', 'frequencyPerMinute', profile.motionGraphics.frequencyPerMinute, +buildMGPerMin.toFixed(1), 0.4);

        const buildDensity = buildMGPerMin < 1 ? 'none' : buildMGPerMin < 3 ? 'low' : buildMGPerMin < 6 ? 'medium' : 'high';
        _check('motionGraphics', 'density', profile.motionGraphics.density, buildDensity);

        // Check MG type usage
        if (profile.motionGraphics.preferredTypes?.length) {
            const buildMGTypes = new Set(allMGs.map(m => m.type).filter(Boolean));
            const matched = profile.motionGraphics.preferredTypes.filter(t => buildMGTypes.has(t));
            _check('motionGraphics', 'preferredTypesUsed',
                profile.motionGraphics.preferredTypes.join(', '),
                `${matched.length}/${profile.motionGraphics.preferredTypes.length} matched: ${matched.join(', ') || 'none'}`);
        }
    }

    // --- Transitions ---
    if (profile.transitions && transitions.length > 0) {
        const cutCount = transitions.filter(t => !t.type || t.type === 'cut' || t.type === 'none').length;
        const crossCount = transitions.filter(t => t.type === 'crossfade' || t.type === 'crossBlur' || t.type === 'dissolve').length;
        const total = transitions.length || 1;
        _check('transitions', 'cutRatio', profile.transitions.cutRatio, +(cutCount / total).toFixed(2), 0.2);
        _check('transitions', 'crossfadeRatio', profile.transitions.crossfadeRatio, +(crossCount / total).toFixed(2), 0.2);
    }

    // --- Effects ---
    if (profile.effects) {
        const scriptCtx = videoPlan.scriptContext || {};
        const buildEffect = scriptCtx.effectPreset || scriptCtx.effect || 'none';
        _check('effects', 'closestPreset', profile.effects.closestPreset, buildEffect);
    }

    // --- Footage ---
    if (profile.footage) {
        const imageScenes = scenes.filter(s => s.mediaType === 'image' || (s.file && /\.(jpg|jpeg|png|webp|gif)$/i.test(s.file)));
        const videoScenes = scenes.filter(s => !imageScenes.includes(s));
        const buildVIRatio = scenes.length > 0 ? videoScenes.length / scenes.length : 1;
        _check('footage', 'videoToImageRatio', profile.footage.videoToImageRatio, +buildVIRatio.toFixed(2), 0.2);
    }

    // Overall score
    report.overallScore = report.totalChecks > 0
        ? Math.round((report.matchCount / report.totalChecks) * 100) : 100;

    return report;
}

/**
 * Format a comparison report as human-readable text for display.
 */
function formatComparison(report) {
    if (!report || report.error) return report?.error || 'No comparison data';

    const lines = [`Style Match Score: ${report.overallScore}% (${report.matchCount}/${report.totalChecks} checks passed)\n`];

    const byCategory = {};
    for (const s of (report.sections || [])) {
        if (!byCategory[s.category]) byCategory[s.category] = [];
        byCategory[s.category].push(s);
    }

    for (const [cat, checks] of Object.entries(byCategory)) {
        lines.push(`${cat.toUpperCase()}:`);
        for (const c of checks) {
            const icon = c.match ? '+' : '-';
            const delta = c.delta != null ? ` (delta: ${c.delta > 0 ? '+' : ''}${typeof c.delta === 'number' ? c.delta.toFixed(1) : c.delta})` : '';
            lines.push(`  ${icon} ${c.field}: reference=${c.reference} → build=${c.build}${delta}`);
        }
    }

    return lines.join('\n');
}

module.exports = {
    analyzeStyle,
    analyzeMultiple,
    mergeProfiles,
    loadStyleProfile,
    saveStyleProfile,
    buildStyleBlock,
    compareWithBuild,
    formatComparison,
    // shared helpers for style-studio-agent.js
    _downloadYouTube,
    _uploadToGemini,
    _deleteGeminiFile,
    _findYtdlp,
    _findFfmpegDir,
    _makeYtdlpEnv,
    _getKeys,
    _getNextKey,
    _markExhausted,
    _isQuotaError,
    _parseProfileJSON,
    _sanitizeFilename,
};
