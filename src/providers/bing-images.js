const axios = require('axios');
const BaseProvider = require('./base-provider');
const config = require('../config');

// Rotate User-Agents to reduce blocking
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

// Domains to skip (Bing's own resources, watermarked stock, tiny icons)
const SKIP_DOMAINS = [
    'bing.com', 'bing.net', 'microsoft.com', 'msn.com', 'live.com',
    'shutterstock.com', 'gettyimages.com', 'istockphoto.com', 'dreamstime.com',
    '123rf.com', 'depositphotos.com', 'alamy.com', 'bigstockphoto.com',
    'stock.adobe.com', 'vectorstock.com',
];

class BingImagesProvider extends BaseProvider {
    constructor() {
        super('Bing Images', 'image');
        this.requestCount = 0;
    }

    isAvailable() {
        // Always available — uses web scraping as fallback when no API key
        return true;
    }

    async search(keyword) {
        // Try API first if key is available
        if (config.bing.apiKey) {
            const apiResults = await this._searchAPI(keyword);
            if (apiResults.length > 0) return apiResults;
        }

        // Fallback: web scraping
        return this._searchScrape(keyword);
    }

    async _searchAPI(keyword) {
        try {
            const response = await axios.get('https://api.bing.microsoft.com/v7.0/images/search', {
                headers: {
                    'Ocp-Apim-Subscription-Key': config.bing.apiKey
                },
                params: {
                    q: keyword,
                    count: 15,
                    imageType: 'Photo',
                    size: 'Large',
                    aspect: 'Wide',
                    safeSearch: 'Moderate'
                },
                timeout: 15000
            });

            if (!response.data.value || response.data.value.length === 0) {
                return [];
            }

            return response.data.value.map((item, idx) => ({
                id: `bing-${item.imageId || idx}`,
                url: item.contentUrl,
                width: item.width || 0,
                height: item.height || 0
            }));
        } catch (error) {
            if (error.response?.status === 401) {
                console.log(`  ⚠️ [Bing Images] Invalid API key, falling back to scraper`);
            } else if (error.response?.status === 429) {
                console.log(`  ⚠️ [Bing Images] API rate limited, falling back to scraper`);
            } else {
                console.log(`  ⚠️ [Bing Images] API failed: ${error.message}`);
            }
            return [];
        }
    }

    async _searchScrape(keyword) {
        const userAgent = USER_AGENTS[this.requestCount % USER_AGENTS.length];
        this.requestCount++;

        try {
            // Bing image search URL — qft filters: large size, photo type, wide aspect
            const url = `https://www.bing.com/images/search?q=${encodeURIComponent(keyword)}&qft=+filterui:imagesize-large+filterui:photo-photo+filterui:aspect-wide&form=IRFLTR&first=1`;

            const response = await axios.get(url, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Referer': 'https://www.bing.com/',
                },
                timeout: 15000,
                maxRedirects: 5,
            });

            const html = response.data;
            const imageUrls = []; // { url, width, height, title, source }

            // Method 1: Rich metadata JSON blobs — best source (has title, dimensions, source page)
            // These contain murl (media URL), t (title), mw/mh (width/height), purl (page URL)
            const iuscRegex = /class="iusc"[^>]*m="(\{[^"]*\})"/gi;
            let match;
            while ((match = iuscRegex.exec(html)) !== null && imageUrls.length < 25) {
                try {
                    const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                    const parsed = JSON.parse(decoded);
                    if (parsed.murl && this._isValidImageUrl(parsed.murl)) {
                        if (!imageUrls.some(e => e.url === parsed.murl)) {
                            imageUrls.push({
                                url: parsed.murl,
                                width: parsed.mw || 0,
                                height: parsed.mh || 0,
                                title: parsed.t || '',
                                source: parsed.purl || '',
                            });
                        }
                    }
                } catch {}
            }

            // Method 2: m= JSON blobs (alternate encoding of same metadata)
            if (imageUrls.length < 8) {
                const mJsonRegex = /m\s*=\s*"(\{[^"]+\})"/gi;
                while ((match = mJsonRegex.exec(html)) !== null && imageUrls.length < 25) {
                    try {
                        const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
                        const parsed = JSON.parse(decoded);
                        if (parsed.murl && this._isValidImageUrl(parsed.murl)) {
                            if (!imageUrls.some(e => e.url === parsed.murl)) {
                                imageUrls.push({
                                    url: parsed.murl,
                                    width: parsed.mw || 0,
                                    height: parsed.mh || 0,
                                    title: parsed.t || '',
                                    source: parsed.purl || '',
                                });
                            }
                        }
                    } catch {}
                }
            }

            // Method 3: "murl":"URL" regex fallback (no metadata but reliable)
            if (imageUrls.length < 5) {
                const murlRegex = /"murl"\s*:\s*"(https?:\/\/[^"]+)"/gi;
                while ((match = murlRegex.exec(html)) !== null && imageUrls.length < 25) {
                    const imgUrl = this._unescapeUrl(match[1]);
                    if (this._isValidImageUrl(imgUrl) && !imageUrls.some(e => e.url === imgUrl)) {
                        imageUrls.push({ url: imgUrl, width: 0, height: 0, title: '', source: '' });
                    }
                }
            }

            // Method 4: data-src-hq attributes
            if (imageUrls.length < 5) {
                const dataSrcRegex = /data-src-hq\s*=\s*"(https?:\/\/[^"]+)"/gi;
                while ((match = dataSrcRegex.exec(html)) !== null && imageUrls.length < 25) {
                    const imgUrl = this._unescapeUrl(match[1]);
                    if (this._isValidImageUrl(imgUrl) && !imageUrls.some(e => e.url === imgUrl)) {
                        imageUrls.push({ url: imgUrl, width: 0, height: 0, title: '', source: '' });
                    }
                }
            }

            // Method 5: mediaurl= in anchor hrefs
            if (imageUrls.length < 5) {
                const mediaurlRegex = /mediaurl=(https?%3[Aa]%2[Ff]%2[Ff][^&"]+)/gi;
                while ((match = mediaurlRegex.exec(html)) !== null && imageUrls.length < 25) {
                    const imgUrl = decodeURIComponent(match[1]);
                    if (this._isValidImageUrl(imgUrl) && !imageUrls.some(e => e.url === imgUrl)) {
                        imageUrls.push({ url: imgUrl, width: 0, height: 0, title: '', source: '' });
                    }
                }
            }

            // Method 6: Broad fallback — any image URL with known extensions
            if (imageUrls.length < 3) {
                const broadRegex = /https?:\/\/[^\s"',\]\\>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"',\]\\>]*)?/gi;
                while ((match = broadRegex.exec(html)) !== null && imageUrls.length < 25) {
                    const imgUrl = match[0];
                    if (this._isValidImageUrl(imgUrl) && imgUrl.length > 30 && !imageUrls.some(e => e.url === imgUrl)) {
                        imageUrls.push({ url: imgUrl, width: 0, height: 0, title: '', source: '' });
                    }
                }
            }

            if (imageUrls.length === 0) {
                console.log(`  ⚠️ [Bing Images] Scraper: 0 URLs from HTML (${html.length} bytes)`);
                if (html.includes('captcha') || html.includes('unusual traffic') || html.includes('blocked')) {
                    console.log(`  ⚠️ [Bing Images] Possibly blocked by CAPTCHA`);
                }
            }

            // Score and sort results by relevance + quality
            const scored = this._scoreResults(imageUrls, keyword);
            const top = scored.slice(0, 15);

            return top.map((img, idx) => ({
                id: `bing-scrape-${keyword.substring(0, 20)}-${idx}`,
                url: img.url,
                width: img.width,
                height: img.height
            }));
        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`  ⚠️ [Bing Images] Scraper rate limited`);
            } else {
                console.log(`  ⚠️ [Bing Images] Scraper failed: ${error.message}`);
            }
            return [];
        }
    }

    /**
     * Score and sort results by relevance to search keyword + image quality.
     * Higher score = better result. Sorts descending.
     */
    _scoreResults(results, keyword) {
        const kwWords = keyword.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        for (const r of results) {
            let score = 0;

            // Title relevance: +3 per keyword word found in title
            if (r.title) {
                const titleLower = r.title.toLowerCase();
                for (const w of kwWords) {
                    if (titleLower.includes(w)) score += 3;
                }
            }

            // URL relevance: +1 per keyword word found in URL path (weaker signal)
            const urlLower = r.url.toLowerCase();
            for (const w of kwWords) {
                if (urlLower.includes(w)) score += 1;
            }

            // Size bonus: 750x564+ is fine, bigger is better
            if (r.width && r.height) {
                const pixels = r.width * r.height;
                if (pixels >= 921600) score += 4;         // 1280x720+
                else if (pixels >= 423000) score += 2;    // ~750x564+
            }

            // Aspect ratio bonus: prefer wide/landscape (better for video)
            if (r.width && r.height && r.width > r.height) {
                const aspect = r.width / r.height;
                if (aspect >= 1.5 && aspect <= 2.0) score += 2; // 16:9-ish
                else if (aspect >= 1.2) score += 1;              // landscape
            }

            // Penalize likely low-quality sources
            if (urlLower.includes('thumb') || urlLower.includes('preview')) score -= 3;
            if (urlLower.includes('small') || urlLower.includes('tiny')) score -= 2;


            r._score = score;
        }

        return results.sort((a, b) => b._score - a._score);
    }

    _unescapeUrl(url) {
        return url
            .replace(/\\u002f/gi, '/')
            .replace(/\\u003d/gi, '=')
            .replace(/\\u0026/gi, '&')
            .replace(/\\\//g, '/')
            .replace(/&amp;/g, '&');
    }

    _isValidImageUrl(url) {
        if (!url || url.length > 500) return false;
        const lower = url.toLowerCase();
        // Skip Bing's own resources and watermarked stock
        if (SKIP_DOMAINS.some(domain => lower.includes(domain))) return false;
        // Skip thumbnails, icons, base64
        if (lower.includes('favicon') || lower.includes('icon')) return false;
        if (lower.startsWith('data:')) return false;
        if (lower.includes('/th?') || lower.includes('/th/')) return false; // Bing thumbnail URLs
        return true;
    }
}

module.exports = BingImagesProvider;
