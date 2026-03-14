#!/usr/bin/env node
/**
 * test-web-search.js — Test the web context search step in isolation.
 *
 * This is Step 1 of the pipeline: before AI Director creates scenes,
 * it searches the web (Tavily → Google CSE → Wikipedia → DuckDuckGo)
 * to understand if the narration is about a real event or fictional.
 *
 * Usage:
 *   node test-web-search.js                        # uses first .mp3/.wav in input/
 *   node test-web-search.js myfile.mp3              # specific audio file
 *   node test-web-search.js --skip-transcribe       # reuse cached transcription
 *   node test-web-search.js --query "Trump tariffs" # test with a direct query (no audio)
 *   node test-web-search.js --text "The FBI raided..." # test with raw script text
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./src/config');

async function main() {
    const args = process.argv.slice(2);
    const skipTranscribe = args.includes('--skip-transcribe');
    const directQuery = getArgAfter(args, '--query');
    const directText = getArgAfter(args, '--text');
    const audioArg = args.find(a => !a.startsWith('--'));

    console.log('='.repeat(70));
    console.log('  🧪 WEB CONTEXT SEARCH TEST (Pipeline Step 1)');
    console.log('='.repeat(70));

    let fullScript = '';
    let queryText = '';

    // Mode 1: Direct query — skip everything, just search
    if (directQuery) {
        console.log(`\n  Mode: Direct query`);
        console.log(`  Query: "${directQuery}"`);
        queryText = directQuery;
        fullScript = directQuery;
    }
    // Mode 2: Raw text — use as script
    else if (directText) {
        console.log(`\n  Mode: Raw text input`);
        fullScript = directText;
        console.log(`  Text: "${fullScript.substring(0, 100)}${fullScript.length > 100 ? '...' : ''}"`);
    }
    // Mode 3: Transcribe audio file
    else {
        const CACHE_FILE = path.join(config.paths.temp, 'test-web-search-cache.json');

        if (skipTranscribe && fs.existsSync(CACHE_FILE)) {
            console.log('\n  ⏭️  Using cached transcription...');
            const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            fullScript = cached.fullScript;
        } else {
            const { transcribeAudio } = require('./src/transcribe');
            const inputFiles = fs.readdirSync(config.paths.input);
            const audioFile = audioArg
                ? inputFiles.find(f => f === audioArg)
                : inputFiles.find(f => f.endsWith('.mp3') || f.endsWith('.wav'));

            if (!audioFile) {
                console.error('  ❌ No audio file found in input/');
                console.error('  Use --query "search terms" to test without audio');
                process.exit(1);
            }

            console.log(`\n  🎙️  Transcribing: ${audioFile}...`);
            const audioPath = path.join(config.paths.input, audioFile);
            const transcription = await transcribeAudio(audioPath);
            fullScript = transcription.segments.map(s => s.text).join(' ');
            console.log(`  ✅ ${transcription.segments.length} segments, ${transcription.duration?.toFixed(1)}s`);

            // Cache for reuse
            try {
                fs.mkdirSync(config.paths.temp, { recursive: true });
                fs.writeFileSync(CACHE_FILE, JSON.stringify({ fullScript }, null, 2));
            } catch {}
        }

        console.log(`\n  Script preview: "${fullScript.substring(0, 150)}..."`);
    }

    // Build the search query (same logic as searchWebContext in ai-director.js)
    if (!queryText) {
        const preview = fullScript.substring(0, 300).trim();
        queryText = preview.substring(0, 120)
            .replace(/[^\w\s'-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 80);
    }

    // Scale results by script length: base 10, up to 20 for long scripts
    const scriptWords = fullScript.split(/\s+/).length;
    const numResults = Math.min(20, Math.max(10, Math.round(10 + (scriptWords - 200) / 80)));

    console.log(`\n  Search query: "${queryText}"`);
    console.log(`  Script words: ${scriptWords} → requesting ${numResults} results`);
    console.log('='.repeat(70));

    // ─── Test each provider individually ───

    // 1. Tavily
    console.log('\n━━━ Provider 1: Tavily ━━━');
    const tavilyResults = await testTavily(queryText, numResults);

    // 2. Google CSE
    console.log('\n━━━ Provider 2: Google CSE ━━━');
    const cseResults = await testGoogleCSE(queryText, numResults);

    // 3. Wikipedia (free, always available)
    console.log('\n━━━ Provider 3: Wikipedia ━━━');
    const wikiResults = await testWikipedia(queryText);

    // 4. DuckDuckGo Instant (free, always available)
    console.log('\n━━━ Provider 4: DuckDuckGo Instant ━━━');
    const ddgResults = await testDDG(queryText);

    // ─── Show combined results ───
    console.log('\n' + '='.repeat(70));
    console.log('  📊 COMBINED RESULTS');
    console.log('='.repeat(70));

    const allSnippets = [];
    if (tavilyResults.length > 0) {
        allSnippets.push(...tavilyResults.map(it => `- ${it.title}: ${it.snippet || ''}`));
        console.log(`  ✅ Tavily: ${tavilyResults.length} results`);
    } else {
        console.log(`  ❌ Tavily: no results`);
    }

    if (cseResults.length > 0) {
        allSnippets.push(...cseResults.map(it => `- ${it.title}: ${it.snippet || ''}`));
        console.log(`  ✅ Google CSE: ${cseResults.length} results`);
    } else {
        console.log(`  ❌ Google CSE: no results`);
    }

    if (wikiResults.length > 0) {
        allSnippets.push(...wikiResults.map(it => `- ${it.title}: ${it.snippet}`));
        console.log(`  ✅ Wikipedia: ${wikiResults.length} results`);
    } else {
        console.log(`  ❌ Wikipedia: no results`);
    }

    if (ddgResults.length > 0) {
        allSnippets.push(...ddgResults.map(it => `- ${it.title}: ${it.snippet}`));
        console.log(`  ✅ DuckDuckGo: ${ddgResults.length} results`);
    } else {
        console.log(`  ❌ DuckDuckGo: no results`);
    }

    console.log(`\n  Total snippets: ${allSnippets.length}`);

    // ─── AI Summary (same as searchWebContext) ───
    if (allSnippets.length > 0) {
        console.log('\n' + '='.repeat(70));
        console.log('  🤖 AI CONTEXT SUMMARY');
        console.log('='.repeat(70));

        const snippetsText = allSnippets.join('\n');
        console.log('\n  Raw snippets being sent to AI:\n');
        for (const s of allSnippets.slice(0, 8)) {
            console.log(`    ${s.substring(0, 120)}${s.length > 120 ? '...' : ''}`);
        }
        if (allSnippets.length > 8) {
            console.log(`    ... and ${allSnippets.length - 8} more`);
        }

        const preview = fullScript.substring(0, 300).trim();
        try {
            const { callAI } = require('./src/ai-provider');
            const summary = await callAI(
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

            if (summary && summary.trim().length > 10) {
                console.log('\n  ✅ AI Context Analysis:');
                console.log(`\n  "${summary.trim()}"`);
                console.log('\n  → This context WILL be passed to AI Director for scene planning');
            } else {
                console.log('\n  ⚠️ AI could not extract useful context');
            }
        } catch (err) {
            console.log(`\n  ⚠️ AI summary failed: ${err.message}`);
            console.log('  (The raw snippets above would still be useful — AI provider may be down)');
        }
    } else {
        console.log('\n  ⚠️ No results from any provider — AI Director will get NO web context');
    }

    console.log('\n' + '='.repeat(70));
}

// ─── Individual provider testers ───

async function testTavily(query, num = 10) {
    try {
        const { searchTavily, hasCredentials } = require('./src/tavily-client');
        if (!hasCredentials()) {
            console.log('  ⏭️  No Tavily API key configured (TAVILY_API_KEY)');
            return [];
        }
        console.log(`  🔍 Searching: "${query}" (${num} results)`);
        const { items, skipped, reason } = await searchTavily(query, { num, timeout: 10000 });
        if (skipped) {
            console.log(`  ⏭️  Skipped: ${reason}`);
            return [];
        }
        for (const item of items) {
            console.log(`  📄 ${item.title}`);
            console.log(`     ${(item.snippet || '').substring(0, 120)}${(item.snippet || '').length > 120 ? '...' : ''}`);
            console.log(`     🔗 ${item.link}`);
        }
        console.log(`  ✅ Found ${items.length} results`);
        return items;
    } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        return [];
    }
}

async function testGoogleCSE(query, num = 10) {
    try {
        const { searchGoogleCSE, hasCredentials } = require('./src/google-cse-client');
        if (!hasCredentials()) {
            console.log('  ⏭️  No Google CSE credentials (GOOGLE_CSE_KEY + GOOGLE_CSE_CX)');
            return [];
        }
        console.log(`  🔍 Searching: "${query}" (${num} results)`);
        const { items } = await searchGoogleCSE({ q: query, num }, { timeout: 10000 });
        const normalized = (items || []).map(it => ({
            title: it.title || '',
            snippet: it.snippet || '',
            link: it.link || '',
        }));
        for (const item of normalized) {
            console.log(`  📄 ${item.title}`);
            console.log(`     ${(item.snippet || '').substring(0, 120)}${(item.snippet || '').length > 120 ? '...' : ''}`);
            console.log(`     🔗 ${item.link}`);
        }
        console.log(`  ✅ Found ${normalized.length} results`);
        return normalized;
    } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        return [];
    }
}

async function testWikipedia(query) {
    try {
        console.log(`  🔍 Searching: "${query}"`);
        const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: {
                action: 'query',
                list: 'search',
                srsearch: query,
                srlimit: 5,
                srprop: 'snippet',
                format: 'json'
            },
            headers: { 'User-Agent': 'FacelessVideoGenerator/1.0' },
            timeout: 10000
        });

        const items = resp.data?.query?.search || [];
        const results = items.map(it => ({
            title: it.title,
            snippet: it.snippet.replace(/<[^>]+>/g, '').trim(),
        }));
        for (const item of results) {
            console.log(`  📄 ${item.title}`);
            console.log(`     ${item.snippet.substring(0, 120)}${item.snippet.length > 120 ? '...' : ''}`);
        }
        console.log(`  ✅ Found ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        return [];
    }
}

async function testDDG(query) {
    try {
        console.log(`  🔍 Searching: "${query}"`);
        const resp = await axios.get('https://api.duckduckgo.com/', {
            params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
            timeout: 8000
        });

        const data = resp.data;
        const results = [];

        if (data.AbstractText) {
            results.push({ title: data.AbstractSource || 'Summary', snippet: data.AbstractText });
        }
        if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, 3)) {
                if (topic.Text) results.push({ title: 'Related', snippet: topic.Text });
            }
        }

        for (const item of results) {
            console.log(`  📄 ${item.title}`);
            console.log(`     ${item.snippet.substring(0, 120)}${item.snippet.length > 120 ? '...' : ''}`);
        }
        console.log(`  ✅ Found ${results.length} results`);
        return results;
    } catch (err) {
        console.log(`  ❌ Error: ${err.message}`);
        return [];
    }
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
