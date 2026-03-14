#!/usr/bin/env node
/**
 * test-keywords.js — Test the AI keyword generation pipeline in isolation.
 *
 * Runs: Transcribe → AI Director → Visual Planner
 * Outputs: All scene keywords, stockQuery, webQuery, sourceHint, mediaType
 * Does NOT download anything — just shows what WOULD be searched.
 *
 * Usage:
 *   node test-keywords.js                    # uses first .mp3/.wav in input/
 *   node test-keywords.js myfile.mp3         # specific audio file
 *   node test-keywords.js --skip-transcribe  # reuse cached transcription.json
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { createDirectorsBrief } = require('./src/directors-brief');
const { analyzeAndCreateScenes } = require('./src/ai-director');
const { planVisuals } = require('./src/ai-visual-planner');
const { rewriteQuery, pickNicheFromContent } = require('./src/niches');

const CACHE_FILE = path.join(config.paths.temp, 'test-keywords-cache.json');

async function main() {
    const args = process.argv.slice(2);
    const skipTranscribe = args.includes('--skip-transcribe');
    const audioArg = args.find(a => !a.startsWith('--'));

    console.log('='.repeat(70));
    console.log('  🧪 KEYWORD PIPELINE TEST');
    console.log('='.repeat(70));

    const directorsBrief = createDirectorsBrief();
    console.log(`\n📋 Brief: format=${directorsBrief.format} quality=${directorsBrief.qualityTier} niche=${directorsBrief.nicheOverride} theme=${directorsBrief.themeOverride}`);

    let transcription;

    // Step 1: Transcribe (or reuse cache)
    if (skipTranscribe && fs.existsSync(CACHE_FILE)) {
        console.log('\n⏭️  Skipping transcription (using cache)...');
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        transcription = cached.transcription;
    } else {
        const { transcribeAudio } = require('./src/transcribe');
        const inputFiles = fs.readdirSync(config.paths.input);
        const audioFile = audioArg
            ? inputFiles.find(f => f === audioArg)
            : inputFiles.find(f => f.endsWith('.mp3') || f.endsWith('.wav'));

        if (!audioFile) {
            console.error('❌ No audio file found in input/');
            process.exit(1);
        }

        console.log(`\n🎙️  Transcribing: ${audioFile}...`);
        const audioPath = path.join(config.paths.input, audioFile);
        transcription = await transcribeAudio(audioPath);
        console.log(`   ✅ ${transcription.segments.length} segments, ${transcription.duration?.toFixed(1)}s`);
    }

    // Step 2: AI Director
    console.log('\n🎬 Running AI Director...');
    const { scenes, scriptContext } = await analyzeAndCreateScenes(transcription, directorsBrief);
    console.log(`   ✅ ${scenes.length} scenes | theme: ${scriptContext.themeId} | niche: ${scriptContext.nicheId}`);
    console.log(`   Summary: "${(scriptContext.summary || '').substring(0, 100)}..."`);
    if (scriptContext.entities?.length) {
        console.log(`   Entities: ${scriptContext.entities.join(', ')}`);
    }

    // Step 3: Visual Planner
    console.log('\n🎨 Running Visual Planner...');
    const scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    // Cache for --skip-transcribe reuse
    try {
        fs.mkdirSync(config.paths.temp, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ transcription }, null, 2));
    } catch {}

    // Display results
    const nicheId = scriptContext.nicheId || 'general';
    console.log('\n' + '='.repeat(70));
    console.log('  📊 KEYWORD RESULTS');
    console.log('='.repeat(70));

    for (const scene of scenesWithKeywords) {
        const kw = scene.keyword || '(none)';
        const sq = scene.stockQuery || '(auto)';
        const wq = scene.webQuery || '(auto)';
        const mt = scene.mediaType || 'video';
        const sh = scene.sourceHint || 'stock';
        const fr = scene.framing || 'fullscreen';
        const time = `${(scene.startTime || 0).toFixed(1)}s-${(scene.endTime || 0).toFixed(1)}s`;

        console.log(`\n  Scene ${scene.index} [${time}] ${mt} | ${sh} | ${fr}`);
        console.log(`    keyword:    "${kw}"`);
        console.log(`    stockQuery: "${sq}"`);
        console.log(`    webQuery:   "${wq}"`);

        // Show what each provider would actually search
        const stockRewritten = rewriteQuery(sq !== '(auto)' ? sq : kw, nicheId, 'pexels', scene);
        const webRewritten = rewriteQuery(wq !== '(auto)' ? wq : kw, nicheId, 'bing', scene);
        console.log(`    → Pexels:   "${stockRewritten}"`);
        console.log(`    → Bing:     "${webRewritten}"`);

        if (scene.visualIntent) {
            console.log(`    intent:     "${scene.visualIntent.substring(0, 80)}"`);
        }
        const text = (scene.text || '').substring(0, 60);
        console.log(`    narration:  "${text}${scene.text?.length > 60 ? '...' : ''}"`);
    }

    // Summary stats
    console.log('\n' + '='.repeat(70));
    const sources = {};
    const types = {};
    for (const s of scenesWithKeywords) {
        sources[s.sourceHint || 'stock'] = (sources[s.sourceHint || 'stock'] || 0) + 1;
        types[s.mediaType || 'video'] = (types[s.mediaType || 'video'] || 0) + 1;
    }
    console.log(`  Total: ${scenesWithKeywords.length} scenes`);
    console.log(`  Sources: ${Object.entries(sources).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    console.log(`  Types: ${Object.entries(types).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    console.log(`  Has stockQuery: ${scenesWithKeywords.filter(s => s.stockQuery).length}/${scenesWithKeywords.length}`);
    console.log(`  Has webQuery: ${scenesWithKeywords.filter(s => s.webQuery).length}/${scenesWithKeywords.length}`);
    console.log('='.repeat(70));
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
