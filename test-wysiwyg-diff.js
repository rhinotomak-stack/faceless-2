/**
 * test-wysiwyg-diff.js — Milestone 5B: WebGL vs Native D3D11 visual comparison
 *
 * Compares a reference "preview" PNG against the native export frame PNG.
 * Usage:
 *   npx electron ./test-wysiwyg-diff.js [--preview <preview.png>] [--native <native.png>]
 *
 * If no arguments given, it will:
 *   1. Render frame 0 via native compositor (solid red + 50% blue overlay)
 *   2. Generate a mathematically correct reference frame (same blend math)
 *   3. Run pixelmatch to find mismatches
 *
 * Outputs:
 *   output/wysiwyg-diff.png   — red pixels show mismatches
 *   Console log of mismatch count and error percentage
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const OUTPUT_DIR = path.join(__dirname, 'output');
const TEMP_DIR = path.join(__dirname, 'temp');
const FFMPEG = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const WIDTH = 1920;
const HEIGHT = 1080;

function log(msg) { console.log(`[WYSIWYGDiff] ${msg}`); }

function ensureDirs() {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { preview: null, native: null, threshold: 0.1 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--preview' && args[i + 1]) opts.preview = args[++i];
        if (args[i] === '--native' && args[i + 1]) opts.native = args[++i];
        if (args[i] === '--threshold' && args[i + 1]) opts.threshold = parseFloat(args[++i]);
    }
    return opts;
}

// Render 1-frame h264 via native compositor, extract PNG with FFmpeg
function renderNativeFrame(addon) {
    const h264Path = path.join(TEMP_DIR, 'wysiwyg-native.h264');
    const pngPath = path.join(TEMP_DIR, 'wysiwyg-native.png');

    const result = addon.composeAndEncode({
        width: WIDTH, height: HEIGHT, fps: 30, totalFrames: 1,
        outputPath: h264Path,
        bitrate: 50000000, maxBitrate: 50000000, gop: 1,
        bframes: 0, preset: 5, rc: 'cbr',
        layers: [
            { type: 'solid', color: [0.8, 0.2, 0.1, 1.0], startFrame: 0, endFrame: 1 },
            { type: 'solid', color: [0.1, 0.3, 0.9, 0.5], startFrame: 0, endFrame: 1 },
        ],
    });

    if (!result.ok) throw new Error('Native render failed: ' + result.reason);

    execSync(`"${FFMPEG}" -y -i "${h264Path}" -frames:v 1 "${pngPath}"`, { stdio: 'pipe' });
    try { fs.unlinkSync(h264Path); } catch (_) { }
    return pngPath;
}

// Generate a reference PNG via pngjs (same alpha-blend math as Canvas 2D)
function renderPreviewReference() {
    const { PNG } = require('pngjs');
    const pngPath = path.join(TEMP_DIR, 'wysiwyg-webgl.png');

    // bg = rgba(204, 51, 26, 1.0), fg = rgba(26, 77, 230, 0.5)
    // Canvas 2D over: out = fg * a + bg * (1 - a)
    const bgR = 204, bgG = 51, bgB = 26;
    const fgR = 26, fgG = 77, fgB = 230, fgA = 128;
    const a = fgA / 255.0;
    const outR = Math.round(fgR * a + bgR * (1 - a));
    const outG = Math.round(fgG * a + bgG * (1 - a));
    const outB = Math.round(fgB * a + bgB * (1 - a));

    log('  Expected blend: rgb(' + outR + ', ' + outG + ', ' + outB + ')');

    const png = new PNG({ width: WIDTH, height: HEIGHT });
    for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
            const idx = (y * WIDTH + x) * 4;
            png.data[idx] = outR;
            png.data[idx + 1] = outG;
            png.data[idx + 2] = outB;
            png.data[idx + 3] = 255;
        }
    }
    fs.writeFileSync(pngPath, PNG.sync.write(png));
    return pngPath;
}

// Pixelmatch comparison
function compareFrames(previewPath, nativePath, threshold) {
    const { PNG } = require('pngjs');
    const pixelmatch = require('pixelmatch');

    const previewPng = PNG.sync.read(fs.readFileSync(previewPath));
    const nativePng = PNG.sync.read(fs.readFileSync(nativePath));

    const w = Math.min(previewPng.width, nativePng.width);
    const h = Math.min(previewPng.height, nativePng.height);

    if (previewPng.width !== nativePng.width || previewPng.height !== nativePng.height) {
        log('  SIZE NOTE: preview=' + previewPng.width + 'x' + previewPng.height + ' native=' + nativePng.width + 'x' + nativePng.height);
    }

    // Extract WxH region
    const extract = (png, rw, rh) => {
        const buf = new Uint8Array(rw * rh * 4);
        for (let y = 0; y < rh; y++) {
            for (let x = 0; x < rw * 4; x++) {
                buf[y * rw * 4 + x] = png.data[y * png.width * 4 + x];
            }
        }
        return buf;
    };

    const imgA = (w === previewPng.width && h === previewPng.height)
        ? new Uint8Array(previewPng.data.buffer, previewPng.data.byteOffset, w * h * 4)
        : extract(previewPng, w, h);
    const imgB = (w === nativePng.width && h === nativePng.height)
        ? new Uint8Array(nativePng.data.buffer, nativePng.data.byteOffset, w * h * 4)
        : extract(nativePng, w, h);

    const diff = new PNG({ width: w, height: h });
    const mismatchCount = pixelmatch(imgA, imgB, diff.data, w, h, { threshold: threshold });

    const totalPixels = w * h;
    const errorPct = ((mismatchCount / totalPixels) * 100).toFixed(3);

    // Sample center pixel
    const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
    const idx = (cy * w + cx) * 4;
    log('  Center pixel:');
    log('    Preview: rgba(' + imgA[idx] + ', ' + imgA[idx + 1] + ', ' + imgA[idx + 2] + ', ' + imgA[idx + 3] + ')');
    log('    Native:  rgba(' + imgB[idx] + ', ' + imgB[idx + 1] + ', ' + imgB[idx + 2] + ', ' + imgB[idx + 3] + ')');

    const diffPath = path.join(OUTPUT_DIR, 'wysiwyg-diff.png');
    fs.writeFileSync(diffPath, PNG.sync.write(diff));

    return { mismatchCount, totalPixels, errorPct, diffPath, width: w, height: h };
}

// ========== Main ==========
app.whenReady().then(async () => {
    log('=== Milestone 5B: WYSIWYG Diff Tool ===');
    log('');
    ensureDirs();

    const opts = parseArgs();
    let previewPath = opts.preview;
    let nativePath = opts.native;

    const addon = require('./src/native/native-exporter/build/Release/native_exporter.node');

    if (!nativePath) {
        log('Rendering native D3D11 frame...');
        nativePath = renderNativeFrame(addon);
        log('  Native frame: ' + nativePath);
    }

    if (!previewPath) {
        log('Generating preview reference frame...');
        previewPath = renderPreviewReference();
        log('  Preview frame: ' + previewPath);
    }

    if (!fs.existsSync(previewPath)) { log('FAIL: Preview not found: ' + previewPath); app.quit(); return; }
    if (!fs.existsSync(nativePath)) { log('FAIL: Native not found: ' + nativePath); app.quit(); return; }

    log('Comparing (threshold=' + opts.threshold + ')...');
    try {
        const r = compareFrames(previewPath, nativePath, opts.threshold);

        log('');
        log('=== Results ===');
        log('  Resolution:     ' + r.width + ' x ' + r.height);
        log('  Total pixels:   ' + r.totalPixels.toLocaleString());
        log('  Mismatched:     ' + r.mismatchCount.toLocaleString());
        log('  Error:          ' + r.errorPct + '%');
        log('  Diff image:     ' + r.diffPath);
        log('');

        if (parseFloat(r.errorPct) < 1.0) {
            log('  VERDICT: PASS (<1% error)');
        } else if (parseFloat(r.errorPct) < 5.0) {
            log('  VERDICT: WARNING (' + r.errorPct + '% — review diff.png)');
        } else {
            log('  VERDICT: FAIL (' + r.errorPct + '% — significant mismatch)');
        }
    } catch (err) {
        log('FAIL: ' + err.message);
        log(err.stack);
    }

    log('');
    log('=== WYSIWYG Diff Complete ===');
    app.quit();
});
