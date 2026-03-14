#!/usr/bin/env node
/**
 * test-download.js — Test the footage download step in isolation.
 *
 * Searches and downloads media for a single keyword, showing all provider attempts.
 * Good for testing specific keywords without running the full pipeline.
 *
 * Usage:
 *   node test-download.js "police car night"                 # default: image, stock
 *   node test-download.js "FBI raid mansion" --type video    # force video
 *   node test-download.js "Elon Musk 2024" --hint web-image # web source hint
 *   node test-download.js "ocean waves" --provider pexels    # specific provider only
 *   node test-download.js "sunset city" --niche tech         # apply niche rewriting
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('./src/config');

async function main() {
    const args = process.argv.slice(2);

    // Parse args
    const keyword = args.find(a => !a.startsWith('--'));
    if (!keyword) {
        console.log('Usage: node test-download.js "search keyword" [--type video|image] [--hint stock|web-image|youtube] [--niche tech|crime|...] [--provider pexels|bing|...]');
        process.exit(1);
    }

    const mediaType = (args.find(a => a.startsWith('--type'))?.split('=')[1]) || getArgAfter(args, '--type') || 'image';
    const sourceHint = (args.find(a => a.startsWith('--hint'))?.split('=')[1]) || getArgAfter(args, '--hint') || 'stock';
    const nicheId = (args.find(a => a.startsWith('--niche'))?.split('=')[1]) || getArgAfter(args, '--niche') || '';
    const providerFilter = (args.find(a => a.startsWith('--provider'))?.split('=')[1]) || getArgAfter(args, '--provider') || '';

    console.log('='.repeat(60));
    console.log('  🧪 DOWNLOAD TEST');
    console.log('='.repeat(60));
    console.log(`  Keyword:  "${keyword}"`);
    console.log(`  Type:     ${mediaType}`);
    console.log(`  Hint:     ${sourceHint}`);
    console.log(`  Niche:    ${nicheId || '(none)'}`);
    if (providerFilter) console.log(`  Provider: ${providerFilter} only`);
    console.log('='.repeat(60));

    // Create test scene object with stockQuery/webQuery
    const scene = {
        keyword,
        stockQuery: keyword.split(/\s+/).length <= 3 ? keyword : keyword.split(/\s+/).slice(0, 3).join(' '),
        webQuery: keyword,
        mediaType,
        sourceHint,
        index: 0,
    };

    // Ensure temp dir
    fs.mkdirSync(config.paths.temp, { recursive: true });

    const { downloadAllMedia } = require('./src/footage-manager');

    // Mock scriptContext
    const scriptContext = {
        nicheId: nicheId || 'general',
        themeId: 'neutral',
    };

    // Download single scene
    const result = await downloadAllMedia([scene], scriptContext, {
        inlineVision: false,
        skipVisionAI: true,
    });

    const s = result.scenes[0];
    console.log('\n' + '='.repeat(60));
    if (s.mediaFile) {
        const stat = fs.statSync(s.mediaFile);
        console.log(`  ✅ SUCCESS`);
        console.log(`  File:     ${path.basename(s.mediaFile)}`);
        console.log(`  Size:     ${(stat.size / 1024).toFixed(0)} KB`);
        console.log(`  Provider: ${s.sourceProvider}`);
        console.log(`  Dims:     ${s.mediaWidth}x${s.mediaHeight}`);
        console.log(`  Path:     ${s.mediaFile}`);
    } else {
        console.log(`  ❌ FAILED — no media found`);
    }
    console.log('='.repeat(60));
}

function getArgAfter(args, flag) {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
