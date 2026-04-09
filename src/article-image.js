/**
 * Article Image: Screenshot real news articles
 *
 * Strategy:
 * 1. Search providers (Tavily first, then Google CSE) find article URLs.
 * 2. thum.io screenshots that URL to generate a real article PNG.
 * 3. Fallback: return null so articleHighlight uses HTML card mode.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { searchWeb } = require('./web-search-client');

// Domains to skip in search results
const SKIP_DOMAINS = [
    'youtube.com',
    'facebook.com',
    'twitter.com',
    'x.com',
    'instagram.com',
    'tiktok.com',
    'reddit.com',
    'wikipedia.org',
    'amazon.com',
    'pinterest.com',
    // Paywalled / access-denied / login-wall sites — thum.io screenshots their block pages
    'nytimes.com',
    'wsj.com',
    'ft.com',
    'bloomberg.com',
    'washingtonpost.com',
    'economist.com',
    'newyorker.com',
    'theatlantic.com',
    'wired.com',
    'hbr.org',
    'thetimes.co.uk',
    'telegraph.co.uk',
    'foreignpolicy.com',
    'foreignaffairs.com',
];

/**
 * Find article URL using web-search providers.
 * Returns first news article URL found, skipping social/media domains.
 */
async function findArticleUrlSearch(headline, subtext) {
    const clean = headline.replace(/["']/g, '').trim();
    let searchQuery = clean;
    if (subtext) {
        const cleanSub = subtext.replace(/\*\*/g, '').replace(/\|\|/g, ' ').trim();
        if (cleanSub.length > 10) {
            searchQuery = `${clean} ${cleanSub}`.substring(0, 150);
        }
    }

    console.log('   [Web Search] Finding article URL...');
    try {
        const { items, provider, errors } = await searchWeb(`${searchQuery} news article`, {
            num: 5,
            timeout: 10000,
            providerOrder: ['tavily', 'googleCSE'],
        });

        for (const item of items) {
            const url = item.link;
            if (url && !SKIP_DOMAINS.some((d) => url.toLowerCase().includes(d))) {
                console.log(`   [${provider}] Found article: ${url.substring(0, 90)}...`);
                return url;
            }
        }

        if (errors.length > 0) {
            console.log(`   Web search providers skipped: ${errors.join(' | ')}`);
        }
    } catch (err) {
        console.log(`   Web search failed: ${err.message}`);
    }

    // Fallback: Wikipedia search to find a relevant topic page
    console.log('   [Wikipedia] Searching for article context...');
    try {
        const wikiResp = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'search', srsearch: searchQuery, srlimit: 3, format: 'json' },
            headers: { 'User-Agent': 'FacelessVideoGenerator/1.0' },
            timeout: 10000,
        });

        const results = wikiResp.data?.query?.search || [];
        if (results.length > 0) {
            const wikiTitle = results[0].title.replace(/ /g, '_');
            const wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(wikiTitle)}`;
            console.log(`   [Wikipedia] Found context: ${wikiUrl}`);
            return wikiUrl;
        }
    } catch (err) {
        console.log(`   Wikipedia search failed: ${err.message}`);
    }

    return null;
}

/**
 * Find article URL with backup provider order.
 */
async function findArticleUrlCSE(headline) {
    const clean = headline.replace(/["']/g, '').trim();
    const short = clean.length > 80 ? clean.substring(0, 80).replace(/\s+\S*$/, '') : clean;

    console.log('   [Web Search] Retrying article search...');

    const { items, provider, errors } = await searchWeb(short, {
        num: 5,
        timeout: 15000,
        providerOrder: ['googleCSE', 'tavily'],
    });

    if (errors.length > 0) {
        console.log(`   Web search providers skipped: ${errors.join(' | ')}`);
    }

    for (const item of items) {
        const link = item.link || '';
        if (SKIP_DOMAINS.some((d) => link.toLowerCase().includes(d))) continue;
        console.log(`   [${provider}] Found article: ${link.substring(0, 90)}...`);
        return link;
    }

    return null;
}

/**
 * Screenshot an article URL using thum.io (free, no API key)
 */
function getScreenshotUrl(articleUrl) {
    return `https://image.thum.io/get/width/1280/crop/900/noanimate/${articleUrl}`;
}

/**
 * Download screenshot to file
 */
async function downloadImage(url, outputPath) {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: 60000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            Accept: 'image/*,*/*;q=0.8',
        },
        maxRedirects: 5,
    });

    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('text/html') && !contentType.includes('image')) {
        throw new Error(`Server returned ${contentType} instead of image`);
    }

    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            const stat = fs.statSync(outputPath);
            if (stat.size < 10000) {
                fs.unlinkSync(outputPath);
                reject(new Error(`Screenshot too small (${stat.size} bytes)`));
            } else {
                resolve(outputPath);
            }
        });
        writer.on('error', reject);
    });
}

/**
 * Main entry: find and screenshot a real article for articleHighlight MGs
 */
async function processArticleImages(mgScenes) {
    const mgIndex = mgScenes.findIndex((mg) => mg.type === 'articleHighlight');
    if (mgIndex === -1) return null;

    const mg = mgScenes[mgIndex];
    const headline = mg.text || '';
    if (!headline) {
        console.log('   articleHighlight has no headline text, skipping');
        return null;
    }

    try {
        let articleUrl = null;

        try {
            articleUrl = await findArticleUrlSearch(headline, mg.subtext);
        } catch (err) {
            console.log(`   Article URL search failed: ${err.message}`);
        }

        // Backup search path if combined search missed
        if (!articleUrl) {
            try {
                articleUrl = await findArticleUrlCSE(headline);
            } catch (err) {
                console.log(`   Backup search failed: ${err.message}`);
            }
        }

        if (!articleUrl) {
            console.log('   No article found for headline');
            return null;
        }

        const screenshotUrl = getScreenshotUrl(articleUrl);
        const filename = 'article-0.png';
        const filePath = path.join(config.paths.temp, filename);

        console.log('   Screenshotting article via thum.io...');
        await downloadImage(screenshotUrl, filePath);

        const stat = fs.statSync(filePath);
        console.log(`   Article screenshot saved: ${filename} (${(stat.size / 1024).toFixed(0)}KB)`);

        return { filePath, filename, mgIndex, articleUrl };
    } catch (err) {
        console.log(`   Article screenshot failed: ${err.message}`);
        return null;
    }
}

// Exposed for QA Replacer re-screenshot
async function findArticleUrl(keyword, subtext) {
    let url = null;
    try { url = await findArticleUrlSearch(keyword, subtext); } catch (_) {}
    if (!url) { try { url = await findArticleUrlCSE(keyword); } catch (_) {} }
    return url;
}

module.exports = { processArticleImages, findArticleUrl, getScreenshotUrl, __SKIP_DOMAINS: SKIP_DOMAINS };
