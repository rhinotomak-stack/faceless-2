/**
 * Debug v3: use React's nativeInputValueSetter to force-set values, wait
 * for the Login button to become enabled, then submit. Also dump whether
 * reCAPTCHA challenges us.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

function findChrome() {
    const cands = [
        path.join(process.env['PROGRAMFILES'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(process.env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
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
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    page.on('request', req => {
        const u = req.url();
        if (req.method() !== 'GET' && (/login|auth|signin/i.test(u))) {
            console.log(`[REQ ${req.method()}]`, u.slice(0, 120), '— body=' + (req.postData() || '').length + 'B');
        }
        if (/recaptcha/i.test(u)) console.log(`[RECAPTCHA REQ]`, u.slice(0, 120));
    });
    page.on('response', res => {
        const u = res.url();
        if (/api\/(login|session|auth)/i.test(u)) {
            console.log(`[API RES ${res.status()}]`, u.slice(0, 120));
        }
    });

    console.log('Goto login…');
    await page.goto('https://www.storyblocks.com/login', { waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));  // let React hydrate

    console.log('Force-setting via nativeInputValueSetter…');
    await page.evaluate((em, pw) => {
        const setNative = (el, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        const email = document.querySelector('input[type="email"]');
        const pass = document.querySelector('input[type="password"]');
        if (email) setNative(email, em);
        if (pass) setNative(pass, pw);
        const cb = document.querySelector('#agreement-checkbox');
        if (cb && !cb.checked) cb.click();
    }, process.env.STORYBLOCKS_EMAIL, process.env.STORYBLOCKS_PASSWORD);

    await new Promise(r => setTimeout(r, 1500));

    const state1 = await page.evaluate(() => ({
        emailVal: document.querySelector('input[type="email"]')?.value,
        pwLen: document.querySelector('input[type="password"]')?.value?.length,
        cbChecked: document.querySelector('#agreement-checkbox')?.checked,
        btnDisabled: Array.from(document.querySelectorAll('button')).find(b => /^login$/i.test((b.textContent || '').trim()))?.disabled,
        recaptchaPresent: !!document.querySelector('[class*="recaptcha"], iframe[src*="recaptcha"], .grecaptcha-badge'),
    }));
    console.log('After fill:', state1);

    console.log('Clicking Login…');
    await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /^login$/i.test((b.textContent || '').trim()));
        if (btn && !btn.disabled) btn.click();
    });

    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await page.evaluate(() => ({
            url: location.href,
            bodyLen: document.body ? document.body.innerText.length : 0,
            errors: Array.from(document.querySelectorAll('[class*="error"], [role="alert"]'))
                .map(e => (e.textContent || '').trim()).filter(Boolean).slice(0, 2),
            captchaIframe: Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]'))
                .map(f => f.src).slice(0, 2),
        }));
        console.log(`[t+${1.5 * (i+1)}s]`, JSON.stringify(s));
        if (!/\/login/.test(s.url)) { console.log('\n✅ left /login'); break; }
    }

    const shot = path.join(process.cwd(), 'storyblocks-login-dump.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log('Screenshot:', shot);

    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
