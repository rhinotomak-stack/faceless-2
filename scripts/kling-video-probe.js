// scripts/kling-video-probe.js
// ZERO-CREDIT diagnostic: loads the Kling video page with saved cookies, waits for
// full hydration, and reports login state + a rich DOM inventory so we can tell an
// auth problem (→ refresh cookies) from a selector/timing problem (→ tune). Never
// clicks Generate, so it spends no credits.
//   node scripts/kling-video-probe.js
'use strict';
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (_) {}

const COOKIE_FILE = process.env.KLING_COOKIE_FILE || path.join(process.cwd(), '.kling-cookies.json');
const URL = process.env.KLING_VIDEO_URL || 'https://kling.ai/app/text-to-video/new';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findChrome() {
    const c = ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',(process.env.LOCALAPPDATA||'')+'/Google/Chrome/Application/chrome.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
    return c.find(x => { try { return fs.existsSync(x); } catch (_) { return false; } });
}

(async () => {
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    console.log(`cookies: ${raw.length} loaded from ${COOKIE_FILE}`);
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: findChrome(), headless: false, defaultViewport: null, args: ['--no-sandbox','--disable-blink-features=AutomationControlled','--lang=en-US,en','--start-maximized'] });
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
        await page.setCookie(...raw.map(c => ({ ...c })));
        console.log(`opening ${URL} …`);
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        // Wait up to 45s for the SPA to fully mount.
        for (let i = 0; i < 45; i++) {
            const has = await page.evaluate(() => !!document.querySelector('textarea, [contenteditable=true]')).catch(() => false);
            if (has) break;
            await sleep(1000);
        }
        await sleep(2000);
        try { await page.keyboard.press('Escape'); } catch (_) {}

        const report = await page.evaluate(() => {
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const body = document.body ? (document.body.innerText || '') : '';
            const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
            const loggedOut = /one-?click sign in|sign in|log in|登录/i.test(body);
            const creditMatch = body.match(/\b(\d{1,4})\s*(credits?|points?)\b/i);
            return {
                url: location.href,
                loggedOutSignal: loggedOut,
                creditText: creditMatch ? creditMatch[0] : null,
                textareas: Array.from(document.querySelectorAll('textarea')).map(el => ({ ph: el.placeholder || '', vis: vis(el) })),
                contenteditables: Array.from(document.querySelectorAll('[contenteditable=true]')).map(el => ({ label: (el.getAttribute('aria-label')||el.getAttribute('data-placeholder')||norm(el.textContent).slice(0,30)), vis: vis(el) })),
                textInputs: Array.from(document.querySelectorAll('input[type=text], input:not([type])')).map(el => ({ ph: el.placeholder || '', vis: vis(el) })),
                fileInputs: document.querySelectorAll('input[type=file]').length,
                iframes: document.querySelectorAll('iframe').length,
                buttons: Array.from(document.querySelectorAll('button, [role=button], a')).map(b => norm(b.textContent)).filter(Boolean).slice(0, 40),
                bodySample: norm(body).slice(0, 400),
            };
        });
        const outPng = path.join(process.cwd(), 'temp', '.kling-video', `probe-${Date.now()}.png`);
        fs.mkdirSync(path.dirname(outPng), { recursive: true });
        await page.screenshot({ path: outPng, fullPage: false });
        console.log('\n=== PROBE REPORT ===');
        console.log(JSON.stringify(report, null, 2));
        console.log(`\nscreenshot → ${outPng}`);
        console.log(report.loggedOutSignal
            ? '\n>>> VERDICT: appears LOGGED OUT → cookies expired, re-run `npm run kling-cookies`'
            : '\n>>> VERDICT: appears LOGGED IN → this is a selector/timing issue, tune from the inventory above');
        await sleep(3000);
    } finally {
        try { await browser.close(); } catch (_) {}
    }
})().catch(e => { console.error('PROBE FAILED:', e.message); process.exit(1); });
