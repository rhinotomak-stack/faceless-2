const axios = require('axios');
const BaseProvider = require('./base-provider');

// Rotate User-Agents to reduce blocking
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

// Domains to skip (Google's own resources, not actual results)
const SKIP_DOMAINS = ['gstatic.com', 'google.com', 'googleapis.com', 'googleusercontent.com', 'ggpht.com', 'youtube.com', 'ytimg.com'];

// Keywords that need ALL image types (not just "photos")
// Charts/infographics are classified as clipart, news screenshots aren't always "photos"
const UNFILTERED_KEYWORDS = [
    // Data/charts
    'chart', 'graph', 'data', 'infographic', 'statistics', 'market share', 'growth rate', 'percentage', 'ranking',
    // News/articles
    'news', 'article', 'headline', 'report', 'announcement', 'press', 'breaking',
    // Specific content that needs real images
    'logo', 'screenshot', 'map', 'diagram', 'comparison', 'timeline', 'forecast',
    // Sales/finance (often shown as charts)
    'sales', 'revenue', 'profit', 'gdp', 'price', 'stock', 'index',
];

class GoogleImagesProvider extends BaseProvider {
    constructor() {
        super('Google Images', 'image');
        this.requestCount = 0;
    }

    isAvailable() {
        return true; // No API key needed
    }

    async search(keyword) {
        const userAgent = USER_AGENTS[this.requestCount % USER_AGENTS.length];
        this.requestCount++;

        try {
            // Detect if keyword needs unfiltered results (charts, news, specific content)
            const kwLower = keyword.toLowerCase();
            const needsAllTypes = UNFILTERED_KEYWORDS.some(uk => kwLower.includes(uk));

            // For data/news/specific keywords: large images, ANY type (charts/screenshots aren't "photos")
            // For generic keywords: large photos only
            const tbs = needsAllTypes ? 'isz:l' : 'isz:l,itp:photo';
            const url = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&tbm=isch&tbs=${tbs}`;

            const response = await axios.get(url, {
                headers: {
                    'User-Agent': userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Cache-Control': 'no-cache',
                    'Referer': 'https://www.google.com/',
                    'Cookie': 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2ODE5MjEyNTQaAmVuIAEaBgiA_LyaBg',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'same-origin',
                },
                timeout: 15000,
                maxRedirects: 5,
            });

            const html = response.data;
            const imageUrls = [];

            // Method 1: Extract from JSON-like data structures ["url",width,height]
            // For data keywords, also match URLs without explicit extensions (dynamic chart images)
            const urlPattern = needsAllTypes
                ? /\["(https?:\/\/[^"]{20,})",(\d+),(\d+)\]/gi
                : /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)",(\d+),(\d+)\]/gi;
            const jsonRegex = urlPattern;
            let match;
            while ((match = jsonRegex.exec(html)) !== null && imageUrls.length < 20) {
                const imgUrl = match[1];
                const width = parseInt(match[2]);
                const height = parseInt(match[3]);
                if (!this._shouldSkip(imgUrl) && width >= 400 && height >= 300) {
                    imageUrls.push({ url: imgUrl, width, height });
                }
            }

            // Method 2: Extract from AF_initDataCallback data blocks
            if (imageUrls.length < 5) {
                const afRegex = /AF_initDataCallback\({[^}]*data:(\[[\s\S]*?\])\s*}\)/g;
                while ((match = afRegex.exec(html)) !== null && imageUrls.length < 20) {
                    const urlsInBlock = match[1].match(/https?:\/\/[^\s"',\]]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"',\]]*)?/gi);
                    if (urlsInBlock) {
                        for (const imgUrl of urlsInBlock) {
                            if (!this._shouldSkip(imgUrl) && imgUrl.length < 500 && imageUrls.length < 20) {
                                if (!imageUrls.some(existing => existing.url === imgUrl)) {
                                    imageUrls.push({ url: imgUrl, width: 0, height: 0 });
                                }
                            }
                        }
                    }
                }
            }

            // Method 3: Extract image URLs from "ou":"url" patterns (Google's metadata format)
            if (imageUrls.length < 5) {
                const ouRegex = /"ou"\s*:\s*"(https?:\/\/[^"]+)"/gi;
                while ((match = ouRegex.exec(html)) !== null && imageUrls.length < 20) {
                    const imgUrl = match[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
                    if (!this._shouldSkip(imgUrl) && imgUrl.length < 500) {
                        if (!imageUrls.some(existing => existing.url === imgUrl)) {
                            imageUrls.push({ url: imgUrl, width: 0, height: 0 });
                        }
                    }
                }
            }

            // Method 4: Extract from data-src or imgurl= patterns
            if (imageUrls.length < 5) {
                const dataSrcRegex = /(?:imgurl|data-src|data-iurl)\s*[=:]\s*"?(https?:\/\/[^\s"'&>]+)/gi;
                while ((match = dataSrcRegex.exec(html)) !== null && imageUrls.length < 20) {
                    const imgUrl = decodeURIComponent(match[1]);
                    if (!this._shouldSkip(imgUrl) && imgUrl.length < 500) {
                        if (!imageUrls.some(existing => existing.url === imgUrl)) {
                            imageUrls.push({ url: imgUrl, width: 0, height: 0 });
                        }
                    }
                }
            }

            // Method 5: Extract from escaped URLs in script data (\\x22url\\x22:\\x22...\\x22)
            if (imageUrls.length < 5) {
                const escapedRegex = /\\x22(https?:\/\/[^\\]+?\.(?:jpg|jpeg|png|webp)[^\\]*)\\x22/gi;
                while ((match = escapedRegex.exec(html)) !== null && imageUrls.length < 20) {
                    const imgUrl = match[1].replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
                    if (!this._shouldSkip(imgUrl) && imgUrl.length < 500) {
                        if (!imageUrls.some(existing => existing.url === imgUrl)) {
                            imageUrls.push({ url: imgUrl, width: 0, height: 0 });
                        }
                    }
                }
            }

            // Method 6: Extract from Google's newer data format ["IMAGE",null,["url",...]]
            if (imageUrls.length < 5) {
                const newFormatRegex = /\[\"IMAGE\"[^\]]*\][^\[]*\[\"(https?:\/\/[^"]+)\",(\d+),(\d+)\]/gi;
                while ((match = newFormatRegex.exec(html)) !== null && imageUrls.length < 20) {
                    const imgUrl = match[1];
                    const width = parseInt(match[2]);
                    const height = parseInt(match[3]);
                    if (!this._shouldSkip(imgUrl) && width >= 200 && height >= 150) {
                        if (!imageUrls.some(existing => existing.url === imgUrl)) {
                            imageUrls.push({ url: imgUrl, width, height });
                        }
                    }
                }
            }

            // Method 7: Broad URL extraction fallback — any image URL in the HTML
            if (imageUrls.length < 3) {
                const broadRegex = /https?:\/\/[^\s"',\]\\>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"',\]\\>]*)?/gi;
                while ((match = broadRegex.exec(html)) !== null && imageUrls.length < 20) {
                    const imgUrl = match[0];
                    if (!this._shouldSkip(imgUrl) && imgUrl.length < 500 && imgUrl.length > 30) {
                        if (!imageUrls.some(existing => existing.url === imgUrl)) {
                            imageUrls.push({ url: imgUrl, width: 0, height: 0 });
                        }
                    }
                }
            }

            if (imageUrls.length === 0) {
                console.log(`  ⚠️ [Google Images] 0 URLs extracted from HTML (${html.length} bytes)`);
                // Debug: check if consent/CAPTCHA page
                if (html.includes('consent.google') || html.includes('CONSENT')) {
                    console.log(`  ⚠️ [Google Images] Blocked by consent page`);
                } else if (html.includes('captcha') || html.includes('unusual traffic')) {
                    console.log(`  ⚠️ [Google Images] Blocked by CAPTCHA`);
                } else {
                    // Log a snippet to help debug the format
                    const snippet = html.substring(0, 300).replace(/\s+/g, ' ');
                    console.log(`  ⚠️ [Google Images] HTML preview: ${snippet}`);
                }
            }

            // Deduplicate and limit
            const unique = imageUrls.slice(0, 15);

            return unique.map((img, idx) => ({
                id: `google-${keyword}-${idx}`,
                url: img.url,
                width: img.width,
                height: img.height
            }));
        } catch (error) {
            if (error.response?.status === 429) {
                console.log(`  ⚠️ [Google Images] Rate limited, try again later`);
            } else {
                console.log(`  ⚠️ [Google Images] Search failed: ${error.message}`);
            }
            return [];
        }
    }

    _shouldSkip(url) {
        const lower = url.toLowerCase();
        // Skip Google's own resources
        if (SKIP_DOMAINS.some(domain => lower.includes(domain))) return true;
        // Skip likely thumbnails
        if (lower.includes('thumb') && lower.includes('px-')) return true;
        // Skip tiny icons
        if (lower.includes('favicon') || lower.includes('icon')) return true;
        // Skip base64 data URIs
        if (lower.startsWith('data:')) return true;
        return false;
    }
}

module.exports = GoogleImagesProvider;
