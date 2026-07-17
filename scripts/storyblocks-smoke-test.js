/**
 * Storyblocks Provider Smoke Test
 *
 * Verifies the provider end-to-end without touching footage-manager:
 *   1. Search for a query
 *   2. Confirm results come back with valid CloudFront URLs
 *   3. Download the first result to a local file
 *   4. Verify the file is a real MP4 (size, magic bytes)
 *
 * Usage: node scripts/storyblocks-smoke-test.js
 */

const fs = require('fs');
const path = require('path');
const StoryblocksVideoProvider = require('../src/media/providers/storyblocks-video');

const TEST_QUERY = process.argv[2] || 'red sea ships';
const OUT_DIR = path.join(__dirname, '..', 'output', 'storyblocks-smoke');

function isMp4(buf) {
    if (buf.length < 12) return false;
    // ISO Base Media File Format: bytes 4-7 = "ftyp"
    return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`[smoke] Output dir: ${OUT_DIR}`);
    console.log(`[smoke] Query: "${TEST_QUERY}"`);

    const provider = new StoryblocksVideoProvider();
    console.log(`[smoke] Provider: ${provider.name}, available: ${provider.isAvailable()}`);

    const t0 = Date.now();
    let results;
    try {
        results = await provider.search(TEST_QUERY);
    } catch (e) {
        console.error('[smoke] FATAL search error:', e.message);
        process.exit(1);
    }
    console.log(`[smoke] Search returned ${results.length} results in ${Math.round((Date.now() - t0) / 1000)}s`);

    if (results.length === 0) {
        console.error('[smoke] ❌ No results — search failed');
        process.exit(1);
    }

    results.slice(0, 5).forEach((r, i) => {
        console.log(`\n  [${i}] id: ${r.id}`);
        console.log(`      title: ${r.title}`);
        console.log(`      url: ${r.url.slice(0, 120)}...`);
        console.log(`      preview: ${r._isPreview}, src: ${r._sourcePage?.slice(0, 80)}`);
    });

    // Attempt download of first result
    const pick = results[0];
    const outFile = path.join(OUT_DIR, `${pick.id}.mp4`);
    console.log(`\n[smoke] Downloading first result → ${outFile}`);
    const dt0 = Date.now();
    try {
        await provider.download(pick.url, outFile);
    } catch (e) {
        console.error(`[smoke] ❌ Download failed: ${e.message}`);
        process.exit(1);
    }
    const stat = fs.statSync(outFile);
    console.log(`[smoke] Downloaded ${(stat.size / 1024 / 1024).toFixed(2)} MB in ${Math.round((Date.now() - dt0) / 1000)}s`);

    // Validate it's a real MP4
    const fd = fs.openSync(outFile, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    const valid = isMp4(buf);
    console.log(`[smoke] Magic bytes valid MP4: ${valid ? '✅' : '❌'} (${buf.slice(0, 12).toString('hex')})`);

    if (!valid || stat.size < 100_000) {
        console.error('[smoke] ❌ File is not a valid MP4 or too small');
        process.exit(1);
    }

    console.log('\n[smoke] ✅ ALL CHECKS PASSED');
    console.log(`        Search OK, ${results.length} results, downloaded ${(stat.size / 1024 / 1024).toFixed(1)}MB MP4`);
    console.log(`        Inspect: ${outFile}`);

    // Close browser so process exits
    const { closeStoryblocksBrowser } = require('../src/media/providers/storyblocks-video');
    await closeStoryblocksBrowser();
}

main().catch(e => {
    console.error('[smoke] FATAL:', e);
    process.exit(1);
});
