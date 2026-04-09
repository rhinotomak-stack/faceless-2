/**
 * Style Learner — Reference Video Analysis
 *
 * Takes a YouTube URL or local video file, sends it to Gemini for full multimodal
 * analysis, and extracts a structured JSON style profile that captures:
 *   pacing, footage style, MG patterns, transitions, effects, typography, hook, CTA
 *
 * The profile is then injected into every AI step of the build pipeline so the
 * generated video matches the editing style of the reference.
 *
 * Reuses Gemini upload pattern from src/qa-studio-agent.js and yt-dlp binary
 * discovery from src/providers/youtube-video.js.
 */

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const config = require('./config');
const vertex = require('./vertex-auth');

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

    const projectRoot = path.join(__dirname, '..');
    const isWin = process.platform === 'win32';
    const bin = isWin ? 'yt-dlp.exe' : 'yt-dlp';
    const candidates = [
        config.youtube?.ytdlpPath || null,
        path.join(projectRoot, 'yt-dlp', bin),
        path.join(projectRoot, bin),
        'yt-dlp',
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ['--version'], {
                timeout: 5000,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            _ytdlpPath = candidate;
            _log(`yt-dlp found: ${candidate}`);
            return _ytdlpPath;
        } catch (e) {
            // try next
        }
    }
    _log('yt-dlp not found — YouTube URL input will fail');
    return null;
}

// ============ YOUTUBE DOWNLOAD ============

/**
 * Download a YouTube video for style analysis. For long videos (>15min), only
 * downloads the first 10 minutes — that's enough to capture the hook, body
 * pacing rhythm, and MG patterns without burning bandwidth.
 */
async function _downloadYouTube(url, outputPath, onProgress) {
    const ytdlp = _findYtdlp();
    if (!ytdlp) throw new Error('yt-dlp not installed. See https://github.com/yt-dlp/yt-dlp');

    // First, get duration so we know whether to truncate
    let duration = 0;
    let title = 'reference';
    try {
        const meta = execFileSync(ytdlp, [
            '--print', '%(duration)s',
            '--print', '%(title)s',
            '--no-warnings',
            url,
        ], { timeout: 30000, encoding: 'utf8', windowsHide: true });
        const lines = meta.trim().split('\n');
        duration = parseInt(lines[0]) || 0;
        title = (lines[1] || 'reference').replace(/[^\w\s-]/g, '').trim() || 'reference';
        _log(`Video metadata: "${title}" (${duration}s)`);
    } catch (e) {
        _log(`Could not fetch metadata: ${e.message}`);
    }

    const args = [
        url,
        '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]',
        '--merge-output-format', 'mp4',
        '--max-filesize', '200M',
        '-o', outputPath,
        '--no-playlist',
        '--no-warnings',
        '--quiet',
    ];

    // Truncate long videos: keep first 10 minutes
    if (duration > 900) {
        args.push('--download-sections', '*0-600');
        _log(`Video > 15min, downloading first 10 minutes only`);
    }

    if (onProgress) onProgress(15, `Downloading reference video...`);

    return new Promise((resolve, reject) => {
        const proc = spawn(ytdlp, args, { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', d => { stderr += d.toString(); });
        proc.on('close', code => {
            if (code === 0 && fs.existsSync(outputPath)) {
                const sizeMB = fs.statSync(outputPath).size / 1024 / 1024;
                _log(`Downloaded: ${outputPath} (${sizeMB.toFixed(1)}MB)`);
                resolve({ path: outputPath, title, duration: Math.min(duration || 600, 600) });
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
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
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
    const EFFECT_PRESETS = require('./effect-presets');
    const presetNames = Object.keys(EFFECT_PRESETS).filter(k => k !== 'none');
    const MG_REGISTRY = require('./mg-registry').MG_REGISTRY || require('./mg-registry');
    const mgTypes = Object.keys(MG_REGISTRY).filter(k => !['listicleCounter', 'progressTracker', 'listicleGrid', 'subscribeCTA'].includes(k));

    return `You are a professional video editor analyzing the EDITING STYLE of a reference video.
Your goal is to extract a style profile that our automated video generation system can use as INSPIRATION for pacing, footage choices, and visual treatment.

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

NICHE CATEGORIES: explainer.* (nature, crime, business, luxury, sport, history, motivation, food, diy, military, tech) and news.* (politics, celebrity, military, economy, tech, sport). Each niche controls which MG types are allowed and footage priority.

MAP SYSTEM: We can show satellite/street maps with markers. If the reference uses maps or geographic visuals, note the style.

Watch the entire video carefully. Then output a STRUCTURED JSON style profile.

ANALYZE THESE ASPECTS:

1. PACING
   - Count scene cuts. Estimate average scene duration in seconds.
   - Calculate cuts per minute.
   - Is the rhythm consistent, varied, or accelerating?
   - How long is the hook (attention-grabbing opening)?
   - How long is the CTA/outro?

2. FOOTAGE
   - Is this stock footage, real/original footage, or mixed?
   - Estimate the ratio of: aerial shots, closeups, wide shots, medium shots (must sum to ~1.0)
   - B-roll pattern: illustrative (shows what's described), literal (matching actions), or abstract
   - Ratio of video clips vs static images

3. MOTION GRAPHICS (text overlays, lower thirds, stat counters, charts)
   - Density: none, low, medium, or high
   - Which types from OUR SUPPORTED LIST appear most?
   - Frequency per minute
   - Placement timing: on-beat (synced to narration), regular (evenly spaced), or sparse
   - Text animation speed: fast, moderate, or slow
   - Average duration each MG stays on screen
   - IMPORTANT: If the video uses MG styles we DON'T support, describe them in systemNotes

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

6. TYPOGRAPHY
   - Size style: large-bold, medium, small-clean
   - Animation type: pop, slide, fade, typewriter
   - How long does text stay on screen?
   - Colors: describe the text color scheme (white on dark, colored accents, etc.)
   - Font feel: modern/sans-serif, serif/elegant, handwritten, monospace, bold/impact

7. HOOK (first 5-15 seconds)
   - Style: cold-open, question, dramatic-statement, montage
   - Duration in seconds
   - Does it use motion graphics?

8. CTA (last 10-20 seconds)
   - Style: subscribe-prompt, fade-out, call-to-action, none
   - Duration in seconds

9. SYSTEM NOTES — CRITICAL
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
    "ctaDuration": <number, seconds>
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
    "avgDurationOnScreen": <number, seconds>
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
  "typography": {
    "sizeStyle": "large-bold" | "medium" | "small-clean",
    "animationType": "pop" | "slide" | "fade" | "typewriter",
    "durationOnScreen": <number, seconds>,
    "colorScheme": "<describe: e.g. 'white text on dark overlays with yellow accents'>",
    "fontFeel": "modern-sans" | "serif-elegant" | "bold-impact" | "monospace" | "handwritten"
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
      "area": "<motionGraphics|effects|transitions|typography|maps|framing|other>",
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
                generationConfig: { maxOutputTokens: 3000, temperature: 0.2 },
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
                _log(`Key #${keyIdx + 1} ${quotaKind} — trying next key`);
                if (uploadedFile) {
                    try { await _deleteGeminiFile(uploadedFile.fileName, apiKey); } catch (e) {}
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

function saveStyleProfile(profile, dir) {
    if (!profile || !dir) throw new Error('saveStyleProfile: profile and dir required');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filename = `${_sanitizeFilename(profile.name)}.style.json`;
    const fullPath = path.join(dir, filename);
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
        if (parts.length) lines.push(`MG STYLE (hint only — niche allowlist takes priority): ${parts.join('. ')}.`);
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
        // Legacy format support (grain/vignette strings from old profiles)
        if (!e.closestPreset) {
            if (e.grain && e.grain !== 'none') parts.push(`${e.grain} grain`);
            if (e.vignette && e.vignette !== 'none') parts.push(`${e.vignette} vignette`);
        }
        if (e.colorTemperature && e.colorTemperature !== 'neutral') parts.push(`${e.colorTemperature} color`);
        if (e.contrastLevel && e.contrastLevel !== 'normal') parts.push(`${e.contrastLevel} contrast`);
        if (parts.length) lines.push(`EFFECTS INSPIRATION: ${parts.join(', ')}.`);
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
            version: 1,
            name: title,
            sourceUrl: isYouTubeUrl ? input : null,
            sourceFile: isYouTubeUrl ? null : input,
            createdAt: new Date().toISOString(),
            videoDuration: parsed.videoDuration || videoDuration || 0,
            ...parsed,
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

module.exports = {
    analyzeStyle,
    loadStyleProfile,
    saveStyleProfile,
    buildStyleBlock,
};
