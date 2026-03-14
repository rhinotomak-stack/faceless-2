/**
 * Quick test: download images with backgrounds → run bg remover → save to test project public/
 * Usage: node test-explainer.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const TEST_DIR = 'C:\\Users\\user\\Downloads\\test theme\\public';

// Two test images with backgrounds (free stock images)
const TEST_IMAGES = [
    {
        name: 'Windows Logo',
        // Simple solid-bg image for easy bg removal test
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5f/Windows_logo_-_2012.svg/512px-Windows_logo_-_2012.svg.png',
        outFile: 'explainer-windows.png',
    },
    {
        name: 'HP Logo',
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ad/HP_logo_2012.svg/480px-HP_logo_2012.svg.png',
        outFile: 'explainer-hp.png',
    },
];

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const request = (reqUrl, redirectCount = 0) => {
            if (redirectCount > 5) return reject(new Error('Too many redirects'));
            mod.get(reqUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return request(res.headers.location, redirectCount + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
                const file = fs.createWriteStream(dest);
                res.pipe(file);
                file.on('finish', () => { file.close(); resolve(); });
            }).on('error', reject);
        };
        request(url);
    });
}

async function main() {
    console.log('=== Explainer Image Test ===\n');

    // Step 1: Download raw images
    for (const img of TEST_IMAGES) {
        const rawPath = path.join(TEST_DIR, 'raw-' + img.outFile);
        console.log(`Downloading ${img.name}...`);
        try {
            await download(img.url, rawPath);
            console.log(`  ✅ Saved: ${rawPath}\n`);
        } catch (e) {
            console.log(`  ❌ Failed: ${e.message}`);
            console.log('  Trying fallback: generating a simple test image instead...\n');
            // Create a simple colored square as fallback
            const { createCanvas } = require('@napi-rs/canvas');
            const c = createCanvas(400, 400);
            const ctx = c.getContext('2d');
            // Draw a colored circle on white bg
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 400, 400);
            ctx.fillStyle = img.name.includes('Windows') ? '#0078d4' : '#0096d6';
            ctx.beginPath();
            ctx.arc(200, 200, 150, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 60px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(img.name.includes('Windows') ? 'W' : 'HP', 200, 200);
            const buf = c.toBuffer('image/png');
            fs.writeFileSync(rawPath, buf);
            console.log(`  ✅ Created fallback test image: ${rawPath}\n`);
        }
    }

    // Step 2: Background removal
    console.log('\nLoading background remover (first run downloads ONNX model ~30MB)...');
    const { removeBg } = require('./src/explainer-image-provider');

    for (const img of TEST_IMAGES) {
        const rawPath = path.join(TEST_DIR, 'raw-' + img.outFile);
        const outPath = path.join(TEST_DIR, img.outFile);

        if (!fs.existsSync(rawPath)) {
            console.log(`  ⏩ Skipping ${img.name} (no raw file)`);
            continue;
        }

        console.log(`\nRemoving background: ${img.name}...`);
        const start = Date.now();
        const ok = await removeBg(rawPath, outPath, 120000);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        if (ok) {
            const size = (fs.statSync(outPath).size / 1024).toFixed(0);
            console.log(`  ✅ Done in ${elapsed}s → ${img.outFile} (${size} KB)`);
        } else {
            console.log(`  ⚠️ Bg removal failed, used original (${elapsed}s)`);
        }
    }

    console.log('\n=== Done! ===');
    console.log(`\nFiles in ${TEST_DIR}:`);
    console.log('  explainer-windows.png  ← use for "Windows OS" MG');
    console.log('  explainer-hp.png       ← use for "HP Laptops" MG');
    console.log('\nNow update the .fvp file to point at these, then reload the app.');
}

main().catch(e => console.error('Fatal:', e));
