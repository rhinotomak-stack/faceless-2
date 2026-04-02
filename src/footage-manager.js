const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config');
const { getBackgroundSource } = require('./themes');
const { getNiche, rewriteQuery, getFallbackKeywords, getSearchPolicy } = require('./niches');
const { scoreDownloadedVideo } = require('./smart-segment');
const clipAnalyzer = require('./clip-analyzer');

// ─── Scene-scoped log buffering ──────────────────────────────────────
// When downloading scenes in parallel, logs from different scenes interleave
// making output unreadable. AsyncLocalStorage tracks which scene each async
// call belongs to, buffering output per-scene and flushing as clean blocks.
const _logStorage = new AsyncLocalStorage();
const _originalConsoleLog = console.log.bind(console);

// Import all providers
const PexelsVideoProvider = require('./providers/pexels-video');
const PexelsImageProvider = require('./providers/pexels-image');
const PixabayVideoProvider = require('./providers/pixabay-video');
const PixabayImageProvider = require('./providers/pixabay-image');
const BingImagesProvider = require('./providers/bing-images');
const UnsplashProvider = require('./providers/unsplash');
const GoogleImagesProvider = require('./providers/google-images');
const YouTubeVideoProvider = require('./providers/youtube-video');
const TelegramVideoProvider = require('./providers/telegram-video');
const VKVideoProvider = require('./providers/vk-video');
const RedditVideoProvider = require('./providers/reddit-video');

// Provider type sets (mirrors niches.js for query routing)
const STOCK_PROVIDERS = new Set(['pexels', 'pixabay', 'unsplash']);
const WEB_PROVIDERS = new Set(['bing', 'googleScrape', 'telegram', 'vkVideo', 'reddit']);
const YOUTUBE_PROVIDERS = new Set(['youtube']);
// Providers that do their own pre-download smart segment scoring (via smart-segment.js).
// These skip the post-download segment quality check (but still get relevance scoring).
const PRESCORE_PROVIDERS = new Set(['youtube']);

// ============ MEDIA CACHE (CLIP REUSE) ============

/**
 * In-build media cache — maps keywords to downloaded+scored files.
 * Allows later scenes to reuse already-downloaded media without re-downloading
 * or wasting vision API credits. Especially useful for listicle videos where
 * similar keywords appear across different list items.
 *
 * Key: normalized keyword (lowercase, trimmed)
 * Value: { path, ext, provider, mediaType, mediaWidth, mediaHeight, visionScore, keyword, sceneIndices }
 */
const _mediaCache = new Map();
let _lastCacheHitSceneIndex = -999; // prevent back-to-back reuse

/**
 * Add a successfully downloaded media file to the cache.
 */
function _cacheMedia(keyword, result, visionScore, sceneIndex) {
    const key = keyword.toLowerCase().trim();
    _mediaCache.set(key, {
        ...result,
        visionScore: visionScore || 0,
        keyword,
        sceneIndices: [sceneIndex],
    });
}

/**
 * Try to find a cached media file for the given keyword.
 * Checks exact match first, then looks for partial/similar matches.
 * Returns null if no suitable cache hit, or the cached result + copy path.
 *
 * @param {string} keyword
 * @param {string} mediaType
 * @param {number} sceneIndex - current scene index (to prevent consecutive reuse)
 * @param {string} filenameBase - e.g. 'scene-5'
 * @returns {Object|null} { path, ext, provider, mediaType, mediaWidth, mediaHeight, fromCache: true }
 */
function _checkMediaCache(keyword, mediaType, sceneIndex, filenameBase) {
    if (_mediaCache.size === 0) return null;

    // Prevent back-to-back reuse (consecutive scenes shouldn't show same clip)
    if (Math.abs(sceneIndex - _lastCacheHitSceneIndex) <= 1) return null;

    const keyLower = keyword.toLowerCase().trim();
    const keyWords = keyLower.split(/\s+/).filter(w => w.length > 2);

    let bestMatch = null;
    let bestScore = 0;

    for (const [cachedKey, cached] of _mediaCache) {
        // Must match media type
        if (cached.mediaType !== mediaType) continue;

        // Must still exist on disk
        if (!fs.existsSync(cached.path)) continue;

        // Don't reuse in the immediately previous or next scene
        if (cached.sceneIndices.some(si => Math.abs(si - sceneIndex) <= 1)) continue;

        // Exact keyword match = best
        if (cachedKey === keyLower) {
            bestMatch = cached;
            bestScore = 100;
            break;
        }

        // Partial match: check word overlap (Jaccard-like)
        const cachedWords = cachedKey.split(/\s+/).filter(w => w.length > 2);
        if (cachedWords.length === 0 || keyWords.length === 0) continue;

        const intersection = keyWords.filter(w => cachedWords.includes(w)).length;
        const union = new Set([...keyWords, ...cachedWords]).size;
        const similarity = intersection / union;

        // Need at least 50% word overlap to consider it a match
        if (similarity >= 0.5 && similarity > bestScore) {
            bestMatch = cached;
            bestScore = similarity;
        }
    }

    if (!bestMatch) return null;

    // Copy the cached file to the new scene's filename
    try {
        const ext = bestMatch.ext;
        const destPath = path.join(config.paths.temp, filenameBase + ext);

        // If source and dest are same, just return
        if (destPath === bestMatch.path) return null;

        fs.copyFileSync(bestMatch.path, destPath);
        bestMatch.sceneIndices.push(sceneIndex);
        _lastCacheHitSceneIndex = sceneIndex;

        return {
            path: destPath,
            ext: ext,
            provider: bestMatch.provider + ' (cached)',
            mediaType: bestMatch.mediaType,
            mediaWidth: bestMatch.mediaWidth,
            mediaHeight: bestMatch.mediaHeight,
            fromCache: true,
        };
    } catch {
        return null;
    }
}

/**
 * Clear the media cache (call at start of each build).
 */
function _clearMediaCache() {
    _mediaCache.clear();
    _lastCacheHitSceneIndex = -999;
    _urlBlacklist.clear();
    _urlUseCount.clear();
}

// ============ URL BLACKLIST ============
// Remembers URLs that scored poorly so we don't re-download and re-score them
// across different scenes. Key: URL string, Value: { score, description }
const _urlBlacklist = new Map();

function _blacklistUrl(url, score, description) {
    if (!url) return;
    // Normalize: strip query params for HLS manifests, keep base URL
    const key = url.split('?')[0];
    _urlBlacklist.set(key, { score, description });
}

function _isBlacklisted(url) {
    if (!url) return null;
    const key = url.split('?')[0];
    return _urlBlacklist.get(key) || null;
}

// ============ URL REUSE LIMITER ============
// Tracks how many scenes used each base URL. Doesn't block — signals to try others first.
const MAX_URL_REUSE = 2; // after this many uses, URL is "overused" (deprioritized, not blocked)
const _urlUseCount = new Map(); // key (base URL) → number of scenes it was used in

function _trackUrlUse(url) {
    if (!url) return;
    const key = url.split('?')[0];
    _urlUseCount.set(key, (_urlUseCount.get(key) || 0) + 1);
}

function _getUrlUseCount(url) {
    if (!url) return 0;
    const key = url.split('?')[0];
    return _urlUseCount.get(key) || 0;
}

// ============ INLINE VISION SCORING ============

let _visionEnabled = false;
let _scoreVideoFrame = null;

function enableInlineVision() {
    try {
        const { scoreVideoFrame, isVisionAvailable } = require('./ai-vision');
        if (isVisionAvailable()) {
            _visionEnabled = true;
            _scoreVideoFrame = scoreVideoFrame;
            console.log(`  👁️ Inline vision scoring enabled`);
        }
    } catch {}
}

/**
 * Score a downloaded image or extract frames from video and score them.
 * For videos: extracts 3 frames (at 20%, 50%, 80% of clip) and uses the
 * MINIMUM score — if any frame shows an anchor/person/bad content, reject.
 * Returns { score, description } or null on failure.
 */
async function _scoreDownloadedMedia(filePath, ext, keyword, context) {
    if (!_scoreVideoFrame) return null;
    try {
        const isImage = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext.toLowerCase());
        const isVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(ext.toLowerCase());

        let base64, mimeType;

        if (isImage) {
            const buf = fs.readFileSync(filePath);
            base64 = buf.toString('base64');
            mimeType = ext.toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
        } else if (isVideo) {
            // Extract 3 frames from the downloaded clip to catch mid-clip cuts
            // (e.g., scene starts with ships but cuts to anchor at second 4)
            const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
            const { execFile: _execFile } = require('child_process');
            const { probeDuration: _probe } = require('./smart-segment');

            // Get clip duration
            const clipDuration = await _probe(ffmpegPath, filePath);
            const dur = clipDuration || 8; // fallback 8s for short clips

            // Sample 3 frames: 20%, 50%, 80% of clip
            const sampleTimes = dur >= 4
                ? [Math.floor(dur * 0.2), Math.floor(dur * 0.5), Math.floor(dur * 0.8)]
                : [1]; // very short clip: just 1 frame

            const framePaths = [];
            for (let fi = 0; fi < sampleTimes.length; fi++) {
                const framePath = filePath + `_vision_frame_${fi}.jpg`;
                framePaths.push(framePath);
                await new Promise((resolve) => {
                    _execFile(ffmpegPath, [
                        '-ss', String(sampleTimes[fi]), '-i', filePath,
                        '-vf', 'scale=512:-1', '-frames:v', '1', '-q:v', '3',
                        '-y', framePath
                    ], { timeout: 10000, windowsHide: true }, () => resolve());
                });
            }

            // Score each frame
            let worstScore = 10;
            let worstDesc = '';
            let bestScore = 0;
            let bestDesc = '';
            let scoredCount = 0;
            const allFrameScores = [];

            for (let fi = 0; fi < framePaths.length; fi++) {
                const fp = framePaths[fi];
                if (!fs.existsSync(fp)) continue;
                try {
                    const stat = fs.statSync(fp);
                    if (stat.size < 500) continue;
                    const buf = fs.readFileSync(fp);
                    const b64 = buf.toString('base64');
                    const result = await _scoreVideoFrame(b64, 'image/jpeg', keyword, context);
                    scoredCount++;
                    allFrameScores.push(result.score);

                    if (sampleTimes.length > 1) {
                        console.log(`    👁️ Clip frame ${fi + 1}/${sampleTimes.length} (${sampleTimes[fi]}s): ${result.score}/10 → ${result.description || ''}`);
                    }

                    if (result.score < worstScore) {
                        worstScore = result.score;
                        worstDesc = result.description || '';
                    }
                    if (result.score > bestScore) {
                        bestScore = result.score;
                        bestDesc = result.description || '';
                    }

                    // Fast fail: if this frame scores 0, vision is broken
                    if (fi === 0 && result.score === 0) break;
                } catch (e) {}
                finally {
                    try { fs.unlinkSync(fp); } catch {}
                }
            }

            // Cleanup any remaining frames
            for (const fp of framePaths) {
                try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
            }

            if (scoredCount === 0) return null;

            // Scoring strategy: use MEDIAN instead of minimum.
            // One bad frame (e.g., a text overlay or transition) shouldn't kill a good clip.
            // If 2 of 3 frames score well, the clip is usable.
            let finalScore;
            if (allFrameScores.length >= 3) {
                const sorted = [...allFrameScores].sort((a, b) => a - b);
                finalScore = sorted[Math.floor(sorted.length / 2)]; // median
            } else if (allFrameScores.length === 2) {
                // 2 frames: use lower of the two (conservative)
                finalScore = Math.min(...allFrameScores);
            } else {
                finalScore = worstScore;
            }

            return {
                score: finalScore,
                description: worstScore === bestScore
                    ? worstDesc
                    : `worst: ${worstDesc} (${worstScore}/10) | best: ${bestDesc} (${bestScore}/10) → median: ${finalScore}/10`,
            };
        } else {
            return null;
        }

        return await _scoreVideoFrame(base64, mimeType, keyword, context);
    } catch {
        return null;
    }
}

/**
 * When vision rejects all attempts, ask AI to suggest a better search keyword.
 * Returns { keyword, switchToVideo } or null.
 */
async function _visionSuggestKeyword(failedDescriptions, originalKeyword, context) {
    try {
        const { callAI } = require('./ai-provider');
        const descList = failedDescriptions.map((d, i) => `  ${i + 1}. ${d}`).join('\n');

        // Build rich context so AI can suggest a DIFFERENT angle, not a synonym
        let contextBlock = '';
        if (context.videoTopic) contextBlock += `Video topic: "${context.videoTopic}"\n`;
        if (context.sceneText) contextBlock += `Scene narration: "${context.sceneText}"\n`;
        if (context.eventAnchor) contextBlock += `Specific event: "${context.eventAnchor}"\n`;
        if (context.entities && context.entities.length > 0) contextBlock += `Key entities: ${context.entities.join(', ')}\n`;
        if (context.niche) contextBlock += `Content niche: ${context.niche}\n`;

        // Include previously tried keywords so AI avoids them
        const triedList = context.triedKeywords && context.triedKeywords.length > 0
            ? `\nKeywords already tried (DO NOT repeat or rephrase these): ${context.triedKeywords.map(k => `"${k}"`).join(', ')}`
            : '';

        const response = await callAI(
            `I'm searching for B-roll footage for a scene but ALL results were wrong.

Failed keyword: "${originalKeyword}"
What the search returned:
${descList}
${triedList}

CONTEXT:
${contextBlock}
TASK: Think about what DIFFERENT visual could represent this scene. Don't just rephrase the same concept — suggest a COMPLETELY DIFFERENT ANGLE or RELATED VISUAL.

Examples of good lateral thinking:
- "stressed military personnel ship" fails → try "aircraft carrier crew quarters" or "navy sailors on deck"
- "explosion damage building" fails → try "firefighters rubble rescue" or "aerial destroyed city"
- "economic crisis graph" fails → try "stock market trading floor" or "empty factory warehouse"

Suggest a 3-5 word search keyword that approaches the scene from a DIFFERENT visual angle.
Also say VIDEO if this would work better as a video clip, or IMAGE for a still.

Reply format (exactly 2 lines):
[new search keyword]
[VIDEO or IMAGE]`,
            { maxTokens: 40, systemPrompt: 'You suggest creative alternative search keywords for B-roll footage. Think laterally — find a DIFFERENT visual that still fits the scene context. Be specific and literal. Output ONLY the keyword and media type.' }
        );

        const lines = response.trim().split('\n').filter(l => l.trim());
        if (lines.length === 0) return null;

        const newKeyword = lines[0].replace(/^["']|["']$/g, '').trim();
        const switchToVideo = lines.length > 1 && lines[1].trim().toUpperCase().includes('VIDEO');

        if (!newKeyword || newKeyword.length < 3 || newKeyword.toLowerCase() === originalKeyword.toLowerCase()) return null;

        return { keyword: newKeyword, switchToVideo };
    } catch {
        return null;
    }
}

// ============ CONCURRENCY UTILITY ============

/**
 * Execute async tasks with a concurrency limit.
 * @param {Array<() => Promise>} tasks - Array of async task functions
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in original order
 */
async function parallelWithLimit(tasks, limit) {
    const results = new Array(tasks.length);
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < tasks.length) {
            const i = nextIndex++;
            results[i] = await tasks[i]();
        }
    }

    const workers = [];
    for (let w = 0; w < Math.min(limit, tasks.length); w++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

// Map source keys (from UI) to provider classes
const VIDEO_SOURCE_MAP = {
    pexels: PexelsVideoProvider,
    pixabay: PixabayVideoProvider,
    youtube: YouTubeVideoProvider,
    telegram: TelegramVideoProvider,
    vkVideo: VKVideoProvider,
    reddit: RedditVideoProvider,
};

const IMAGE_SOURCE_MAP = {
    pexels: PexelsImageProvider,
    pixabay: PixabayImageProvider,
    bing: BingImagesProvider,
    unsplash: UnsplashProvider,
    googleScrape: GoogleImagesProvider,
};

// Default provider priority order (when no smart hint available)
const VIDEO_PRIORITY = ['pexels', 'pixabay', 'youtube', 'telegram', 'vkVideo', 'reddit'];
const IMAGE_PRIORITY = ['pexels', 'pixabay', 'bing', 'unsplash', 'googleScrape'];

// ============ SMART SOURCE PRIORITY ============

// AI source hint → provider order (reorders, never adds unchecked sources)
const SOURCE_PRIORITY_MAP = {
    'stock': {
        video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'],
        image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleScrape']
    },
    'youtube': {
        video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'],
        image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
    'web-image': {
        video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'],
        image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
    'news': { // legacy alias — same as telegram
        video: ['telegram', 'reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'],
        image: ['bing', 'googleScrape', 'unsplash', 'pexels', 'pixabay']
    },
    'telegram': {
        video: ['telegram', 'reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'],
        image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
    'reddit': {
        video: ['reddit', 'youtube', 'telegram', 'vkVideo', 'pexels', 'pixabay'],
        image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
};

// Theme-level fallback when AI source hint is missing
const THEME_PRIORITY_MAP = {
    // Factual/news themes → prefer real footage (Telegram, VK, Reddit, YouTube)
    politics:      { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    finance:       { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    business:      { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    technology:    { video: ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    crime:         { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    documentary:   { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    military:      { video: ['telegram', 'reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    war:           { video: ['telegram', 'reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    geopolitics:   { video: ['telegram', 'reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    // Celebrity/entertainment → Reddit has few hosted videos, use as fallback
    celebrity:     { video: ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    // Aesthetic/organic themes → prefer stock footage, Reddit as fallback
    nature:        { video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'], image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleScrape'] },
    travel:        { video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'], image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleScrape'] },
    lifestyle:     { video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'], image: ['pexels', 'unsplash', 'pixabay', 'bing', 'googleScrape'] },
    food:          { video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'], image: ['pexels', 'unsplash', 'pixabay', 'bing', 'googleScrape'] },
    health:        { video: ['pexels', 'pixabay', 'youtube', 'reddit', 'telegram', 'vkVideo'], image: ['pexels', 'unsplash', 'pixabay', 'bing', 'googleScrape'] },
    // Other
    history:       { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    entertainment: { video: ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    sports:        { video: ['reddit', 'youtube', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    diy:           { video: ['youtube', 'reddit', 'telegram', 'vkVideo', 'pexels', 'pixabay'], image: ['bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
};

/**
 * Get smart provider priority order based on AI source hint and video theme.
 * Resolution: source hint → theme fallback → default order.
 * Only reorders — never adds providers that weren't enabled.
 */
function getSmartPriority(sourceHint, mediaType, scriptContext) {
    let order;
    const nicheId = scriptContext?.nicheId;

    // Priority 1: AI per-scene source hint
    if (sourceHint && SOURCE_PRIORITY_MAP[sourceHint]) {
        order = SOURCE_PRIORITY_MAP[sourceHint][mediaType];
    }

    // Priority 2: Niche-based provider priority
    if (!order) {
        if (nicheId) {
            const niche = getNiche(nicheId);
            if (niche.footagePriority && niche.footagePriority[mediaType]) {
                order = niche.footagePriority[mediaType];
            }
        }
    }

    // Priority 3: Legacy theme-based fallback
    if (!order) {
        const theme = (scriptContext?.theme || '').toLowerCase();
        if (theme && THEME_PRIORITY_MAP[theme]) {
            order = THEME_PRIORITY_MAP[theme][mediaType];
        }
    }

    // Priority 4: Default hardcoded order
    if (!order) {
        order = mediaType === 'video' ? VIDEO_PRIORITY : IMAGE_PRIORITY;
    }

    // Make a copy so we don't mutate source arrays
    order = [...order];

    // === POST-FILTERS ===

    // Niche exclusions: remove providers the niche explicitly bans
    // (e.g., sport bans telegram for video — irrelevant military/political results)
    if (nicheId && mediaType === 'video') {
        const niche = getNiche(nicheId);
        if (niche.excludeVideoProviders && niche.excludeVideoProviders.length > 0) {
            const excluded = new Set(niche.excludeVideoProviders);
            order = order.filter(p => !excluded.has(p));
        }
    }

    // Global rule: Bing always first for images (best real-world image results)
    if (mediaType === 'image' && order.includes('bing')) {
        order = ['bing', ...order.filter(p => p !== 'bing')];
    }

    return order;
}

// ============ PROVIDER MANAGEMENT ============

// Active provider instances (persisted across scenes for duplicate tracking)
let videoProviders = [];
let imageProviders = [];
let scriptContextRef = null;

function getEnabledSources() {
    try {
        const raw = process.env.FOOTAGE_SOURCES;
        if (raw) return JSON.parse(raw);
    } catch (e) { }
    // Default: all on except API-key-only ones
    return { pexels: true, pixabay: true, unsplash: true, bing: true, googleScrape: true, youtube: true, telegram: true, vkVideo: true, reddit: true };
}

function initProviders(scriptContext) {
    const enabled = getEnabledSources();
    scriptContextRef = scriptContext || null;

    // Build filtered provider lists based on UI toggles
    videoProviders = VIDEO_PRIORITY
        .filter(key => enabled[key])
        .map(key => new VIDEO_SOURCE_MAP[key]());

    imageProviders = IMAGE_PRIORITY
        .filter(key => enabled[key])
        .map(key => new IMAGE_SOURCE_MAP[key]());

    // Set context on providers that support it (e.g., YouTube for theme-aware queries)
    for (const p of videoProviders) {
        if (p.setContext) p.setContext(scriptContext);
    }

    // Log what's active
    console.log('  📦 Video providers:');
    if (videoProviders.length === 0) console.log('     (none enabled)');
    videoProviders.forEach(p => {
        const status = p.isAvailable() ? '✅' : '⚠️ (no API key)';
        console.log(`     ${status} ${p.name}`);
    });
    console.log('  📦 Image providers:');
    if (imageProviders.length === 0) console.log('     (none enabled)');
    imageProviders.forEach(p => {
        const status = p.isAvailable() ? '✅' : '⚠️ (no API key)';
        console.log(`     ${status} ${p.name}`);
    });

    // Log active search policy
    const nicheId = scriptContext?.nicheId;
    if (nicheId && nicheId !== 'general') {
        const policy = getSearchPolicy(nicheId);
        console.log(`  🔍 Search policy (${nicheId}):`);
        if (policy.contextTerms?.length) console.log(`     context: +${policy.contextTerms.join(', +')}`);
        if (policy.avoidTerms?.length) console.log(`     avoid: -${policy.avoidTerms.join(', -')}`);
        console.log(`     stock max words: ${policy.stockMaxWords || 3} | entity boost: ${policy.entityBoost ? 'on' : 'off'}`);
    }

    // Enable inline vision scoring
    enableInlineVision();
}

// ============ PROVIDER KEY LOOKUP ============

// Reverse map: provider class → key string (for search policy rewriting)
const PROVIDER_CLASS_TO_KEY = new Map();
for (const [key, cls] of Object.entries(VIDEO_SOURCE_MAP)) PROVIDER_CLASS_TO_KEY.set(cls, key);
for (const [key, cls] of Object.entries(IMAGE_SOURCE_MAP)) PROVIDER_CLASS_TO_KEY.set(cls, key);

function getProviderKey(provider) {
    return PROVIDER_CLASS_TO_KEY.get(provider.constructor) || '';
}

// ============ KEYWORD VARIANTS ============

// Common visual synonyms for retry — maps generic terms to more searchable alternatives
const VISUAL_SYNONYMS = {
    'person': ['man', 'woman', 'people'], 'people': ['crowd', 'group', 'audience'],
    'building': ['architecture', 'skyscraper', 'structure'], 'house': ['home', 'residence', 'property'],
    'car': ['vehicle', 'automobile', 'driving'], 'money': ['currency', 'cash', 'finance'],
    'water': ['ocean', 'river', 'waves'], 'city': ['urban', 'downtown', 'skyline'],
    'road': ['highway', 'street', 'path'], 'forest': ['woods', 'trees', 'woodland'],
    'fight': ['conflict', 'battle', 'confrontation'], 'danger': ['risk', 'warning', 'emergency'],
    'police': ['law enforcement', 'officers', 'patrol'], 'crime': ['investigation', 'evidence', 'forensic'],
    'technology': ['digital', 'innovation', 'computing'], 'data': ['analytics', 'statistics', 'graph'],
    'meeting': ['conference', 'discussion', 'boardroom'], 'doctor': ['medical', 'hospital', 'healthcare'],
    'food': ['cuisine', 'cooking', 'restaurant'], 'night': ['dark', 'evening', 'nighttime'],
    'old': ['vintage', 'historic', 'ancient'], 'fast': ['speed', 'racing', 'rapid'],
    'explosion': ['blast', 'detonation', 'debris'], 'fire': ['flames', 'blaze', 'burning'],
    'storm': ['hurricane', 'thunderstorm', 'tempest'], 'mountain': ['peak', 'summit', 'highland'],
    'rich': ['luxury', 'wealth', 'affluent'], 'poor': ['poverty', 'deprived', 'struggling'],
};

/**
 * Generate keyword variants for retry with smarter strategies:
 * 1-4: Mechanical word dropping (original)
 * 5: Longest meaningful word
 * 6: Synonym substitution
 * 7: Broadest 2-word distillation
 */
function getKeywordVariants(keyword) {
    const variants = [];
    const words = keyword.trim().split(/\s+/);

    if (words.length <= 1) return variants;

    // 1. Drop last word
    if (words.length >= 3) variants.push(words.slice(0, -1).join(' '));

    // 2. Drop first word
    if (words.length >= 3) variants.push(words.slice(1).join(' '));

    // 3. Keep only first 2 words
    if (words.length >= 3) variants.push(words.slice(0, 2).join(' '));

    // 4. Keep only last 2 words
    if (words.length >= 3) {
        const last2 = words.slice(-2).join(' ');
        if (!variants.includes(last2)) variants.push(last2);
    }

    // 5. Single most meaningful word (longest = most specific)
    const sorted = [...words].sort((a, b) => b.length - a.length);
    if (!variants.includes(sorted[0])) variants.push(sorted[0]);

    // 6. Synonym substitution — swap first matchable word with a visual synonym
    const lowerWords = words.map(w => w.toLowerCase());
    for (let i = 0; i < lowerWords.length; i++) {
        const syns = VISUAL_SYNONYMS[lowerWords[i]];
        if (syns) {
            const synVariant = [...words];
            synVariant[i] = syns[0];
            const v = synVariant.slice(0, 3).join(' ');
            if (!variants.includes(v)) { variants.push(v); break; }
        }
    }

    // 7. Broadest 2-word distillation — the 2 longest non-stop words
    if (words.length >= 4) {
        const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were']);
        const meaningful = words.filter(w => !STOP.has(w.toLowerCase()) && w.length > 2);
        if (meaningful.length >= 2) {
            const broad = meaningful.sort((a, b) => b.length - a.length).slice(0, 2).join(' ');
            if (!variants.includes(broad)) variants.push(broad);
        }
    }

    return variants;
}

// ============ DIMENSION PROBING ============

const { execFileSync } = require('child_process');

/**
 * Detect dimensions of a media file using ffprobe (derived from ffmpeg-static).
 * Used as fallback when providers don't report width/height (YouTube, some web scrapers).
 */
function probeMediaDimensions(filePath) {
    try {
        let ffprobePath = 'ffprobe';
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
                if (!fs.existsSync(ffprobePath)) ffprobePath = 'ffprobe';
            }
        } catch (e) { /* use system ffprobe */ }

        const result = execFileSync(ffprobePath, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'json', filePath
        ], { timeout: 10000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

        const data = JSON.parse(result.toString());
        const stream = data.streams?.[0];
        if (stream && stream.width && stream.height) {
            return { width: stream.width, height: stream.height };
        }
    } catch (e) { /* ffprobe not available or failed */ }
    return null;
}

// ============ KEYWORD VALIDATION ============

/**
 * Validate and fix AI-generated keywords before searching.
 * Catches common AI mistakes that waste API calls.
 */
function validateKeyword(keyword, scene) {
    if (!keyword || typeof keyword !== 'string') {
        // Fallback: extract from scene text
        return _extractFromText(scene?.text || '');
    }

    let kw = keyword.trim();

    // Strip quotes the AI might wrap around the keyword
    kw = kw.replace(/^["']|["']$/g, '').trim();

    // Strip common AI prefixes/suffixes
    kw = kw.replace(/^(keyword:|search:|query:|find:|look for:)\s*/i, '').trim();

    // Strip markdown formatting
    kw = kw.replace(/\*\*/g, '').replace(/\*/g, '').trim();

    // Reject if too short (single char or empty)
    if (kw.length < 3) {
        console.log(`  ⚠️ Keyword too short ("${kw}"), extracting from scene text`);
        return _extractFromText(scene?.text || '') || kw;
    }

    // Reject if too long (AI sometimes dumps entire sentences)
    if (kw.split(/\s+/).length > 10) {
        console.log(`  ⚠️ Keyword too long (${kw.split(/\s+/).length} words), truncating`);
        // Keep the most meaningful 5 words
        const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'that', 'this', 'it']);
        const words = kw.split(/\s+/).filter(w => !STOP.has(w.toLowerCase()));
        kw = words.slice(0, 5).join(' ');
    }

    // Reject if it's just a description instead of a search term
    const DESCRIPTION_PATTERNS = [
        /^(a|an|the)\s+(scene|shot|clip|view|image|video)\s+(of|showing|depicting|featuring)/i,
        /^(close-?up|wide|aerial|overhead)\s+(shot|view|angle)\s+(of|showing)/i,
    ];
    for (const pattern of DESCRIPTION_PATTERNS) {
        if (pattern.test(kw)) {
            // Strip the description prefix, keep the subject
            kw = kw.replace(pattern, '').trim();
            if (kw.length < 3) kw = keyword.trim();
        }
    }

    return kw;
}

/**
 * Extract a searchable keyword from scene text as last resort.
 */
function _extractFromText(text) {
    if (!text) return 'abstract background';
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'that', 'this', 'it', 'but', 'not', 'so', 'if', 'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'can', 'may']);
    const words = text.split(/\s+/).filter(w => w.length > 3 && !STOP.has(w.toLowerCase()));
    // Take 2-4 of the longest words (most likely to be nouns/subjects)
    const sorted = words.sort((a, b) => b.length - a.length);
    return sorted.slice(0, 3).join(' ') || text.split(/\s+/).slice(0, 3).join(' ');
}

// ============ DOWNLOAD LOGIC ============

/**
 * Reorder provider instances by smart priority order.
 * Only includes providers that are already in the allProviders list (enabled + initialized).
 */
function reorderProviders(allProviders, priorityOrder, sourceMap) {
    const ordered = [];
    for (const key of priorityOrder) {
        const providerClass = sourceMap[key];
        if (!providerClass) continue;
        const match = allProviders.find(p => p instanceof providerClass);
        if (match) ordered.push(match);
    }
    // Append any providers not in the priority list (safety net)
    for (const p of allProviders) {
        if (!ordered.includes(p)) ordered.push(p);
    }
    return ordered;
}

async function downloadMedia(keyword, mediaType, filenameBase, sceneDuration = 10, sourceHint = '', nicheId = '', scene = null) {
    // Get smart priority and reorder providers for this scene
    const priorityOrder = getSmartPriority(sourceHint, mediaType, scriptContextRef);
    const allProviders = mediaType === 'video' ? videoProviders : imageProviders;
    const sourceMap = mediaType === 'video' ? VIDEO_SOURCE_MAP : IMAGE_SOURCE_MAP;
    const providers = reorderProviders(allProviders, priorityOrder, sourceMap);
    const ext = mediaType === 'video' ? '.mp4' : '.jpg';

    for (const provider of providers) {
        if (!provider.isAvailable()) continue;

        try {
            // Smart query selection: use stockQuery for stock, webQuery for web/youtube
            const providerKey = getProviderKey(provider);
            const isStock = STOCK_PROVIDERS.has(providerKey);
            const isWeb = WEB_PROVIDERS.has(providerKey);
            const isYouTube = YOUTUBE_PROVIDERS.has(providerKey);

            // Pick the best pre-optimized query for this provider type
            let baseQuery = keyword;
            if (scene) {
                if (isStock && scene.stockQuery) {
                    baseQuery = scene.stockQuery;
                    // Safety: if stock query lost specificity (e.g. "Abqaiq oil field" → "oil field"),
                    // fall back to original keyword to avoid garbage results like flowers for "oil field"
                    const stockWords = scene.stockQuery.toLowerCase().split(/\s+/).length;
                    const kwWords = keyword.toLowerCase().split(/\s+/).length;
                    if (stockWords <= 2 && kwWords > stockWords) {
                        baseQuery = keyword; // original keyword is more specific
                    }
                } else if ((isWeb || isYouTube) && scene.webQuery) {
                    baseQuery = scene.webQuery;
                }
            }

            // Then apply niche search policy on top
            const searchQuery = nicheId ? rewriteQuery(baseQuery, nicheId, providerKey, scene) : baseQuery;
            const queryChanged = searchQuery !== keyword;
            console.log(`  🔍 [${provider.name}] Searching: "${searchQuery}"${queryChanged ? ` (from: "${keyword}")` : ''}...`);
            let results = await provider.search(searchQuery);

            // Apply quality filtering (watermark + size rejection)
            const beforeCount = results.length;
            results = provider.filterResults(results);
            if (results.length < beforeCount) {
                console.log(`  🛡️ [${provider.name}] Filtered ${beforeCount - results.length} low-quality result(s)`);
            }

            if (results.length === 0) {
                console.log(`  ⚠️ [${provider.name}] No results, trying next...`);
                continue;
            }

            // Try multiple results from this provider (vision may reject early ones)
            const maxTries = Math.min(results.length, _visionEnabled ? 5 : 3);
            const visionRejections = []; // track what vision saw for keyword rewrite
            for (let attempt = 0; attempt < maxTries; attempt++) {
                const isOverused = (url) => _getUrlUseCount(url) >= MAX_URL_REUSE;
                const selected = attempt === 0
                    ? provider.pickUnused(results, isOverused)
                    : results[attempt]; // fallback to next results if first download fails

                if (!selected) continue;

                // Check URL blacklist — skip URLs that scored poorly in previous scenes.
                // PRESCORE_PROVIDERS (YouTube) do per-scene segment selection
                // so the same URL can yield different content at different timestamps — don't blacklist them.
                const dlUrl = selected._directVideoUrl || selected.url;
                if (!PRESCORE_PROVIDERS.has(providerKey)) {
                    const blacklisted = _isBlacklisted(dlUrl);
                    if (blacklisted) {
                        console.log(`  ⛔ [${provider.name}] Skipping blacklisted URL (scored ${blacklisted.score}/10 before): ${dlUrl.substring(0, 80)}...`);
                        continue;
                    }
                    // Deprioritize overused URLs — skip them on early attempts,
                    // but allow as last resort (last attempt)
                    const urlUses = _getUrlUseCount(dlUrl);
                    if (urlUses >= MAX_URL_REUSE && attempt < maxTries - 1) {
                        console.log(`  ⏭️ [${provider.name}] URL used ${urlUses}x already, trying fresh clips first...`);
                        continue;
                    }
                }

                try {
                    const outputPath = path.join(config.paths.temp, filenameBase + ext);

                    // ── Smart Trimming: Omni pre-download segment selection ──
                    // If video is long enough and clip analyzer has budget,
                    // extract frames from URL → Omni picks best segment → pass startTime to download
                    let smartStartTime = null;
                    const videoDuration = selected._cachedMeta?.duration || selected._meta?.duration || selected.duration || 0;
                    const smartTrimEligible = videoDuration > sceneDuration + 15 && mediaType === 'video' && !PRESCORE_PROVIDERS.has(providerKey);
                    const omniAvailable = clipAnalyzer.isAvailable();
                    // Only use Omni on first attempt per provider — retries use single-frame vision instead
                    const useOmni = omniAvailable && attempt === 0;
                    console.log(`  🔍 [Smart Trim] provider=${provider.name} | videoDur=${Math.round(videoDuration)}s | sceneDur=${Math.round(sceneDuration)}s | eligible=${smartTrimEligible} | omniAvailable=${omniAvailable}${attempt > 0 ? ' (retry→skip)' : ''} | prescore=${PRESCORE_PROVIDERS.has(providerKey)}`);

                    if (smartTrimEligible && useOmni) {
                        try {
                            // Prefer direct stream URLs that ffmpeg can seek into
                            // (Reddit permalinks need yt-dlp, but fallback_url is a direct DASH stream)
                            // For VK/Telegram: resolve via yt-dlp --get-url since web URLs aren't seekable
                            let segUrl = selected._directVideoUrl || selected._fallbackUrl || null;
                            if (!segUrl && provider.getStreamUrl) {
                                console.log(`  🔍 [Smart Trim] Resolving stream URL via ${provider.name}...`);
                                segUrl = await provider.getStreamUrl(selected.url);
                            }
                            if (!segUrl) segUrl = selected.url;
                            console.log(`  🔍 [Smart Trim] Sending ${clipAnalyzer.getFramesBudgetInfo ? clipAnalyzer.getFramesBudgetInfo() : '?'} frames to Omni for segment selection | URL: ${segUrl.substring(0, 80)}...`);
                            const segResult = await clipAnalyzer.findBestSegment(
                                segUrl,
                                videoDuration,
                                sceneDuration,
                                keyword,
                                {
                                    sceneText: scene?.text || '',
                                    niche: nicheId || '',
                                    videoTopic: scriptContextRef?.summary || '',
                                    entities: scriptContextRef?.entities || [],
                                }
                            );
                            if (segResult && segResult.startTime !== null) {
                                smartStartTime = segResult.startTime;
                                console.log(`  🎯 [Smart Trim] Omni picked START=${Math.round(smartStartTime)}s (reason: ${segResult.reason || 'best segment'}) | keyword="${keyword}"`);
                            } else {
                                console.log(`  ⚠️ [Smart Trim] Omni returned no segment — falling back to dumb trim`);
                            }
                        } catch (e) {
                            console.log(`  ⚠️ [Smart Trim] Failed: ${e.message} — falling back to dumb trim`);
                        }
                    } else if (smartTrimEligible && !useOmni) {
                        const reason = attempt > 0 ? 'retry attempt (saving budget)' : 'no Qwen/Gemini key or budget exhausted';
                        console.log(`  ⏭️ [Smart Trim] Skipped — ${reason}`);
                    }

                    console.log(`  ⬇️  [${provider.name}] Downloading${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`);
                    const finalPath = await provider.download(selected.url, outputPath, { duration: sceneDuration, keyword: keyword, _directVideoUrl: selected._directVideoUrl || null, _cachedMeta: selected._cachedMeta || selected._meta || null, _fallbackUrl: selected._fallbackUrl || null, _smartStartTime: smartStartTime, sceneText: scene?.text || '', niche: nicheId || '', videoTopic: scriptContextRef?.summary || '' });
                    const finalExt = path.extname(finalPath);
                    console.log(`  ✅ [${provider.name}] Downloaded: ${path.basename(finalPath)}`);

                    // Post-download segment quality check for video files from providers
                    // that DON'T do their own pre-download smart segment scoring.
                    // YouTube & News already pick the best segment before downloading.
                    const isVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                    if (_visionEnabled && isVideo && !PRESCORE_PROVIDERS.has(providerKey) && fs.existsSync(finalPath)) {
                        const segResult = await scoreDownloadedVideo(finalPath, {
                            keyword,
                            context: {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: scriptContextRef?.summary || '',
                                theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                entities: scriptContextRef?.entities || [],
                                tone: scriptContextRef?.tone || '',
                                mood: scriptContextRef?.mood || '',
                            },
                            providerTag: provider.name,
                        });
                        if (segResult.shouldRetrim && attempt < maxTries - 1) {
                            console.log(`  🎯 [${provider.name}] Video segment scored poorly — trying next result...`);
                            _blacklistUrl(dlUrl, segResult.bestScore || 0, 'Poor video segment');
                            visionRejections.push(`Poor video segment (score: ${segResult.bestScore}/10)`);
                            try { fs.unlinkSync(finalPath); } catch {}
                            continue;
                        }
                    }

                    // Inline vision scoring — ALL providers get 3-frame post-download check
                    // (YouTube does pre-download scoring too, but mid-clip cuts can still slip through)
                    let visionScore = 0;
                    if (_visionEnabled && fs.existsSync(finalPath)) {
                        const visionResult = await _scoreDownloadedMedia(finalPath, finalExt, keyword, {
                            sceneText: scene?.text || '',
                            niche: nicheId || '',
                            videoTopic: scriptContextRef?.summary || '',
                            theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                            entities: scriptContextRef?.entities || [],
                            tone: scriptContextRef?.tone || '',
                            mood: scriptContextRef?.mood || '',
                        });
                        if (visionResult) {
                            const { score, description } = visionResult;
                            visionScore = score;
                            console.log(`  👁️ Vision: ${score}/10 → ${description}`);
                            if (score <= 4) {
                                console.log(`  ❌ Score too low (${score}/10), trying next result...`);
                                if (!PRESCORE_PROVIDERS.has(providerKey)) {
                                    _blacklistUrl(dlUrl, score, description);
                                }
                                visionRejections.push(description);
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }
                        }
                    }

                    // Deep clip analysis — Omni multimodal video understanding (optional)
                    // Runs AFTER basic vision pass. Sends 8 frames to Qwen Omni for holistic
                    // clip understanding: watermark detection, motion quality, content relevance.
                    // Only for video files, only if within frame budget.
                    let clipAnalysis = null;
                    const isVideoForAnalysis = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                    if (isVideoForAnalysis && clipAnalyzer.isAvailable() && fs.existsSync(finalPath)) {
                        try {
                            const { probeDuration: _probeDur } = require('./smart-segment');
                            const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                            const clipDur = await _probeDur(ffmpegPath, finalPath) || sceneDuration;
                            clipAnalysis = await clipAnalyzer.analyzeClip(finalPath, clipDur, keyword, {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: scriptContextRef?.summary || '',
                                entities: scriptContextRef?.entities || [],
                            });
                            if (clipAnalysis) {
                                console.log(`  🎬 Clip Analysis: ${clipAnalysis.score}/10 | ${clipAnalysis.motion} motion | ${clipAnalysis.issues.length ? 'Issues: ' + clipAnalysis.issues.join(', ') : 'Clean'}`);
                                console.log(`     ${clipAnalysis.description}`);
                                const rejectThreshold = config.clipAnalyzer?.rejectThreshold || 3;
                                if (clipAnalysis.score <= rejectThreshold) {
                                    console.log(`  ❌ Deep analysis too low (${clipAnalysis.score}/10 ≤ ${rejectThreshold}), trying next result...`);
                                    _blacklistUrl(dlUrl, clipAnalysis.score, clipAnalysis.description);
                                    visionRejections.push(`Deep: ${clipAnalysis.description}`);
                                    try { fs.unlinkSync(finalPath); } catch {}
                                    continue;
                                }
                                // Upgrade or downgrade visionScore based on deep analysis
                                // Weighted blend: 40% basic vision + 60% deep analysis
                                if (visionScore > 0) {
                                    visionScore = Math.round(visionScore * 0.4 + clipAnalysis.score * 0.6);
                                } else {
                                    visionScore = clipAnalysis.score;
                                }
                            }
                        } catch (err) {
                            // Non-fatal — deep analysis is optional
                            console.log(`  ⚠️ Clip analysis skipped: ${err.message}`);
                        }
                    }

                    // Track URL reuse count
                    _trackUrlUse(dlUrl);

                    return {
                        path: finalPath,
                        ext: finalExt,
                        provider: provider.name,
                        mediaType: mediaType,
                        mediaWidth: selected.width || 0,
                        mediaHeight: selected.height || 0,
                        visionScore: visionScore,
                        clipAnalysis: clipAnalysis,
                    };
                } catch (dlError) {
                    console.log(`  ⚠️ [${provider.name}] Download failed: ${dlError.message}${attempt < maxTries - 1 ? ', trying next result...' : ''}`);
                }
            }

            // Vision rejected all attempts — ask AI to suggest a DIFFERENT keyword angle
            if (visionRejections.length >= 3) {
                const suggestion = await _visionSuggestKeyword(visionRejections, keyword, {
                    sceneText: scene?.text || '',
                    niche: nicheId || '',
                    videoTopic: scriptContextRef?.summary || '',
                    theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                    entities: scriptContextRef?.entities || [],
                    tone: scriptContextRef?.tone || '',
                    eventAnchor: scriptContextRef?.eventAnchor || '',
                    triedKeywords: [keyword, ...(scene?.stockQuery ? [scene.stockQuery] : []), ...(scene?.webQuery ? [scene.webQuery] : [])],
                });
                if (suggestion) {
                    console.log(`  🧠 Vision AI suggests different angle: "${suggestion.keyword}"${suggestion.switchToVideo ? ' (as VIDEO)' : ''}`);
                    // Retry with AI-suggested keyword using ALL providers in smart priority order
                    // (not just the current provider — if YouTube failed 5x, try Telegram/VK too)
                    const retryType = suggestion.switchToVideo ? 'video' : mediaType;
                    const retryExt = retryType === 'video' ? '.mp4' : '.jpg';
                    const retryAllProviders = retryType === 'video'
                        ? reorderProviders(videoProviders, getSmartPriority(sourceHint, 'video', scriptContextRef), VIDEO_SOURCE_MAP)
                        : reorderProviders(imageProviders, getSmartPriority(sourceHint, 'image', scriptContextRef), IMAGE_SOURCE_MAP);
                    for (const retryProvider of retryAllProviders) {
                        if (!retryProvider.isAvailable()) continue;
                        try {
                            const retryResults = await retryProvider.search(suggestion.keyword);
                            const filtered = retryProvider.filterResults(retryResults);
                            if (filtered.length === 0) continue;
                            const isOverused = (url) => _getUrlUseCount(url) >= MAX_URL_REUSE;
                            const picked = retryProvider.pickUnused(filtered, isOverused);
                            if (!picked) continue;

                            const outputPath = path.join(config.paths.temp, filenameBase + retryExt);
                            console.log(`  ⬇️  [${retryProvider.name}] Retry with AI keyword...`);
                            const finalPath = await retryProvider.download(picked.url, outputPath, { duration: sceneDuration, keyword: suggestion.keyword, _directVideoUrl: picked._directVideoUrl || null, sceneText: scene?.text || '', niche: nicheId || '', videoTopic: scriptContextRef?.summary || '' });
                            const finalExt = path.extname(finalPath);
                            console.log(`  ✅ [${retryProvider.name}] Downloaded: ${path.basename(finalPath)}`);

                            // Vision scoring on AI-retry clips (same as primary path)
                            let retryVisionScore = 0;
                            const retryContext = {
                                sceneText: scene?.text || '',
                                niche: nicheId || '',
                                videoTopic: scriptContextRef?.summary || '',
                                theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                                entities: scriptContextRef?.entities || [],
                                tone: scriptContextRef?.tone || '',
                                mood: scriptContextRef?.mood || '',
                            };
                            if (_visionEnabled && fs.existsSync(finalPath)) {
                                const retryVision = await _scoreDownloadedMedia(finalPath, finalExt, suggestion.keyword, retryContext);
                                if (retryVision) {
                                    retryVisionScore = retryVision.score;
                                    console.log(`  👁️ Vision (retry): ${retryVision.score}/10 → ${retryVision.description}`);
                                    if (retryVision.score <= 4) {
                                        console.log(`  ❌ Retry score too low (${retryVision.score}/10), trying next provider...`);
                                        try { fs.unlinkSync(finalPath); } catch {}
                                        continue;
                                    }
                                }
                            }

                            // Deep clip analysis on AI-retry clips
                            let retryClipAnalysis = null;
                            const retryIsVideo = ['.mp4', '.webm', '.mkv', '.mov'].includes(finalExt.toLowerCase());
                            if (retryIsVideo && clipAnalyzer.isAvailable() && fs.existsSync(finalPath)) {
                                try {
                                    const { probeDuration: _probeDur } = require('./smart-segment');
                                    const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
                                    const clipDur = await _probeDur(ffmpegPath, finalPath) || sceneDuration;
                                    retryClipAnalysis = await clipAnalyzer.analyzeClip(finalPath, clipDur, suggestion.keyword, {
                                        sceneText: scene?.text || '',
                                        niche: nicheId || '',
                                        videoTopic: scriptContextRef?.summary || '',
                                        entities: scriptContextRef?.entities || [],
                                    });
                                    if (retryClipAnalysis) {
                                        console.log(`  🎬 Clip Analysis (retry): ${retryClipAnalysis.score}/10 | ${retryClipAnalysis.motion} motion | ${retryClipAnalysis.issues.length ? 'Issues: ' + retryClipAnalysis.issues.join(', ') : 'Clean'}`);
                                        console.log(`     ${retryClipAnalysis.description}`);
                                        const rejectThreshold = config.clipAnalyzer?.rejectThreshold || 3;
                                        if (retryClipAnalysis.score <= rejectThreshold) {
                                            console.log(`  ❌ Deep analysis too low (${retryClipAnalysis.score}/10), trying next provider...`);
                                            try { fs.unlinkSync(finalPath); } catch {}
                                            continue;
                                        }
                                        if (retryVisionScore > 0) {
                                            retryVisionScore = Math.round(retryVisionScore * 0.4 + retryClipAnalysis.score * 0.6);
                                        } else {
                                            retryVisionScore = retryClipAnalysis.score;
                                        }
                                    }
                                } catch (err) {
                                    console.log(`  ⚠️ Clip analysis skipped: ${err.message}`);
                                }
                            }

                            _trackUrlUse(picked._directVideoUrl || picked.url);
                            return {
                                path: finalPath,
                                ext: finalExt,
                                provider: retryProvider.name,
                                mediaType: retryType,
                                mediaWidth: picked.width || 0,
                                mediaHeight: picked.height || 0,
                                visionScore: retryVisionScore,
                                clipAnalysis: retryClipAnalysis,
                            };
                        } catch (e) {
                            console.log(`  ⚠️ [${retryProvider.name}] AI keyword retry failed: ${e.message}`);
                        }
                    }
                }
            }
        } catch (error) {
            console.log(`  ⚠️ [${provider.name}] Failed: ${error.message}, trying next...`);
            continue;
        }
    }

    console.log(`  ❌ All ${mediaType} providers failed for "${keyword}"`);
    return null;
}

async function downloadAllMedia(scenes, scriptContext, options = {}) {
    console.log('\n🎥 Downloading stock footage...\n');

    // Initialize fresh provider instances with script context
    initProviders(scriptContext);

    // Clear media cache for fresh build
    _clearMediaCache();
    const isListicle = scriptContext?.format === 'listicle';

    // If no video providers enabled, force all scenes to image (and vice versa)
    const hasVideoProviders = videoProviders.some(p => p.isAvailable());
    const hasImageProviders = imageProviders.some(p => p.isAvailable());
    const CONCURRENCY = 3;

    // ─── Log buffering for clean scene-by-scene output ─────────────
    // Scenes download in parallel (3 at a time) but their logs interleave,
    // making output unreadable. We use AsyncLocalStorage to track which
    // async context belongs to which scene, buffer logs per-scene, and
    // flush each scene's logs as a clean block when it finishes.

    const _sceneBuffers = new Map(); // sceneIndex → string[]
    const _readyScenes = new Set();  // scenes that finished and are ready to flush
    let _nextFlush = 0;              // next scene index to flush in order

    function _flushSceneLog(sceneIdx) {
        _readyScenes.add(sceneIdx);

        // Flush in order: scene 0, 1, 2, 3... so output reads sequentially
        // If scene 2 finishes before scene 0, it waits until 0 and 1 flush first
        while (_readyScenes.has(_nextFlush)) {
            const buf = _sceneBuffers.get(_nextFlush);
            if (buf && buf.length > 0) {
                _originalConsoleLog(buf.join('\n'));
            }
            _sceneBuffers.delete(_nextFlush);
            _readyScenes.delete(_nextFlush);
            _nextFlush++;
        }
    }

    // Hijack console.log — route to scene buffer via AsyncLocalStorage
    const _prevLog = console.log;
    console.log = function (...args) {
        const store = _logStorage.getStore();
        if (store && store.sceneIdx !== undefined) {
            const line = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
            const buf = _sceneBuffers.get(store.sceneIdx);
            if (buf) {
                buf.push(line);
                return;
            }
        }
        // Outside scene context — print immediately
        _originalConsoleLog.apply(console, args);
    };

    const tasks = scenes.map((scene, i) => async () => {
        // Use scene's original index for filenames/logs (preserves alignment with fullscreen MG scenes)
        const si = scene.index !== undefined ? scene.index : i;
        // Each scene task runs inside its own AsyncLocalStorage context
        return _logStorage.run({ sceneIdx: i }, async () => {
            _sceneBuffers.set(i, []);

            let mediaType = scene.mediaType || 'video';
            const sourceHint = scene.sourceHint || '';

            // Auto-correct type if providers aren't available
            if (mediaType === 'video' && !hasVideoProviders && hasImageProviders) {
                mediaType = 'image';
                scene.mediaType = 'image';
            } else if (mediaType === 'image' && !hasImageProviders && hasVideoProviders) {
                mediaType = 'video';
                scene.mediaType = 'video';
            }

            let keyword = scene.researchKeyword || scene.keyword;
            const sceneDuration = (scene.endTime || 0) - (scene.startTime || 0) || 10;
            const nicheId = scriptContext?.nicheId || '';

            // Validate and fix keyword before searching
            keyword = validateKeyword(keyword, scene);

            console.log(`\n${'═'.repeat(70)}`);
            console.log(`📌 Scene ${si}/${scenes.length - 1} (${mediaType}) — "${keyword}"${sourceHint ? `  [hint: ${sourceHint}]` : ''}${nicheId ? `  [niche: ${nicheId}]` : ''}`);
            console.log(`${'─'.repeat(70)}`);
            if (scene.stockQuery || scene.webQuery) {
                console.log(`  🎯 Optimized: stock="${scene.stockQuery || '-'}" web="${scene.webQuery || '-'}"`);
            }

            // Check media cache first (reuse previously downloaded clips)
            if (isListicle || _mediaCache.size > 0) {
                const cached = _checkMediaCache(keyword, mediaType, si, `scene-${si}`);
                if (cached) {
                    console.log(`  ♻️ Cache hit! Reusing ${path.basename(cached.path)} (from ${cached.provider})`);
                    console.log(`  ✅ Scene ${si} DONE (cached)`);
                    scene.mediaFile = cached.path;
                    scene.mediaExtension = cached.ext;
                    scene.sourceProvider = cached.provider;
                    scene.mediaWidth = cached.mediaWidth || 0;
                    scene.mediaHeight = cached.mediaHeight || 0;
                    scene.reusedFromCache = true;
                    _flushSceneLog(i);
                    return;
                }
            }

            // Log provider priority
            const priorityOrder = getSmartPriority(sourceHint, mediaType, scriptContext);
            const prioritySource = sourceHint && SOURCE_PRIORITY_MAP[sourceHint] ? 'hint' : nicheId ? 'niche' : 'default';
            console.log(`  📦 Priority: ${priorityOrder.join(' → ')} (${prioritySource})`);

            let result = await downloadMedia(keyword, mediaType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene);

            // If primary keyword failed, try simplified variants
            if (!result) {
                const variants = getKeywordVariants(keyword);
                for (const variant of variants) {
                    console.log(`  🔄 Retrying with simplified keyword: "${variant}"`);
                    result = await downloadMedia(variant, mediaType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene);
                    if (result) break;
                }
            }

            // If still failed, try the other media type
            if (!result) {
                const fallbackType = mediaType === 'video' ? 'image' : 'video';
                const fallbackProviders = fallbackType === 'video' ? videoProviders : imageProviders;
                if (fallbackProviders.some(p => p.isAvailable())) {
                    console.log(`  🔄 Trying fallback type: ${fallbackType}...`);
                    result = await downloadMedia(keyword, fallbackType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene);

                    if (!result) {
                        const variants = getKeywordVariants(keyword);
                        for (const variant of variants) {
                            console.log(`  🔄 Retrying ${fallbackType} with: "${variant}"`);
                            result = await downloadMedia(variant, fallbackType, `scene-${si}`, sceneDuration, sourceHint, nicheId, scene);
                            if (result) break;
                        }
                    }

                    if (result) {
                        scene.mediaType = fallbackType;
                    }
                }
            }

            // Last resort: niche fallback keywords
            if (!result && nicheId) {
                const fallbacks = getFallbackKeywords(nicheId);
                console.log(`  🔄 Trying niche fallback keywords (${nicheId})...`);
                for (const fbKeyword of fallbacks) {
                    result = await downloadMedia(fbKeyword, mediaType, `scene-${si}`, sceneDuration, '', '', null);
                    if (result) {
                        console.log(`  ✅ Niche fallback worked: "${fbKeyword}"`);
                        break;
                    }
                }
            }

            if (result) {
                scene.mediaFile = result.path;
                scene.mediaExtension = result.ext;
                scene.sourceProvider = result.provider;
                scene.mediaWidth = result.mediaWidth || 0;
                scene.mediaHeight = result.mediaHeight || 0;
                console.log(`  ✅ Scene ${si} DONE → ${result.provider}: ${path.basename(result.path)}${result.visionScore ? ` (vision: ${result.visionScore}/10)` : ''}`);

                _cacheMedia(keyword, result, result.visionScore || 0, si);
            } else {
                console.log(`  ❌ Scene ${si}: No media found after all retries`);
                scene.mediaFile = null;
                scene.mediaExtension = mediaType === 'image' ? '.jpg' : '.mp4';
                scene.sourceProvider = null;
                scene.mediaWidth = 0;
                scene.mediaHeight = 0;
            }

            // Flush this scene's buffered logs as a clean block
            _flushSceneLog(i);
        });
    });

    await parallelWithLimit(tasks, CONCURRENCY);

    // Restore console.log
    console.log = _prevLog;

    // Post-download: Probe dimensions for scenes missing them (YouTube, some web-image providers)
    let probeCount = 0;
    for (const scene of scenes) {
        if (scene.mediaFile && (!scene.mediaWidth || !scene.mediaHeight)) {
            const dims = probeMediaDimensions(scene.mediaFile);
            if (dims) {
                scene.mediaWidth = dims.width;
                scene.mediaHeight = dims.height;
                probeCount++;
            }
        }
    }
    if (probeCount > 0) {
        console.log(`  🔍 Probed dimensions for ${probeCount} file(s)`);
    }

    // Provider usage summary
    const providerHits = {};
    let failed = 0;
    let cacheHits = 0;
    for (const scene of scenes) {
        if (scene.reusedFromCache) {
            cacheHits++;
        }
        if (scene.sourceProvider) {
            providerHits[scene.sourceProvider] = (providerHits[scene.sourceProvider] || 0) + 1;
        } else if (!scene.mediaFile) {
            failed++;
        }
    }
    const hitsSummary = Object.entries(providerHits).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}(${c})`).join(', ');
    console.log(`\n✅ All media downloaded!`);
    console.log(`  📊 Sources: ${hitsSummary}${failed ? ` | failed(${failed})` : ''}${cacheHits ? ` | ♻️ reused(${cacheHits})` : ''}\n`);
    return { scenes };
}

// ============================================================
// BACKGROUND CANVAS DOWNLOAD
// ============================================================

const BACKGROUND_CACHE_DIR = path.join(__dirname, '..', 'assets', 'backgrounds');

/**
 * Ensure background cache directory exists
 */
function ensureBackgroundCacheDir() {
    if (!fs.existsSync(BACKGROUND_CACHE_DIR)) {
        fs.mkdirSync(BACKGROUND_CACHE_DIR, { recursive: true });
    }
}

/**
 * Download background canvas video for a theme
 * Downloads subtle texture video that plays behind all footage
 * Cached in assets/backgrounds/ for future builds
 *
 * @param {string} themeId - Theme identifier (e.g., 'tech', 'nature', 'dark')
 * @returns {string|null} Path to downloaded background video, or null if failed
 */
async function downloadBackgroundCanvas(themeId) {
    console.log(`\n🎨 Downloading background canvas for theme: ${themeId}...`);

    ensureBackgroundCacheDir();

    const backgroundSource = getBackgroundSource(themeId);
    const cacheFile = path.join(BACKGROUND_CACHE_DIR, `${themeId}.mp4`);

    // Check cache first
    if (fs.existsSync(cacheFile)) {
        console.log(`   ✅ Cache hit: ${cacheFile}`);
        console.log(`   📦 Background ready (${backgroundSource.name})\n`);
        return cacheFile;
    }

    console.log(`   🔍 Searching: "${backgroundSource.name}"`);
    console.log(`   Keywords: ${backgroundSource.keywords.join(' | ')}`);

    // Try downloading from available providers
    // Priority: Pexels → Pixabay (same as overlay-manager)
    let downloaded = false;

    // Try Pexels first
    if (config.pexels?.apiKey) {
        const pexels = new PexelsVideoProvider({
            priority: 1,
            enabled: true,
            quality: 'medium'
        });

        try {
            for (const keyword of backgroundSource.keywords) {
                const results = await pexels.search(keyword);
                if (results && results.length > 0) {
                    const picked = results[0];
                    console.log(`   🎬 Found on Pexels: ${picked.url}`);
                    downloaded = await pexels.download(picked.url, cacheFile);
                    if (downloaded) break;
                }
            }
        } catch (err) {
            console.log(`   ⚠️ Pexels failed: ${err.message}`);
        }
    }

    // Try Pixabay if Pexels failed
    if (!downloaded && config.pixabay?.apiKey) {
        const pixabay = new PixabayVideoProvider({
            priority: 2,
            enabled: true,
            quality: 'medium'
        });

        try {
            for (const keyword of backgroundSource.keywords) {
                const results = await pixabay.search(keyword);
                if (results && results.length > 0) {
                    const picked = results[0];
                    console.log(`   🎬 Found on Pixabay: ${picked.url}`);
                    downloaded = await pixabay.download(picked.url, cacheFile);
                    if (downloaded) break;
                }
            }
        } catch (err) {
            console.log(`   ⚠️ Pixabay failed: ${err.message}`);
        }
    }

    if (downloaded) {
        console.log(`   ✅ Background canvas downloaded & cached`);
        console.log(`   📦 ${cacheFile}\n`);
        return cacheFile;
    } else {
        console.log(`   ⚠️ Could not download background canvas`);
        console.log(`   💡 Rendering will use solid color fallback\n`);
        return null;
    }
}

module.exports = { downloadMedia, downloadAllMedia, initProviders };
