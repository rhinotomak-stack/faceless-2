// Probe each Qwen vision key against the FULL VL + omni model pools.
// Run with: node scripts/probe-qwen-keys.js
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai-provider.js'), 'utf8');
function extractArray(name) {
    const re = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];');
    const m = src.match(re);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}
const vl = extractArray('QWEN_VL_POOL');
const omni = extractArray('QWEN_OMNI_HTTP_POOL');
const omniRealtime = extractArray('QWEN_OMNI_REALTIME_POOL');
const omniUnsupported = extractArray('QWEN_OMNI_OPENAI_UNSUPPORTED_POOL');
const fb = extractArray('QWEN_IMAGE_FALLBACK_POOL');

const visionKeys = (process.env.QWEN_VISION_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const base = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

// 256x256 test PNG to satisfy Qwen-VL min-dimensions check.
const { createCanvas } = require('@napi-rs/canvas');
const c = createCanvas(256, 256);
const ctx = c.getContext('2d');
ctx.fillStyle = '#ff6644'; ctx.fillRect(0, 0, 256, 256);
ctx.fillStyle = '#ffffff'; ctx.fillRect(64, 64, 128, 128);
const b64 = c.toBuffer('image/png').toString('base64');

function probe(key, model) {
    return new Promise((resolve) => {
        const body = JSON.stringify({
            model,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
                    { type: 'text', text: 'shape in center?' },
                ],
            }],
            // Some Omni variants reject max_tokens<10 — use 16 to keep the
            // probe portable across both VL (any) and Omni (≥10) models.
            max_tokens: 16,
        });
        const url = new URL(base + '/chat/completions');
        const t0 = Date.now();
        const req = https.request({
            method: 'POST', hostname: url.hostname, path: url.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + key,
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 25_000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(data); } catch (_) { parsed = null; }
                const err = parsed?.error?.message || parsed?.message || '';
                resolve({ status: res.statusCode, ok: res.statusCode === 200, ms: Date.now() - t0, err: String(err).slice(0, 70) });
            });
        });
        req.on('error', (e) => resolve({ status: 0, ok: false, ms: Date.now() - t0, err: e.message.slice(0, 70) }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, ms: Date.now() - t0, err: 'timeout' }); });
        req.write(body); req.end();
    });
}

function classifyError(err) {
    if (!err) return '';
    if (/free tier.*exhausted/i.test(err)) return 'EXHAUSTED';
    if (/Incorrect API key/i.test(err)) return 'INVALID_KEY';
    if (/model.*not.*support/i.test(err) || /model.*not.*found/i.test(err) || /invalid_model/i.test(err)) return 'MODEL_UNSUPPORTED';
    if (/InvalidParameter/i.test(err)) return 'BAD_PARAM';
    if (/timeout/i.test(err)) return 'TIMEOUT';
    if (/rate_limit|too many requests/i.test(err)) return 'RATE_LIMIT';
    return 'OTHER';
}

(async () => {
    console.log('═══ QWEN KEY HEALTH — full pools (256x256 PNG) ═══');
    console.log('VL pool: ' + vl.length + ' | Fallback (text-as-vision, inert): ' + fb.length + ' | Omni HTTP: ' + omni.length);
    console.log('Omni realtime: ' + omniRealtime.length + ' (quota dashboard only; not probed by HTTP script) | OpenAI-unsupported: ' + omniUnsupported.length);
    console.log('Endpoint: ' + base);
    console.log('Keys configured: ' + visionKeys.length);
    console.log('');
    for (let i = 0; i < visionKeys.length; i++) {
        const k = visionKeys[i];
        console.log('▶ Key ' + (i + 1) + ' [...' + k.slice(-6) + ']');
        const sections = [
            ['QWEN_VL_POOL', vl],
            ['QWEN_OMNI_HTTP_POOL', omni],
        ];
        for (const [name, list] of sections) {
            const counts = { OK: 0, EXHAUSTED: 0, INVALID_KEY: 0, MODEL_UNSUPPORTED: 0, BAD_PARAM: 0, TIMEOUT: 0, RATE_LIMIT: 0, OTHER: 0 };
            const aliveModels = [];
            for (const m of list) {
                const r = await probe(k, m);
                if (r.ok) { counts.OK++; aliveModels.push(m); }
                else counts[classifyError(r.err)]++;
            }
            const total = list.length;
            console.log('  [' + name + '] (' + total + ' models)');
            for (const [k2, v] of Object.entries(counts)) {
                if (v > 0) console.log('     ' + k2.padEnd(20) + ' ' + v + '/' + total);
            }
            if (aliveModels.length > 0) {
                console.log('     ✅ alive: ' + aliveModels.slice(0, 8).join(', ') + (aliveModels.length > 8 ? ` (+${aliveModels.length - 8} more)` : ''));
            }
        }
        console.log('');
    }
})();
