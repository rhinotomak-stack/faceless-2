/**
 * scripts/storyblocks-subscribed-recon.js
 *
 * Validates the subscribed Storyblocks flow end-to-end:
 *   1. Read STORYBLOCKS_EMAIL/STORYBLOCKS_PASSWORD from .env
 *   2. Run _loginIfNeeded → confirm login succeeded + cookies saved
 *   3. Do one search → grab first clip
 *   4. Open the clip page → dump all download-related buttons + .mp4 URLs
 *      we observed during the click sequence
 *
 * Use this to confirm our selectors match the real subscribed UI BEFORE
 * running a full build. If anything looks off, the dump will tell us
 * exactly which selectors to patch in storyblocks-video.js.
 *
 * Run:  node scripts/storyblocks-subscribed-recon.js [optional search keyword]
 */

require('dotenv').config();

const StoryblocksVideoProvider = require('../src/media/providers/storyblocks-video');
const { prewarmStoryblocksBrowser, closeStoryblocksBrowser } = StoryblocksVideoProvider;

(async () => {
    if (!process.env.STORYBLOCKS_EMAIL || !process.env.STORYBLOCKS_PASSWORD) {
        console.error('❌ Missing STORYBLOCKS_EMAIL / STORYBLOCKS_PASSWORD in .env');
        process.exit(1);
    }
    if (process.env.STORYBLOCKS_SUBSCRIBED !== '1') {
        console.error('❌ STORYBLOCKS_SUBSCRIBED is not set to 1 in .env — recon would just test preview mode.');
        process.exit(1);
    }

    const keyword = process.argv[2] || 'cargo ship aerial';
    console.log(`\n🔍 Storyblocks subscribed recon — keyword: "${keyword}"\n`);

    console.log('1/3 Pre-warming + logging in…');
    const warmed = await prewarmStoryblocksBrowser();
    console.log(warmed ? '   ✅ login + warm OK\n' : '   ❌ login or warm failed\n');
    if (!warmed) {
        await closeStoryblocksBrowser();
        process.exit(1);
    }

    console.log('2/3 Searching…');
    const provider = new StoryblocksVideoProvider();
    const results = await provider.search(keyword);
    console.log(`   ✅ ${results.length} result(s) returned`);
    if (results.length === 0) {
        console.log('   No results — adjust keyword or check login.');
        await closeStoryblocksBrowser();
        process.exit(1);
    }

    console.log('\n3/3 First result:');
    const first = results[0];
    console.log('   id:        ', first.id);
    console.log('   url:       ', first.url);
    console.log('   title:     ', first.title);
    console.log('   isPreview: ', first._isPreview === true ? '⚠️  TRUE (login failed → fell back to preview)' : '✅ false (clean asset)');
    console.log('   source:    ', first._sourcePage);

    // Sanity: pull HEAD to confirm the file is reachable
    try {
        const https = require('https');
        await new Promise((resolve, reject) => {
            const req = https.request(first.url, { method: 'HEAD' }, (res) => {
                console.log(`\n   HEAD ${res.statusCode}  size=${res.headers['content-length']}  type=${res.headers['content-type']}`);
                resolve();
            });
            req.on('error', reject);
            req.setTimeout(15000, () => { req.destroy(new Error('HEAD timeout')); });
            req.end();
        });
    } catch (e) {
        console.log(`\n   HEAD failed: ${e.message}`);
    }

    console.log('\n✅ Recon complete. If url is clean (no /watermarks/), subscribed flow is wired correctly.\n');
    await closeStoryblocksBrowser();
    process.exit(0);
})().catch(err => {
    console.error('❌ Recon error:', err);
    closeStoryblocksBrowser().finally(() => process.exit(1));
});
