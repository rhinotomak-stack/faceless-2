/**
 * QA Studio Agent — Full Video Clip Analysis
 *
 * Receives rendered video clips (from ExportPipeline with in/out points) and
 * sends them to Gemini using the native generateContent API with video input.
 * Gemini sees the real composited video: audio, animations, transitions, effects.
 *
 * Two upload paths:
 *   < 15MB  → inline base64 (no upload, immediate)
 *   >= 15MB → Gemini Files API (upload → wait ACTIVE → analyze → delete)
 *
 * READ-ONLY — never writes to video-plan.json.
 */

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const { execFile } = require('child_process');
const config = require('../settings/config');
const vertex = require('../brain/vertex-auth');
const { getNiche } = require('../data/niches');
const { buildQAContextBlock, buildFeatureCatalog } = require('./qa-features-context');
const { filterDisabledSources, sanitizeSourceHint } = require('../media/source-policy');

// ============ LOG ============

function _nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

let _logFile = path.join(__dirname, '..', '..', `qa-studio-${_nowStamp()}.log`);

function initLog(projectDir) {
    try {
        const logsDir = path.join(projectDir || path.join(__dirname, '..', '..'), 'logs');
        if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
        _logFile = path.join(logsDir, `qa-studio-${_nowStamp()}.log`);
        fs.writeFileSync(_logFile, `=== QA Studio Log ===\nStarted : ${new Date().toISOString()}\n\n`);
    } catch (e) {
        _logFile = path.join(__dirname, '..', '..', `qa-studio-${_nowStamp()}.log`);
    }
}

function qaLog(...args) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const line = `[${ts}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`;
    try { fs.appendFileSync(_logFile, line + '\n'); } catch (e) {}
}

function getLogPath() { return _logFile; }

// ============ PROVIDER ============

let _provider = 'gemini';
let _geminiModel = '';

function setProvider(p, model) {
    _provider = p || 'gemini';
    if (model) _geminiModel = model;
    qaLog(`[Studio] Provider set: ${_provider}`);
}
function getProvider() { return _provider; }

// ── Gemini key rotation (multi-key support) ──
let _geminiKeyIndex = 0;
const _geminiKeyExhausted = new Map(); // keyIdx → true (permanent) | timestamp (cooldown end)

function _getGeminiKeys() {
    const keys = config.gemini?.apiKeys || (config.gemini?.apiKey ? [config.gemini.apiKey] : []);
    if (!keys.length) throw new Error('[Studio] No Gemini API key configured');
    return keys;
}

function _getGeminiKey() {
    // Legacy single-key getter (kept for compatibility) — returns first available key
    const next = _getNextGeminiKey();
    if (!next) throw new Error('[Studio] All Gemini keys exhausted');
    return next.key;
}

function _getNextGeminiKey() {
    const keys = _getGeminiKeys();
    const now = Date.now();
    for (let offset = 0; offset < keys.length; offset++) {
        const idx = (_geminiKeyIndex + offset) % keys.length;
        const exh = _geminiKeyExhausted.get(idx);
        if (exh === true) continue; // permanently dead
        if (typeof exh === 'number') {
            if (exh > now) continue; // still in cooldown
            _geminiKeyExhausted.delete(idx); // cooldown expired
        }
        _geminiKeyIndex = idx;
        return { key: keys[idx], index: idx };
    }
    return null;
}

function _markGeminiKeyExhausted(idx, kind) {
    if (kind === 'rate_limited') {
        _geminiKeyExhausted.set(idx, Date.now() + 60_000); // 60s cooldown
        qaLog(`[Gemini] Key #${idx + 1} rate-limited — 60s cooldown`);
    } else {
        _geminiKeyExhausted.set(idx, true);
        qaLog(`[Gemini] Key #${idx + 1} exhausted (permanent for this session)`);
    }
}

function _isGeminiQuotaError(err) {
    const status = err.response?.status;
    if (status === 403) return 'exhausted';
    if (status === 429) return 'rate_limited';
    return null;
}

function _geminiPoolStatus() {
    const keys = _getGeminiKeys();
    const now = Date.now();
    let available = 0;
    for (let i = 0; i < keys.length; i++) {
        const exh = _geminiKeyExhausted.get(i);
        if (exh === true) continue;
        if (typeof exh === 'number' && exh > now) continue;
        available++;
    }
    return { available, total: keys.length };
}

function _getModel() {
    return _geminiModel || config.gemini?.visionModel || 'gemini-2.0-flash';
}

// ============ FILE UPLOAD (Vertex AI → GCS, Regular → Gemini Files API) ============

/**
 * Upload a video file for Gemini analysis.
 * Vertex AI: uploads to GCS, returns gs:// URI.
 * Regular:  uploads to Gemini Files API, polls until ACTIVE.
 */
async function _uploadToGeminiFiles(filePath, apiKey) {
    const mimeType = filePath.endsWith('.webm') ? 'video/webm' : 'video/mp4';
    const displayName = path.basename(filePath);
    const fileSizeMB = fs.statSync(filePath).size / 1024 / 1024;

    // ── Vertex AI path: upload to GCS ──
    if (vertex.isVertexEnabled()) {
        qaLog(`[Upload/Vertex] Uploading ${displayName} (${fileSizeMB.toFixed(1)}MB) to GCS...`);
        const gcs = await vertex.uploadToGCS(filePath, mimeType);
        qaLog(`[Upload/Vertex] Uploaded: ${gcs.gsUri}`);
        return { fileUri: gcs.gsUri, fileName: gcs.objectName, mimeType, isGCS: true };
    }

    // ── Regular Gemini Files API path ──
    const fileData = fs.readFileSync(filePath);

    qaLog(`[Upload] Uploading ${displayName} (${fileSizeMB.toFixed(1)}MB) to Gemini Files API...`);

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
        timeout: 120000,
        maxBodyLength: 2 * 1024 * 1024 * 1024,
        maxContentLength: 2 * 1024 * 1024 * 1024,
    });

    const file = uploadResp.data?.file;
    if (!file?.uri) throw new Error(`[Upload] No file URI in response: ${JSON.stringify(uploadResp.data)}`);

    qaLog(`[Upload] Uploaded: ${file.name} — waiting for ACTIVE state...`);

    // Poll until ACTIVE (usually < 5s for short clips)
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const stateResp = await axios.get(
            `https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${apiKey}`,
            { timeout: 10000 }
        );
        const state = stateResp.data?.state;
        qaLog(`[Upload] File state: ${state} (attempt ${i + 1})`);
        if (state === 'ACTIVE') {
            return { fileUri: file.uri, fileName: file.name, mimeType };
        }
        if (state === 'FAILED') throw new Error('[Upload] File processing failed on Gemini side');
    }
    throw new Error('[Upload] Timed out waiting for file to become ACTIVE');
}

/**
 * Delete an uploaded file (GCS object or Gemini Files API file).
 */
async function _deleteGeminiFile(fileName, apiKey, isGCS) {
    if (isGCS) {
        await vertex.deleteFromGCS(fileName);
        qaLog(`[Upload/Vertex] Deleted GCS object: ${fileName}`);
        return;
    }
    try {
        await axios.delete(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
            { timeout: 10000 }
        );
        qaLog(`[Upload] Deleted remote file: ${fileName}`);
    } catch (e) {
        qaLog(`[Upload] Could not delete remote file ${fileName}: ${e.message}`);
    }
}

// ============ GEMINI GENERATE CONTENT (native API / Vertex AI) ============

async function _geminiGenerateContent(prompt, videoPart, apiKey, model) {
    const body = {
        contents: [{
            parts: [
                { text: prompt },
                videoPart,
            ],
        }],
        generationConfig: {
            maxOutputTokens: 2500,
            temperature: 0.2,
        },
    };

    let url, headers;

    if (vertex.isVertexEnabled()) {
        const auth = await vertex.getVertexAuth(model);
        url = auth.url;
        headers = auth.headers;
        qaLog(`[Gemini/Vertex] Calling ${model} with video input...`);
    } else {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        headers = { 'Content-Type': 'application/json' };
        qaLog(`[Gemini] Calling ${model} with video input...`);
    }

    // Single attempt — no internal retries. Outer loop in analyzeSceneClip
    // handles key rotation; after all keys tried once, Omni fallback kicks in.
    const resp = await axios.post(url, body, {
        headers,
        timeout: 180000,
    });
    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    qaLog(`[Gemini] Response: ${text.length} chars`);
    return text;
}

// ============ QA-ISOLATED QWEN OMNI POOL ============
//
// This pool is COMPLETELY SEPARATE from src/ai-provider.js's QWEN_OMNI_POOL.
// QA Studio gets its own model rotation state so a clip-analyzer exhausted model
// does NOT block QA, and vice versa. Same model list, different exhaustion file.

const QA_OMNI_POOL = [
    'qwen3.5-omni-plus',
    'qwen3.5-omni-plus-2026-03-15',
    'qwen3.5-omni-flash',
    'qwen3.5-omni-flash-2026-03-15',
    'qwen3-omni-flash',
    'qwen3-omni-flash-2025-09-15',
    'qwen-omni-turbo',
    'qwen2.5-omni-7b',
];

const QA_OMNI_REALTIME_POOL = [
    'qwen3.5-omni-plus-realtime',
    'qwen3.5-omni-plus-realtime-2026-03-15',
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-omni-flash-realtime-2026-03-15',
    'qwen3-omni-flash-realtime',
    'qwen3-omni-flash-realtime-2025-09-15',
    'qwen-omni-turbo-realtime',
    'qwen-omni-turbo-realtime-2025-05-08',
];

const QA_OMNI_OPENAI_UNSUPPORTED_POOL = [
    'qwen-omni-turbo-2025-03-26',
];

const _qaRuntimeStateRoot = process.env.YTA_USER_DATA_DIR || path.join(__dirname, '..', '..');
const _qaExhaustedFile = path.join(_qaRuntimeStateRoot, '.qa-omni-exhausted-models.json');
let _qaExhaustedModels = {}; // { model: true (permanent) | timestamp (cooldown end) }

try {
    if (fs.existsSync(_qaExhaustedFile)) {
        _qaExhaustedModels = JSON.parse(fs.readFileSync(_qaExhaustedFile, 'utf8'));
        const dead = Object.keys(_qaExhaustedModels).filter(k => _qaExhaustedModels[k] === true).length;
        if (dead > 0) qaLog(`[QA Omni] ${dead} models permanently exhausted (loaded from disk)`);
    }
} catch (e) { /* fresh start */ }

function _qaSaveExhausted() {
    try { fs.writeFileSync(_qaExhaustedFile, JSON.stringify(_qaExhaustedModels, null, 2)); } catch (e) {}
}

function _qaIsQuotaError(err) {
    const status = err.response?.status;
    let data = err.response?.data || {};
    if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch (_) { data = { message: data }; }
    }
    const code = String(data.error?.code || data.code || '').toLowerCase();
    const msg = String(data.error?.message || data.message || err.message || '').toLowerCase();
    if (
        code.includes('allocationquota.freetieronly') ||
        code.includes('quotaexceeded.freetier') ||
        msg.includes('allocationquota.freetieronly') ||
        msg.includes('quotaexceeded.freetier') ||
        msg.includes('free tier quota') ||
        msg.includes('free tier of the model has been exhausted')
    ) return 'exhausted';
    if (status === 429) return 'rate_limited';
    if (status === 400 || status === 403 || status === 404 || status >= 500) return 'rate_limited';
    return null;
}

function _qaMarkExhausted(model, reason) {
    if (reason === 'exhausted') {
        _qaExhaustedModels[model] = true;
        _qaSaveExhausted();
        qaLog(`[QA Omni] ${model} — quota exhausted (permanent)`);
    } else {
        _qaExhaustedModels[model] = Date.now() + 60000;
        qaLog(`[QA Omni] ${model} — rate limited (60s cooldown)`);
    }
}

function _qaGetAvailableModel() {
    const now = Date.now();
    for (const model of QA_OMNI_POOL) {
        const state = _qaExhaustedModels[model];
        if (!state) return model;
        if (state === true) continue;
        if (state < now) return model;
    }
    return null;
}

function _qaPoolStatus() {
    const now = Date.now();
    let available = 0;
    for (const model of QA_OMNI_POOL) {
        const state = _qaExhaustedModels[model];
        if (!state || (state !== true && state < now)) available++;
    }
    return { available, total: QA_OMNI_POOL.length };
}

// ============ FRAME EXTRACTION (for Qwen Omni) ============
//
// Qwen Omni accepts an array of image frames as a "video sequence" — NOT a video file.
// Extract N evenly-spaced frames from the rendered clip and base64-encode them.

function _resolveFfmpeg() {
    try {
        const p = require('ffmpeg-static');
        if (p && fs.existsSync(p)) return p;
    } catch (e) {}
    if (process.platform === 'win32' && fs.existsSync('C:\\ffmg\\bin\\ffmpeg.exe')) {
        return 'C:\\ffmg\\bin\\ffmpeg.exe';
    }
    return 'ffmpeg'; // PATH lookup
}

async function _probeDuration(ffmpegPath, videoPath) {
    return new Promise((resolve) => {
        execFile(ffmpegPath, ['-i', videoPath], { timeout: 10000, windowsHide: true }, (err, _stdout, stderr) => {
            // ffmpeg writes duration to stderr even on success
            const m = (stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
            if (m) resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
            else resolve(0);
        });
    });
}

async function _extractFramesFromClip(clipPath, frameCount = 5) {
    const ffmpegPath = _resolveFfmpeg();
    const duration = await _probeDuration(ffmpegPath, clipPath);
    if (!duration || duration <= 0) {
        qaLog(`[QA Omni] Could not probe duration for ${path.basename(clipPath)}`);
        return [];
    }

    const tmpDir = path.dirname(clipPath);
    const baseName = path.basename(clipPath, path.extname(clipPath));
    const frames = [];

    // Evenly spaced timestamps, skipping the very start and very end
    for (let i = 0; i < frameCount; i++) {
        const t = duration * ((i + 0.5) / frameCount);
        const framePath = path.join(tmpDir, `${baseName}-qa-frame-${i}.jpg`);

        try {
            await new Promise((resolve, reject) => {
                execFile(ffmpegPath, [
                    '-ss', t.toFixed(2),
                    '-i', clipPath,
                    '-vf', 'scale=768:-1',
                    '-frames:v', '1',
                    '-q:v', '5',
                    '-y', framePath,
                ], { timeout: 15000, windowsHide: true }, (err) => err ? reject(err) : resolve());
            });
            if (fs.existsSync(framePath)) {
                const buf = fs.readFileSync(framePath);
                frames.push({ base64: buf.toString('base64'), mimeType: 'image/jpeg', timestamp: t, path: framePath });
            }
        } catch (e) {
            qaLog(`[QA Omni] Frame ${i} extraction failed: ${e.message}`);
        }
    }

    return frames;
}

function _cleanupFrames(frames) {
    for (const f of frames) {
        try { fs.unlinkSync(f.path); } catch (e) {}
    }
}

// ============ QWEN OMNI ANALYSIS ============

async function _qwenOmniAnalyze(prompt, frames) {
    if (!config.qwen?.apiKey) {
        throw new Error('No Qwen API key configured');
    }
    if (!frames || frames.length === 0) {
        throw new Error('No frames extracted from clip');
    }

    const baseUrl = config.qwen.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

    const content = [{ type: 'text', text: prompt }];
    for (const frame of frames) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${frame.mimeType};base64,${frame.base64}` },
        });
    }

    const tried = new Set();
    let lastErr;

    for (let attempt = 0; attempt < QA_OMNI_POOL.length; attempt++) {
        const model = _qaGetAvailableModel();
        if (!model || tried.has(model)) {
            throw new Error(`[QA Omni] All models exhausted — ${_qaPoolStatus().available}/${QA_OMNI_POOL.length} available`);
        }
        tried.add(model);

        try {
            qaLog(`[QA Omni] Calling ${model} with ${frames.length} frames...`);
            const response = await axios.post(`${baseUrl}/chat/completions`, {
                model,
                messages: [{ role: 'user', content }],
                max_tokens: 2500,
            }, {
                headers: {
                    'Authorization': `Bearer ${config.qwen.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 60000,
            });

            const text = response.data?.choices?.[0]?.message?.content || '';
            if (text.trim()) {
                qaLog(`[QA Omni] ${model} responded: ${text.length} chars`);
                return text;
            }
            qaLog(`[QA Omni] ${model} returned empty — rotating`);
        } catch (err) {
            lastErr = err;
            const isTimeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.message?.includes('timeout');
            const quotaErr = _qaIsQuotaError(err);
            if (quotaErr) {
                _qaMarkExhausted(model, quotaErr);
                continue;
            }
            if (isTimeout) {
                qaLog(`[QA Omni] Timeout on ${model} — rotating`);
                continue;
            }
            qaLog(`[QA Omni] ${model} failed: ${err.message} — rotating`);
            continue;
        }
    }

    throw new Error(`[QA Omni] All models failed: ${lastErr?.message || 'unknown'}`);
}

// ============ NICHE INTELLIGENCE ============

/**
 * Build the full niche context block for the QA prompt.
 * Pulls live niche data (shotStyle, searchPolicy, keywordRules, allowedMGs)
 * directly from the niches system and merges it with per-niche behavioral rules.
 *
 * @param {string} nicheId  - e.g. 'explainer.crime', 'news.military'
 * @param {Object} niche    - resolved niche object from getNiche()
 * @returns {string} formatted block ready to inject into the prompt
 */
function _buildNicheContext(nicheId, niche) {
    const isNews      = nicheId?.startsWith('news');
    const isExplainer = nicheId?.startsWith('explainer') || nicheId === 'explainer';
    const category    = isNews ? 'Breaking News' : isExplainer ? 'Explainer / Documentary' : 'General';

    const parts = [];

    // ── 1. Niche identity + visual style ──
    parts.push(`NICHE CONTEXT (${nicheId || 'general'} — ${category}):`);
    if (niche.shotStyle) {
        parts.push(`  Visual style : ${niche.shotStyle}`);
    }
    if (niche.preferredMediaType) {
        const mediaNote = niche.preferredMediaType === 'image'
            ? 'static images/photos expected, minimal motion'
            : niche.preferredMediaType === 'video'
            ? 'motion footage expected — a static image clip is less ideal unless historical'
            : 'mix of video and image acceptable';
        parts.push(`  Media type   : ${niche.preferredMediaType} — ${mediaNote}`);
    }
    if (niche.defaultPacing) {
        parts.push(`  Pacing       : ${niche.defaultPacing} — evaluate edit points with this rhythm in mind`);
    }

    // ── 2. Footage quality / avoid terms ──
    if (niche.searchPolicy?.avoidTerms?.length) {
        parts.push(`  Reject if footage contains: ${niche.searchPolicy.avoidTerms.join(', ')}`);
        parts.push(`    → These are always wrong for this niche — flag as CONTEXT poor regardless of narration.`);
    }

    // ── 3. Allowed MGs for this niche ──
    if (niche.allowedMGs?.length) {
        parts.push(`  Allowed MGs  : ${niche.allowedMGs.join(', ')}`);
        if (isNews) {
            parts.push(`    → This is a footage-first niche. Only these 4 overlay types are used. If you see any other MG type on a news scene, note it as unexpected.`);
        } else if (isExplainer) {
            parts.push(`    → Full MG library available for this educational niche. All overlay types are valid.`);
        }
    }

    // ── 4. Category-level behavioral rules ──
    parts.push('');
    if (isNews) {
        parts.push('CATEGORY RULES (Breaking News):');
        parts.push('  - Footage comes from real events. Lower production quality, shaky cam, field camera work, broadcast artifacts = NORMAL — never flag as quality issues.');
        parts.push('  - Baked-in broadcast lower-thirds, chyrons, tickers, subtitles from original broadcasters are VERY COMMON. Apply TYPE A / TYPE B rules carefully.');
        parts.push('  - Context threshold: ONLY mark "poor" if footage has ZERO thematic relation to narration. Imperfect footage of a related real event = "good".');
        parts.push('  - Political leaders, military figures, celebrities in news context = FINE, not a presenter face issue.');
    } else if (isExplainer) {
        parts.push('CATEGORY RULES (Explainer / Documentary):');
        parts.push('  - Expect clean stock B-roll, archival photos, product/process footage, scientific diagrams — high production quality is the standard.');
        parts.push('  - Context threshold: flag "poor" if footage is generic/unrelated to the SPECIFIC topic (e.g. random street for a specific invention).');
        parts.push('  - A person talking vlog-style directly to camera = presenter face = reject, even if discussing the topic.');
        parts.push('  - Replacement sources are niche-specific. Use youtube/reddit/stock/web-image.');
    }

    // ── 5. Sub-niche specific rules ──
    const subRules = _buildSubNicheRules(nicheId);
    if (subRules) {
        parts.push('');
        parts.push(`SUB-NICHE RULES (${nicheId}):`);
        parts.push(subRules);
    }

    // ── 6. Keyword strategy — how to form replacement keywords ──
    if (niche.keywordRules) {
        const kr = niche.keywordRules;
        parts.push('');
        parts.push(`KEYWORD STRATEGY FOR REPLACEMENTS (${kr.strategy}):`);
        parts.push('  Use this strategy when filling REPLACEMENT_KEYWORD:');
        if (kr.rules?.length) {
            kr.rules.forEach(r => parts.push(`  - ${r}`));
        }
        if (kr.examples?.good?.length) {
            parts.push(`  Good: ${kr.examples.good.join(' | ')}`);
        }
        if (kr.examples?.bad?.length) {
            parts.push(`  Bad (never use): ${kr.examples.bad.join(' | ')}`);
        }
    }

    // ── 7. Replacement source guidance ──
    parts.push('');
    parts.push('REPLACEMENT SOURCE RULES:');
    parts.push(_buildReplacementSourceGuidance(nicheId));

    return parts.join('\n');
}

/**
 * Sub-niche specific behavioral rules (what's expected / not expected).
 */
function _buildSubNicheRules(nicheId) {
    switch (nicheId) {
        case 'explainer.crime':
            return [
                '  - Dark moody aesthetics are 100% intentional. Desaturated tones, heavy film grain, dark vignette, sepia = style. NEVER flag as quality issues.',
                '  - Archival photos, crime scene stills, court documents, mugshots, surveillance screenshots = expected, even if they look "low quality".',
                '  - Expected footage: crime scene tape, police cars, courtrooms, dark alleyways, evidence close-ups, case documents.',
            ].join('\n');

        case 'explainer.history':
            return [
                '  - Old/archival quality is INTENTIONAL. Black and white film, sepia photos, scratchy grain, faded colors = era being shown correctly. NEVER flag old archival material as poor quality.',
                '  - Paintings, maps, historical portraits, monument shots, museum artifacts = standard and correct.',
                '  - Slow panning across photos (Ken Burns effect) is deliberate editorial technique — not a static image problem.',
                '  - Films and photos from before 1960 will naturally look grainy and low-res — this is correct.',
            ].join('\n');

        case 'explainer.military':
            return [
                '  - Historical military footage: tanks, aircraft, ships, battlefields, war memorials, military museums, archival war photos = all correct.',
                '  - This is a DOCUMENTARY not breaking news. Live drone strikes, raw combat explosions, frontline chaos = context mismatch (wrong niche).',
                '  - Historical reenactments and archive footage are fine even if dramatized.',
            ].join('\n');

        case 'explainer.politics':
            return [
                '  - Long-form political analysis: parliament/capitol exteriors, summit handshakes, policy document close-ups, trade-route maps, chokepoint aerials, historical leader footage = all correct.',
                '  - This is a DOCUMENTARY / POLICY EXPLAINER, not breaking politics news. Constant podium clips, live hit coverage, ticker-heavy broadcast footage, and generic "breaking news" visuals are usually a weak fit unless used briefly as context.',
                '  - Maps, timelines, treaty visuals, sanctions graphics, and archival government footage are expected and often stronger than generic protest/news montages.',
            ].join('\n');

        case 'explainer.tech':
            return [
                '  - Hardware close-ups, PCB macro shots, data centers, product demos, lab footage, schematic overlays = all correct.',
                '  - Clean AI visualizations (neural network diagrams, abstract data flows) are acceptable UNLESS they have morphing faces or surreal body artifacts.',
                '  - Screen recordings and software UI demos are valid context footage for tech explainers.',
            ].join('\n');

        case 'explainer.nature':
            return [
                '  - High production quality is the standard: cinematic wildlife, slow-motion nature, aerial drone shots, golden-hour landscapes.',
                '  - Low-quality pixelated or clearly amateur nature footage is worth flagging here — premium B-roll is expected.',
                '  - Scientific diagrams, ecosystem infographics = acceptable as B-roll.',
            ].join('\n');

        case 'explainer.business':
            return [
                '  - Corporate offices, trading floors, charts, product shots, company HQ, executive portraits = expected.',
                '  - Educational financial content: chart animations, infographic-style footage, data visualization = correct.',
                '  - Presenter-style talking head = reject even if discussing business topics.',
            ].join('\n');

        case 'explainer.luxury':
            return [
                '  - Premium production quality expected: macro shots with bokeh, smooth panning, elegant warm lighting, gold/black tones.',
                '  - Low-quality, washed-out, or generic lifestyle stock is a weak fit here — flag context if it looks like budget stock photography.',
            ].join('\n');

        case 'explainer.sport':
            return [
                '  - Sports documentary: historical match clips, athlete biographies, behind-the-scenes training footage, stadium establishing shots = all correct.',
                '  - This is DOCUMENTARY sport, not breaking sports news. Transfer rumors, press conferences about current events = wrong niche.',
            ].join('\n');

        case 'explainer.motivation':
            return [
                '  - Cinematic visuals with emotional energy: sunrise/summit shots, runners, silhouettes, dramatic landscapes = correct.',
                '  - Inspirational figure footage: OK if it is documentary-style (them competing, working, achieving) — NOT if they are talking directly to camera.',
            ].join('\n');

        case 'explainer.food':
            return [
                '  - Close-up food photography with shallow depth of field, kitchen prep, ingredient shots = correct.',
                '  - Scientific nutrition content: lab footage, molecular diagrams, health infographics = acceptable.',
            ].join('\n');

        case 'explainer.diy':
            return [
                '  - Hands-on POV shots, tool close-ups, before/after reveals, step-by-step demonstrations = correct.',
                '  - Workshop/garage/kitchen settings with practical demonstrations are the standard.',
            ].join('\n');

        case 'news.military':
            return [
                '  - Raw combat footage, drone strike videos, military convoy footage, press conference clips, satellite imagery = all expected and correct.',
                '  - Lower-quality field-camera footage with foreign-language baked subtitles = NORMAL for this category.',
                '  - Baked-in Arabic or Cyrillic subtitles = TYPE A caption bars — apply caption_shift or scale fix, NOT rejection.',
                '  - For replacements: prefer youtube, then reddit for conflict zone footage.',
            ].join('\n');

        case 'news.politics':
            return [
                '  - Press conferences, parliament/congress sessions, protest marches, diplomatic events, government buildings = all expected.',
                '  - Political leaders in news context = FINE (not a presenter face).',
                '  - For replacements: youtube first, reddit for specific government/regional events.',
            ].join('\n');

        case 'news.celebrity':
            return [
                '  - Red carpet photos, award ceremony clips, paparazzi shots, interview clips, social media content = all correct.',
                '  - PersonIntro templates are VERY COMMON here. Be STRICT about wrong-person mismatches — the exact celebrity must appear.',
                '  - For replacements: youtube or reddit using celebrity name + event.',
            ].join('\n');

        case 'news.economy':
            return [
                '  - Stock market tickers, trading floors, company HQ, oil refineries, shipping ports, central bank buildings = all expected.',
                '  - Charts and data visualizations as B-roll are acceptable for economic news.',
                '  - For replacements: youtube for corporate/market footage, storyblocks for generic business B-roll.',
            ].join('\n');

        case 'news.tech':
            return [
                '  - Product launch events, company campus shots, press conferences, product close-ups, cybersecurity visuals = expected.',
                '  - Screen recordings and product demo footage are valid context footage.',
                '  - For replacements: youtube for tech company footage, bing for news images.',
            ].join('\n');

        case 'news.sport':
            return [
                '  - Press conference podiums, training ground clips, stadium establishing shots, athlete close-ups, trophy ceremonies = all expected.',
                '  - Match/game highlights may have broadcast lower-thirds (scores, player names) — evaluate as TYPE A baked text if at the edge.',
                '  - For replacements: youtube or reddit for sports event footage.',
            ].join('\n');

        default:
            return '';
    }
}

/**
 * Niche-aware replacement source guidance.
 * Provider access is resolved from the niche config and global source policy.
 */
function _buildReplacementSourceGuidance(nicheId) {
    const niche = getNiche(nicheId || 'general');
    const isNews      = nicheId?.startsWith('news');
    const isExplainer = nicheId?.startsWith('explainer') || nicheId === 'explainer';
    const providers = filterDisabledSources(['youtube', 'reddit', 'storyblocks']);

    if (isExplainer) {
        return [
            `  Available: ${providers.join(' | ')}`,
            '  - Archival / historical footage → youtube',
            '  - Generic clean B-roll (landscapes, objects, processes) → storyblocks',
            '  - Specific people / events / products → youtube first, then reddit',
        ].join('\n');
    }

    if (isNews) {
        return [
            `  Available: ${providers.join(' | ')}`,
            '  - Real news events / on-location footage → youtube',
            '  - Celebrity / athlete footage → youtube or reddit',
            '  - Financial / economic visuals → youtube or storyblocks',
            '  - Generic B-roll fallback → storyblocks',
        ].filter(Boolean).join('\n');
    }

    return [
        `  Available: ${providers.join(' | ')}`,
        '  - Real news events / political / military footage → youtube or reddit',
        '  - Historical archive footage → youtube or storyblocks',
        '  - Generic B-roll → storyblocks',
    ].join('\n');
}

// ============ FIX HISTORY ============

function _buildFixHistoryBlock(sceneInfo) {
    const parts = [];
    const fixCount = sceneInfo.qaFixCount || 0;

    if (fixCount > 0 || sceneInfo.qaPriorResults?.length) {
        parts.push(`\n⚠️ FIX HISTORY — This scene has been analyzed before:`);
        parts.push(`  Times fixed: ${fixCount}`);
        if (sceneInfo.qaWasReplaced) parts.push(`  Last action: FOOTAGE REPLACED`);
        else if (sceneInfo.qaWasFixed) parts.push(`  Last action: CROPPED/SCALED`);
        if (sceneInfo.qaLastFixReason) parts.push(`  Fix reason : ${sceneInfo.qaLastFixReason}`);

        if (sceneInfo.qaPriorResults?.length) {
            const prev = sceneInfo.qaPriorResults[0];
            parts.push(`  Prior score: ${prev.score}/10 (${prev.verdict})`);
            if (prev.issues?.length) parts.push(`  Prior issues: ${prev.issues.join(', ')}`);
            if (prev.watermark) parts.push(`  Prior watermark: ${prev.watermark.substring(0, 150)}`);
            if (prev.context) parts.push(`  Prior context: ${prev.context.substring(0, 150)}`);
            if (prev.replacementKeyword) parts.push(`  Replacement used: "${prev.replacementKeyword}"`);
        }

        parts.push(`  → This is a RE-CHECK. The footage you see now may be different from what was scored before.`);
        parts.push(`  → If the previous issue is now FIXED, score accordingly. If the SAME issue persists or a new one appeared, note it.`);

        // Escalation guidance when same watermark persists after crop/scale fix
        if (sceneInfo.qaWasFixed && sceneInfo.qaPriorResults?.length) {
            const prev = sceneInfo.qaPriorResults[0];
            if (prev.issues?.includes('watermark') && (prev.fixStrategy === 'scale' || prev.fixStrategy === 'zoom')) {
                parts.push(`\n  ⚡ ESCALATION: The previous crop/scale fix did NOT fully remove the watermark.`);
                parts.push(`     If you STILL see the same watermark:`);
                parts.push(`     - INCREASE the CROP_FIX percentage significantly (add 8-12% more than before)`);
                parts.push(`     - If the required crop would exceed 25%, switch FIX_STRATEGY to "floating" instead`);
                parts.push(`     - Do NOT repeat the same crop percentage — it already failed once`);
            }
        }
    }

    return parts.length > 0 ? parts.join('\n') : '';
}

// ============ SCENE MAP TRUNCATION ============

/**
 * For large projects (100+ scenes), show full detail for ±10 scenes around the target,
 * and compact summaries for the rest. Marks the current scene with ▶.
 */
function _truncateSceneMap(sceneMap, currentSceneIndex) {
    if (!sceneMap) return '(no scene data)';
    const lines = sceneMap.split('\n');
    if (lines.length <= 40) {
        // Small project — show everything, just mark current
        return lines.map(l => {
            const m = l.match(/^#(\d+)\s/);
            return (m && parseInt(m[1]) === currentSceneIndex) ? `▶ ${l}` : `  ${l}`;
        }).join('\n');
    }

    // Large project — show ±10 neighbours in full, summarize the rest
    const WINDOW = 10;
    const result = [];
    let skipping = false;
    let skipStart = -1;
    let skipCount = 0;

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^#(\d+)\s/);
        const idx = m ? parseInt(m[1]) : i;
        const dist = Math.abs(idx - currentSceneIndex);

        if (dist <= WINDOW) {
            // In window — flush any skip summary first
            if (skipping) {
                result.push(`  ... (${skipCount} scenes omitted: #${skipStart}–#${skipStart + skipCount - 1})`);
                skipping = false;
                skipCount = 0;
            }
            const prefix = idx === currentSceneIndex ? '▶' : ' ';
            result.push(`${prefix} ${lines[i]}`);
        } else {
            if (!skipping) { skipStart = idx; skipping = true; skipCount = 0; }
            skipCount++;
        }
    }
    if (skipping) {
        result.push(`  ... (${skipCount} scenes omitted: #${skipStart}–#${skipStart + skipCount - 1})`);
    }

    return result.join('\n');
}

// ============ FEATURES CONTEXT (auto-captured) ============

function _buildFeaturesBlock(sceneInfo) {
    try {
        const block = buildQAContextBlock(sceneInfo);
        if (!block) return '';
        return `\nSYSTEM FEATURES (auto-detected — DO NOT ignore these when reviewing):\n${block}\n`;
    } catch (e) {
        return '';
    }
}

// ============ PROMPT ============

function _buildPrompt(sceneInfo, ctx) {
    const timeRange = `${sceneInfo.startTime.toFixed(1)}s – ${sceneInfo.endTime.toFixed(1)}s`;
    const duration  = (sceneInfo.endTime - sceneInfo.startTime).toFixed(1);
    const isTemplate    = sceneInfo.sceneType === 'template';
    const isMGScene     = sceneInfo.sceneType === 'motion-graphic';
    const isPersonIntro = isTemplate && (sceneInfo.keyword || '').toLowerCase().includes('personintro');

    // MG context — distinguish VP suggestion from confirmed placed MG
    let mgContextBlock = '';
    if (isMGScene) {
        mgContextBlock = `  MG        : ${sceneInfo.activeMG || sceneInfo.hasMG || 'unknown'} — THIS IS a fullscreen Motion Graphic scene. The entire frame IS the MG. Evaluate the graphic, not footage.`;
    } else if (sceneInfo.activeMG) {
        mgContextBlock = `  Expected MG : ${sceneInfo.activeMG}\n                (The system ATTEMPTED to place this MG on the footage. It may or may not be visible — you MUST visually confirm. If you do NOT see any overlay text/graphic matching this description, report MG_TEXT as "missing" and ANIMATION as "missing — expected MG not visible". Do NOT confirm an MG you cannot actually see.)\n  VP Hint     : ${sceneInfo.vpMgHint || 'same'} (original VP suggestion)`;
    } else if (sceneInfo.vpMgHint) {
        mgContextBlock = `  VP Hint   : ${sceneInfo.vpMgHint} (VP suggested this — but it was NOT placed. Do not expect to see it.)`;
    } else {
        mgContextBlock = `  MG        : none — no Motion Graphic on this scene`;
    }

    // Surrounding scene context
    let surroundBlock = '';
    if (sceneInfo.prevKeyword || sceneInfo.nextKeyword) {
        surroundBlock = `\n  Prev scene: "${sceneInfo.prevKeyword || '—'}"
  Next scene: "${sceneInfo.nextKeyword || '—'}"`;
    }

    const niche = getNiche(ctx.niche || 'general');
    const nicheContextBlock = _buildNicheContext(ctx.niche || 'general', niche);

    return `You are a professional video editor doing a thorough QA review for a faceless YouTube ${ctx.format || 'documentary'} video.

VIDEO CONTEXT:
  Title    : "${ctx.title || 'unknown'}"
  Niche    : ${ctx.niche || 'general'}
  Theme    : ${ctx.themeId || 'standard'}
  Format   : ${ctx.format || 'documentary'}
  Language : ${ctx.projectOverview?.language || 'en'}
  Pacing   : ${ctx.projectOverview?.pacing || 'moderate'}
${ctx.entities?.length ? `  Subjects : ${ctx.entities.slice(0, 10).join(', ')}` : ''}
${ctx.projectOverview?.hook ? `  Hook     : "${ctx.projectOverview.hook}"` : ''}
${ctx.projectOverview?.cta  ? `  CTA      : "${ctx.projectOverview.cta}"`  : ''}

PROJECT OVERVIEW — ${ctx.projectOverview?.totalScenes || '?'} scenes, ${ctx.projectOverview?.totalDuration || '?'}s total, pacing: ${ctx.projectOverview?.pacing || 'moderate'}:
${ctx.projectOverview?.sections?.length ? `Sections: ${ctx.projectOverview.sections.map((s, i) => `[${i}] ${s.label || s.title || s.name || '?'} (${s.startTime?.toFixed?.(1) || '?'}s–${s.endTime?.toFixed?.(1) || '?'}s)`).join(' → ')}\n` : ''}${_truncateSceneMap(ctx.projectOverview?.sceneMap || '', sceneInfo.sceneIndex)}

Use this overview to understand: where the current scene sits in the video flow, what comes before/after, whether footage or MGs are repeating, and whether the pacing fits the video's ${ctx.projectOverview?.pacing || 'moderate'} pacing. The scene you are reviewing is marked with ▶.
${ctx.styleBlock ? `
REFERENCE STYLE BENCHMARK (advisory — use to judge stylistic deviations, NOT to auto-reject):
${ctx.styleBlock}
The video above is being built to match this reference style. When you analyze this scene, note whether the pacing, footage choice, MG density, transitions, or effects deviate significantly from the reference. Add deviation notes under NOTES, but do NOT lower the score solely for stylistic mismatch — only flag actual quality issues (watermarks, wrong context, broken animations, etc.).
` : ''}
${nicheContextBlock}
${_buildFeaturesBlock(sceneInfo)}

HOW THIS APP WORKS — READ BEFORE REVIEWING:
- This is a FACELESS YouTube ${ctx.format || 'documentary'} video. There is NEVER a host/presenter talking to camera. If you see someone talking directly to camera = presenter face = reject immediately.
- The pipeline: AI Director analyzes the script → AI Visual Planner assigns footage keywords + MG types per scene → footage is downloaded from providers (Storyblocks, YouTube, Reddit) → Motion Graphics are composited on top.
- KEYWORDS are AI-generated search queries used to find stock footage. They are approximate matches, NOT exact descriptions. A keyword like "crime scene investigation" may pull footage of police tape, a courtroom, a detective, etc. — all valid. Only flag CONTEXT if the footage has ZERO relation to the narration topic.
- STOCK FOOTAGE: images and clips come from stock providers and may carry watermarks. This is the #1 thing to check.
- 3 composited tracks: V1 (base footage, bottom), V2 (middle overlay), V3 (fullscreen MG or template, top layer).
- MOTION GRAPHICS (MGs): Our app places MGs on top of footage via a compositor. The "Expected MG" field below lists what the system ATTEMPTED to place. However, MGs can FAIL to render — they may be invisible, off-screen, or broken. You MUST visually verify: if Expected MG says "lowerThird" but you see NO text overlay from our system in the clip, report it as MISSING. Do NOT confirm an MG exists just because the metadata says so. If "Expected MG" says "none", we placed ZERO MGs — anything that looks like a lower-third, chyron, headline, or text overlay is BAKED INTO THE SOURCE FOOTAGE from the original broadcaster/channel, NOT from our system.
- BAKED-IN BROADCAST GRAPHICS: News footage from YouTube or Reddit often has burnt-in lower thirds, chyrons, tickers, channel logos, and subtitles from the original broadcast. These are part of the footage itself. Flag them under WATERMARK if they are channel logos/branding (e.g. "MIRROR NOW", "AP", "Reuters"), but do NOT confuse them with our Motion Graphic system.
- When Active MG lists a specific type (e.g. lowerThird, statCounter), ONLY evaluate that specific overlay for animation quality. A stat counter showing "53" mid-clip when it counts to 75 is CORRECT behavior, not broken.
- VISUAL EFFECTS: film grain, dust particles, vignette, chromatic aberration, color grade, light leaks, film scratches = INTENTIONAL STYLE driven by the theme. NEVER flag these as quality issues. A dark, moody, desaturated look on crime/history = 100% intentional.
- FRAMING: rounded frame borders, black letterbox bars, floating video with shadow, cinematic crop = intentional framing choices from the theme. NOT quality issues.
- PEOPLE IN FOOTAGE: historical figures, news subjects, politicians, athletes, celebrities shown in documentary/news context = FINE. Only flag a live presenter talking directly into the camera lens at you.
- TEMPLATE SCENES: some scenes are fully AI-designed graphic screens (infographic, quote card, fact card, stat card, person intro). These have no stock footage — the entire frame is a designed graphic. Do NOT judge them like footage scenes. Evaluate whether the graphic is legible, visually clean, and relevant to the narration.
- PERSON INTRO TEMPLATE — CRITICAL: The template description intentionally does NOT include the person's name — this was hidden to prevent you from confirming it based on context alone. You MUST look at the face visually and identify who you actually see. The PERSON_MATCH field at the bottom of the output will tell you who was expected — but you must form your visual opinion FIRST before reading it. The image search may have downloaded the WRONG PERSON entirely. A modern young man where a historical figure was expected = WRONG PERSON = mismatch.
- TRANSITIONS: transition effects (cross-dissolve, wipe, zoom) are composited ACROSS scene boundaries as a separate pass — they are NOT included in this individual scene clip. The clip ends with a hard cut. Do NOT report "jarring cut" — instead evaluate whether the raw footage itself has a natural visual endpoint (action completing, subject settling, etc.) that would make a good edit point.

SCENE UNDER REVIEW:
  Index     : ${sceneInfo.sceneIndex}
  Type      : ${isTemplate ? 'TEMPLATE (designed graphic screen — no stock footage)' : isMGScene ? 'MOTION GRAPHIC (fullscreen MG overlay — no footage behind it)' : 'footage'}
  Media     : ${sceneInfo.mediaType || 'video'}${sceneInfo.mediaType === 'image' ? ' — this is a STATIC IMAGE, no motion expected' : ''}
  Time      : ${timeRange} (${duration}s)
  Framing   : ${sceneInfo.framingMode || 'fullscreen'}
  Source    : ${sceneInfo.sourceHint || 'stock'}${sceneInfo.sourceHint === 'reddit' ? ' — expect broadcast captures or drone footage' : sceneInfo.sourceHint === 'youtube' ? ' — expect documentary or real-world footage' : sceneInfo.sourceHint === 'web-image' ? ' — this is a web image (photo), not video' : ' — expect cinematic stock B-roll'}
  Keyword   : "${sceneInfo.keyword || 'unknown'}" (AI-generated search query)
${sceneInfo.visualIntent ? `  VP Intent : "${sceneInfo.visualIntent}" (what the Visual Planner described as the ideal footage)` : ''}  Narration : "${(sceneInfo.narrationText || '').substring(0, 500)}"
  Effect    : ${sceneInfo.effectName || 'none'}
${mgContextBlock}${sceneInfo.activeMGList && sceneInfo.activeMGList.length > 1 ? `  All MGs   : ${sceneInfo.activeMGList.join(' / ')}` : ''}${surroundBlock}
${_buildFixHistoryBlock(sceneInfo)}
You are watching the FULL VIDEO CLIP for this scene including narration audio, all animations, and visual overlays.
Watch the entire clip before evaluating.
CRITIQUE DISCIPLINE: anchor every issue to the exact on-screen element and the timestamp where it occurs. Only report defects you can actually see and name a concrete fix for. If something merely looks uncertain or you cannot articulate a specific fix, treat it as an observation under NOTES — do NOT lower the score or reject on vague dissatisfaction or on stylistic taste.

---

WHAT TO CHECK:

1. WATERMARK — Two categories, handled differently:
   a) STOCK AGENCY watermarks: Getty Images, Shutterstock, iStock, Adobe Stock, Pond5, Depositphotos, Dreamstime, Alamy, "Preview", "Sample" text. These are ALWAYS a problem → flag immediately, any position. Center = reject (score 1-2). Edge = croppable (score 3-4).
   b) BROADCAST/NEWS CHANNEL logos: small network/channel logos in corners (CNN, BBC, Republic, RT, Al Jazeera, Fox, NDTV, single-letter logos like "R", "N", etc.), news tickers, "BREAKING" banners, channel name text, timestamp overlays. These are NOT as severe as stock watermarks, but they should still be CROPPED out for a clean look. Score 5-6 (not reject), verdict "review", fix_strategy MUST be "scale" — crop the edge and zoom slightly. NEVER use fix_strategy "flag" for broadcast logos — the footage itself is fine, just crop.
   ⚠ Even if broadcast logos appear on 2 corners (e.g. top-left logo + top-right channel text), they share the SAME top edge — one top crop removes both. FIX_STRATEGY = "scale", NOT "flag".

2. FACE — A live presenter/YouTuber talking directly to camera (NOT news clips, historical footage, documentary subjects, or people shown in context). If someone is speaking directly into the lens in a vlog/presenter style = reject.
   SPECIAL CASE — personIntro templates: The graphic is designed to show a specific named person (see items[] in Active MG/Template). Visually confirm the face shown IS that person. If a generic-looking person, a stock model, or clearly the wrong individual appears where a known historical/public figure was expected, report it here as: "wrong-person — shows [describe what you see] but template names [person from items[]]". This is the most common failure mode for person intro templates.

3. CONTEXT — Does the footage relate to what the narration is saying? Remember: keywords are approximate search queries. Flag ONLY if there is ZERO thematic connection (narration says "space rocket launch" but video shows someone cooking pasta). For template/MG scenes, does the graphic content match the narration topic?
   Always describe specifically what you see in the footage, even if it matches well.

4. AUDIO — Listen carefully to the narration audio:
   - Summarize what the narrator is actually saying (key phrases, topic)
   - Is the voice clear and audible?
   - Does the pacing feel right for the scene length (not cut off, not trailing silence)?
   - Any sudden cuts, silence gaps, distortion, or the wrong section of audio?
   Always write what you heard, even if everything sounds fine.

5. ANIMATION — Watch the full clip carefully:
   a) FLOATING FRAME: ONLY relevant if Framing field above says "floating". If framing is "fullscreen" or "cinematic", there is NO floating panel animation — do not invent one. A cinematic zoom/vignette effect is NOT a floating frame animation.
   b) MOTION GRAPHICS: Check what is listed in "Expected MG" above. If it says "none", we placed no MGs — ignore any baked-in broadcast graphics. If an Expected MG IS listed, VISUALLY VERIFY it exists in the clip. If you cannot see the described overlay, report it as missing.
   c) COUNTERS: If a stat counter is counting up, what final value does it reach?
   d) If nothing animates (fullscreen footage, no active MG), say "none"
   Always describe only what you actually observed — never infer animations that aren't there.

6. QUALITY — ONLY flag genuine technical problems (not style):
   - Footage that is actually out-of-focus or blurry (not grain/vignette)
   - AI-generated video artifacts (morphing faces, impossible geometry, extra limbs)
   - Completely black or frozen frames

7. EDIT POINT — Does this scene's footage have a natural visual endpoint? (action completing, camera settling, etc.) Or does it cut mid-motion in a way that would look bad even WITH a transition effect?

---

SCORING:
9-10: Perfect — footage matches narration, no issues, clean edit point
7-8: Good — minor imperfections, fully acceptable for publish
5-6: Acceptable — notable issue but usable
3-4: Poor — edge watermark that can be cropped out, or minor context mismatch
1-2: Reject — center/unfixable watermark, presenter face, completely black, totally wrong content

BAKED TEXT RULES — baked-in text burned directly into the video pixels (NOT our Motion Graphics):
There are two types — handle them differently:

TYPE A — CAPTION BAR: A subtitle/translation/news-ticker bar along the bottom OR top edge, spanning most of the width, height ≤ 15% of frame. Examples: Arabic subtitles, broadcast news tickers, CNN/BBC lower thirds.
  → FIXABLE. Score 3-4, verdict "review". Choose strategy:
     • caption_shift: if bar height ≤ 10% — crop edge and shift frame up/down to compensate (no zoom, no black bars).
     • scale: if bar height > 10% — crop edge and zoom in to fill the frame (avoids black bar from large shift).
  → CAPTION_CROP: estimate % to fully remove the bar (add 2% margin). e.g. bottom:14

TYPE B — CENTER OVERLAY TEXT: Any text, title card, graphic, or overlay that appears in the CENTER AREA of the frame (roughly the middle 60% height AND middle 60% width). Examples: "ORGANIZED IN 3 DIMENSIONS", marketing slogans, pop-up info boxes, large centered titles burned into the footage, dimension labels like "48 INCH / 56 INCH".
  → NOT FIXABLE regardless of how relevant the text is to the narration. Score 1-2, verdict "reject", FIX_STRATEGY = flag. Must be replaced.
  → Also flag if: text spans >40% of frame width AND >20% of frame height (too large to crop).
  ⚠ CRITICAL — REPLACEMENT REQUIRED: When you detect TYPE B center overlay, you MUST fill REPLACEMENT_KEYWORD with a search term for clean footage WITHOUT the baked-in text. The contextual relevance of the text does NOT matter — the clip is disqualified because it has center-frame text we cannot remove. The RECOMMENDATION must say to replace, not "none needed".

WATERMARK SCORING RULE — read carefully:
- Watermark at an edge/corner (top-left, top-right, bottom-left, bottom-right, top, bottom, left, right) = CROPPABLE. Score 3-4, verdict "review". Do NOT score 1-2 for an edge watermark.
- Watermark in the CENTER of the frame, or spanning full width at 20%+ height = NOT croppable. Score 1-2, verdict "reject". FIX_STRATEGY = flag.
- If FIX_STRATEGY is "scale", "floating", or "caption_shift", the RECOMMENDATION must describe the fix — never say "replace the footage".

CONTEXT MISMATCH RULE:
- If CONTEXT is "poor" → verdict must be "reject" and FIX_STRATEGY = flag (context mismatch always requires replacement).

FIX STRATEGY RULES — after filling CROP_FIX / CAPTION_CROP, choose ONE:
- zoom: JUST zoom in slightly (1.05–1.25x) — NO crop needed. The zoom itself pushes small edge logos/text off-frame. Use when watermarks are SMALL and sit right at the very edge/corner (tiny logos ≤ 5% of frame). CROP_FIX should be "none" with this strategy.
- scale: crop edge watermark(s) + zoom in so frame stays full. Use when watermarks are LARGER (8-25%) and need explicit cropping. This is the DEFAULT for sizable edge/corner watermarks.
- floating: switch to floating card layout. Use when crop > 25% on any axis, or watermarks on 3+ DIFFERENT edges (top+bottom+left = 3 edges). Two corners on the SAME edge (e.g. top-left + top-right) = ONE edge, use "scale" or "zoom" not "floating".
- caption_shift: crop caption bar (≤10%) at top or bottom edge + shift frame to fill gap. Use ONLY for small TYPE A caption bars.
- flag: center text overlay, unfixable watermark, context mismatch, or presenter face. Must replace footage. NEVER use "flag" for broadcast logos or edge watermarks — those are always fixable with zoom or scale.

ZOOM vs SCALE decision:
- Watermark is a tiny corner logo (≤ 5% of frame width/height)? → zoom (no crop, just scale up ~1.1x)
- Watermark is medium-sized text or logo (> 5%)? → scale (explicit crop + auto-zoom to fill)
FLOATING_BG guidance: crime→warm-charcoal, history→slate, modern→soft-gray, minimal→warm-white, standard→soft-beige. Theme is: ${ctx.themeId || 'standard'}.

---

OUTPUT — fill every field, no skipping:

SCENE_SUMMARY: <2-3 sentences: what the narration is saying, what the Visual Planner keyword was trying to find, and what footage actually appears in the clip. This is your interpretation before the verdict.>

SCORE: <1-10>
VERDICT: pass | review | reject
WATERMARK: none | visible <list each watermark separately: location (top-left/top-right/bottom-left/bottom-right/top/bottom/left/right/center) and brand name — e.g. "top-left: Getty Images logo, bottom-right: shutterstock.com text">
CROP_FIX: — One entry PER watermark you listed in WATERMARK. Each entry = "<same location as above>:<crop percent>".
  Rules:
  - ONLY output entries for locations you actually named in WATERMARK above. No extra locations.
  - Estimate % so the watermark is fully outside the frame (add 2-3% margin).
    Small logo = 8-12%, medium text = 12-18%, tall/wide bar = 18-25%
  - If a watermark is center-frame OR spans full width and is taller than 20% → write "flag" for that entry
  - Examples:
    top-left:10, bottom-right:14     (two watermarks, one per entry)
    bottom:18                        (one watermark at bottom)
    top-left:10, bottom:flag         (one croppable, one too large)
  If WATERMARK is "none" → output: none
BAKED_TEXT: none | caption <location: bottom/top, estimated height %> | center_overlay <describe what text says>
  (baked-in text burned into the footage pixels — see BAKED TEXT RULES above. NOT our Motion Graphics.)
CAPTION_CROP: <only if BAKED_TEXT is "caption"> — "bottom:<crop%>" or "top:<crop%>" to fully remove the bar. If BAKED_TEXT is not caption → output: none
FIX_STRATEGY: zoom | scale | floating | caption_shift | flag
  (see FIX STRATEGY RULES above. If WATERMARK is "none" AND BAKED_TEXT is "none" AND CONTEXT is "good" → output: none)
ZOOM_LEVEL: <only if FIX_STRATEGY is "zoom"> — a number between 1.05 and 1.25 (how much to scale up). Small corner logo = 1.08-1.12, slightly larger = 1.15-1.25. Otherwise → output: none
FLOATING_BG: soft-beige | warm-white | soft-gray | slate | warm-charcoal | paper
  (only if FIX_STRATEGY is "floating" — pick the background that fits the theme. Otherwise → output: none)
FACE: none | presenter <describe what you see> | person-in-content <who and context>
CONTEXT: good <describe in 1 sentence what is actually shown in the footage> | poor <what is shown vs what narration says>
AUDIO: ok <summarize what the narrator says, voice clarity, pacing> | mismatch <what's wrong> | silent | glitch <describe>
ANIMATION: ok <describe only what actually animated — floating frame only if Framing=floating, MG only if Active MG is set> | none <fullscreen footage with no active MG = none> | broken <exactly what broke and why>
MG_TEXT: none <no MG was placed by our system on this scene — Active MG is empty> | ok <describe our placed MG text and confirm it's legible — ignore baked-in broadcast graphics> | missing <Expected MG listed above but you CANNOT see it in the clip — it failed to render or is invisible> | cut-off <which of OUR MG text is cut off> | illegible <why our MG text is illegible>
QUALITY: good | poor <specific technical reason — do NOT list style effects>
EDIT_POINT: natural | mid-motion <describe what's happening when it cuts>
${isPersonIntro ? `PERSON_MATCH: — MANDATORY — DO THIS IN ORDER:
  1. LOOK at the face in the graphic RIGHT NOW. Without reading anything else. Describe: age, hair, skin tone, clothing, photo era (old/modern).
  2. From your own knowledge ONLY — who is this person? Do NOT reference the template metadata or scene context. Just: do you recognize this face?
  3. The template was SUPPOSED to show: "${sceneInfo.personIntroExpectedName || 'unknown'}". Is the face you described in step 1-2 actually this person? Be honest — if you cannot confirm visually, say so.
  WARNING: Do NOT just confirm the expected name. If the photo shows a generic-looking person, a stock model, a modern young man, or anyone who does NOT look like "${sceneInfo.personIntroExpectedName || 'the expected person'}", say MISMATCH.
  Output: match <describe what you saw + why you're confident> | mismatch <describe what you actually see vs what was expected> | unrecognizable <describe what you see: age/hair/clothing/era>` : ''}
RECOMMENDATION: <one specific actionable sentence.
  FIX_STRATEGY=zoom: "Zoom in [X]x to push [what] off the edges — no cropping needed."
  FIX_STRATEGY=scale: "Crop [sides] to remove [what] — renderer zooms in to fill the frame."
  FIX_STRATEGY=floating: "Switch to floating card on [bg] background — watermark becomes invisible at card scale."
  FIX_STRATEGY=caption_shift: "Crop [top/bottom] [N]% to remove the caption bar — frame shifts to compensate."
  FIX_STRATEGY=flag, verdict=reject: say to replace the footage and the exact reason (context mismatch / center overlay / presenter face / unfixable watermark). NEVER write "None needed" or say the footage is fine when FIX_STRATEGY is flag — there is ALWAYS a specific reason to replace.
  BAKED_TEXT=center_overlay specifically: say "Replace footage — baked-in center text '[text]' cannot be removed. Search for clean footage without overlaid text."
  NEVER say "replace the footage" when FIX_STRATEGY is scale, floating, or caption_shift.>
REPLACEMENT_DIAGNOSIS: <Only fill if FIX_STRATEGY is "flag". Diagnose WHY the footage failed in one sentence. Was it:
  - Wrong keyword (keyword was too generic / too specific / wrong language / ambiguous)?
  - Wrong source (stock footage has no real events; youtube/reddit needed for actual news footage)?
  - Both? Explain briefly. If not flagged → output: none>
REPLACEMENT_KEYWORD: <Fill when FIX_STRATEGY is "flag" OR BAKED_TEXT is "center_overlay" — MANDATORY in both cases. Suggest a search keyword to find clean footage without baked-in text overlays.
  Rules:
  - Must directly match what the narration is describing (e.g. if narration says "Saudi oil pipeline 1981", use "Saudi Aramco pipeline construction 1981" not "oil infrastructure")
  - Keep it 3-6 words, specific, searchable
  - If the scene needs a real news event or specific person: add their name + event (e.g. "King Khalid Saudi Arabia oil 1980")
  - If not flagged → output: none>
REPLACEMENT_SOURCE: <Only fill if FIX_STRATEGY is "flag". Pick the BEST source for this replacement.
  Use the REPLACEMENT SOURCE RULES from the NICHE CONTEXT block above.
  - If not flagged → output: none>
NOTES: <any other observations worth flagging, or "none">`;
}

// ============ RESPONSE PARSER ============

function _parseResponse(text, sceneIndex) {
    const result = {
        sceneIndex,
        sceneSummary: '',
        score: 7, verdict: 'pass',
        watermark: 'none', watermarkLocation: null,
        face: 'none',
        context: 'good', contextReason: '',
        audio: 'ok',
        animation: 'ok',
        mgText: 'ok',
        quality: 'good',
        transition: 'clean',
        recommendation: '',
        notes: '',
        cropFix: null,       // watermark crop: "bottom:15" | "top:8,right:10" | "flag" | null
        bakedText: 'none',   // "none" | "caption ..." | "center_overlay ..."
        captionCrop: null,   // "bottom:14" | "top:12" | null
        fixStrategy: null,   // zoom | scale | floating | caption_shift | flag | null
        zoomLevel: null,     // 1.05-1.25 (only for zoom strategy)
        floatingBg: 'soft-gray',
        replacementDiagnosis: '',  // why the footage failed
        replacementKeyword: '',    // better search keyword
        replacementSource: '',     // best provider to use
        issues: [],
        rawResponse: text,
    };

    if (!text) return result;

    for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
        const lower = line.toLowerCase();
        const raw   = line.includes(':') ? line.substring(line.indexOf(':') + 1).trim() : '';
        const val   = raw.toLowerCase();

        if (lower.startsWith('scene_summary:')) {
            result.sceneSummary = raw;
        } else if (lower.startsWith('score:')) {
            const m = line.match(/(\d+)/); if (m) result.score = Math.min(10, Math.max(1, parseInt(m[1])));
        } else if (lower.startsWith('verdict:')) {
            result.verdict = val.includes('reject') ? 'reject' : val.includes('review') ? 'review' : 'pass';
        } else if (lower.startsWith('watermark:')) {
            if (!val.startsWith('none')) {
                result.watermark = raw;
                result.issues.push('watermark');
                const m = val.match(/visible\s+([\w-]+)/); result.watermarkLocation = m ? m[1] : 'unknown';
            }
        } else if (lower.startsWith('crop_fix:')) {
            if (!val.startsWith('none')) {
                result.cropFix = val.trim(); // e.g. "bottom:15" | "top:8,right:10" | "bottom-right:12" | "flag"
            }
        } else if (lower.startsWith('baked_text:')) {
            if (!val.startsWith('none')) {
                result.bakedText = raw;
                if (val.startsWith('center_overlay')) result.issues.push('center_overlay');
                else if (val.startsWith('caption'))   result.issues.push('caption_bar');
            }
        } else if (lower.startsWith('caption_crop:')) {
            if (!val.startsWith('none')) result.captionCrop = val.trim();
        } else if (lower.startsWith('fix_strategy:')) {
            const v = val.trim();
            if (v === 'zoom')            result.fixStrategy = 'zoom';
            else if (v === 'floating')   result.fixStrategy = 'floating';
            else if (v === 'flag')       result.fixStrategy = 'flag';
            else if (v.startsWith('caption_shift')) result.fixStrategy = 'caption_shift';
            else if (v !== 'none')       result.fixStrategy = 'scale';
        } else if (lower.startsWith('zoom_level:')) {
            const m = raw.match(/([\d.]+)/);
            if (m) result.zoomLevel = Math.min(1.5, Math.max(1.01, parseFloat(m[1])));
        } else if (lower.startsWith('floating_bg:')) {
            if (!val.startsWith('none')) result.floatingBg = val.trim();
        } else if (lower.startsWith('face:')) {
            if (!val.startsWith('none')) {
                result.face = raw;
                if (val.startsWith('presenter')) result.issues.push('face_presenter');
                if (val.startsWith('wrong-person')) result.issues.push('face_wrong_person');
            }
        } else if (lower.startsWith('context:')) {
            result.context = raw;  // always store full text (e.g. "good — shows military ships in the strait")
            if (val.startsWith('poor')) { result.contextReason = raw.replace(/^poor\s*/i, ''); result.issues.push('context_mismatch'); }
        } else if (lower.startsWith('audio:')) {
            result.audio = raw;    // always store full text (e.g. "ok — narrator describes Iran's naval blockade, clear voice, good pacing")
            if (!val.startsWith('ok')) result.issues.push('audio_issue');
        } else if (lower.startsWith('animation:')) {
            result.animation = raw; // always store full text (e.g. "ok — lower-third 'Strait of Hormuz' slides in at 2s, fully legible")
            if (val.startsWith('broken')) result.issues.push('animation_broken');
        } else if (lower.startsWith('mg_text:')) {
            result.mgText = raw;
            if (!val.startsWith('ok') && !val.startsWith('none')) result.issues.push('mg_text_issue');
        } else if (lower.startsWith('quality:')) {
            result.quality = raw;
            if (!val.startsWith('good')) result.issues.push('quality_poor');
        } else if (lower.startsWith('transition:') || lower.startsWith('edit_point:')) {
            result.transition = raw;
            if (val.startsWith('mid-motion')) result.issues.push('edit_point_midmotion');
        } else if (lower.startsWith('person_match:')) {
            result.personMatch = raw;
            if (val.startsWith('mismatch')) {
                result.issues.push('face_wrong_person');
                // Downgrade the face field so it renders red in the UI
                if (!result.face || result.face === 'none') result.face = raw;
            }
        } else if (lower.startsWith('replacement_diagnosis:')) {
            if (!val.startsWith('none')) result.replacementDiagnosis = raw;
        } else if (lower.startsWith('replacement_keyword:')) {
            if (!val.startsWith('none')) result.replacementKeyword = raw;
        } else if (lower.startsWith('replacement_source:')) {
            if (!val.startsWith('none')) result.replacementSource = sanitizeSourceHint(val.trim(), 'youtube');
        } else if (lower.startsWith('recommendation:')) {
            result.recommendation = raw;
        } else if (lower.startsWith('notes:')) {
            result.notes = val === 'none' ? '' : raw;
        }
    }

    // Context mismatch or center overlay → always reject, always flag
    if (result.issues.includes('context_mismatch') || result.issues.includes('center_overlay')) {
        result.verdict     = 'reject';
        result.fixStrategy = 'flag';
        result.score       = Math.min(result.score, 3);
    }

    // Safety net: AI said "flag" but provided valid edge crop data → override to "scale"
    // Broadcast logos on edges are always croppable — never flag them
    if (result.fixStrategy === 'flag' && result.cropFix && result.cropFix !== 'flag' && result.cropFix !== 'none' &&
        !result.cropFix.includes('flag') && !result.issues.includes('context_mismatch') && !result.issues.includes('center_overlay')) {
        result.fixStrategy = 'scale';
    }

    // Croppable/zoomable watermark → upgrade reject→review
    const hasCroppableFix = result.fixStrategy === 'zoom' ||
                            result.fixStrategy === 'floating' ||
                            result.fixStrategy === 'caption_shift' ||
                            (result.cropFix && result.cropFix !== 'flag' && result.cropFix !== 'none' &&
                             !result.cropFix.includes('flag'));
    if (result.score <= 2 && result.issues.includes('watermark') && hasCroppableFix) {
        result.score   = Math.max(result.score, 3);
        result.verdict = 'review';
    } else if (result.score <= 2) {
        result.verdict = 'reject';
    } else if (result.score <= 5 && result.verdict === 'pass') {
        result.verdict = 'review';
    }

    // Caption bar fixable → upgrade to review
    if (result.issues.includes('caption_bar') && result.captionCrop && result.fixStrategy === 'caption_shift') {
        result.verdict = result.verdict === 'reject' ? 'review' : result.verdict;
        result.score   = Math.max(result.score, 3);
    }

    return result;
}

// ============ MAIN EXPORT ============

/**
 * Analyze a rendered video clip for one scene.
 * Clips are produced by ExportPipeline with in/out points — they include audio.
 *
 * @param {string} clipPath - Absolute path to the rendered .mp4 clip
 * @param {Object} sceneInfo - {sceneIndex, startTime, endTime, keyword, narrationText, sceneType, effectName, hasMG}
 * @param {Object} context   - {title, niche, format, themeId, entities}
 * @returns {Promise<Object>} analysis result (read-only, no writes to plan)
 */
async function analyzeSceneClip(clipPath, sceneInfo, context) {
    if (!fs.existsSync(clipPath)) {
        qaLog(`[Studio] Clip not found: ${clipPath}`);
        return { sceneIndex: sceneInfo.sceneIndex, score: null, verdict: 'error', error: 'Clip file not found', issues: [] };
    }

    const fileSizeMB = fs.statSync(clipPath).size / (1024 * 1024);
    qaLog(`[Studio] Analyzing scene ${sceneInfo.sceneIndex} "${sceneInfo.keyword}" — clip: ${path.basename(clipPath)} (${fileSizeMB.toFixed(1)}MB) via ${_provider}`);

    const prompt = _buildPrompt(sceneInfo, context);
    qaLog(`[Studio] Prompt for scene ${sceneInfo.sceneIndex}:\n${prompt.substring(0, 500)}...`);

    let uploadedFileName = null;
    let uploadedIsGCS = false;
    let apiKey = null;
    let extractedFrames = null;

    try {
        let responseText;

        if (_provider === 'qwen' || _provider === 'qwenOmni') {
            // ── QWEN OMNI PATH (user-selected, no fallback) ──
            const status = _qaPoolStatus();
            qaLog(`[Studio] QA Omni pool: ${status.available}/${status.total} models available`);
            extractedFrames = await _extractFramesFromClip(clipPath, 5);
            if (extractedFrames.length === 0) {
                throw new Error('Failed to extract any frames from clip');
            }
            qaLog(`[Studio] Extracted ${extractedFrames.length} frames from clip`);
            responseText = await _qwenOmniAnalyze(prompt, extractedFrames);

        } else {
            // ── GEMINI PATH (default) — with multi-key rotation + Omni fallback ──
            const gStatus = _geminiPoolStatus();
            qaLog(`[Studio] Gemini key pool: ${gStatus.available}/${gStatus.total} keys available`);

            const model = _getModel();
            const keys = _getGeminiKeys();
            let geminiErr = null;

            // Try each Gemini key (rotate on quota errors)
            for (let attempt = 0; attempt < keys.length; attempt++) {
                const next = _getNextGeminiKey();
                if (!next) break;
                const { key: tryKey, index: keyIdx } = next;

                let attemptUploadedFile = null;
                let attemptUploadedIsGCS = false;
                try {
                    let videoPart;
                    if (fileSizeMB < 15) {
                        const base64 = fs.readFileSync(clipPath).toString('base64');
                        const mimeType = clipPath.endsWith('.webm') ? 'video/webm' : 'video/mp4';
                        videoPart = { inline_data: { mime_type: mimeType, data: base64 } };
                        qaLog(`[Studio] Using inline video (${fileSizeMB.toFixed(1)}MB) with Gemini key #${keyIdx + 1}`);
                    } else {
                        const uploaded = await _uploadToGeminiFiles(clipPath, tryKey);
                        videoPart = { file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.fileUri } };
                        attemptUploadedFile = uploaded.fileName;
                        attemptUploadedIsGCS = !!uploaded.isGCS;
                        qaLog(`[Studio] Using ${uploaded.isGCS ? 'GCS' : 'Files API'} with Gemini key #${keyIdx + 1}`);
                    }

                    responseText = await _geminiGenerateContent(prompt, videoPart, tryKey, model);

                    // Success — record key/file for cleanup, advance round-robin
                    apiKey = tryKey;
                    uploadedFileName = attemptUploadedFile;
                    uploadedIsGCS = attemptUploadedIsGCS;
                    _geminiKeyIndex = (_geminiKeyIndex + 1) % keys.length;
                    geminiErr = null;
                    break;
                } catch (err) {
                    geminiErr = err;
                    // Clean up any uploaded file from this failed attempt
                    if (attemptUploadedFile) {
                        try { await _deleteGeminiFile(attemptUploadedFile, tryKey, attemptUploadedIsGCS); } catch (e) {}
                    }
                    // Always rotate on ANY error — one try per key, then move on.
                    // Quota errors (403/429) also mark the key dead so future scenes skip it.
                    const quotaErr = _isGeminiQuotaError(err);
                    if (quotaErr) {
                        _markGeminiKeyExhausted(keyIdx, quotaErr);
                        qaLog(`[Studio] Gemini key #${keyIdx + 1} hit ${quotaErr} — rotating to next key`);
                    } else {
                        const status = err.response?.status || 'no-status';
                        qaLog(`[Studio] Gemini key #${keyIdx + 1} failed (${status}: ${err.message}) — rotating to next key`);
                    }
                    // Advance the round-robin pointer so the next key is tried in this loop
                    _geminiKeyIndex = (_geminiKeyIndex + 1) % keys.length;
                    continue;
                }
            }

            // Gemini failed (all keys exhausted or non-quota error) → fall back to Omni
            if (!responseText) {
                qaLog(`[Studio] Gemini unavailable (${geminiErr?.message || 'all keys exhausted'}) — falling back to Qwen Omni`);
                try {
                    const oStatus = _qaPoolStatus();
                    qaLog(`[Studio] Fallback QA Omni pool: ${oStatus.available}/${oStatus.total} models available`);
                    extractedFrames = await _extractFramesFromClip(clipPath, 5);
                    if (extractedFrames.length === 0) {
                        throw new Error('Failed to extract any frames from clip');
                    }
                    qaLog(`[Studio] Extracted ${extractedFrames.length} frames for Omni fallback`);
                    responseText = await _qwenOmniAnalyze(prompt, extractedFrames);
                    qaLog(`[Studio] Omni fallback succeeded for scene ${sceneInfo.sceneIndex}`);
                } catch (omniErr) {
                    throw new Error(`Gemini failed (${geminiErr?.message || 'unknown'}); Omni fallback also failed (${omniErr.message})`);
                }
            }
        }

        qaLog(`[Studio] Raw response scene ${sceneInfo.sceneIndex}:\n${responseText}`);

        const result = _parseResponse(responseText, sceneInfo.sceneIndex);

        // Escalation: if scene was previously fixed and same watermark persists, boost crop
        if (sceneInfo.qaWasFixed && sceneInfo.qaPriorResults?.length) {
            const prev = sceneInfo.qaPriorResults[0];
            if (prev.issues?.includes('watermark') && result.issues.includes('watermark')) {
                result._wasFixedBefore = true;
                // Re-run post-processing escalation (the flag was set after initial parse, re-trigger)
                if ((result.fixStrategy === 'scale' || result.fixStrategy === 'zoom') && result.cropFix) {
                    const boosted = result.cropFix.split(',').map(part => {
                        const colonIdx = part.indexOf(':');
                        if (colonIdx === -1) return part;
                        const loc = part.slice(0, colonIdx).trim();
                        const pct = parseInt(part.slice(colonIdx + 1).trim()) || 10;
                        const newPct = Math.min(30, pct + 10);
                        if (newPct > 25) {
                            result.fixStrategy = 'floating';
                            result.cropFix = null;
                            return null;
                        }
                        return `${loc}:${newPct}`;
                    }).filter(Boolean);
                    if (result.fixStrategy !== 'floating' && boosted.length > 0) {
                        result.cropFix = boosted.join(',');
                        qaLog(`[Studio] Escalation: boosted crop to "${result.cropFix}" (watermark persisted after fix #${sceneInfo.qaFixCount || 1})`);
                    } else if (result.fixStrategy === 'floating') {
                        qaLog(`[Studio] Escalation: switched to floating (crop too large after escalation)`);
                    }
                }
            }
        }

        // Fallback: center_overlay scenes must have a replacement keyword for auto-download.
        // If the agent skipped it despite our instructions, use the scene's original keyword.
        if (result.issues.includes('center_overlay') && !result.replacementKeyword && sceneInfo.keyword) {
            result.replacementKeyword = sceneInfo.keyword;
            result.replacementSource  = sanitizeSourceHint(result.replacementSource || sceneInfo.sourceHint || 'storyblocks', 'youtube');
            result.replacementDiagnosis = result.replacementDiagnosis ||
                `Clip has baked-in center-frame text that cannot be removed. Need clean footage without text overlays.`;
            qaLog(`[Studio] center_overlay fallback: using scene keyword "${sceneInfo.keyword}" as replacement`);
        }

        qaLog(`[Studio] Parsed: score=${result.score} verdict=${result.verdict} issues=[${result.issues.join(',')}]`);
        return result;

    } catch (err) {
        qaLog(`[Studio] Scene ${sceneInfo.sceneIndex} failed: ${err.message}`);
        return { sceneIndex: sceneInfo.sceneIndex, score: null, verdict: 'error', error: err.message, issues: [] };
    } finally {
        // Clean up uploaded file from Gemini
        if (uploadedFileName) await _deleteGeminiFile(uploadedFileName, apiKey, uploadedIsGCS);
        // Clean up extracted frames
        if (extractedFrames) _cleanupFrames(extractedFrames);
        // Delete local clip after analysis
        try { fs.unlinkSync(clipPath); qaLog(`[Studio] Deleted local clip: ${path.basename(clipPath)}`); } catch (e) {}
    }
}

module.exports = {
    analyzeSceneClip,
    initLog,
    getLogPath,
    qaLog,
    setProvider,
    getProvider,
};
