/**
 * Storyblocks Recon Script v2
 * Handles Cloudflare interstitial gracefully (HTTP 202 + JS challenge).
 */

const path = require('path');
const fs = require('fs');

function findBrowser() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || '';
    const candidates = [
        path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
        LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ].filter(Boolean);
    for (const p of candidates) if (fs.existsSync(p)) return p;
    throw new Error('No Chrome/Edge found');
}

async function applyStealth(page) {
    // Strip the obvious headless/automation fingerprints. Cloudflare's bot score
    // weights these heavily.
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });
}

async function waitForRealPage(page, maxMs = 30_000) {
    // Loop: wait, check title and whether body has actual content (not just CF challenge).
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
        await new Promise(r => setTimeout(r, 1500));
        try {
            const status = await page.evaluate(() => ({
                title: document.title,
                bodyLen: document.body ? document.body.innerText.length : 0,
                hasChallenge: !!document.querySelector('#challenge-running, #cf-challenge-running, #challenge-form'),
            }));
            if (!status.hasChallenge && status.bodyLen > 500) {
                return status;
            }
        } catch (_) {
            // page navigated, context destroyed — try again next loop
        }
    }
    return null;
}

async function dumpSearchPage(page) {
    console.log('\n[recon] PHASE 1: search page');
    const searchUrl = 'https://www.storyblocks.com/video/search/red%20sea%20ships';
    try {
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
        console.log(`  goto warning: ${e.message}`);
    }
    const status = await waitForRealPage(page, 30_000);
    if (!status) {
        console.log('  ⚠ Cloudflare challenge did not resolve within 30s');
        return null;
    }
    console.log(`  ✓ Page loaded — title: "${status.title}", body: ${status.bodyLen} chars`);
    console.log(`  URL: ${page.url()}`);

    const searchInfo = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href*="/video/stock/"]'));
        // Dedupe by href
        const seen = new Set();
        const unique = anchors.filter(a => {
            if (seen.has(a.href)) return false;
            seen.add(a.href);
            return true;
        });
        const sample = unique.slice(0, 5).map(a => {
            const img = a.querySelector('img') || a.parentElement?.querySelector('img');
            const card = a.closest('[class*="card"], [class*="result"], article, li, div') || a;
            return {
                href: a.href,
                imgSrc: img?.src || null,
                imgAlt: img?.alt || null,
                cardText: (card.textContent || '').trim().slice(0, 120),
                ariaLabel: a.getAttribute('aria-label') || null,
            };
        });
        const nextData = document.getElementById('__NEXT_DATA__');
        return {
            totalAnchors: anchors.length,
            uniqueClips: unique.length,
            sample,
            hasNextData: !!nextData,
            nextDataLen: nextData ? nextData.textContent.length : 0,
        };
    });
    console.log(`  Unique clip links: ${searchInfo.uniqueClips} (raw anchors: ${searchInfo.totalAnchors})`);
    console.log(`  __NEXT_DATA__: ${searchInfo.hasNextData} (${searchInfo.nextDataLen} chars)`);
    if (searchInfo.sample.length) {
        console.log('  First 3 results:');
        searchInfo.sample.slice(0, 3).forEach((s, i) => {
            console.log(`    [${i}] ${s.href}`);
            console.log(`        img: ${s.imgSrc}`);
            console.log(`        alt: ${s.imgAlt}`);
        });
    }

    // Dump __NEXT_DATA__ for offline analysis
    if (searchInfo.hasNextData && searchInfo.nextDataLen > 1000) {
        const nd = await page.evaluate(() => document.getElementById('__NEXT_DATA__').textContent);
        const out = path.join(__dirname, 'storyblocks-search-nextdata.json');
        fs.writeFileSync(out, nd, 'utf8');
        console.log(`  __NEXT_DATA__ saved → ${out}`);
    }
    return searchInfo;
}

async function dumpClipPage(page, searchSample) {
    console.log('\n[recon] PHASE 2: clip detail page');
    // Prefer a real result from search; fall back to user's example.
    const clipUrl = searchSample?.sample?.[0]?.href
        || 'https://www.storyblocks.com/video/stock/jordan-aqaba-december-10-2016-freight-vessels-in-red-sea-gulf-of-aqaba-near-aqaba-city-hashemite-kingdom-of-jordan-rqty-jlbzjapvkfmg';
    console.log(`  URL: ${clipUrl}`);

    try {
        await page.goto(clipUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (e) {
        console.log(`  goto warning: ${e.message}`);
    }
    const status = await waitForRealPage(page, 30_000);
    if (!status) {
        console.log('  ⚠ Cloudflare challenge did not resolve on clip page');
        return null;
    }
    console.log(`  ✓ Page loaded — title: "${status.title}"`);

    const clipInfo = await page.evaluate(() => {
        const watermarkLinks = [];
        document.querySelectorAll('a, button').forEach(el => {
            const text = (el.textContent || '').trim().toLowerCase();
            if (text.includes('watermark') || text.includes('download')) {
                const dataAttrs = {};
                for (const attr of el.attributes) {
                    if (attr.name.startsWith('data-')) dataAttrs[attr.name] = attr.value;
                }
                watermarkLinks.push({
                    tag: el.tagName,
                    text: text.slice(0, 80),
                    href: el.getAttribute('href') || null,
                    dataAttrs,
                });
            }
        });
        // Pull metadata - title, stock ID, contributor, duration
        const titleEl = document.querySelector('h1');
        const stockIdMatch = (document.body.innerText.match(/SBV-\d+/) || [])[0];
        const nextData = document.getElementById('__NEXT_DATA__');
        return {
            title: titleEl?.textContent?.trim()?.slice(0, 120),
            stockId: stockIdMatch,
            watermarkLinks: watermarkLinks.slice(0, 10),
            watermarkLinksCount: watermarkLinks.length,
            hasNextData: !!nextData,
            nextDataLen: nextData ? nextData.textContent.length : 0,
        };
    });
    console.log(`  Clip title: ${clipInfo.title}`);
    console.log(`  Stock ID: ${clipInfo.stockId}`);
    console.log(`  Download/watermark elements found: ${clipInfo.watermarkLinksCount}`);
    clipInfo.watermarkLinks.forEach((c, i) => {
        console.log(`    [${i}] <${c.tag}> "${c.text}"`);
        if (c.href) console.log(`        href: ${c.href}`);
        if (Object.keys(c.dataAttrs).length) {
            console.log(`        data: ${JSON.stringify(c.dataAttrs).slice(0, 200)}`);
        }
    });
    console.log(`  __NEXT_DATA__: ${clipInfo.hasNextData} (${clipInfo.nextDataLen} chars)`);

    if (clipInfo.hasNextData) {
        const nd = await page.evaluate(() => document.getElementById('__NEXT_DATA__').textContent);
        const out = path.join(__dirname, 'storyblocks-clip-nextdata.json');
        fs.writeFileSync(out, nd, 'utf8');
        console.log(`  __NEXT_DATA__ saved → ${out}`);
    }

    // PHASE 3: try the watermark link
    console.log('\n[recon] PHASE 3: intercept watermark download');
    const intercepted = [];
    const onReq = req => {
        const u = req.url();
        if (/\.(mp4|mov|webm|m3u8)(\?|$)/i.test(u)
            || /\/download/i.test(u)
            || /watermark/i.test(u)) {
            intercepted.push({
                url: u,
                method: req.method(),
                hasAuth: !!(req.headers().authorization || req.headers().cookie),
            });
        }
    };
    page.on('request', onReq);
    try {
        const clickResult = await page.evaluate(() => {
            // Look for "Download Watermarked" link/button
            const all = Array.from(document.querySelectorAll('a, button'));
            const wm = all.find(el => /download.*watermark/i.test((el.textContent || '').replace(/\s+/g, ' ')))
                || all.find(el => /watermark/i.test(el.textContent || ''));
            if (!wm) return { clicked: false };
            const info = { tag: wm.tagName, href: wm.getAttribute('href'), text: (wm.textContent || '').trim().slice(0, 80) };
            wm.click();
            return { clicked: true, ...info };
        });
        console.log(`  Click attempt: ${JSON.stringify(clickResult)}`);
        await new Promise(r => setTimeout(r, 6000));
    } catch (e) {
        console.log(`  Click error: ${e.message}`);
    }
    page.off('request', onReq);

    if (intercepted.length === 0) {
        console.log('  ⚠ No media/download requests captured');
    } else {
        console.log(`  ✓ Captured ${intercepted.length} requests:`);
        intercepted.slice(0, 8).forEach((r, i) => {
            console.log(`    [${i}] ${r.method} ${r.url.slice(0, 200)}`);
            console.log(`        auth: ${r.hasAuth}`);
        });
    }
}

async function main() {
    const puppeteer = require('puppeteer-core');
    const exe = findBrowser();
    console.log(`[recon] Using browser: ${exe}`);
    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        args: [
            '--disable-blink-features=AutomationControlled',
            '--lang=en-US,en',
        ],
        defaultViewport: { width: 1440, height: 2000 },
    });
    try {
        const page = await browser.newPage();
        await applyStealth(page);
        const searchInfo = await dumpSearchPage(page);
        await dumpClipPage(page, searchInfo);
        console.log('\n[recon] DONE');
    } finally {
        await browser.close();
    }
}

main().catch(e => {
    console.error('[recon] FATAL:', e);
    process.exit(1);
});
