const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getBackgroundSource } = require('./themes');
const { getNiche, rewriteQuery, getFallbackKeywords } = require('./niches');

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
const IMAGE_PRIORITY = ['pexels', 'pixabay', 'googleCSE', 'bing', 'unsplash', 'googleScrape'];

// ============ SMART SOURCE PRIORITY ============

// AI source hint → provider order (reorders, never adds unchecked sources)
const SOURCE_PRIORITY_MAP = {
    'stock': {
        video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
        image: ['pexels', 'pixabay', 'unsplash', 'googleCSE', 'bing', 'googleScrape']
    },
    'youtube': {
        video: ['youtube', 'pexels', 'pixabay', 'newsVideo'],
        image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash']
    },
    'web-image': {
        video: ['pexels', 'pixabay', 'youtube', 'newsVideo'],
        image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
    'news': {
        video: ['newsVideo', 'youtube', 'pexels', 'pixabay'],
        image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash']
    },
};

// Theme-level fallback when AI source hint is missing
const THEME_PRIORITY_MAP = {
    // News/factual themes → prefer real footage (news sites, YouTube)
    politics:      { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    finance:       { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    business:      { video: ['youtube', 'newsVideo', 'pexels', 'pixabay'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    technology:    { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['googleCSE', 'bing', 'googleScrape', 'pexels', 'pixabay', 'unsplash'] },
    crime:         { video: ['newsVideo', 'youtube', 'pexels', 'pixabay'], image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash'] },
    documentary:   { video: ['youtube', 'newsVideo', 'pexels', 'pixabay'], image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash'] },
    // Aesthetic themes → prefer stock footage
    nature:        { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'pixabay', 'unsplash', 'googleScrape', 'googleCSE', 'bing'] },
    travel:        { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'pixabay', 'unsplash', 'googleScrape', 'googleCSE', 'bing'] },
    lifestyle:     { video: ['pexels', 'pixabay', 'youtube', 'newsVideo'], image: ['pexels', 'unsplash', 'pixabay', 'googleScrape', 'googleCSE', 'bing'] },
    // Other
    history:       { video: ['youtube', 'newsVideo', 'pexels', 'pixabay'], image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash'] },
    entertainment: { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash'] },
    sports:        { video: ['youtube', 'pexels', 'pixabay', 'newsVideo'], image: ['googleScrape', 'googleCSE', 'bing', 'pexels', 'pixabay', 'unsplash'] },
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
    return { pexels: true, pixabay: true, unsplash: true, googleCSE: false, bing: false, duckduckgo: false, googleScrape: true, youtube: false, newsVideo: false };
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

/**
 * Generate simplified keyword variants for retry.
 * "intel workers leaving factory" → ["intel workers leaving", "intel workers", "workers leaving factory"]
 */
function getKeywordVariants(keyword) {
    const variants = [];
    const words = keyword.trim().split(/\s+/);

    if (words.length <= 1) return variants;

    // Drop last word: "intel workers leaving" → "intel workers"
    if (words.length >= 3) {
        variants.push(words.slice(0, -1).join(' '));
    }

    // Drop first word: "workers leaving factory"
    if (words.length >= 3) {
        variants.push(words.slice(1).join(' '));
    }

    // Keep only first 2 words: "intel workers"
    if (words.length >= 3) {
        variants.push(words.slice(0, 2).join(' '));
    }

    // Keep only last 2 words: "leaving factory"
    if (words.length >= 3) {
        const last2 = words.slice(-2).join(' ');
        if (!variants.includes(last2)) variants.push(last2);
    }

    // Single most meaningful word (longest word, likely the most specific)
    const sorted = [...words].sort((a, b) => b.length - a.length);
    if (!variants.includes(sorted[0])) variants.push(sorted[0]);

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
            // Apply niche search policy to rewrite query per-provider
            const providerKey = getProviderKey(provider);
            const searchQuery = nicheId ? rewriteQuery(keyword, nicheId, providerKey, scene) : keyword;
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

            // Try multiple results from this provider (not just the first unused)
            const maxTries = Math.min(results.length, 3);
            for (let attempt = 0; attempt < maxTries; attempt++) {
                const selected = attempt === 0
                    ? provider.pickUnused(results)
                    : results[attempt]; // fallback to next results if first download fails

                if (!selected) continue;

                try {
                    const outputPath = path.join(config.paths.temp, filenameBase + ext);
                    console.log(`  ⬇️  [${provider.name}] Downloading${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}...`);
                    const finalPath = await provider.download(selected.url, outputPath, { duration: sceneDuration, keyword: keyword, _directVideoUrl: selected._directVideoUrl || null });
                    const finalExt = path.extname(finalPath);
                    console.log(`  ✅ [${provider.name}] Downloaded: ${path.basename(finalPath)}`);

                    return {
                        path: finalPath,
                        ext: finalExt,
                        provider: provider.name,
                        mediaType: mediaType,
                        mediaWidth: selected.width || 0,
                        mediaHeight: selected.height || 0
                    };
                } catch (dlError) {
                    console.log(`  ⚠️ [${provider.name}] Download failed: ${dlError.message}${attempt < maxTries - 1 ? ', trying next result...' : ''}`);
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
    const { inlineVision = false, skipVisionAI = false } = options;
    console.log('\n🎥 Downloading stock footage...\n');

    // Initialize fresh provider instances with script context
    initProviders(scriptContext);

    // If no video providers enabled, force all scenes to image (and vice versa)
    const hasVideoProviders = videoProviders.some(p => p.isAvailable());
    const hasImageProviders = imageProviders.some(p => p.isAvailable());

    // Lazy-load vision module only when needed
    let analyzeSingleScene, createDefaultAnalysis;
    if (inlineVision) {
        const vision = require('./ai-vision');
        analyzeSingleScene = vision.analyzeSingleScene;
        createDefaultAnalysis = vision.createDefaultAnalysis;
    }

    const visualAnalysis = new Array(scenes.length);
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

        const keyword = scene.researchKeyword || scene.keyword;
        const sceneDuration = (scene.endTime || 0) - (scene.startTime || 0) || 10;
        const nicheId = scriptContext?.nicheId || '';
        console.log(`\nScene ${i} (${mediaType}): "${keyword}"${sourceHint ? ` [hint: ${sourceHint}]` : ''}${nicheId ? ` [niche: ${nicheId}]` : ''}`);

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
        } else {
            console.log(`  ❌ Scene ${i}: No media found after all retries`);
            scene.mediaFile = null;
            scene.mediaExtension = mediaType === 'image' ? '.jpg' : '.mp4';
            scene.sourceProvider = null;
            scene.mediaWidth = 0;
            scene.mediaHeight = 0;
        }

        // Inline vision analysis — runs immediately after this scene's download
        if (inlineVision && !skipVisionAI && scene.mediaFile) {
            try {
                visualAnalysis[i] = await analyzeSingleScene(scene, i, scriptContext);
                const icon = visualAnalysis[i].suitability === 'good' ? '✅'
                    : visualAnalysis[i].suitability === 'poor' ? '❌' : '⚠️';
                console.log(`  ${icon} Vision: ${visualAnalysis[i].suitability} — "${visualAnalysis[i].description?.substring(0, 50)}"`);
            } catch (e) {
                visualAnalysis[i] = createDefaultAnalysis(i);
            }
        } else {
            if (createDefaultAnalysis) {
                visualAnalysis[i] = createDefaultAnalysis(i);
            }
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
    for (const scene of scenes) {
        if (scene.sourceProvider) {
            providerHits[scene.sourceProvider] = (providerHits[scene.sourceProvider] || 0) + 1;
        } else if (!scene.mediaFile) {
            failed++;
        }
    }
    const hitsSummary = Object.entries(providerHits).sort((a, b) => b[1] - a[1]).map(([p, c]) => `${p}(${c})`).join(', ');
    console.log(`\n✅ All media downloaded!`);
    console.log(`  📊 Sources: ${hitsSummary}${failed ? ` | failed(${failed})` : ''}\n`);
    return { scenes, visualAnalysis };
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
                const url = await pexels.search(keyword, 1);
                if (url) {
                    console.log(`   🎬 Found on Pexels: ${url}`);
                    downloaded = await pexels.download(url, cacheFile, 1);
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
                const url = await pixabay.search(keyword, 1);
                if (url) {
                    console.log(`   🎬 Found on Pixabay: ${url}`);
                    downloaded = await pixabay.download(url, cacheFile, 1);
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

// ============================================================
// FOOTAGE RETRY FOR POOR VISION SCORES
// ============================================================

/**
 * Retry downloading media for a scene that scored "poor" in vision analysis.
 * Skips the provider that returned poor footage, tries others + keyword variants.
 *
 * @param {string} keyword - Original search keyword
 * @param {string} mediaType - 'video' or 'image'
 * @param {string} filenameBase - Base name for the file (e.g., 'scene-3-retry')
 * @param {number} sceneDuration - Duration in seconds
 * @param {string} sourceHint - AI source hint
 * @param {string[]} excludeProviders - Provider names to skip (already tried, returned poor footage)
 * @returns {Object|null} Download result or null
 */
async function retryPoorMedia(keyword, mediaType, filenameBase, sceneDuration = 10, sourceHint = '', excludeProviders = []) {
    const priorityOrder = getSmartPriority(sourceHint, mediaType, scriptContextRef);
    const allProviders = mediaType === 'video' ? videoProviders : imageProviders;
    const sourceMap = mediaType === 'video' ? VIDEO_SOURCE_MAP : IMAGE_SOURCE_MAP;
    const providers = reorderProviders(allProviders, priorityOrder, sourceMap);
    const ext = mediaType === 'video' ? '.mp4' : '.jpg';
    const excludeSet = new Set(excludeProviders);

    // Try 1: Other providers with same keyword (skip already-tried providers)
    for (const provider of providers) {
        if (!provider.isAvailable()) continue;
        if (excludeSet.has(provider.name)) continue;

        try {
            let results = await provider.search(keyword);
            results = provider.filterResults(results);
            if (results.length === 0) continue;

            const selected = provider.pickUnused(results);
            if (!selected) continue;

            const outputPath = path.join(config.paths.temp, filenameBase + ext);
            const finalPath = await provider.download(selected.url, outputPath, { duration: sceneDuration, keyword, _directVideoUrl: selected._directVideoUrl || null });

            return {
                path: finalPath,
                ext: path.extname(finalPath),
                provider: provider.name,
                mediaType,
                mediaWidth: selected.width || 0,
                mediaHeight: selected.height || 0
            };
        } catch (e) {
            continue;
        }
    }

    // Try 2: Keyword variants — but still skip excluded providers
    // (same YouTube video found with different keywords = same poor result)
    const variants = getKeywordVariants(keyword);
    for (const variant of variants) {
        for (const provider of providers) {
            if (!provider.isAvailable()) continue;
            if (excludeSet.has(provider.name)) continue;

            try {
                let results = await provider.search(variant);
                results = provider.filterResults(results);
                if (results.length === 0) continue;

                const selected = provider.pickUnused(results);
                if (!selected) continue;

                const outputPath = path.join(config.paths.temp, filenameBase + ext);
                const finalPath = await provider.download(selected.url, outputPath, { duration: sceneDuration, keyword: variant, _directVideoUrl: selected._directVideoUrl || null });

                return {
                    path: finalPath,
                    ext: path.extname(finalPath),
                    provider: provider.name,
                    mediaType,
                    mediaWidth: selected.width || 0,
                    mediaHeight: selected.height || 0
                };
            } catch (e) {
                continue;
            }
        }
    }

    return null;
}

module.exports = { downloadMedia, downloadAllMedia, initProviders, downloadBackgroundCanvas, retryPoorMedia };
