// scripts/verify-ai-videos.js
// Isolated unit tests for the AI Videos module (src/categories/ai-videos/). No build,
// no AI, no I/O — proves the script-input normalizer + the pipeline's INPUT stage.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const scriptInput = require('../src/categories/ai-videos/script-input');
const sourceLoader = require('../src/categories/ai-videos/source-loader');
const promptGenerator = require('../src/categories/ai-videos/prompt-generator');
const { buildAiVideosProject } = require('../src/categories/ai-videos/pipeline');
const cats = require('../src/categories');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

(async () => {
    console.log('\n=== script-input.normalizeScript ===');
    ok('CRLF → LF + trims each line', scriptInput.normalizeScript('a\r\n b \r\n') === 'a\nb');
    ok('markdown headings/bold stripped', scriptInput.normalizeScript('# Title\n**bold** and `code`') === 'Title\nbold and code');
    ok('collapses 3+ blank lines to one', scriptInput.normalizeScript('a\n\n\n\nb') === 'a\n\nb');
    ok('bullets flattened', scriptInput.normalizeScript('- one\n- two') === 'one\ntwo');
    ok('empty/nullish → ""', scriptInput.normalizeScript('') === '' && scriptInput.normalizeScript(null) === '' && scriptInput.normalizeScript(undefined) === '');

    console.log('\n=== script-input.toParagraphs / wordCount ===');
    ok('paragraphs split on blank line', JSON.stringify(scriptInput.toParagraphs('one\ntwo\n\nthree')) === JSON.stringify(['one two', 'three']));
    ok('wordCount counts words', scriptInput.wordCount('the quick brown fox') === 4 && scriptInput.wordCount('') === 0);

    console.log('\n=== script-input.isLink ===');
    ok('detects URL', scriptInput.isLink('https://example.com/story') === true);
    ok('detects file path', scriptInput.isLink('/tmp/story.txt') === true && scriptInput.isLink('C:\\a\\story.md') === true);
    ok('multi-word text is NOT a link', scriptInput.isLink('once upon a time') === false);

    console.log('\n=== source-loader (portable file inputs) ===');
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-ai-video-source-'));
    try {
        const textPath = path.join(fixtureDir, 'story.txt');
        fs.writeFileSync(textPath, 'A first scene.\n\nA second scene.', 'utf8');
        const textLoaded = sourceLoader.loadScriptFile(textPath);
        ok('loads plain text files', textLoaded.text === 'A first scene.\n\nA second scene.');
        const utf16Loaded = sourceLoader.loadScriptBuffer(Buffer.from('UTF16 story text.', 'utf16le'), { filename: 'utf16.txt' });
        ok('detects UTF-16 text without a BOM', utf16Loaded.text === 'UTF16 story text.');

        const rtfLoaded = sourceLoader.loadScriptBuffer(Buffer.from('{\\rtf1\\ansi First line.\\par Second line.}'), { filename: 'story.rtf' });
        ok('extracts readable RTF text', /First line\./.test(rtfLoaded.text) && /Second line\./.test(rtfLoaded.text));

        const docx = new AdmZip();
        docx.addFile('word/document.xml', Buffer.from('<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>DOCX story line one.</w:t></w:r></w:p><w:p><w:r><w:t>Line two.</w:t></w:r></w:p></w:body></w:document>'));
        const docxLoaded = sourceLoader.loadScriptBuffer(docx.toBuffer(), { filename: 'story.docx' });
        ok('extracts DOCX story text', /DOCX story line one\./.test(docxLoaded.text) && /Line two\./.test(docxLoaded.text));

        const htmlLoaded = sourceLoader.loadScriptBuffer(Buffer.from('<h1>Story</h1><p>Clean paragraph.</p><script>bad()</script>'), { filename: 'story.html' });
        ok('strips HTML/script markup', /Story/.test(htmlLoaded.text) && /Clean paragraph/.test(htmlLoaded.text) && !/bad\(\)/.test(htmlLoaded.text));
    } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
    }

    console.log('\n=== prompt + quality settings are active ===');
    const directedPrompt = promptGenerator._buildPrompt('A city wakes before dawn.', {
        themeId: 'crime',
        nicheLabel: 'True Crime Documentary',
        videoTitle: 'The Vanishing',
        aiInstructions: 'slow surveillance camera movement',
    });
    ok('prompt uses title/niche/theme/instructions', /The Vanishing/.test(directedPrompt)
        && /True Crime Documentary/.test(directedPrompt)
        && /slow surveillance camera movement/.test(directedPrompt)
        && /Dark, moody/i.test(directedPrompt));

    console.log('\n=== pipeline.buildAiVideosProject (full flow, dry-run) ===');
    const story = '# My Story\n\nA hero rises from nothing. He trains for years in the cold. Then he falls hard and loses it all.\n\nBut he gets back up and wins.';
    const ctx = await buildAiVideosProject({ script: story }, {
        qualityTier: 'standard',
        themeId: 'modern',
        nicheLabel: 'Motivation',
        videoTitle: 'Rise Again',
        aiInstructions: 'bold camera motion',
    });
    ok('runs all stages → stage "plan"', ctx.stage === 'plan');
    ok('scriptText normalized', ctx.scriptText.startsWith('My Story'));
    ok('scenes planned (≥ 2, each with text + duration)', ctx.scenes.length >= 2 && ctx.scenes.every((s) => s.text && s.duration > 0));
    ok('scene timings are sequential', ctx.scenes.every((s, i) => i === 0 ? s.startTime === 0 : s.startTime === ctx.scenes[i - 1].startTime + ctx.scenes[i - 1].duration));
    ok('one prompt per scene (B-roll style)', ctx.prompts.length === ctx.scenes.length && ctx.prompts.every((p) => /B-roll/i.test(p.prompt)));
    ok('dry-run clips: no files, marked dryRun', ctx.clips.length === ctx.scenes.length && ctx.clips.every((c) => c.file === null && c.dryRun === true));
    ok('plan assembled + renderer-shaped', !!ctx.plan && ctx.plan.productionMode === 'aiVideos' && ctx.plan.scenes.length === ctx.scenes.length && ctx.plan.totalDuration > 0);
    ok('plan scenes carry sourceHint=ai-video + prompt', ctx.plan.scenes.every((s) => s.sourceHint === 'ai-video' && s._aiVideoPrompt && s.trackId === 'video-track-1'));
    ok('plan carries canonical timing + script settings', ctx.plan.scenes.every((s) => s.endTime > s.startTime && s.durationUnit === 'seconds')
        && ctx.plan.scriptContext.title === 'Rise Again'
        && ctx.plan.scriptContext.qualityTier === 'standard');
    const mini = await buildAiVideosProject({ script: story }, { qualityTier: 'mini' });
    const pro = await buildAiVideosProject({ script: story }, { qualityTier: 'pro' });
    ok('quality tier changes generated shot density', pro.scenes.length >= mini.scenes.length && pro.scenes.length > 0);
    const empty = await buildAiVideosProject({ script: '   ' });
    ok('empty script → stage "empty" (no crash)', empty.stage === 'empty' && !empty.plan);

    console.log('\n=== category wiring ===');
    ok('registry exposes aiVideos with scriptFirst + pipeline', cats.get('aiVideos').scriptFirst === true && typeof cats.get('aiVideos').pipeline.buildAiVideosProject === 'function');

    console.log(`\n${fail === 0 ? '✅ ALL AI-VIDEOS CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
