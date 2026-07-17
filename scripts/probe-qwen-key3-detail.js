// Detailed per-model probe for Key 3 — shows the EXACT error returned for
// each model that earlier scripts bucketed as OTHER / BAD_PARAM.
const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai-provider.js'), 'utf8');
function extractArray(name) {
    const re = new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];');
    const m = src.match(re);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
}
const vl = extractArray('QWEN_VL_POOL');
const omni = extractArray('QWEN_OMNI_HTTP_POOL');

const keys = (process.env.QWEN_VISION_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
const key3 = keys[2];
if (!key3) { console.error('Key 3 not found in .env'); process.exit(1); }
const base = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';

const { createCanvas } = require('@napi-rs/canvas');
const c = createCanvas(256, 256);
const ctx = c.getContext('2d');
ctx.fillStyle = '#ff6644'; ctx.fillRect(0, 0, 256, 256);
ctx.fillStyle = '#ffffff'; ctx.fillRect(64, 64, 128, 128);
const b64 = c.toBuffer('image/png').toString('base64');

function probe(model) {
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
            max_tokens: 6,
        });
        const url = new URL(base + '/chat/completions');
        const t0 = Date.now();
        const req = https.request({
            method: 'POST', hostname: url.hostname, path: url.pathname,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + key3,
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: 25_000,
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(data); } catch (_) { parsed = null; }
                const err = parsed?.error?.message || parsed?.message || '';
                const code = parsed?.error?.code || '';
                resolve({
                    status: res.statusCode,
                    ok: res.statusCode === 200,
                    ms: Date.now() - t0,
                    err: String(err).slice(0, 140),
                    code: String(code).slice(0, 40),
                });
            });
        });
        req.on('error', (e) => resolve({ status: 0, ok: false, ms: Date.now() - t0, err: e.message.slice(0, 140), code: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, ok: false, ms: Date.now() - t0, err: 'timeout', code: '' }); });
        req.write(body); req.end();
    });
}

(async () => {
    console.log('═══ Key 3 [...' + key3.slice(-6) + '] — detailed error report ═══');
    console.log('Endpoint: ' + base);
    console.log('');
    const sections = [['VL pool', vl], ['Omni HTTP pool', omni]];
    for (const [name, list] of sections) {
        console.log('── ' + name + ' (' + list.length + ' models) ──');
        for (const m of list) {
            const r = await probe(m);
            const tag = r.ok ? '✅ OK         ' : `❌ ${String(r.status).padStart(3)}/${(r.code||'').padEnd(15).slice(0,15)}`;
            const detail = r.ok ? '' : `  ${r.err}`;
            console.log('  ' + tag + ' ' + m.padEnd(40) + ' ' + r.ms + 'ms' + detail);
        }
        console.log('');
    }
})();
