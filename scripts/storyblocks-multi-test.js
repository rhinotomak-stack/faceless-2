/**
 * Multi-query Storyblocks Smoke Test
 *
 * Replays the exact failure-mode queries from the user's stuck build
 * (Mps Fixing / 17:43 log) against the patched provider so we can measure
 * the new success rate. Goes through the same code paths as a real build:
 *   - search via browser (CF challenge resolution, subscribed cookies)
 *   - per-clip _downloadFromClipPage → _captureCleanDownloadUrl
 *   - browser-download watcher / CDP downloadWillBegin / URL interception
 *   - axios stream download
 *
 * Per query: try up to N clips until one succeeds (mirrors race batching).
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const StoryblocksVideoProvider = require('../src/media/providers/storyblocks-video');
const { closeStoryblocksBrowser } = require('../src/media/providers/storyblocks-video');

const QUERIES = [
    'tanker strait channel',
    'container port logistics',
    'cargo ship ocean blue calm',
    'industrial factory interior containers',
    'cargo ship sailing calm ocean',
    'modern warehouse shelves cardboard boxes',
    'distribution center inventory shelves',
];

const PER_QUERY_CLIP_BUDGET = 3;     // try at most 3 clips per query
const OUT_DIR = path.join(__dirname, '..', 'output', 'storyblocks-multi-test');

function isMp4(buf) {
    if (buf.length < 12) return false;
    return buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70;
}

function fmt(ms) { return `${(ms / 1000).toFixed(1)}s`; }

async function runOneQuery(provider, query, idx) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[${idx + 1}/${QUERIES.length}] Query: "${query}"`);
    console.log('─'.repeat(70));

    const qt0 = Date.now();
    let results;
    try {
        results = await provider.search(query);
    } catch (e) {
        console.log(`  ❌ search failed: ${e.message}`);
        return { query, status: 'search-fail', error: e.message };
    }
    console.log(`  🔍 search → ${results.length} results (${fmt(Date.now() - qt0)})`);
    if (results.length === 0) {
        return { query, status: 'no-results' };
    }

    const tries = Math.min(PER_QUERY_CLIP_BUDGET, results.length);
    for (let i = 0; i < tries; i++) {
        const pick = results[i];
        const outFile = path.join(OUT_DIR, `${query.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}-${i}-${pick.id || 'x'}.mp4`);
        const t0 = Date.now();
        try {
            await provider.download(pick.url, outFile);
            const stat = fs.statSync(outFile);
            const fd = fs.openSync(outFile, 'r');
            const buf = Buffer.alloc(16);
            fs.readSync(fd, buf, 0, 16, 0);
            fs.closeSync(fd);
            const valid = isMp4(buf);
            if (valid && stat.size > 100_000) {
                console.log(`  ✅ clip ${i + 1}/${tries}: ${(stat.size / 1024 / 1024).toFixed(1)}MB MP4 in ${fmt(Date.now() - t0)} → ${path.basename(outFile)}`);
                return {
                    query, status: 'ok', tries: i + 1, sizeMB: stat.size / 1024 / 1024,
                    elapsedMs: Date.now() - qt0, file: outFile,
                };
            }
            console.log(`  ⚠️  clip ${i + 1}/${tries}: file too small or not MP4 (${stat.size}B)`);
            try { fs.unlinkSync(outFile); } catch (_) {}
        } catch (e) {
            console.log(`  ❌ clip ${i + 1}/${tries}: ${e.message} (${fmt(Date.now() - t0)})`);
        }
    }
    return { query, status: 'all-failed', tries, elapsedMs: Date.now() - qt0 };
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`Storyblocks Multi-Query Test`);
    console.log(`Queries: ${QUERIES.length} | budget per query: ${PER_QUERY_CLIP_BUDGET} clips`);
    console.log(`Subscribed: ${process.env.STORYBLOCKS_SUBSCRIBED || '0'} | output: ${OUT_DIR}`);

    const provider = new StoryblocksVideoProvider();
    console.log(`Provider available: ${provider.isAvailable()}`);

    const T0 = Date.now();
    const results = [];
    for (let i = 0; i < QUERIES.length; i++) {
        const r = await runOneQuery(provider, QUERIES[i], i);
        results.push(r);
    }
    const totalMs = Date.now() - T0;

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`SUMMARY (total ${fmt(totalMs)})`);
    console.log('═'.repeat(70));

    const okCount = results.filter(r => r.status === 'ok').length;
    const successRate = ((okCount / results.length) * 100).toFixed(0);
    console.log(`Success: ${okCount}/${results.length} (${successRate}%)`);
    console.log('');
    for (const r of results) {
        const icon = r.status === 'ok' ? '✅' : '❌';
        const detail = r.status === 'ok'
            ? `clip ${r.tries}, ${r.sizeMB.toFixed(1)}MB, ${fmt(r.elapsedMs)}`
            : `${r.status}${r.tries ? ` after ${r.tries} clip(s)` : ''}${r.error ? `: ${r.error}` : ''}`;
        console.log(`  ${icon} "${r.query}" — ${detail}`);
    }

    try { await closeStoryblocksBrowser(); } catch (_) {}
    process.exit(okCount > 0 ? 0 : 1);
}

main().catch(e => {
    console.error('[multi-test] FATAL:', e);
    process.exit(1);
});
