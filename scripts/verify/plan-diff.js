#!/usr/bin/env node
// scripts/verify/plan-diff.js
// ============================================================================
// The BEHAVIOR-PRESERVATION PROOF. Diffs two video-plan.json after normalizing
// away volatile noise (absolute/tmp paths → basename, timestamps, sort keys). A
// behavior-preserving refactor MUST produce an EMPTY diff against its baseline.
// Because nearly every AI decision (scene split, keywords, effects, MG/templates,
// transitions, SFX, directives, map compile) lands in video-plan.json, an empty
// diff is strong evidence the smartness is unchanged.
//     node scripts/verify/plan-diff.js <baseline.json> <candidate.json>
// Exit 0 = identical (normalized); 1 = differences (first 60 shown); 2 = usage.
// ============================================================================
'use strict';
const fs = require('fs');

const VOLATILE_KEYS = new Set([
    '_fileIndex', 'generatedAt', 'builtAt', 'createdAt', 'updatedAt', 'timestamp',
    'buildTime', 'renderedAt', '_ts', 'mtime', 'downloadedAt',
]);

function normStr(s) {
    if (typeof s !== 'string') return s;
    let out = s;
    // Windows absolute paths → <path>/<basename> (greedy: collapse the whole dir)
    out = out.replace(/[A-Za-z]:[\\/][^\s"']*[\\/]([^\\/\s"']+)/g, '<path>/$1');
    // Unix absolute paths under common roots → <path>/<basename>
    out = out.replace(/\/(?:tmp|var|home|Users|mnt|opt)\/[^\s"']*[\\/]([^\\/\s"']+)/g, '<path>/$1');
    return out;
}

function normalize(v) {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) {
            if (VOLATILE_KEYS.has(k)) continue;
            out[k] = normalize(v[k]);
        }
        return out;
    }
    return normStr(v);
}

function load(p) { return normalize(JSON.parse(fs.readFileSync(p, 'utf8'))); }

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('Usage: node scripts/verify/plan-diff.js <baseline.json> <candidate.json>'); process.exit(2); }

let A, B;
try { A = JSON.stringify(load(a), null, 2); } catch (e) { console.error(`cannot read ${a}: ${e.message}`); process.exit(2); }
try { B = JSON.stringify(load(b), null, 2); } catch (e) { console.error(`cannot read ${b}: ${e.message}`); process.exit(2); }

if (A === B) { console.log('✅ plan-diff: IDENTICAL (normalized)'); process.exit(0); }

const la = A.split('\n'), lb = B.split('\n');
console.log('❌ plan-diff: DIFFERENCES (normalized):');
let shown = 0;
for (let i = 0; i < Math.max(la.length, lb.length) && shown < 60; i++) {
    if (la[i] !== lb[i]) {
        console.log(`  line ${i + 1}:`);
        console.log(`    - ${la[i] || '(none)'}`);
        console.log(`    + ${lb[i] || '(none)'}`);
        shown++;
    }
}
if (shown >= 60) console.log('  … (more differences truncated)');
process.exit(1);
