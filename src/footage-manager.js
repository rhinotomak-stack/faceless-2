const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getBackgroundSource } = require('./themes');
const { getNiche, rewriteQuery, getFallbackKeywords, getSearchPolicy } = require('./niches');

// Import all providers
const PexelsVideoProvider = require('./providers/pexels-video');
const PexelsImageProvider = require('./providers/pexels-image');
const PixabayVideoProvider = require('./providers/pixabay-video');
const PixabayImageProvider = require('./providers/pixabay-image');
const GoogleCSEProvider = require('./providers/google-cse');
const BingImagesProvider = require('./providers/bing-images');
const UnsplashProvider = require('./providers/unsplash');
const DuckDuckGoImagesProvider = require('./providers/duckduckgo-images');
const GoogleImagesProvider = require('./providers/google-images');
const YouTubeVideoProvider = require('./providers/youtube-video');
const NewsVideoProvider = require('./providers/news-video');

// Provider type sets (mirrors niches.js for query routing)
const STOCK_PROVIDERS = new Set(['pexels', 'pixabay', 'unsplash']);
const WEB_PROVIDERS = new Set(['googleCSE', 'bing', 'googleScrape', 'duckduckgo', 'newsVideo']);
const YOUTUBE_PROVIDERS = new Set(['youtube']);

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
 * Score a downloaded image or extract a frame from video and score it.
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
            // Extract a frame at 1s (or middle of clip)
            const ffmpegPath = config.paths?.ffmpeg || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
            const framePath = filePath + '_vision_frame.jpg';
            await new Promise((resolve) => {
                const { execFile } = require('child_process');
                execFile(ffmpegPath, [
                    '-ss', '1', '-i', filePath,
                    '-vf', 'scale=512:-1', '-frames:v', '1', '-q:v', '3',
                    '-y', framePath
                ], { timeout: 10000, windowsHide: true }, () => resolve());
            });
            if (!fs.existsSync(framePath)) return null;
            const buf = fs.readFileSync(framePath);
            base64 = buf.toString('base64');
            mimeType = 'image/jpeg';
            try { fs.unlinkSync(framePath); } catch {}
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

        const response = await callAI(
            `I searched for images using the keyword "${originalKeyword}" but all results were wrong:
${descList}

${context.videoTopic ? `Video topic: "${context.videoTopic}"` : ''}
${context.sceneText ? `Scene narration: "${context.sceneText}"` : ''}

The search results don't match what I need. Suggest a BETTER 3-5 word search keyword that would find the RIGHT image.
Also say VIDEO if this topic would work better as a video clip instead of a still image.

Reply format (exactly 1-2 lines):
[new search keyword]
[VIDEO or IMAGE]`,
            { maxTokens: 30, systemPrompt: 'You suggest image search keywords. Be specific and literal. Output ONLY the keyword and media type.' }
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
    newsVideo: NewsVideoProvider,
};

const IMAGE_SOURCE_MAP = {
    pexels: PexelsImageProvider,
    pixabay: PixabayImageProvider,
    googleCSE: GoogleCSEProvider,
    bing: BingImagesProvider,
    unsplash: UnsplashProvider,
    duckduckgo: DuckDuckGoImagesProvider,
    googleScrape: GoogleImagesProvider,
};

// Default provider priority order (when no smart hint available)
const VIDEO_PRIORITY = ['pexels', 'pixabay', 'youtube', 'newsVideo'];
const IMAGE_PRIORITY = ['pexels', 'pixabay', 'bing', 'unsplash', 'googleCSE', 'googleScrape'];

// ============ SMART SOURCE PRIORITY ============

// AI source hint → provider order (reorders, never adds unchecked sources)
const SOURCE_PRIORITY_MAP = {
    'stock': {
        video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
        image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleCSE', 'googleScrape']
    },
    'youtube': {
        video: ['youtube', 'pexels', 'pixabay', 'newsVideo'],
        image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
    'web-image': {
        video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
        image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
    'news': {
        video: ['newsVideo', 'youtube', 'pexels', 'pixabay'],
        image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
};

// Theme-level fallback when AI source hint is missing
const THEME_PRIORITY_MAP = {
    // Factual/news themes → prefer real footage (news sites, YouTube)
    politics:      { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    finance:       { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    business:      { video: ['youtube', 'newsVideo', 'pexels', 'pixabay'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    technology:    { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    crime:         { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    documentary:   { video: ['youtube', 'newsVideo', 'pexels', 'pixabay'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    military:      { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    war:           { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    geopolitics:   { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    // Aesthetic/organic themes → prefer stock footage
    nature:        { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleCSE', 'googleScrape'] },
    travel:        { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'pixabay', 'unsplash', 'bing', 'googleCSE', 'googleScrape'] },
    lifestyle:     { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'unsplash', 'pixabay', 'bing', 'googleCSE', 'googleScrape'] },
    food:          { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'unsplash', 'pixabay', 'googleCSE', 'bing', 'googleScrape'] },
    health:        { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'unsplash', 'pixabay', 'googleCSE', 'bing', 'googleScrape'] },
    // Other
    history:       { video: ['youtube', 'newsVideo', 'pexels', 'pixabay'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    entertainment: { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    sports:        { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['bing', 'googleCSE', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    diy:           { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
};

/**
 * Get smart provider priority order based on AI source hint and video theme.
 * Resolution: source hint → theme fallback → default order.
 * Only reorders — never adds providers that weren't enabled.
 */
function getSmartPriority(sourceHint, mediaType, scriptContext) {
    // Priority 1: AI per-scene source hint
    if (sourceHint && SOURCE_PRIORITY_MAP[sourceHint]) {
        const order = SOURCE_PRIORITY_MAP[sourceHint][mediaType];
        if (order) return order;
    }

    // Priority 2: Niche-based provider priority
    const nicheId = scriptContext?.nicheId;
    if (nicheId) {
        const niche = getNiche(nicheId);
        if (niche.footagePriority && niche.footagePriority[mediaType]) {
            return niche.footagePriority[mediaType];
        }
    }

    // Priority 3: Legacy theme-based fallback
    const theme = (scriptContext?.theme || '').toLowerCase();
    if (theme && THEME_PRIORITY_MAP[theme]) {
        const order = THEME_PRIORITY_MAP[theme][mediaType];
        if (order) return order;
    }

    // Priority 4: Default hardcoded order
    return mediaType === 'video' ? VIDEO_PRIORITY : IMAGE_PRIORITY;
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
    return { pexels: true, pixabay: true, unsplash: true, googleCSE: false, bing: true, duckduckgo: false, googleScrape: true, youtube: true, newsVideo: false };
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
                const selected = attempt === 0
                    ? provider.pickUnused(results)
                    : results[attempt]; // fallback to next results if first download fails

                if (!selected) continue;

                try {
                    const outputPath = path.join(config.paths.temp, filenameBase + ext);
                    console.log(`  ⬇️  [${provider.name}] Downloading${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`);
                    const finalPath = await provider.download(selected.url, outputPath, { duration: sceneDuration, keyword: keyword, _directVideoUrl: selected._directVideoUrl || null, sceneText: scene?.text || '', niche: nicheId || '', videoTopic: scriptContextRef?.summary || '' });
                    const finalExt = path.extname(finalPath);
                    console.log(`  ✅ [${provider.name}] Downloaded: ${path.basename(finalPath)}`);

                    // Inline vision scoring — skip for YouTube (does its own internal scoring)
                    let visionScore = 0;
                    if (_visionEnabled && !isYouTube && fs.existsSync(finalPath)) {
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
                            if (score <= 3 && attempt < maxTries - 1) {
                                console.log(`  ❌ Score too low, trying next result...`);
                                visionRejections.push(description);
                                try { fs.unlinkSync(finalPath); } catch {}
                                continue;
                            }
                        }
                    }

                    return {
                        path: finalPath,
                        ext: finalExt,
                        provider: provider.name,
                        mediaType: mediaType,
                        mediaWidth: selected.width || 0,
                        mediaHeight: selected.height || 0,
                        visionScore: visionScore,
                    };
                } catch (dlError) {
                    console.log(`  ⚠️ [${provider.name}] Download failed: ${dlError.message}${attempt < maxTries - 1 ? ', trying next result...' : ''}`);
                }
            }

            // Vision rejected all attempts — ask AI to suggest a better keyword
            if (visionRejections.length >= 3) {
                const suggestion = await _visionSuggestKeyword(visionRejections, keyword, {
                    sceneText: scene?.text || '',
                    niche: nicheId || '',
                    videoTopic: scriptContextRef?.summary || '',
                    theme: scriptContextRef?.themeId || scriptContextRef?.theme || '',
                    entities: scriptContextRef?.entities || [],
                    tone: scriptContextRef?.tone || '',
                });
                if (suggestion) {
                    console.log(`  🧠 Vision AI suggests: "${suggestion.keyword}"${suggestion.switchToVideo ? ' (as VIDEO)' : ''}`);
                    // Retry with AI-suggested keyword on same provider
                    const retryType = suggestion.switchToVideo ? 'video' : mediaType;
                    const retryExt = retryType === 'video' ? '.mp4' : '.jpg';
                    const retryProviders = retryType === 'video' ? videoProviders : [provider];
                    for (const retryProvider of retryProviders) {
                        if (!retryProvider.isAvailable()) continue;
                        try {
                            const retryResults = await retryProvider.search(suggestion.keyword);
                            const filtered = retryProvider.filterResults(retryResults);
                            if (filtered.length === 0) continue;
                            const picked = retryProvider.pickUnused(filtered);
                            if (!picked) continue;

                            const outputPath = path.join(config.paths.temp, filenameBase + retryExt);
                            console.log(`  ⬇️  [${retryProvider.name}] Retry with AI keyword...`);
                            const finalPath = await retryProvider.download(picked.url, outputPath, { duration: sceneDuration, keyword: suggestion.keyword, _directVideoUrl: picked._directVideoUrl || null, sceneText: scene?.text || '', niche: nicheId || '', videoTopic: scriptContextRef?.summary || '' });
                            const finalExt = path.extname(finalPath);
                            console.log(`  ✅ [${retryProvider.name}] Downloaded: ${path.basename(finalPath)}`);

                            return {
                                path: finalPath,
                                ext: finalExt,
                                provider: retryProvider.name,
                                mediaType: retryType,
                                mediaWidth: picked.width || 0,
                                mediaHeight: picked.height || 0
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

    const tasks = scenes.map((scene, i) => async () => {
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

        console.log(`\nScene ${i} (${mediaType}): "${keyword}"${sourceHint ? ` [hint: ${sourceHint}]` : ''}${nicheId ? ` [niche: ${nicheId}]` : ''}`);
        if (scene.stockQuery || scene.webQuery) {
            console.log(`  🎯 Optimized: stock="${scene.stockQuery || '-'}" web="${scene.webQuery || '-'}"`);
        }

        // Check media cache first (reuse previously downloaded clips)
        // Listicles always check cache; documentaries check if keyword is very similar
        if (isListicle || _mediaCache.size > 0) {
            const cached = _checkMediaCache(keyword, mediaType, i, `scene-${i}`);
            if (cached) {
                console.log(`  ♻️ Cache hit! Reusing ${path.basename(cached.path)} (from ${cached.provider})`);
                scene.mediaFile = cached.path;
                scene.mediaExtension = cached.ext;
                scene.sourceProvider = cached.provider;
                scene.mediaWidth = cached.mediaWidth || 0;
                scene.mediaHeight = cached.mediaHeight || 0;
                scene.reusedFromCache = true;
                return;
            }
        }

        // Log provider priority for first scene or when source hint changes per scene
        const priorityOrder = getSmartPriority(sourceHint, mediaType, scriptContext);
        const prioritySource = sourceHint && SOURCE_PRIORITY_MAP[sourceHint] ? 'hint' : nicheId ? 'niche' : 'default';
        console.log(`  📦 Priority: ${priorityOrder.join(' → ')} (${prioritySource})`);

        let result = await downloadMedia(keyword, mediaType, `scene-${i}`, sceneDuration, sourceHint, nicheId, scene);

        // If primary keyword failed, try simplified variants
        if (!result) {
            const variants = getKeywordVariants(keyword);
            for (const variant of variants) {
                console.log(`  🔄 Retrying with simplified keyword: "${variant}"`);
                result = await downloadMedia(variant, mediaType, `scene-${i}`, sceneDuration, sourceHint, nicheId, scene);
                if (result) break;
            }
        }

        // If still failed, try the other media type with all keyword variants
        if (!result) {
            const fallbackType = mediaType === 'video' ? 'image' : 'video';
            const fallbackProviders = fallbackType === 'video' ? videoProviders : imageProviders;
            if (fallbackProviders.some(p => p.isAvailable())) {
                console.log(`  🔄 Trying fallback type: ${fallbackType}...`);
                result = await downloadMedia(keyword, fallbackType, `scene-${i}`, sceneDuration, sourceHint, nicheId, scene);

                if (!result) {
                    const variants = getKeywordVariants(keyword);
                    for (const variant of variants) {
                        console.log(`  🔄 Retrying ${fallbackType} with: "${variant}"`);
                        result = await downloadMedia(variant, fallbackType, `scene-${i}`, sceneDuration, sourceHint, nicheId, scene);
                        if (result) break;
                    }
                }

                if (result) {
                    scene.mediaType = fallbackType;
                }
            }
        }

        // Last resort: try niche-specific fallback keywords
        if (!result && nicheId) {
            const fallbacks = getFallbackKeywords(nicheId);
            console.log(`  🔄 Trying niche fallback keywords (${nicheId})...`);
            for (const fbKeyword of fallbacks) {
                result = await downloadMedia(fbKeyword, mediaType, `scene-${i}`, sceneDuration, '', '', null);
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

            // Cache the downloaded media for potential reuse by later scenes
            _cacheMedia(keyword, result, result.visionScore || 0, i);
        } else {
            console.log(`  ❌ Scene ${i}: No media found after all retries`);
            scene.mediaFile = null;
            scene.mediaExtension = mediaType === 'image' ? '.jpg' : '.mp4';
            scene.sourceProvider = null;
            scene.mediaWidth = 0;
            scene.mediaHeight = 0;
        }

    });

    await parallelWithLimit(tasks, CONCURRENCY);

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
