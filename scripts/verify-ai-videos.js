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

    console.log('\n=== pipeline.buildAiVideosProject (full flow, dry-run) ===');
    const ctx = await buildAiVideosProject({ script: '# My Story\n\nA hero rises from nothing. He trains for years in the cold. Then he falls hard and loses it all.\n\nBut he gets back up and wins.' });
    ok('runs all stages → stage "plan"', ctx.stage === 'plan');
    ok('scriptText normalized', ctx.scriptText.startsWith('My Story'));
    ok('scenes planned (≥ 2, each with text + duration)', ctx.scenes.length >= 2 && ctx.scenes.every((s) => s.text && s.duration > 0));
    ok('scene timings are sequential', ctx.scenes.every((s, i) => i === 0 ? s.startTime === 0 : s.startTime === ctx.scenes[i - 1].startTime + ctx.scenes[i - 1].duration));
    ok('one prompt per scene (B-roll style)', ctx.prompts.length === ctx.scenes.length && ctx.prompts.every((p) => /B-roll/i.test(p.prompt)));
    ok('dry-run clips: no files, marked dryRun', ctx.clips.length === ctx.scenes.length && ctx.clips.every((c) => c.file === null && c.dryRun === true));
    ok('plan assembled + renderer-shaped', !!ctx.plan && ctx.plan.productionMode === 'aiVideos' && ctx.plan.scenes.length === ctx.scenes.length && ctx.plan.totalDuration > 0);
    ok('plan scenes carry sourceHint=ai-video + prompt', ctx.plan.scenes.every((s) => s.sourceHint === 'ai-video' && s._aiVideoPrompt && s.trackId === 'video-track-1'));
    const empty = await buildAiVideosProject({ script: '   ' });
    ok('empty script → stage "empty" (no crash)', empty.stage === 'empty' && !empty.plan);

    console.log('\n=== category wiring ===');
    ok('registry exposes aiVideos with scriptFirst + pipeline', cats.get('aiVideos').scriptFirst === true && typeof cats.get('aiVideos').pipeline.buildAiVideosProject === 'function');

    console.log(`\n${fail === 0 ? '✅ ALL AI-VIDEOS CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
})();
