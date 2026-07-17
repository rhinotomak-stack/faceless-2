#!/usr/bin/env node
// scripts/verify/sacred-invariants.js
// ============================================================================
// The SMARTNESS TRIPWIRE. Asserts that load-bearing intelligence anchors (prompt
// builders, task routing, deterministic floors, enforcement bodies) still exist
// verbatim after a refactor. Complements plan-diff: plan-diff proves OUTPUT is
// unchanged; this proves the KEY CODE wasn't gutted/rewritten. Config lives in
// sacred-invariants.json (expand it as we go). Update paths there during P1.
//     node scripts/verify/sacred-invariants.js
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sacred-invariants.json'), 'utf8'));

let miss = 0, checked = 0;
for (const entry of cfg.invariants) {
    const p = path.join(ROOT, entry.file);
    let src;
    try { src = fs.readFileSync(p, 'utf8'); }
    catch (_) { console.log(`❌ MISSING FILE: ${entry.file}`); miss += (entry.mustContain || []).length || 1; continue; }
    for (const pat of entry.mustContain || []) {
        checked++;
        if (!src.includes(pat)) { console.log(`❌ ${entry.file} lost sacred anchor: ${JSON.stringify(pat)}`); miss++; }
    }
}
console.log(`[sacred] checked ${checked} anchors across ${cfg.invariants.length} file(s)`);
console.log(miss === 0 ? '✅ all sacred anchors present' : `❌ ${miss} sacred anchor(s) missing`);
process.exit(miss === 0 ? 0 : 1);
