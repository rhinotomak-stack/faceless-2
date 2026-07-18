// scripts/verify-base-director.js
// Unit-tests the BaseDirector harness sequencing with a FAKE descriptor (no real
// director, no real callAI). Proves: disabled-gate, collect min-count bail, reuse
// short-circuit (0 AI), cache read (valid+invalid), AI path + apply + cache write,
// floor on parse-null and on AI throw, and the writeWhen guard. The real directors'
// byte-identical migration is verified separately by director-snapshot.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mock ai-provider BEFORE requiring base-director so its `const {callAI}` binds the mock.
const aiPath = require.resolve('../src/brain/ai-provider');
let callCount = 0, nextResponse = '{"ok":1}', shouldThrow = false, lastPrompt = null, lastOpts = null;
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
    callAI: async (prompt, opts) => { callCount++; lastPrompt = prompt; lastOpts = opts; if (shouldThrow) throw new Error('boom'); return nextResponse; },
} };
const { runDirector, hashOf } = require('../src/agents/base-director');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));
const reset = () => { callCount = 0; nextResponse = '{"ok":1}'; shouldThrow = false; lastPrompt = null; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'basedir-'));

// A fake descriptor whose closures record what the harness passed them.
function mkDescriptor(over = {}) {
    return Object.assign({
        id: 'fake', flagEnv: 'FAKE_DIRECTOR_FLAG', cacheFile: '.fake-cache.json',
        callOpts: { taskType: 'brain', maxTokens: 100 },
        collect: (subject) => (subject && subject.units && subject.units.length ? { units: subject.units } : null),
        reuse: () => null,
        hashInputs: (ctx) => ['v9', ctx.units.length],
        cacheValid: (cached) => cached && Array.isArray(cached.data),
        applyCache: (cached) => ({ decided: cached.data.length, fromCache: true }),
        buildPrompt: (ctx) => `PROMPT units=${ctx.units.length}`,
        parse: (text) => { try { return JSON.parse(text); } catch { return null; } },
        apply: (parsed, ctx) => ({ result: { decided: ctx.units.length, ai: true }, payload: { data: ctx.units }, decided: ctx.units.length }),
        floor: (ctx, subject, opts, reason) => ({ decided: 0, floor: true, reason }),
    }, over);
}

(async () => {
console.log('\n=== BaseDirector sequencing ===');

// disabled gate
reset(); process.env.FAKE_DIRECTOR_FLAG = 'off';
let r = await runDirector(mkDescriptor(), { units: [1, 2] }, { projectDir: tmp });
ok('disabled flag → skipped, 0 AI calls', r.skipped === true && callCount === 0);
delete process.env.FAKE_DIRECTOR_FLAG;

// collect bail (no units)
reset();
r = await runDirector(mkDescriptor(), { units: [] }, { projectDir: tmp });
ok('collect returns null → decided 0, 0 AI calls', r.decided === 0 && callCount === 0);

// reuse short-circuit
reset();
r = await runDirector(mkDescriptor({ reuse: () => ({ decided: 3, reused: true }) }), { units: [1, 2, 3] }, { projectDir: tmp });
ok('reuse short-circuits BEFORE AI (0 AI calls)', r.reused === true && callCount === 0);

// AI path + cache write
reset();
const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'basedir2-'));
r = await runDirector(mkDescriptor(), { units: [1, 2] }, { projectDir: pdir });
const cachePath = path.join(pdir, '.fake-cache.json');
const wrote = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : null;
ok('AI path: 1 call, prompt built from ctx', callCount === 1 && lastPrompt === 'PROMPT units=2');
ok('cache written with correct hash + payload', wrote && wrote.hash === hashOf(['v9', 2]) && Array.isArray(wrote.data));
ok('taskType passed through verbatim (SACRED)', lastOpts.taskType === 'brain');

// cache read (hit)
reset();
r = await runDirector(mkDescriptor(), { units: [1, 2] }, { projectDir: pdir });
ok('cache hit → applyCache, 0 AI calls', r.fromCache === true && callCount === 0);

// cache invalid (cacheValid=false) → falls through to AI
reset();
fs.writeFileSync(cachePath, JSON.stringify({ hash: hashOf(['v9', 2]), data: 'not-an-array' }));
r = await runDirector(mkDescriptor(), { units: [1, 2] }, { projectDir: pdir });
ok('cache invalid → re-runs AI (cacheValid gate honored)', callCount === 1);

// floor on parse null
reset(); nextResponse = 'not json';
r = await runDirector(mkDescriptor(), { units: [1] }, { projectDir: tmp });
ok('unparseable response → floor', r.floor === true && r.reason === 'unparseable');

// floor on AI throw
reset(); shouldThrow = true;
r = await runDirector(mkDescriptor(), { units: [1] }, { projectDir: tmp });
ok('AI throw → floor (ai-error)', r.floor === true && r.reason === 'ai-error');

// writeWhen guard: decided 0 → no write
reset();
const pdir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'basedir3-'));
await runDirector(mkDescriptor({ apply: (p, ctx) => ({ result: { decided: 0 }, payload: { data: ctx.units }, decided: 0 }) }), { units: [1] }, { projectDir: pdir3 });
ok('decided=0 → cache NOT written (default writeWhen)', !fs.existsSync(path.join(pdir3, '.fake-cache.json')));

console.log(`\n${fail === 0 ? '✅ ALL BASE-DIRECTOR CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})();
