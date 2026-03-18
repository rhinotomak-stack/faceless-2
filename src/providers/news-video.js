const { execFile, execFileSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const BaseProvider = require('./base-provider');

// RSS feeds — only sites where we can actually extract video
// Priority: video-specific feeds first, then sites with og:video/mp4 in HTML
const NEWS_RSS_FEEDS = [
    // Video-specific feeds (highest chance of extractable video)
    { url: 'https://feeds.bbci.co.uk/news/video/rss.xml', domain: 'bbc.co.uk', videoFeed: true },
    // Sites that embed mp4/video in HTML (extractable via HTML scraping)
    { url: 'https://www.rt.com/rss/news/', domain: 'rt.com', videoFeed: false },
    { url: 'https://www.france24.com/en/rss', domain: 'france24.com', videoFeed: false },
    { url: 'https://rss.dw.com/xml/rss-en-all', domain: 'dw.com', videoFeed: false },
    { url: 'https://www.euronews.com/rss', domain: 'euronews.com', videoFeed: false },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', domain: 'aljazeera.com', videoFeed: false },
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', domain: 'bbc.co.uk', videoFeed: false },
    { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', domain: 'cnbc.com', videoFeed: false },
    { url: 'https://feeds.skynews.com/feeds/rss/world.xml', domain: 'sky.com', videoFeed: false },
    { url: 'https://www.cbsnews.com/latest/rss/main', domain: 'cbsnews.com', videoFeed: false },
    { url: 'https://globalnews.ca/feed/', domain: 'globalnews.ca', videoFeed: false },
    { url: 'https://www.ndtv.com/rss/world-news', domain: 'ndtv.com', videoFeed: false },
];

// YouTube news channels for fallback
const NEWS_YOUTUBE_CHANNELS = [
    'BBC News', 'Al Jazeera English', 'France 24 English',
    'DW News', 'Euronews', 'RT', 'CNN', 'Reuters',
    'Sky News', 'WION', 'TRT World',
];

// Stop words to skip in keyword matching
const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
    'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
    'not', 'no', 'so', 'if', 'as', 'its', 'it', 'my', 'he', 'she', 'we',
    'they', 'you', 'your', 'his', 'her', 'our', 'their', 'about', 'into',
    'new', 'how', 'what', 'when', 'where', 'who', 'which', 'why', 'all',
    'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
    'than', 'too', 'very', 'just', 'also', 'now', 'video', 'footage',
    'report', 'news', 'recent', 'latest', 'current', 'aerial', 'close',
    'view', 'image', 'graphic', 'map',
]);

class NewsVideoProvider extends BaseProvider {
    constructor() {
        super('News Videos', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._scriptContext = null;
    }

    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    isAvailable() {
        if (!this._ytdlpChecked) {
            this._ytdlpChecked = true;
            this._ytdlpAvailable = false;

            const projectRoot = path.join(__dirname, '..', '..');
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
                        windowsHide: true
                    });
                    this._ytdlpPath = candidate;
                    this._ytdlpAvailable = true;
                    break;
                } catch (e) {
                    // try next
                }
            }
        }
        return this._ytdlpAvailable;
    }

    /**
     * Search for news videos.
     * 1) RSS feeds → extract video URL from HTML (no yt-dlp dependency for detection)
     * 2) YouTube news search (always-works fallback)
     */
    async search(keyword) {
        try {
            let query = keyword;
            const words = query.trim().split(/\s+/);
            if (words.length > 8) query = words.slice(0, 8).join(' ');

            console.log(`  🔍 [News] Searching: "${query}" on news sites...`);

            let urls = [];

            // Strategy 1: RSS feeds → HTML video extraction
            const rssUrls = await this._searchNewsRSS(query);
            urls.push(...rssUrls);

            // Strategy 2: YouTube news (always available)
            if (urls.length < 2) {
                const ytUrls = await this._searchYouTubeNews(query);
                for (const u of ytUrls) {
                    if (!urls.some(e => e.url === u.url)) urls.push(u);
                }
            }

            if (urls.length === 0) {
                console.log(`  ⚠️ [News] No news articles found`);
                return [];
            }

            console.log(`  📰 [News] Found ${urls.length} result(s), checking for video...`);

            const results = [];
            const maxChecks = Math.min(urls.length, 12);

            for (let i = 0; i < maxChecks; i++) {
                const urlInfo = urls[i];

                // YouTube results are already confirmed
                if (urlInfo.confirmed) {
                    results.push({
                        id: `news-yt-${i}`,
                        url: urlInfo.url,
                        title: urlInfo.title || '',
                        width: urlInfo.width || 1280,
                        height: urlInfo.height || 720,
                        duration: urlInfo.duration || 0,
                        _directVideoUrl: null,
                    });
                    console.log(`  ✅ [News] YouTube: "${(urlInfo.title || '').substring(0, 60)}" (${Math.round(urlInfo.duration || 0)}s)\n         → ${urlInfo.url}`);
                    if (results.length >= 3) break;
                    continue;
                }

                // News site article — extract video from HTML first, then try yt-dlp
                console.log(`  🔎 [News] Checking (${i + 1}/${maxChecks}): ${urlInfo.domain} — ${urlInfo.url.substring(0, 90)}`);

                // Step A: Try HTML scraping for direct video URL
                const htmlVideo = await this._extractVideoFromHTML(urlInfo.url);
                if (htmlVideo) {
                    results.push({
                        id: `news-${urlInfo.domain}-${i}`,
                        url: urlInfo.url,
                        title: urlInfo.title || htmlVideo.title || '',
                        width: 1280,
                        height: 720,
                        duration: 0,
                        _directVideoUrl: htmlVideo.videoUrl,
                    });
                    console.log(`  ✅ [News] Direct video on ${urlInfo.domain}\n         → ${htmlVideo.videoUrl.substring(0, 100)}`);
                    if (results.length >= 3) break;
                    continue;
                }

                // Step B: Try yt-dlp as fallback
                const videoInfo = await this._checkHasVideo(urlInfo.url);
                if (videoInfo) {
                    results.push({
                        id: `news-${urlInfo.domain}-${i}`,
                        url: urlInfo.url,
                        title: urlInfo.title || videoInfo.title || '',
                        width: videoInfo.width || 1280,
                        height: videoInfo.height || 720,
                        duration: videoInfo.duration || 0,
                        _directVideoUrl: null,
                    });
                    console.log(`  ✅ [News] yt-dlp video on ${urlInfo.domain} (${Math.round(videoInfo.duration || 0)}s)\n         → ${urlInfo.url}`);
                    if (results.length >= 3) break;
                }
            }

            if (results.length === 0) {
                console.log(`  ⚠️ [News] No results had extractable video`);
            }

            return results;
        } catch (error) {
            console.log(`  ⚠️ [News] Search failed: ${error.message}`);
            return [];
        }
    }

    // ─── Strategy 1: RSS Feeds ───────────────────────────────────────────

    async _searchNewsRSS(query) {
        const queryWords = query.toLowerCase().split(/\s+/)
            .filter(w => w.length >= 3 && !STOP_WORDS.has(w));

        if (queryWords.length === 0) {
            console.log(`  ⚠️ [News] No meaningful keywords for RSS`);
            return [];
        }

        console.log(`  🔍 [News] RSS keywords: [${queryWords.join(', ')}]`);

        const feedPromises = NEWS_RSS_FEEDS.map(feed => this._fetchRSSFeed(feed, queryWords));
        const feedResults = await Promise.all(feedPromises);

        const allMatches = feedResults.flat();
        allMatches.sort((a, b) => b.matchScore - a.matchScore);

        const urls = [];
        for (const match of allMatches) {
            if (!urls.some(u => u.url === match.url)) urls.push(match);
            if (urls.length >= 8) break;
        }

        if (urls.length > 0) {
            console.log(`  📰 [News] RSS found ${urls.length} article(s) from: ${[...new Set(urls.map(u => u.domain))].join(', ')}`);
        } else {
            console.log(`  ⚠️ [News] RSS: no keyword matches`);
        }

        return urls;
    }

    async _fetchRSSFeed(feed, queryWords) {
        try {
            const response = await axios.get(feed.url, {
                timeout: 8000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
                    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
                },
                maxContentLength: 2 * 1024 * 1024,
            });

            const items = this._parseRSSItems(response.data);
            const matches = [];

            for (const item of items) {
                const text = ((item.title || '') + ' ' + (item.description || '')).toLowerCase();

                let matchCount = 0;
                for (const word of queryWords) {
                    if (text.includes(word)) matchCount++;
                }

                const minMatches = queryWords.length <= 2 ? 1 : 2;
                if (matchCount >= minMatches) {
                    matches.push({
                        url: item.link,
                        domain: feed.domain,
                        title: item.title,
                        matchScore: matchCount + (feed.videoFeed ? 2 : 0), // Boost video-specific feeds
                    });
                }
            }

            return matches;
        } catch (error) {
            return [];
        }
    }

    _parseRSSItems(xml) {
        const items = [];
        const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
        let match;

        while ((match = itemRegex.exec(xml)) !== null) {
            const block = match[1];

            let title = '';
            const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (titleMatch) {
                title = titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
            }

            let link = '';
            const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
            if (linkMatch) {
                link = linkMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
            }
            if (!link) {
                const linkAttrMatch = block.match(/<link[^>]+href=["']([^"']+)["']/i);
                if (linkAttrMatch) link = linkAttrMatch[1];
            }

            let description = '';
            const descMatch = block.match(/<description[^>]*>([\s\S]*?)<\/description>/i);
            if (descMatch) {
                description = descMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').substring(0, 300).trim();
            }

            if (title && link && link.startsWith('http')) {
                // Clean RSS tracking params
                link = link.replace(/&amp;/g, '&');
                items.push({ title, link, description });
            }
        }

        return items;
    }

    // ─── HTML Video Extraction ───────────────────────────────────────────

    /**
     * Fetch a news article page and extract direct video URL from HTML.
     * Looks for: og:video, <video>/<source> tags, JSON-LD VideoObject, inline mp4 URLs.
     * This works where yt-dlp fails because we're looking for the raw video URL.
     */
    async _extractVideoFromHTML(url) {
        try {
            const response = await axios.get(url, {
                timeout: 12000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                maxContentLength: 3 * 1024 * 1024,
                // Follow redirects
                maxRedirects: 5,
            });

            const html = response.data;
            if (typeof html !== 'string') return null;

            let videoUrl = null;
            let title = '';

            // Extract page title
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();

            // Method 1: og:video meta tag (most reliable)
            const ogVideo = html.match(/<meta\s+[^>]*property=["']og:video(?::url)?["'][^>]*content=["']([^"']+)["']/i)
                || html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:video(?::url)?["']/i);
            if (ogVideo && this._isVideoUrl(ogVideo[1])) {
                videoUrl = ogVideo[1];
            }

            // Method 2: <video> or <source> tags with mp4/m3u8
            if (!videoUrl) {
                const videoSrcMatch = html.match(/<(?:video|source)[^>]+src=["']([^"']+\.(?:mp4|m3u8|webm)[^"']*)["']/i);
                if (videoSrcMatch) {
                    videoUrl = this._resolveUrl(videoSrcMatch[1], url);
                }
            }

            // Method 3: JSON-LD VideoObject
            if (!videoUrl) {
                const jsonLdMatches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
                for (const m of jsonLdMatches) {
                    try {
                        const data = JSON.parse(m[1]);
                        const videoObj = this._findVideoObject(data);
                        if (videoObj) {
                            videoUrl = videoObj;
                            break;
                        }
                    } catch (e) { /* skip bad json */ }
                }
            }

            // Method 4: Direct mp4 URLs in the page (common on RT.com, etc.)
            if (!videoUrl) {
                const mp4Match = html.match(/["'](https?:\/\/[^"'\s]+\.mp4(?:\?[^"'\s]*)?)["']/i);
                if (mp4Match && !mp4Match[1].includes('thumbnail') && !mp4Match[1].includes('poster')) {
                    videoUrl = mp4Match[1];
                }
            }

            // Method 5: data-video-url or data-src attributes
            if (!videoUrl) {
                const dataVideoMatch = html.match(/data-(?:video-url|video-src|src)=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
                if (dataVideoMatch) {
                    videoUrl = dataVideoMatch[1];
                }
            }

            // Method 6: Embedded YouTube/Dailymotion (common on euronews, france24)
            if (!videoUrl) {
                const embedMatch = html.match(/(?:src|href)=["'](https?:\/\/(?:www\.)?(?:youtube\.com\/embed|player\.vimeo\.com|www\.dailymotion\.com\/embed)\/[^"']+)["']/i);
                if (embedMatch) {
                    videoUrl = embedMatch[1];
                    // Convert YouTube embed to watch URL for yt-dlp
                    if (videoUrl.includes('youtube.com/embed/')) {
                        const videoId = videoUrl.match(/embed\/([a-zA-Z0-9_-]+)/);
                        if (videoId) videoUrl = `https://www.youtube.com/watch?v=${videoId[1]}`;
                    }
                }
            }

            if (videoUrl) {
                return { videoUrl, title };
            }

            console.log(`    ❌ No video URL found in HTML`);
            return null;
        } catch (error) {
            console.log(`    ❌ Page fetch failed: ${error.response?.status || error.message}`);
            return null;
        }
    }

    /**
     * Check if a URL looks like a video file.
     */
    _isVideoUrl(url) {
        if (!url) return false;
        return /\.(mp4|m3u8|webm|mov)(\?|$)/i.test(url)
            || url.includes('youtube.com')
            || url.includes('dailymotion.com')
            || url.includes('vimeo.com');
    }

    /**
     * Resolve a potentially relative URL against a base URL.
     */
    _resolveUrl(relative, base) {
        try {
            return new URL(relative, base).href;
        } catch (e) {
            return relative;
        }
    }

    /**
     * Find contentUrl in JSON-LD VideoObject (may be nested).
     */
    _findVideoObject(data) {
        if (!data) return null;
        if (Array.isArray(data)) {
            for (const item of data) {
                const result = this._findVideoObject(item);
                if (result) return result;
            }
            return null;
        }
        if (typeof data === 'object') {
            if (data['@type'] === 'VideoObject' && data.contentUrl) {
                return data.contentUrl;
            }
            // Check nested objects
            if (data.video && typeof data.video === 'object') {
                return this._findVideoObject(data.video);
            }
            if (data['@graph']) {
                return this._findVideoObject(data['@graph']);
            }
        }
        return null;
    }

    // ─── Strategy 2: YouTube News ────────────────────────────────────────

    async _searchYouTubeNews(query) {
        const shuffled = [...NEWS_YOUTUBE_CHANNELS].sort(() => Math.random() - 0.5);

        const searchTerms = [
            `${query} news report`,
            `${query} ${shuffled[0]}`,
        ];

        const urls = [];

        for (const term of searchTerms) {
            if (urls.length >= 3) break;
            try {
                console.log(`  🔍 [News] yt-dlp YouTube search: "${term.substring(0, 50)}"...`);
                const results = await this._ytdlpYouTubeSearch(term, 3);
                for (const r of results) {
                    if (!urls.some(e => e.url === r.url)) urls.push(r);
                }
            } catch (e) { /* continue */ }
        }

        if (urls.length > 0) {
            console.log(`  📰 [News] YouTube news found ${urls.length} video(s)`);
        }
        return urls;
    }

    _ytdlpYouTubeSearch(query, maxResults = 3) {
        return new Promise((resolve) => {
            const args = [
                `ytsearch${maxResults}:${query}`,
                '--dump-json',
                '--no-download',
                '--no-warnings',
                '--no-check-certificates',
                '--socket-timeout', '15',
                '--flat-playlist',
            ];

            execFile(this._ytdlpPath, args, {
                timeout: 20000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024,
            }, (error, stdout) => {
                if (error || !stdout) return resolve([]);

                const results = [];
                const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'));
                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);
                        const url = data.webpage_url || data.url;
                        if (!url) continue;
                        const duration = data.duration || 0;
                        if (duration < 15 || duration > 1800) continue;

                        results.push({
                            url,
                            domain: 'youtube.com',
                            title: data.title || '',
                            duration,
                            width: data.width || 1280,
                            height: data.height || 720,
                            confirmed: true,
                        });
                    } catch (e) { /* skip */ }
                }
                resolve(results);
            });
        });
    }

    // ─── Shared Helpers ──────────────────────────────────────────────────

    _extractDomain(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, '');
        } catch (e) {
            return null;
        }
    }

    /**
     * Check if a URL has extractable video using yt-dlp.
     */
    async _checkHasVideo(url) {
        return new Promise((resolve) => {
            execFile(this._ytdlpPath, [
                url, '--dump-json', '--no-download',
                '--no-check-certificates', '--socket-timeout', '15',
            ], {
                timeout: 30000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                if (error) {
                    const errMsg = (stderr || error.message || '').substring(0, 150);
                    if (errMsg.includes('Unsupported URL')) {
                        console.log(`    ❌ Unsupported by yt-dlp`);
                    } else if (error.killed) {
                        console.log(`    ❌ Timed out`);
                    } else {
                        console.log(`    ❌ yt-dlp: ${errMsg.split('\n')[0]}`);
                    }
                    return resolve(null);
                }

                try {
                    const firstLine = stdout.split('\n').find(l => l.trim().startsWith('{'));
                    if (!firstLine) return resolve(null);

                    const data = JSON.parse(firstLine);
                    const duration = data.duration || 0;
                    if (duration < 5) return resolve(null);
                    if (data.vcodec === 'none') return resolve(null);

                    resolve({
                        title: data.title || '',
                        duration,
                        width: data.width || 1280,
                        height: data.height || 720,
                    });
                } catch (e) {
                    resolve(null);
                }
            });
        });
    }

    /**
     * Download a video clip.
     * If we have a direct video URL (mp4), download directly.
     * Otherwise use yt-dlp.
     */
    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const downloadDuration = Math.ceil(duration) + 2;
        const maxHeight = config.youtube?.maxHeight || 720;

        // Check if this result has a direct video URL stored
        // (passed through result._directVideoUrl from search)
        const directUrl = options._directVideoUrl || null;

        if (directUrl && directUrl.match(/\.mp4(\?|$)/i)) {
            // Direct mp4 download — no yt-dlp needed
            return this._downloadDirect(directUrl, outputPath, downloadDuration);
        }

        // For YouTube embeds found in HTML or yt-dlp-compatible URLs
        const downloadUrl = directUrl || url;

        const metadata = await this._checkHasVideo(downloadUrl);
        const totalDuration = metadata?.duration || 120;

        let startTime = Math.min(5, Math.floor(totalDuration * 0.05));
        if (totalDuration > 60) startTime = Math.min(15, Math.floor(totalDuration * 0.1));
        const endTime = Math.min(startTime + downloadDuration, totalDuration);

        console.log(`  📥 [News] ${Math.round(totalDuration)}s video → extracting ${startTime}s-${endTime}s`);

        const args = [
            downloadUrl,
            '-f', `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]`,
            '--download-sections', `*${startTime}-${endTime}`,
            '--merge-output-format', 'mp4',
            '--no-playlist', '--no-warnings', '--no-check-certificates',
            '-o', outputPath,
            '--force-overwrites', '--max-filesize', '50M',
        ];

        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) args.push('--ffmpeg-location', path.dirname(ffmpegPath));
        } catch (e) {}

        return new Promise((resolve, reject) => {
            console.log(`  📥 [News] Downloading from ${this._extractDomain(downloadUrl)}...\n         → ${downloadUrl}`);

            execFile(this._ytdlpPath, args, {
                timeout: 120000,
                windowsHide: true,
            }, (error) => {
                if (error) {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                    return reject(new Error(`News video download failed: ${error.message}`));
                }

                if (!fs.existsSync(outputPath)) {
                    const dir = path.dirname(outputPath);
                    const base = path.basename(outputPath, '.mp4');
                    try {
                        const files = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.mp4'));
                        if (files.length > 0) fs.renameSync(path.join(dir, files[0]), outputPath);
                    } catch (e) {}
                }

                if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                    return reject(new Error('yt-dlp produced empty or missing file'));
                }

                console.log(`  ✅ [News] Downloaded: ${path.basename(outputPath)}`);
                resolve(outputPath);
            });
        });
    }

    /**
     * Download a direct mp4 URL using axios (no yt-dlp needed).
     * Extracts a clip using ffmpeg if available, otherwise downloads full file.
     */
    async _downloadDirect(videoUrl, outputPath, duration) {
        console.log(`  📥 [News] Direct download from ${this._extractDomain(videoUrl)}...\n         → ${videoUrl.substring(0, 100)}`);

        // Try using ffmpeg to download only a portion
        let ffmpegPath = null;
        try { ffmpegPath = require('ffmpeg-static'); } catch (e) {}

        if (ffmpegPath) {
            // Use ffmpeg to download a clip (skip first 5s for intros)
            return new Promise((resolve, reject) => {
                const startTime = 5;
                const args = [
                    '-ss', String(startTime),
                    '-i', videoUrl,
                    '-t', String(duration),
                    '-c', 'copy',
                    '-y',
                    outputPath,
                ];

                execFile(ffmpegPath, args, {
                    timeout: 60000,
                    windowsHide: true,
                }, (error) => {
                    if (error) {
                        // Fallback: try without -ss (some servers don't support seeking)
                        const fallbackArgs = [
                            '-i', videoUrl,
                            '-t', String(duration + 5),
                            '-c', 'copy',
                            '-y',
                            outputPath,
                        ];
                        execFile(ffmpegPath, fallbackArgs, {
                            timeout: 60000,
                            windowsHide: true,
                        }, (error2) => {
                            if (error2) {
                                return reject(new Error(`Direct download failed: ${error2.message}`));
                            }
                            if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                                return reject(new Error('ffmpeg produced empty file'));
                            }
                            console.log(`  ✅ [News] Downloaded: ${path.basename(outputPath)}`);
                            resolve(outputPath);
                        });
                        return;
                    }

                    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                        return reject(new Error('ffmpeg produced empty file'));
                    }
                    console.log(`  ✅ [News] Downloaded: ${path.basename(outputPath)}`);
                    resolve(outputPath);
                });
            });
        }

        // Fallback: download with axios (full file, limited size)
        const response = await axios.get(videoUrl, {
            responseType: 'stream',
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                if (fs.statSync(outputPath).size < 1000) {
                    return reject(new Error('Downloaded file too small'));
                }
                console.log(`  ✅ [News] Downloaded: ${path.basename(outputPath)}`);
                resolve(outputPath);
            });
            writer.on('error', reject);
        });
    }
}

module.exports = NewsVideoProvider;
