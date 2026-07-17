#!/usr/bin/env node
// ─── Kling AI Cookie Refresh (manual login flow) ──────────────────────
// The Kling AI-Human (avatar) bridge drives kling.ai headless with a saved
// session. Kling's login has bot-detection, so — exactly like the Storyblocks
// flow — we open a REAL (visible) Chrome window, YOU log in manually, then we
// dump the session cookies to .kling-cookies.json. The bridge picks those up.
//
// Usage:
//   npm run kling-cookies
//
// Steps:
//   1. A Chrome window opens at the Kling AI-Human page.
//   2. You log in manually (Google / email — whatever your account uses).
//   3. Once you land on the app (you'll see the Avatar tool + your credits),
//      the script detects it and saves the cookies.
//   4. Window closes automatically.
//
// If detection doesn't trip (Kling changed their URLs), just press ENTER in
// this terminal once you're logged in and it'll grab the cookies anyway.
// ──────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = process.env.KLING_COOKIE_FILE
    || path.join(process.cwd(), '.kling-cookies.json');
const APP_URL = process.env.KLING_APP_URL || 'https://app.klingai.com/global/ai-human';
// Fallback domains we also try to open if the primary redirects/404s.
const CANDIDATE_URLS = [
    APP_URL,
    'https://klingai.com/global/ai-human',
    'https://kling.ai/app/ai-human/new',
    'https://app.klingai.com/',
    'https://klingai.com/',
];
// Domains we harvest cookies from (Kling has moved between these).
const COOKIE_DOMAINS = [
    'https://app.klingai.com', 'https://klingai.com', 'https://kling.ai', 'https://www.klingai.com',
];

function findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || '';
    const cands = process.platform === 'win32' ? [
        path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
        LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ].filter(Boolean) : process.platform === 'darwin' ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
    return cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

(async () => {
    const puppeteer = require('puppeteer-core');
    const exe = findChrome();
    if (!exe) {
        console.error('\n  ❌ No Chrome/Edge found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH in .env.\n');
        process.exit(1);
    }

    console.log('');
    console.log('  ╔═══════════════════════════════════════════════════╗');
    console.log('  ║      Kling AI Cookie Refresh (manual login)       ║');
    console.log('  ╠═══════════════════════════════════════════════════╣');
    console.log('  ║  A Chrome window will open.                       ║');
    console.log('  ║  Log in to Kling manually (Google / email).       ║');
    console.log('  ║  Cookies save automatically once you\'re in —      ║');
    console.log('  ║  or press ENTER here when logged in.              ║');
    console.log('  ╚═══════════════════════════════════════════════════╝');
    console.log('');

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: false,
        defaultViewport: null,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US,en', '--start-maximized'],
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    let opened = false;
    for (const url of CANDIDATE_URLS) {
        try {
            console.log(`  Opening ${url} …`);
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
            opened = true;
            break;
        } catch (e) { console.log(`  (couldn't open ${url}: ${e.message})`); }
    }
    if (!opened) console.log('  ⚠️ Could not open any Kling URL automatically — navigate to your account manually in the window.');

    console.log('');
    console.log('  Waiting for you to finish logging in (up to 5 minutes)…');
    console.log('  → When you can see the Avatar tool + your credits, you\'re in.');
    console.log('');

    // Let the user press ENTER to force-capture at any point.
    let enterPressed = false;
    try {
        process.stdin.setRawMode?.(false);
        process.stdin.resume();
        process.stdin.once('data', () => { enterPressed = true; });
    } catch (_) {}

    // ENTER is the reliable signal: the Kling app shell loads at /global/ai-human
    // BEFORE login, so URL/route checks false-trip. We only auto-capture on a STRONG
    // logged-in DOM signal AND after a minimum dwell — otherwise we wait for you.
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    const MIN_DWELL_MS = 20_000; // never auto-capture in the first 20s (gives you time to log in)
    let success = false;
    let announced = false;
    console.log('  →→ LOG IN in the Chrome window. When you SEE YOUR CREDITS, press ENTER here. ←←');
    while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 1500));
        if (enterPressed) { success = true; break; }
        if (Date.now() - startedAt < MIN_DWELL_MS) continue;
        let hasUser = false;
        try {
            hasUser = await page.evaluate(() => {
                // Logged-in Kling shows a numeric credit balance + user avatar; the
                // logged-out shell shows neither and often a login modal. Require a
                // positive signal AND the absence of a password/login field.
                const loginField = document.querySelector('input[type="password"], [class*="login" i] input, [class*="signin" i] input');
                if (loginField) return false;
                const txt = document.body ? (document.body.innerText || '') : '';
                const creditish = /credits?/i.test(txt) && /\d/.test(txt);
                const el = document.querySelector('[class*="userInfo" i], [class*="userAvatar" i], [class*="avatarImg" i], img[alt*="avatar" i]');
                return !!el || creditish;
            });
        } catch (_) { continue; }
        if (hasUser) {
            if (!announced) { announced = true; console.log('  ✓ Looks logged in — capturing in 3s (press ENTER to grab now)…'); await new Promise(r => setTimeout(r, 3000)); }
            success = true; break;
        }
    }

    if (!success) {
        console.log('\n  ⚠️ Timed out (5 min). If you logged in, press ENTER now to capture (15s)…');
        const t0 = Date.now();
        while (!enterPressed && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 200));
        success = enterPressed;
        if (!success) { console.log('  ❌ No login confirmed. Re-run and press ENTER once your credits show.'); }
    }

    // Harvest cookies across all Kling domains (dedupe by name+domain).
    const seen = new Set();
    let cookies = [];
    for (const dom of COOKIE_DOMAINS) {
        try {
            const cs = await page.cookies(dom);
            for (const c of cs) {
                const key = `${c.name}@${c.domain}`;
                if (!seen.has(key)) { seen.add(key); cookies.push(c); }
            }
        } catch (_) {}
    }
    if (!cookies.length) { try { cookies = await page.cookies(); } catch (_) {} }

    if (!cookies || cookies.length === 0) {
        console.log('\n  ❌ No cookies captured. Make sure you were logged in, then re-run.');
        await browser.close();
        process.exit(1);
    }

    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    console.log('');
    console.log(`  ✅ Saved ${cookies.length} cookies → ${COOKIE_FILE}`);
    console.log('  The Kling avatar bridge will use these headless. Re-run this if you get logged out.');
    console.log('');

    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('\n  ❌ Error:', err.message);
    process.exit(1);
});
