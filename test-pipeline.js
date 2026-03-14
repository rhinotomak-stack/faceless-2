#!/usr/bin/env node
/**
 * test-pipeline.js — Test the full footage pipeline step by step.
 *
 * Runs each step sequentially, showing how data flows between them:
 *   Step 1: Transcribe audio
 *   Step 2: Web Search (Tavily/Wikipedia/DDG) → AI context summary
 *   Step 3: AI Director (scene splitting, theme/niche/entity detection)
 *   Step 4: Niche & Theme resolution
 *   Step 5: Visual Planner (keyword generation per scene)
 *   Step 6: Query rewriting (what providers actually search)
 *
 * Does NOT download anything — just shows the full planning pipeline.
 *
 * Usage:
 *   node test-pipeline.js                      # uses first .mp3/.wav in input/
 *   node test-pipeline.js myfile.mp3           # specific audio file
 *   node test-pipeline.js --skip-transcribe    # reuse cached transcription
 *   node test-pipeline.js --stop-after 3       # stop after step N (1-6)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./src/config');

const CACHE_FILE = path.join(config.paths.temp, 'test-pipeline-cache.json');

async function main() {
    const args = process.argv.slice(2);
    const skipTranscribe = args.includes('--skip-transcribe');
    const stopAfter = parseInt(getArgAfter(args, '--stop-after') || '99');
    const audioArg = args.find(a => !a.startsWith('--'));

    // Tee all output to a log file so nothing is lost when terminal overflows
    const LOG_FILE = path.join(config.paths.temp, 'pipeline-test.log');
    fs.mkdirSync(config.paths.temp, { recursive: true });
    const logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
    const origLog = console.log;
    const origError = console.error;
    console.log = (...a) => { const line = a.map(String).join(' '); origLog(...a); logStream.write(line + '\n'); };
    console.error = (...a) => { const line = a.map(String).join(' '); origError(...a); logStream.write('[ERR] ' + line + '\n'); };

    console.log('\n' + '='.repeat(70));
    console.log('  🧪 FULL PIPELINE TEST (Step by Step)');
    console.log(`  📄 Full log saved to: ${LOG_FILE}`);
    console.log('='.repeat(70));

    const { createDirectorsBrief } = require('./src/directors-brief');
    const directorsBrief = createDirectorsBrief();
    console.log(`\n  📋 Brief: format=${directorsBrief.format} quality=${directorsBrief.qualityTier}`);
    console.log(`     niche=${directorsBrief.nicheOverride || 'auto'} theme=${directorsBrief.themeOverride || 'auto'}`);

    // ══════════════════════════════════════════════════════════════
    // STEP 1: TRANSCRIBE
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 1: TRANSCRIBE AUDIO');
    console.log('━'.repeat(70));

    let transcription;
    let fullScript = '';

    if (skipTranscribe && fs.existsSync(CACHE_FILE)) {
        console.log('  ⏭️  Using cached transcription...');
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        transcription = cached.transcription;
        fullScript = cached.fullScript;
        console.log(`  ✅ ${transcription.segments.length} segments, ${transcription.duration?.toFixed(1)}s`);
    } else {
        const { transcribeAudio } = require('./src/transcribe');
        const inputFiles = fs.readdirSync(config.paths.input);
        const audioFile = audioArg
            ? inputFiles.find(f => f === audioArg)
            : inputFiles.find(f => f.endsWith('.mp3') || f.endsWith('.wav'));

        if (!audioFile) {
            console.error('  ❌ No audio file found in input/');
            process.exit(1);
        }

        console.log(`  🎙️  File: ${audioFile}`);
        const audioPath = path.join(config.paths.input, audioFile);
        transcription = await transcribeAudio(audioPath);
        fullScript = transcription.words
            ? transcription.words.map(w => w.word).join(' ').trim()
            : transcription.segments.map(s => s.text).join(' ').trim();
        console.log(`  ✅ ${transcription.segments.length} segments, ${transcription.duration?.toFixed(1)}s`);
    }

    console.log(`  📝 Script preview: "${fullScript.substring(0, 120)}..."`);
    console.log(`  📊 Word count: ${fullScript.split(/\s+/).length}`);

    // Cache for reuse
    try {
        fs.mkdirSync(config.paths.temp, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ transcription, fullScript }, null, 2));
    } catch {}

    if (stopAfter <= 1) { console.log('\n  ⏹️  Stopped after Step 1'); return; }

    // ══════════════════════════════════════════════════════════════
    // STEP 2: WEB SEARCH → AI CONTEXT
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 2: WEB SEARCH + AI CONTEXT ANALYSIS');
    console.log('━'.repeat(70));

    // Build search query (same as searchWebContext in ai-director.js)
    const preview = fullScript.substring(0, 300).trim();
    const queryText = preview.substring(0, 120)
        .replace(/[^\w\s'-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 80);

    const scriptWords = fullScript.split(/\s+/).length;
    const numResults = Math.min(20, Math.max(10, Math.round(10 + (scriptWords - 200) / 80)));

    console.log(`  🔍 Search query: "${queryText}"`);
    console.log(`  📊 Requesting ${numResults} results (based on ${scriptWords} words)\n`);

    const allSnippets = [];

    // Tavily
    try {
        const { searchTavily, hasCredentials } = require('./src/tavily-client');
        if (hasCredentials()) {
            const { items } = await searchTavily(queryText, { num: numResults, timeout: 10000 });
            if (items.length > 0) {
                allSnippets.push(...items.map(it => `- ${it.title}: ${it.snippet || ''}`));
                console.log(`  ✅ Tavily: ${items.length} results`);
                for (const item of items.slice(0, 3)) {
                    console.log(`     📄 ${item.title.substring(0, 80)}`);
                }
                if (items.length > 3) console.log(`     ... and ${items.length - 3} more`);
            } else {
                console.log(`  ❌ Tavily: no results`);
            }
        } else {
            console.log(`  ⏭️  Tavily: no API key`);
        }
    } catch (err) {
        console.log(`  ❌ Tavily error: ${err.message}`);
    }

    // Wikipedia
    try {
        const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: { action: 'query', list: 'search', srsearch: queryText, srlimit: 5, srprop: 'snippet', format: 'json' },
            headers: { 'User-Agent': 'FacelessVideoGenerator/1.0' },
            timeout: 10000
        });
        const items = resp.data?.query?.search || [];
        if (items.length > 0) {
            allSnippets.push(...items.map(it => `- ${it.title}: ${it.snippet.replace(/<[^>]+>/g, '').trim()}`));
            console.log(`  ✅ Wikipedia: ${items.length} results`);
        } else {
            console.log(`  ❌ Wikipedia: no results`);
        }
    } catch (err) {
        console.log(`  ❌ Wikipedia error: ${err.message}`);
    }

    // DuckDuckGo
    try {
        const resp = await axios.get('https://api.duckduckgo.com/', {
            params: { q: queryText, format: 'json', no_html: 1, skip_disambig: 1 },
            timeout: 8000
        });
        const ddgItems = [];
        if (resp.data.AbstractText) ddgItems.push(`- ${resp.data.AbstractSource || 'Summary'}: ${resp.data.AbstractText}`);
        if (resp.data.RelatedTopics) {
            for (const t of resp.data.RelatedTopics.slice(0, 3)) {
                if (t.Text) ddgItems.push(`- ${t.Text}`);
            }
        }
        if (ddgItems.length > 0) {
            allSnippets.push(...ddgItems);
            console.log(`  ✅ DuckDuckGo: ${ddgItems.length} results`);
        } else {
            console.log(`  ❌ DuckDuckGo: no results`);
        }
    } catch {
        console.log(`  ❌ DuckDuckGo: failed`);
    }

    console.log(`\n  📊 Total snippets: ${allSnippets.length}`);

    // AI context analysis
    let webContext = null;
    if (allSnippets.length > 0) {
        try {
            const { callAI } = require('./src/ai-provider');
            const snippetsText = allSnippets.join('\n');
            webContext = await callAI(
                `You are analyzing a video narration and web search results to extract context that will help an AI plan visual scenes.

Narration preview: "${preview}..."

Web search results:
${snippetsText}

Provide a brief analysis (3-5 sentences) covering:
1. What is the main topic/subject? (real event, scientific topic, trending story, fictional scenario, etc.)
2. Key entities: people, places, organizations, objects mentioned
3. Visual context: what real-world imagery, locations, or scenes are associated with this topic?
4. Time period and setting: when and where does this take place?

Always provide useful context — even if the topic is speculative or fictional, describe the real-world elements it references (real locations, real technology, real phenomena, etc.) that would help find relevant footage.

Return ONLY the analysis, no disclaimers.`,
                { maxTokens: 400, systemPrompt: 'You are a media research assistant for video production. Extract actionable visual context from any topic.' }
            );

            if (webContext && webContext.trim().length > 10) {
                console.log(`\n  ✅ AI Context Analysis:`);
                console.log(`  "${webContext.trim().substring(0, 200)}..."`);
                console.log(`\n  ↓ This feeds into Step 3 (AI Director) as webContext`);
            } else {
                webContext = null;
                console.log(`\n  ⚠️ AI could not extract useful context`);
            }
        } catch (err) {
            console.log(`\n  ⚠️ AI analysis failed: ${err.message}`);
        }
    }

    if (stopAfter <= 2) { console.log('\n  ⏹️  Stopped after Step 2'); return; }

    // ══════════════════════════════════════════════════════════════
    // STEP 3: AI DIRECTOR (scene splitting + context extraction)
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 3: AI DIRECTOR (Scene Planning)');
    console.log('━'.repeat(70));
    console.log(`  📡 AI Provider: ${config.aiProvider}`);
    console.log(`  📥 Inputs: transcription + ${webContext ? 'web context ✅' : 'NO web context ❌'}`);

    const { analyzeAndCreateScenes } = require('./src/ai-director');
    const { scenes, scriptContext } = await analyzeAndCreateScenes(transcription, directorsBrief);

    console.log(`\n  ✅ AI Director output:`);
    console.log(`     Scenes: ${scenes.length}`);
    console.log(`     Theme (AI picked): "${scriptContext.theme || '?'}"`);
    console.log(`     Summary: "${(scriptContext.summary || '').substring(0, 100)}..."`);
    if (scriptContext.entities?.length) {
        console.log(`     Entities: ${scriptContext.entities.join(', ')}`);
    }
    console.log(`     Format: ${scriptContext.format || 'auto'}`);
    console.log(`     Pacing: ${scriptContext.pacing || 'moderate'}`);

    // Show scene timing breakdown
    const durations = scenes.map(s => (s.endTime || 0) - (s.startTime || 0));
    const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
    const minDur = Math.min(...durations);
    const maxDur = Math.max(...durations);
    const tinyCount = durations.filter(d => d < 3).length;
    console.log(`\n  📊 Scene timing stats:`);
    console.log(`     Avg: ${avgDur.toFixed(1)}s | Min: ${minDur.toFixed(1)}s | Max: ${maxDur.toFixed(1)}s`);
    if (tinyCount > 0) console.log(`     ⚠️ ${tinyCount} scenes under 3s`);

    console.log(`\n  📋 All scenes:`);
    for (const scene of scenes) {
        const dur = ((scene.endTime || 0) - (scene.startTime || 0)).toFixed(1);
        const text = (scene.text || '').substring(0, 70);
        const flag = parseFloat(dur) < 3 ? ' ⚠️ SHORT' : '';
        console.log(`     [${scene.index}] ${(scene.startTime || 0).toFixed(1)}s-${(scene.endTime || 0).toFixed(1)}s (${dur}s)${flag}  "${text}${scene.text?.length > 70 ? '...' : ''}"`);
    }

    if (stopAfter <= 3) { console.log('\n  ⏹️  Stopped after Step 3'); return; }

    // ══════════════════════════════════════════════════════════════
    // STEP 4: NICHE & THEME RESOLUTION
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 4: NICHE & THEME RESOLUTION');
    console.log('━'.repeat(70));

    const { getNiche } = require('./src/niches');
    const niche = getNiche(scriptContext.nicheId);

    console.log(`\n  🔗 Resolution chain:`);
    console.log(`     AI detected theme: "${scriptContext.theme || '?'}"`);
    console.log(`     → Niche resolved: "${scriptContext.nicheId}" (${directorsBrief.nicheOverride && directorsBrief.nicheOverride !== 'auto' ? 'user override' : 'auto-detected'})`);
    console.log(`     → Theme resolved: "${scriptContext.themeId}" (${directorsBrief.themeOverride && directorsBrief.themeOverride !== 'auto' ? 'user override' : `niche default="${niche.defaultTheme}"`})`);
    console.log(`     → Pacing: "${scriptContext.pacing}"`);

    console.log(`\n  📦 Niche config (affects search behavior):`);
    const searchPolicy = niche.searchPolicy || {};
    console.log(`     footagePriority: ${JSON.stringify(niche.footagePriority || [])}`);
    console.log(`     stockMaxWords: ${searchPolicy.stockMaxWords || 3}`);
    console.log(`     contextTerms: ${JSON.stringify(searchPolicy.contextTerms || [])}`);
    console.log(`     avoidTerms: ${JSON.stringify(searchPolicy.avoidTerms || [])}`);
    console.log(`     entityBoost: ${searchPolicy.entityBoost || false}`);

    console.log(`\n  ↓ Niche + theme feed into Step 5 (Visual Planner)`);

    if (stopAfter <= 4) { console.log('\n  ⏹️  Stopped after Step 4'); return; }

    // ══════════════════════════════════════════════════════════════
    // STEP 5: VISUAL PLANNER (keyword generation)
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 5: VISUAL PLANNER (Keyword Generation)');
    console.log('━'.repeat(70));
    console.log(`  📥 Inputs: ${scenes.length} scenes + scriptContext (niche=${scriptContext.nicheId}, theme=${scriptContext.themeId})`);

    const { planVisuals } = require('./src/ai-visual-planner');
    const scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    console.log(`\n  ✅ Visual Planner assigned keywords to ${scenesWithKeywords.filter(s => s.keyword).length}/${scenesWithKeywords.length} scenes`);

    if (stopAfter <= 5) {
        printSceneResults(scenesWithKeywords, scriptContext);
        console.log('\n  ⏹️  Stopped after Step 5');
        return;
    }

    // ══════════════════════════════════════════════════════════════
    // STEP 6: QUERY REWRITING (what providers actually search)
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 6: QUERY REWRITING (Provider-Specific)');
    console.log('━'.repeat(70));
    console.log(`  📥 Niche "${scriptContext.nicheId}" applies search policy to each query\n`);

    const { rewriteQuery } = require('./src/niches');
    const nicheId = scriptContext.nicheId || 'general';

    for (const scene of scenesWithKeywords) {
        const kw = scene.keyword || '(none)';
        const sq = scene.stockQuery || kw;
        const wq = scene.webQuery || kw;

        const stockRewritten = rewriteQuery(sq, nicheId, 'pexels', scene);
        const webRewritten = rewriteQuery(wq, nicheId, 'bing', scene);
        const ytRewritten = rewriteQuery(wq, nicheId, 'youtube', scene);

        console.log(`  Scene ${scene.index}: "${kw}" [${scene.sourceHint || 'stock'}]`);
        console.log(`    stockQuery: "${sq}" → Pexels: "${stockRewritten}"${stockRewritten !== sq ? ' ✏️' : ''}`);
        console.log(`    webQuery:   "${wq}" → Bing:   "${webRewritten}"${webRewritten !== wq ? ' ✏️' : ''}`);
        console.log(`    webQuery:   "${wq}" → YouTube: "${ytRewritten}"${ytRewritten !== wq ? ' ✏️' : ''}`);
    }

    // ══════════════════════════════════════════════════════════════
    // FINAL RESULTS
    // ══════════════════════════════════════════════════════════════
    printSceneResults(scenesWithKeywords, scriptContext);

    if (stopAfter <= 6) { console.log('\n  ⏹️  Stopped after Step 6'); return; }

    // ══════════════════════════════════════════════════════════════
    // STEP 7: INTERACTIVE DOWNLOAD (type scene numbers to download)
    // ══════════════════════════════════════════════════════════════
    console.log('\n' + '━'.repeat(70));
    console.log('  📌 STEP 7: INTERACTIVE DOWNLOAD');
    console.log('━'.repeat(70));
    console.log('  Type a scene number to download it (e.g. "5")');
    console.log('  Type "all" to download all scenes sequentially');
    console.log('  Type "quit" to exit\n');

    const { downloadMedia, initProviders } = require('./src/footage-manager');
    initProviders(scriptContext);

    const downloadDir = path.join(config.paths.temp, 'test-downloads');
    fs.mkdirSync(downloadDir, { recursive: true });
    console.log(`  📁 Downloads save to: ${downloadDir}\n`);

    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const ask = () => {
        rl.question('  download> ', async (input) => {
            input = input.trim().toLowerCase();
            if (input === 'quit' || input === 'q' || input === 'exit') {
                console.log('  👋 Done.');
                rl.close();
                return;
            }
            if (input === 'all') {
                for (const scene of scenesWithKeywords) {
                    await tryDownloadScene(scene, scriptContext, downloadDir, downloadMedia);
                }
                ask(); return;
            }
            const num = parseInt(input);
            if (isNaN(num)) { console.log('  Type a scene number, "all", or "quit"'); ask(); return; }
            const scene = scenesWithKeywords.find(s => s.index === num);
            if (!scene) { console.log(`  ❌ Scene ${num} not found (0-${scenesWithKeywords.length - 1})`); ask(); return; }
            await tryDownloadScene(scene, scriptContext, downloadDir, downloadMedia);
            ask();
        });
    };
    ask();
}

async function tryDownloadScene(scene, scriptContext, downloadDir, downloadMedia) {
    const kw = scene.keyword || 'unknown';
    const mt = scene.mediaType || 'video';
    const sh = scene.sourceHint || 'stock';
    const dur = scene.endTime - scene.startTime;
    const nicheId = scriptContext.nicheId || 'general';

    console.log(`\n  ┌─ Scene ${scene.index}: "${kw}" [${mt}|${sh}] ${dur.toFixed(1)}s`);
    console.log(`  │  stockQuery: "${scene.stockQuery || '(auto)'}"  webQuery: "${scene.webQuery || '(auto)'}"`);

    try {
        const filename = `scene-${String(scene.index).padStart(3, '0')}-${kw.replace(/[^a-z0-9]/gi, '_').substring(0, 30)}`;
        const result = await downloadMedia(kw, mt, path.join('test-downloads', filename), dur, sh, nicheId, scene);
        if (result) {
            console.log(`  └─ ✅ ${result.provider} → ${path.basename(result.path)}`);
        } else {
            console.log(`  └─ ❌ ALL PROVIDERS FAILED`);
        }
    } catch (err) {
        console.log(`  └─ ❌ Error: ${err.message}`);
    }
}

function printSceneResults(scenesWithKeywords, scriptContext) {
    console.log('\n' + '='.repeat(70));
    console.log('  📊 FINAL SCENE PLAN');
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
    console.log(`  Niche: ${scriptContext.nicheId} | Theme: ${scriptContext.themeId}`);
    console.log(`  Sources: ${Object.entries(sources).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    console.log(`  Types: ${Object.entries(types).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    console.log(`  Has stockQuery: ${scenesWithKeywords.filter(s => s.stockQuery).length}/${scenesWithKeywords.length}`);
    console.log(`  Has webQuery: ${scenesWithKeywords.filter(s => s.webQuery).length}/${scenesWithKeywords.length}`);
    console.log('='.repeat(70));
    console.log(`\n  📄 Full log saved to: ${path.join(config.paths.temp, 'pipeline-test.log')}`);
}

function getArgAfter(args, flag) {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
