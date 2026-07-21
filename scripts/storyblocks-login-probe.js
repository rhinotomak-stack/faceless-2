/**
 * Diagnostic: visit login URL, dump final URL + body length + form selectors
 * found, so we can see what Storyblocks actually serves to a fresh browser.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

function findChrome() {
    const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || '';
    const cands = [
        path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
        LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
    ].filter(Boolean);
    return cands.find(p => fs.existsSync(p));
}

(async () => {
    const browser = await puppeteer.launch({
        executablePath: findChrome(),
        headless: 'new',
        args: ['--disable-blink-features=AutomationControlled', '--lang=en-US,en'],
        defaultViewport: { width: 1440, height: 2000 },
    });

    const urls = [
        'https://www.storyblocks.com/login',
        'https://www.storyblocks.com/signin',
        'https://www.storyblocks.com/sign-in',
    ];

    for (const url of urls) {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            window.chrome = window.chrome || { runtime: {} };
        });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        console.log(`\n=== ${url} ===`);
        try {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            console.log('  initial status:', resp?.status());
        } catch (e) { console.log('  goto err:', e.message); }

        // poll for up to 60s
        const t0 = Date.now();
        let status = null;
        while (Date.now() - t0 < 60000) {
            await new Promise(r => setTimeout(r, 1500));
            try {
                status = await page.evaluate(() => ({
                    finalUrl: location.href,
                    title: document.title,
                    bodyLen: document.body ? document.body.innerText.length : 0,
                    hasChallenge: !!document.querySelector('#challenge-running, #cf-challenge-running, #challenge-form'),
                    sample: document.body ? document.body.innerText.slice(0, 200) : '',
                    inputs: Array.from(document.querySelectorAll('input')).map(i => ({
                        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
                    })),
                    buttons: Array.from(document.querySelectorAll('button')).slice(0, 8).map(b => ({
                        type: b.type, text: (b.textContent || '').trim().slice(0, 50),
                    })),
                    googleBtn: !!Array.from(document.querySelectorAll('button, a')).find(el => /google|continue with google/i.test(el.textContent || '')),
                }));
                if (!status.hasChallenge && status.bodyLen > 200) break;
            } catch (_) {}
        }
        console.log('  ', JSON.stringify(status, null, 2).split('\n').join('\n   '));

        await page.close();
    }

    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
