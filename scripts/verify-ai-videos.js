// scripts/verify-ai-videos.js
// Isolated unit tests for the AI Videos module (src/categories/ai-videos/). No build,
// no AI, no I/O — proves the script-input normalizer + the pipeline's INPUT stage.
'use strict';
const scriptInput = require('../src/categories/ai-videos/script-input');
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

    console.log('\n=== pipeline.buildAiVideosProject (INPUT stage) ===');
    const ctx = await buildAiVideosProject({ script: '# My Story\n\nA hero rises.\n\nThen falls.' });
    ok('stage reached "input"', ctx.stage === 'input');
    ok('scriptText normalized', ctx.scriptText === 'My Story\n\nA hero rises.\n\nThen falls.');
    ok('paragraphs extracted', ctx.paragraphs.length === 3);
    ok('wordCount on ctx', ctx.wordCount === 7);
    ok('unbuilt stages no-op (scenes/prompts empty, no throw)', Array.isArray(ctx.scenes) && ctx.scenes.length === 0 && Array.isArray(ctx.prompts));
    const empty = await buildAiVideosProject({ script: '   ' });
    ok('empty script → stage "empty"', empty.stage === 'empty');

    console.log('\n=== category wiring ===');
    ok('registry exposes aiVideos with scriptFirst + pipeline', cats.get('aiVideos').scriptFirst === true && typeof cats.get('aiVideos').pipeline.buildAiVideosProject === 'function');

    console.log(`\n${fail === 0 ? '✅ ALL AI-VIDEOS CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
