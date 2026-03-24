const { execFile, execFileSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const BaseProvider = require('./base-provider');
const { selectBestSegment, probeDuration: sharedProbeDuration } = require('../smart-segment');

// RSS feeds — only sites where we can actually extract video
// Priority: sites with proven video extraction first, then others
const NEWS_RSS_FEEDS = [
    // Tier 1: Proven reliable video extraction (DW has HLS in HTML, RT has direct mp4)
    { url: 'https://rss.dw.com/xml/rss-en-all', domain: 'dw.com', videoFeed: false, tier: 1 },
    { url: 'https://rss.dw.com/xml/rss-en-world', domain: 'dw.com', videoFeed: false, tier: 1 },
    { url: 'https://www.rt.com/rss/news/', domain: 'rt.com', videoFeed: false, tier: 1 },
    // Tier 2: Sites with extractable embeds (BBC video RSS is dead as of 2026)
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', domain: 'bbc.co.uk', videoFeed: false, tier: 2 },
    { url: 'https://www.france24.com/en/latest-news/rss', domain: 'france24.com', videoFeed: false, tier: 2 },
    { url: 'https://www.france24.com/en/rss', domain: 'france24.com', videoFeed: false, tier: 2 },
    // Euronews removed — returns 406 for all scraping attempts
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', domain: 'aljazeera.com', videoFeed: false, tier: 2 },
    // Tier 3: Sometimes have video
    { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', domain: 'cnbc.com', videoFeed: false, tier: 3 },
    { url: 'https://feeds.skynews.com/feeds/rss/world.xml', domain: 'sky.com', videoFeed: false, tier: 3 },
    { url: 'https://www.cbsnews.com/latest/rss/main', domain: 'cbsnews.com', videoFeed: false, tier: 3 },
    { url: 'https://globalnews.ca/feed/', domain: 'globalnews.ca', videoFeed: false, tier: 3 },
    { url: 'https://www.ndtv.com/rss/world-news', domain: 'ndtv.com', videoFeed: false, tier: 3 },
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

            // Run RSS + Rutube in parallel (both are fast API calls)
            const [rssUrls, rutubeUrls] = await Promise.all([
                this._searchNewsRSS(query),
                this._searchRutube(query),
            ]);

            // Merge: RSS first (scored by relevance), then Rutube confirmed videos
            urls.push(...rssUrls);
            for (const u of rutubeUrls) {
                if (!urls.some(e => e.url === u.url)) urls.push(u);
            }

            // Strategy 3: YouTube news fallback (if not enough results)
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

            // Sites where yt-dlp has WORKING dedicated extractors (handles JS players)
            // NOTE: rt.com excluded — yt-dlp's RTNews extractor returns 0 items even on pages with video
            // NOTE: aljazeera.com excluded — yt-dlp says "Unsupported", HTML scraping finds Brightcove embed
            const YTDLP_FIRST_DOMAINS = new Set(['bbc.co.uk', 'bbc.com', 'cnbc.com', 'sky.com']);

            // ── Title relevance scoring ─────────────────────────────────

            // Score how well an article title matches the search keyword.
            // Used to sort results so the most relevant article is tried first.
            const queryWordsLower = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
            function _titleRelevance(title) {
                if (!title || queryWordsLower.length === 0) return 0;
                const titleLower = title.toLowerCase();
                let hits = 0;
                for (const w of queryWordsLower) {
                    if (titleLower.includes(w)) hits++;
                }
                return hits / queryWordsLower.length; // 0.0 to 1.0
            }

            for (let i = 0; i < maxChecks; i++) {
                const urlInfo = urls[i];

                // YouTube/Rutube results are already confirmed
                if (urlInfo.confirmed) {
                    const relevance = _titleRelevance(urlInfo.title);
                    results.push({
                        id: `news-yt-${i}`,
                        url: urlInfo.url,
                        title: urlInfo.title || '',
                        width: urlInfo.width || 1280,
                        height: urlInfo.height || 720,
                        duration: urlInfo.duration || 0,
                        _directVideoUrl: null,
                        _titleRelevance: relevance,
                    });
                    console.log(`  ✅ [News] YouTube: "${(urlInfo.title || '').substring(0, 60)}" (${Math.round(urlInfo.duration || 0)}s) [rel: ${(relevance * 100).toFixed(0)}%]\n         → ${urlInfo.url}`);
                    if (results.length >= 5) break;
                    continue;
                }

                console.log(`  🔎 [News] Checking (${i + 1}/${maxChecks}): ${urlInfo.domain} — ${urlInfo.url.substring(0, 90)}`);

                const useYtdlpFirst = YTDLP_FIRST_DOMAINS.has(urlInfo.domain);

                if (useYtdlpFirst) {
                    const videoInfo = await this._checkHasVideo(urlInfo.url);
                    if (videoInfo) {
                        const title = urlInfo.title || videoInfo.title || '';
                        const relevance = _titleRelevance(title);
                        results.push({
                            id: `news-${urlInfo.domain}-${i}`,
                            url: urlInfo.url,
                            title,
                            width: videoInfo.width || 1280,
                            height: videoInfo.height || 720,
                            duration: videoInfo.duration || 0,
                            _directVideoUrl: null,
                            _titleRelevance: relevance,
                        });
                        console.log(`  ✅ [News] yt-dlp video on ${urlInfo.domain} (${Math.round(videoInfo.duration || 0)}s) [rel: ${(relevance * 100).toFixed(0)}%]\n         → ${urlInfo.url}`);
                        if (results.length >= 5) break;
                        continue;
                    }
                    const htmlVideo = await this._extractVideoFromHTML(urlInfo.url);
                    if (htmlVideo) {
                        const title = urlInfo.title || htmlVideo.title || '';
                        const relevance = _titleRelevance(title);
                        results.push({
                            id: `news-${urlInfo.domain}-${i}`,
                            url: urlInfo.url,
                            title,
                            width: 1280, height: 720, duration: 0,
                            _directVideoUrl: htmlVideo.videoUrl,
                            _titleRelevance: relevance,
                        });
                        console.log(`  ✅ [News] Direct video on ${urlInfo.domain} [rel: ${(relevance * 100).toFixed(0)}%]\n         → ${htmlVideo.videoUrl.substring(0, 100)}`);
                        if (results.length >= 5) break;
                    }
                } else {
                    const htmlVideo = await this._extractVideoFromHTML(urlInfo.url);
                    if (htmlVideo) {
                        const title = urlInfo.title || htmlVideo.title || '';
                        const relevance = _titleRelevance(title);
                        results.push({
                            id: `news-${urlInfo.domain}-${i}`,
                            url: urlInfo.url,
                            title,
                            width: 1280, height: 720, duration: 0,
                            _directVideoUrl: htmlVideo.videoUrl,
                            _titleRelevance: relevance,
                        });
                        console.log(`  ✅ [News] Direct video on ${urlInfo.domain} [rel: ${(relevance * 100).toFixed(0)}%]\n         → ${htmlVideo.videoUrl.substring(0, 100)}`);
                        if (results.length >= 5) break;
                        continue;
                    }
                    const videoInfo = await this._checkHasVideo(urlInfo.url);
                    if (videoInfo) {
                        const title = urlInfo.title || videoInfo.title || '';
                        const relevance = _titleRelevance(title);
                        results.push({
                            id: `news-${urlInfo.domain}-${i}`,
                            url: urlInfo.url,
                            title,
                            width: videoInfo.width || 1280,
                            height: videoInfo.height || 720,
                            duration: videoInfo.duration || 0,
                            _directVideoUrl: null,
                            _titleRelevance: relevance,
                        });
                        console.log(`  ✅ [News] yt-dlp video on ${urlInfo.domain} (${Math.round(videoInfo.duration || 0)}s) [rel: ${(relevance * 100).toFixed(0)}%]\n         → ${urlInfo.url}`);
                        if (results.length >= 5) break;
                    }
                }
            }

            // Sort results by title relevance — most relevant article tried first
            if (results.length > 1) {
                results.sort((a, b) => (b._titleRelevance || 0) - (a._titleRelevance || 0));
                console.log(`  📊 [News] Sorted ${results.length} results by relevance: ${results.map(r => `"${(r.title || '').substring(0, 40)}" ${((r._titleRelevance || 0) * 100).toFixed(0)}%`).join(' | ')}`);
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
                    // Tier 1 sites get big boost (proven extraction), videoFeed gets boost too
                    const tierBoost = feed.tier === 1 ? 5 : feed.tier === 2 ? 2 : 0;
                    // Boost articles whose URL contains /video/ (much more likely to have video)
                    const videoPathBoost = /\/video[s]?\//i.test(item.link) ? 3 : 0;
                    matches.push({
                        url: item.link,
                        domain: feed.domain,
                        title: item.title,
                        matchScore: matchCount + tierBoost + videoPathBoost + (feed.videoFeed ? 2 : 0),
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

    // ─── Strategy 2: Rutube (RT's video platform) ──────────────────────

    /**
     * Search Rutube for news videos. RT uploads all their content here.
     * Filters results to known news channels only.
     */
    async _searchRutube(query) {
        try {
            const words = query.trim().split(/\s+/);
            const searchQuery = words.slice(0, 6).join(' ');

            console.log(`  🔍 [News] Rutube search: "${searchQuery.substring(0, 50)}"...`);

            const response = await axios.get('https://rutube.ru/api/search/video/', {
                params: { query: searchQuery, page: 1, per_page: 15 },
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                },
            });

            const results = response.data?.results || [];
            if (results.length === 0) {
                console.log(`  ⚠️ [News] Rutube: no results`);
                return [];
            }

            // Filter to known news channels (RT, WION, Reuters, etc.)
            const NEWS_CHANNELS = /^(rt|rt \w|wion|reuters|dw|france\s*24|al\s*jazeera|bbc|cnn|sky\s*news|trt\s*world|military\s*summary)/i;
            const filtered = results.filter(v => {
                const author = (v.author?.name || '').trim();
                if (!NEWS_CHANNELS.test(author)) return false;
                const dur = v.duration || 0;
                if (dur < 15 || dur > 1800) return false; // 15s-30min
                return true;
            });

            if (filtered.length === 0) {
                console.log(`  ⚠️ [News] Rutube: ${results.length} results but none from news channels`);
                return [];
            }

            console.log(`  📰 [News] Rutube: ${filtered.length} news video(s) from: ${[...new Set(filtered.map(v => v.author?.name))].join(', ')}`);

            return filtered.slice(0, 3).map(v => ({
                url: v.video_url || `https://rutube.ru/video/${v.id}/`,
                domain: 'rutube.ru',
                title: v.title || '',
                duration: v.duration || 0,
                confirmed: true, // Rutube videos are confirmed to have video
            }));
        } catch (error) {
            console.log(`  ⚠️ [News] Rutube search failed: ${error.message}`);
            return [];
        }
    }

    // ─── HTML Video Extraction ───────────────────────────────────────────

    /**
     * Fetch a news article page and extract direct video URL from HTML.
     * Uses site-specific extractors first, then generic methods.
     */
    async _extractVideoFromHTML(url) {
        try {
            const domain = this._extractDomain(url) || '';
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1',
                },
                maxContentLength: 3 * 1024 * 1024,
                maxRedirects: 5,
            });

            const html = response.data;
            if (typeof html !== 'string') return null;

            let videoUrl = null;
            let title = '';

            // Extract page title
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').trim();

            // ── Site-specific extractors (most reliable) ──────────────
            if (!videoUrl) videoUrl = this._extractSiteSpecific(html, domain, url);

            // ── Generic methods ───────────────────────────────────────

            // Method 1: og:video meta tag
            if (!videoUrl) {
                const ogVideo = html.match(/<meta\s+[^>]*property=["']og:video(?::url)?["'][^>]*content=["']([^"']+)["']/i)
                    || html.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*property=["']og:video(?::url)?["']/i);
                if (ogVideo && this._isVideoUrl(ogVideo[1])) {
                    videoUrl = ogVideo[1];
                }
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

            // Method 4: Video URLs in __NEXT_DATA__ or __INITIAL_DATA__ JSON blobs
            if (!videoUrl) {
                videoUrl = this._extractFromScriptData(html);
            }

            // Method 5: Direct mp4/m3u8 URLs anywhere in the page
            if (!videoUrl) {
                // Prefer m3u8 (HLS) since many news sites use it
                const hlsMatch = html.match(/["'](https?:\/\/[^"'\s]+\.m3u8(?:\?[^"'\s]*)?)["']/i);
                if (hlsMatch) {
                    videoUrl = hlsMatch[1];
                }
            }
            if (!videoUrl) {
                const mp4Match = html.match(/["'](https?:\/\/[^"'\s]+\.mp4(?:\?[^"'\s]*)?)["']/i);
                if (mp4Match && !mp4Match[1].includes('thumbnail') && !mp4Match[1].includes('poster')) {
                    videoUrl = mp4Match[1];
                }
            }

            // Method 6: data-video-url or data-src attributes
            if (!videoUrl) {
                const dataVideoMatch = html.match(/data-(?:video-url|video-src|src|media-url)=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
                if (dataVideoMatch) {
                    videoUrl = dataVideoMatch[1];
                }
            }

            // Method 7: Embedded YouTube/Dailymotion/Brightcove
            if (!videoUrl) {
                videoUrl = this._extractEmbed(html);
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
     * Site-specific video extraction patterns.
     */
    _extractSiteSpecific(html, domain, pageUrl) {
        // DW.com — HLS streams in script blocks
        if (domain.includes('dw.com')) {
            // DW puts HLS URL in a JSON config like: "file":"https://hlsvod.dw.com/..."
            const dwHls = html.match(/["']file["']\s*:\s*["'](https?:\/\/hlsvod\.dw\.com[^"']+\.m3u8[^"']*)["']/i)
                || html.match(/(https?:\/\/hlsvod\.dw\.com[^"'\s]+\.m3u8[^"'\s]*)/i);
            if (dwHls) return dwHls[1];
        }

        // France24 — Dailymotion embeds or data attributes
        if (domain.includes('france24.com')) {
            // France24 video pages embed Dailymotion player
            const dmEmbed = html.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i);
            if (dmEmbed) return `https://www.dailymotion.com/video/${dmEmbed[1]}`;
            // Also check for data-video-id
            const dmId = html.match(/data-video-id=["']([a-zA-Z0-9]+)["']/i);
            if (dmId) return `https://www.dailymotion.com/video/${dmId[1]}`;
        }

        // Euronews — Dailymotion embeds in __NEXT_DATA__ or inline
        if (domain.includes('euronews.com')) {
            const dmEmbed = html.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i);
            if (dmEmbed) return `https://www.dailymotion.com/video/${dmEmbed[1]}`;
            // Euronews also has direct mp4 in data attributes
            const euroVid = html.match(/data-video-src=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
            if (euroVid) return euroVid[1];
        }

        // BBC — video URLs in __INITIAL_DATA__ or media meta
        if (domain.includes('bbc.co.uk') || domain.includes('bbc.com')) {
            // BBC puts video info in a large JSON blob — look for vpid or versionId
            const bbcVpid = html.match(/["']vpid["']\s*:\s*["']([a-zA-Z0-9]+)["']/i)
                || html.match(/["']versionId["']\s*:\s*["']([a-zA-Z0-9]+)["']/i);
            if (bbcVpid) {
                return `https://www.bbc.co.uk/mediaselector/5/redir/version/2.0/mediaset/pc/vpid/${bbcVpid[1]}/format/hls.m3u8`;
            }
            // BBC also has media in __INITIAL_DATA__: "url":"https://...bbc...mp4"
            const bbcMedia = html.match(/(https?:\/\/[^"'\s]*(?:bbcodspdns|bbc\.co\.uk\/iplayer|open\.live\.bbc)[^"'\s]*\.(?:mp4|m3u8)[^"'\s]*)/i);
            if (bbcMedia) return bbcMedia[1];
            // Fallback: any BBC-hosted mp4
            const bbcMp4 = html.match(/(https?:\/\/[^"'\s]*bbc[^"'\s]*\.mp4[^"'\s]*)/i);
            if (bbcMp4) return bbcMp4[1];
        }

        // Al Jazeera — Brightcove embed URL in JSON-LD or HTML
        if (domain.includes('aljazeera.com')) {
            // AJ embeds Brightcove player URL in JSON-LD embedUrl:
            // "embedUrl":"https://players.brightcove.net/ACCOUNT/PLAYER/index.html?videoId=VIDEO_ID"
            const bcEmbed = html.match(/players\.brightcove\.net\/(\d+)\/[^"']+\?videoId=(\d+)/i);
            if (bcEmbed) {
                // Return the full Brightcove player URL — yt-dlp can download from this
                return `https://players.brightcove.net/${bcEmbed[1]}/default_default/index.html?videoId=${bcEmbed[2]}`;
            }
            // Fallback: data attributes
            const bcAccount = html.match(/data-account=["'](\d+)["']/i);
            const bcVideo = html.match(/data-video-id=["'](\d+)["']/i);
            if (bcAccount && bcVideo) {
                return `https://players.brightcove.net/${bcAccount[1]}/default_default/index.html?videoId=${bcVideo[1]}`;
            }
            // Direct mp4 in __NEXT_DATA__
            const ajNextData = html.match(/__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/i);
            if (ajNextData) {
                const ajMp4 = ajNextData[1].match(/(https?:\/\/[^"\\]+\.mp4[^"\\]*)/i);
                if (ajMp4) return ajMp4[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
            }
        }

        // RT.com — direct mp4/m3u8 from their CDN (multiple CDN patterns)
        if (domain.includes('rt.com')) {
            // RT uses various CDN domains: mf.b37mrtl.ru, rtd.rt.com, cdnv.rt.com, etc.
            const rtVideo = html.match(/(https?:\/\/[^"'\s]*(?:b37mrtl|rtd\.rt|cdnv\.rt|cdn\.rt|rt\.com\/files|rt\.com\/static|rt\.com\/rtd)[^"'\s]*\.(?:mp4|m3u8)[^"'\s]*)/i);
            if (rtVideo) return rtVideo[1];
            // Also check for their video player data attributes
            const rtData = html.match(/data-(?:file|url|video)=["'](https?:\/\/[^"']+\.(?:mp4|m3u8)[^"']*)["']/i);
            if (rtData) return rtData[1];
            // RT sometimes has video ID in script: "id":"VIDEO_ID"
            const rtVideoId = html.match(/["']videoId["']\s*:\s*["']([^"']+)["']/i);
            if (rtVideoId) {
                // Try to construct video URL from ID
                const vidId = rtVideoId[1];
                return `https://www.rt.com/video/${vidId}/`;
            }
        }

        // CNBC — uses CNBC video player with __NEXT_DATA__
        if (domain.includes('cnbc.com')) {
            const cnbcVid = html.match(/(https?:\/\/[^"'\s]*cnbc[^"'\s]*\.mp4[^"'\s]*)/i);
            if (cnbcVid) return cnbcVid[1];
        }

        return null;
    }

    /**
     * Extract video URLs from __NEXT_DATA__, __INITIAL_DATA__, or similar JSON script blocks.
     * Many modern news sites (Next.js, etc.) embed all page data in these.
     */
    _extractFromScriptData(html) {
        const scriptPatterns = [
            /__NEXT_DATA__[^>]*>([\s\S]*?)<\/script>/i,
            /__INITIAL_DATA__[^>]*>([\s\S]*?)<\/script>/i,
            /window\.__data__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/i,
        ];

        for (const pattern of scriptPatterns) {
            const match = html.match(pattern);
            if (!match) continue;

            try {
                const jsonStr = match[1].trim();
                // Look for video URLs in the raw JSON string (faster than parsing)
                const videoPatterns = [
                    // HLS streams
                    /(https?:\/\/[^"'\s\\]+\.m3u8(?:\?[^"'\s\\]*)?)/i,
                    // Direct mp4
                    /(https?:\/\/[^"'\s\\]+\.mp4(?:\?[^"'\s\\]*)?)/i,
                    // Dailymotion video IDs
                    /dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i,
                ];

                for (const vp of videoPatterns) {
                    const vm = jsonStr.match(vp);
                    if (vm) {
                        if (vp.source.includes('dailymotion')) {
                            return `https://www.dailymotion.com/video/${vm[1]}`;
                        }
                        // Unescape JSON string escapes
                        return vm[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
                    }
                }
            } catch (e) { /* skip */ }
        }

        return null;
    }

    /**
     * Extract embedded video players (YouTube, Dailymotion, Brightcove, etc.)
     */
    _extractEmbed(html) {
        // YouTube embed
        const ytEmbed = html.match(/(?:src|href)=["'](https?:\/\/(?:www\.)?youtube\.com\/embed\/[^"']+)["']/i);
        if (ytEmbed) {
            const videoId = ytEmbed[1].match(/embed\/([a-zA-Z0-9_-]+)/);
            if (videoId) return `https://www.youtube.com/watch?v=${videoId[1]}`;
        }

        // Dailymotion embed (France24, Euronews, etc.)
        const dmEmbed = html.match(/(?:src|href)=["'](https?:\/\/(?:www\.)?dailymotion\.com\/embed\/video\/[^"']+)["']/i)
            || html.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/i);
        if (dmEmbed) {
            const id = dmEmbed[1].includes('dailymotion.com') ? dmEmbed[1] : `https://www.dailymotion.com/video/${dmEmbed[1]}`;
            return id;
        }

        // Vimeo embed
        const vimeoEmbed = html.match(/(?:src|href)=["'](https?:\/\/player\.vimeo\.com\/video\/[^"']+)["']/i);
        if (vimeoEmbed) return vimeoEmbed[1];

        return null;
    }

    /**
     * Check if a URL looks like a video file.
     */
    _isVideoUrl(url) {
        if (!url) return false;
        return /\.(mp4|m3u8|webm|mov)(\?|$)/i.test(url)
            || url.includes('youtube.com')
            || url.includes('dailymotion.com')
            || url.includes('vimeo.com')
            || url.includes('brightcove');
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

    // ─── Smart Segment Selection (Vision AI) ─────────────────────────────

    /**
     * Smart segment selection — delegates to shared smart-segment module.
     * Picks the best segment of a news video, avoiding anchors/text screens.
     */
    async _smartSegmentSelect(videoUrl, neededDuration, options, totalDuration = null) {
        return selectBestSegment(videoUrl, {
            neededDuration,
            keyword: options.keyword || '',
            context: {
                sceneText: options.sceneText || '',
                niche: options.niche || '',
                videoTopic: options.videoTopic || '',
            },
            totalDuration,
            numSamples: 4,
            batchSize: 2,        // News: smaller batches (remote URLs can be slow)
            minDuration: 20,     // News: score videos >= 20s
            providerTag: 'News',
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
     * @param {string} url - URL to check
     * @param {object} [opts] - Options
     * @param {number} [opts.socketTimeout=12] - Socket timeout in seconds
     * @param {number} [opts.processTimeout=20000] - Process timeout in ms
     */
    async _checkHasVideo(url, opts = {}) {
        const socketTimeout = opts.socketTimeout || 12;
        const processTimeout = opts.processTimeout || 20000;

        return new Promise((resolve) => {
            execFile(this._ytdlpPath, [
                url, '--dump-json', '--no-download',
                '--no-check-certificates', '--socket-timeout', String(socketTimeout),
                '--no-warnings',
            ], {
                timeout: processTimeout,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024,
            }, (error, stdout, stderr) => {
                if (error) {
                    const errMsg = (stderr || error.message || '').substring(0, 150);
                    if (errMsg.includes('Unsupported URL')) {
                        console.log(`    ❌ Unsupported by yt-dlp`);
                    } else if (error.killed) {
                        console.log(`    ❌ yt-dlp timed out (${socketTimeout}s)`);
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
     * Optionally uses vision AI to pick the best segment (avoids anchors/text screens).
     */
    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const downloadDuration = Math.ceil(duration) + 2;
        const maxHeight = config.youtube?.maxHeight || 720;

        // Check if this result has a direct video URL stored
        // (passed through result._directVideoUrl from search)
        const directUrl = options._directVideoUrl || null;

        if (directUrl && directUrl.match(/\.mp4(\?|$)/i)) {
            // Direct mp4 — try smart segment if vision available, then download
            const smartStart = await this._smartSegmentSelect(directUrl, downloadDuration, options);
            return this._downloadDirect(directUrl, outputPath, downloadDuration, smartStart);
        }

        if (directUrl && directUrl.match(/\.m3u8(\?|$)/i)) {
            // HLS stream — try smart segment, then download
            const smartStart = await this._smartSegmentSelect(directUrl, downloadDuration, options);
            return this._downloadHLS(directUrl, outputPath, downloadDuration, smartStart);
        }

        // For YouTube/Dailymotion embeds or yt-dlp-compatible URLs
        const downloadUrl = directUrl || url;

        const metadata = await this._checkHasVideo(downloadUrl);
        const totalDuration = metadata?.duration || 120;

        // Try smart segment selection via vision scoring.
        // Only works for URLs where ffmpeg can extract frames directly (YouTube streams, etc.)
        // Webpage URLs (Rutube, Dailymotion, etc.) need yt-dlp to resolve the stream first — skip scoring.
        const isWebpageUrl = /rutube\.ru|dailymotion\.com|youtube\.com|youtu\.be/i.test(downloadUrl);
        let smartStart = null;
        if (!isWebpageUrl) {
            smartStart = await this._smartSegmentSelect(downloadUrl, downloadDuration, options, totalDuration);
        } else if (totalDuration >= 60) {
            // For long yt-dlp videos, use a heuristic skip instead of always starting at 15s
            // Skip intro (first 10-15%) to avoid channel intros, anchors, sponsor reads
            const skipPct = Math.floor(totalDuration * 0.12);
            smartStart = Math.min(skipPct, 90);
            console.log(`  🎯 [News] Webpage URL — heuristic skip to ${smartStart}s (can't extract frames from ${this._extractDomain(downloadUrl)})`);
        }

        let startTime = smartStart != null ? smartStart : Math.min(5, Math.floor(totalDuration * 0.05));
        if (smartStart == null && totalDuration > 60) startTime = Math.min(15, Math.floor(totalDuration * 0.1));
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
     * Download an HLS stream using ffmpeg (for .m3u8 URLs from DW, BBC, etc.)
     */
    async _downloadHLS(hlsUrl, outputPath, duration, smartStart = null) {
        const startSec = smartStart != null ? smartStart : 5;
        console.log(`  📥 [News] HLS download from ${this._extractDomain(hlsUrl)}...${smartStart != null ? ` (smart start: ${startSec}s)` : ''}\n         → ${hlsUrl.substring(0, 100)}`);

        let ffmpegPath = null;
        try { ffmpegPath = require('ffmpeg-static'); } catch (e) {}
        if (!ffmpegPath) {
            ffmpegPath = process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg';
        }

        return new Promise((resolve, reject) => {
            const args = [
                '-ss', String(startSec),
                '-i', hlsUrl,
                '-t', String(duration),
                '-c', 'copy',
                '-bsf:a', 'aac_adtstoasc',
                '-y',
                outputPath,
            ];

            execFile(ffmpegPath, args, {
                timeout: 60000,
                windowsHide: true,
            }, (error) => {
                if (error) {
                    // Retry without -ss (some HLS servers don't support seeking)
                    const fallbackArgs = ['-i', hlsUrl, '-t', String(duration + 5), '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-y', outputPath];
                    execFile(ffmpegPath, fallbackArgs, { timeout: 60000, windowsHide: true }, (error2) => {
                        if (error2) return reject(new Error(`HLS download failed: ${error2.message}`));
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

    /**
     * Download a direct mp4 URL using axios (no yt-dlp needed).
     * Extracts a clip using ffmpeg if available, otherwise downloads full file.
     */
    async _downloadDirect(videoUrl, outputPath, duration, smartStart = null) {
        const startSec = smartStart != null ? smartStart : 5;
        console.log(`  📥 [News] Direct download from ${this._extractDomain(videoUrl)}...${smartStart != null ? ` (smart start: ${startSec}s)` : ''}\n         → ${videoUrl.substring(0, 100)}`);

        // Try using ffmpeg to download only a portion
        let ffmpegPath = null;
        try { ffmpegPath = require('ffmpeg-static'); } catch (e) {}

        if (ffmpegPath) {
            return new Promise((resolve, reject) => {
                const startTime = startSec;
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
