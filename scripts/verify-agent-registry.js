// scripts/verify-agent-registry.js
// The agent registry is only useful if it's ACCURATE. For every catalog entry this
// asserts: (1) the module resolves and exports the named entry function, and (2) the
// declared flagEnv / cacheFile / taskType strings actually appear verbatim in the
// director's source. If a director renames its cache file, flag, or entry, this fails
// loudly so the registry (a single source of truth) can't silently drift.
'use strict';
const fs = require('fs');
const path = require('path');
const reg = require('../src/agents/registry');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

console.log('\n=== agent registry accuracy (catalog vs source) ===');
for (const a of reg.AGENTS) {
    // 1. module resolves + entry fn exists
    let fnOk = false, src = '';
    try { fnOk = typeof reg.load(a.id) === 'function'; } catch (e) { console.log(`     ${a.id}: ${e.message}`); }
    ok(`${a.id}: module exports ${a.entry}()`, fnOk);

    // 2. flag / cache / taskType strings appear in the director source
    const abs = require.resolve(path.join(__dirname, '..', 'src', 'agents', a.module));
    try { src = fs.readFileSync(abs, 'utf8'); } catch (_) { src = ''; }
    ok(`${a.id}: flagEnv "${a.flagEnv}" present in source`, src.includes(a.flagEnv));
    ok(`${a.id}: cacheFile "${a.cacheFile}" present in source`, src.includes(a.cacheFile));
    ok(`${a.id}: taskType "${a.taskType}" present in source`, src.includes(`taskType: '${a.taskType}'`) || src.includes(`taskType:'${a.taskType}'`) || src.includes(`taskType: "${a.taskType}"`));
}

console.log('\n=== structure ===');
ok('6 directors catalogued', reg.list('director').length === 6);
ok('ids unique', new Set(reg.AGENTS.map((a) => a.id)).size === reg.AGENTS.length);
ok('get() + list() consistent', reg.get('effects') && reg.get('nope') === null && reg.list().length === reg.AGENTS.length);

console.log(`\n${fail === 0 ? '✅ ALL AGENT-REGISTRY CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
