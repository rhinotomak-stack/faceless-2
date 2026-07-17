/**
 * QA Replacer — surgical scene replacement triggered by QA Studio "Apply Fixes".
 *
 * Given a flagged scene with qaReplacementKeyword + qaReplacementSource,
 * downloads new footage using the existing footage-manager pipeline,
 * then replaces the scene's mediaFile in-place (same filename).
 * No plan update needed — compositor keeps loading the same path.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { sanitizeSourceHint } = require('../media/source-policy');

// Lazy-require to avoid loading heavy provider modules until needed
let _footageManagerLoaded = false;
let _downloadMedia, _initProviders;

function _ensureLoaded() {
    if (_footageManagerLoaded) return;
    const fm = require('../media/footage-manager');
    _downloadMedia  = fm.downloadMedia;
    _initProviders  = fm.initProviders;
    _footageManagerLoaded = true;
}

/**
 * Replace a single scene's media file using AI-suggested keyword + source.
 *
 * @param {Object} params
 * @param {string} params.mediaFile         - Absolute path to the current scene file (will be overwritten)
 * @param {string} params.keyword           - qaReplacementKeyword from QA result
 * @param {string} params.sourceHint        - qaReplacementSource (storyblocks/youtube/reddit/...)
 * @param {string} params.mediaType         - 'video' | 'image'
 * @param {number} params.sceneDuration     - Scene duration in seconds
 * @param {Object} params.scriptContext     - Full scriptContext from video-plan.json (for provider context)
 * @param {Function} [params.onProgress]    - (message: string) => void
 * @returns {Promise<{success: boolean, newFile?: string, error?: string}>}
 */
async function replaceSceneMedia({ mediaFile, keyword, sourceHint, mediaType = 'video', sceneDuration = 8, scriptContext = {}, scene = null, onProgress }) {
    _ensureLoaded();

    const log = onProgress || (() => {});
    const ext = mediaType === 'video' ? '.mp4' : '.jpg';
    const tmpBase = 'qa-replacement-' + Date.now();
    const safeSourceHint = sanitizeSourceHint(sourceHint || '', 'youtube') || '';

    try {
        // Init providers with script context (sets API keys, niche, etc.)
        _initProviders(scriptContext);
        log(`Searching "${keyword}" via ${sourceHint || 'default'}…`);

        // Temporarily lower clip reject threshold for QA replacements —
        // the QA agent already verified what we need, so be more permissive than the build pipeline
        const origThreshold = process.env.CLIP_ANALYZER_REJECT_THRESHOLD;
        process.env.CLIP_ANALYZER_REJECT_THRESHOLD = '2';

        if (scene) {
            delete scene._aborted;
            delete scene._abortSignal;
            delete scene._timeoutFired;
            delete scene._inFlightCandidate;
            delete scene._inFlightCandidateReason;
            delete scene._inFlightCandidateReasons;
            delete scene._inFlightCandidateCount;
            delete scene._inFlightCandidateSince;
        }

        const downloaded = await _downloadMedia(
            keyword,
            mediaType,
            tmpBase,
            sceneDuration,
            safeSourceHint,
            scriptContext.nicheId || '',
            scene || null
        );

        // Restore threshold
        if (origThreshold !== undefined) process.env.CLIP_ANALYZER_REJECT_THRESHOLD = origThreshold;
        else delete process.env.CLIP_ANALYZER_REJECT_THRESHOLD;

        // downloadMedia returns { path, ext, provider, visionScore, ... } — extract the file path
        const downloadedPath = downloaded?.path || downloaded;

        if (!downloadedPath || typeof downloadedPath !== 'string') {
            const err = `No result for "${keyword}" — all providers failed or clip rejected by vision scoring`;
            console.error('[QA Replacer]', err, '| raw result:', downloaded);
            return { success: false, error: err };
        }
        if (!fs.existsSync(downloadedPath)) {
            const err = `Downloaded path does not exist on disk: ${downloadedPath}`;
            console.error('[QA Replacer]', err);
            return { success: false, error: err };
        }

        log(`Downloaded → ${path.basename(downloadedPath)} (score: ${downloaded?.visionScore ?? '?'}), replacing ${path.basename(mediaFile)}…`);
        console.log('[QA Replacer] Copying:', downloadedPath, '→', mediaFile);

        // Ensure destination directory exists
        const destDir = path.dirname(mediaFile);
        if (!fs.existsSync(destDir)) {
            const err = `Destination folder does not exist: ${destDir}`;
            console.error('[QA Replacer]', err);
            return { success: false, error: err };
        }

        // Use copy+delete instead of rename to handle cross-drive moves (D:\temp → C:\public)
        fs.copyFileSync(downloadedPath, mediaFile);
        try { fs.unlinkSync(downloadedPath); } catch (_) { /* temp cleanup — non-fatal */ }

        log(`Replaced ${path.basename(mediaFile)} ✓`);
        console.log('[QA Replacer] ✅ Success:', mediaFile);
        return { success: true, newFile: mediaFile };

    } catch (err) {
        console.error('[QA Replacer] Error:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Re-screenshot an articleHighlight MG by searching for a new article URL
 * and taking a fresh thum.io screenshot, overwriting the existing image file.
 *
 * @param {Object} params
 * @param {string} params.imageFile       - Absolute path to the existing article PNG (will be overwritten)
 * @param {string} params.keyword         - New search keyword (from QA replacement suggestion)
 * @param {string} params.headline        - MG headline text (used as fallback search query)
 * @param {string} params.subtext         - MG subtext (improves article search accuracy)
 * @param {Function} [params.onProgress]  - (message: string) => void
 * @returns {Promise<{success: boolean, articleUrl?: string, error?: string}>}
 */
async function rescreenhotArticle({ imageFile, keyword, headline, subtext, mgScene, onProgress }) {
    const log = onProgress || (() => {});
    const fs   = require('fs');
    const path = require('path');
    const axios = require('axios');

    try {
        const articleImage = require('../media/article-image');
        const searchTerm = keyword || headline || '';
        if (!searchTerm) return { success: false, error: 'No search keyword or headline provided' };

        // Ensure destination exists before downloading
        const destDir = path.dirname(imageFile);
        if (!fs.existsSync(destDir)) return { success: false, error: `Destination folder missing: ${destDir}` };

        // Try up to 3 different article URLs — skip ones that produce error/blank screenshots
        log(`Searching for article: "${searchTerm}"…`);
        const { items: searchItems } = await _searchMultipleArticles(articleImage, searchTerm, subtext || '');
        if (!searchItems || searchItems.length === 0) return { success: false, error: `No article found for "${searchTerm}"` };

        let savedData = null;
        let usedUrl   = null;

        for (const articleUrl of searchItems) {
            log(`Trying: ${articleUrl.substring(0, 70)}…`);
            const screenshotUrl = articleImage.getScreenshotUrl(articleUrl);

            let response = null;
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    if (attempt > 1) log(`thum.io timed out — retrying…`);
                    response = await axios({
                        url: screenshotUrl,
                        method: 'GET',
                        responseType: 'arraybuffer',
                        adapter: 'http',
                        timeout: 90000,
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                    });
                    break;
                } catch (_) { if (attempt === 2) { response = null; } }
            }

            if (!response?.data || response.data.byteLength < 10000) {
                log(`Too small or no response — skipping`);
                continue;
            }

            // Heuristic: a mostly-white/blank image is probably an error/paywall page.
            // Check: if file is tiny (<30KB) it's likely a placeholder — skip it.
            if (response.data.byteLength < 30000) {
                log(`Screenshot too small (${Math.round(response.data.byteLength/1024)}KB) — likely error page, skipping`);
                continue;
            }

            savedData = Buffer.from(response.data);
            usedUrl   = articleUrl;
            break;
        }

        if (!savedData) return { success: false, error: 'All candidate articles produced error/blank screenshots' };

        fs.writeFileSync(imageFile, savedData);
        log(`Article screenshot saved → ${path.basename(imageFile)} ✓`);
        console.log('[QA Replacer] ✅ Article re-screenshot:', imageFile, '| URL:', usedUrl);

        // Always clear stale highlight boxes — they were analyzed for the OLD article image.
        // New boxes will be re-analyzed by QA Studio after compositor reloads the new image.
        if (mgScene) {
            delete mgScene.highlightBoxes;
            log('Cleared stale highlight boxes (will re-analyze on next QA run)');
        }

        return { success: true, articleUrl: usedUrl };

    } catch (err) {
        console.error('[QA Replacer] rescreenhotArticle error:', err);
        return { success: false, error: err.message };
    }
}

// Collect multiple candidate article URLs for fallback iteration
async function _searchMultipleArticles(articleImage, keyword, subtext) {
    const { searchWeb } = require('../media/web-search-client');
    const SKIP_DOMAINS = require('../media/article-image').__SKIP_DOMAINS || [];

    try {
        const { items } = await searchWeb(`${keyword} news article`, {
            num: 8,
            timeout: 15000,
            providerOrder: ['tavily', 'googleCSE'],
        });
        const urls = items
            .map(i => i.link || '')
            .filter(u => u && !SKIP_DOMAINS.some(d => u.toLowerCase().includes(d)));
        if (urls.length > 0) return { items: urls };
    } catch (_) {}

    // Fallback: single URL from existing helper
    const url = await articleImage.findArticleUrl(keyword, subtext);
    return { items: url ? [url] : [] };
}

module.exports = { replaceSceneMedia, rescreenhotArticle };
