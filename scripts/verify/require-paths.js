#!/usr/bin/env node
// scripts/verify/require-paths.js
// ============================================================================
// The FOLDER-REORG GUARDRAIL. After moving files, every relative sibling import
// must still resolve, and every file must still parse. Require resolution is done
// STATICALLY (files are read, never executed → zero side effects); syntax is
// checked with `node --check`. Run before AND after any file move:
//     node scripts/verify/require-paths.js
// Exit 0 = clean; exit 1 = broken require or syntax error (with the list).
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function walk(dir, acc) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, acc);
        else if (e.name.endsWith('.js')) acc.push(full);
    }
    return acc;
}

function collectFiles() {
    const files = [];
    walk(path.join(ROOT, 'src'), files);
    walk(path.join(ROOT, 'ui', 'js'), files);
    walk(path.join(ROOT, 'scripts'), files);
    for (const f of ['main.js', 'preload.js', 'test-pipeline.js']) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p)) files.push(p);
    }
    return files;
}

// Match relative require specifiers (starting with ./ or ../) — the ones moves break.
const REQ_RE = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;

function resolvesTo(fromFile, rel) {
    const base = path.resolve(path.dirname(fromFile), rel);
    const cands = [base, base + '.js', base + '.json', base + '.node', path.join(base, 'index.js')];
    return cands.some(c => { try { return fs.statSync(c).isFile(); } catch (_) { return false; } });
}

// ESM files can't be `node --check`ed as CommonJS; skip syntax-check for those
// (relevant only after the UI is modularized). Require-resolution still runs.
function looksEsm(src) {
    return /^\s*import\s.+\sfrom\s/m.test(src) || /^\s*export\s+(default|const|function|class|\{)/m.test(src);
}

const files = collectFiles();
const problems = [];
let brokenReq = 0, syntaxErr = 0, esmSkipped = 0;

for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m; REQ_RE.lastIndex = 0;
    while ((m = REQ_RE.exec(src))) {
        const rel = m[2];
        if (!resolvesTo(f, rel)) { brokenReq++; problems.push(`BROKEN REQUIRE  ${path.relative(ROOT, f)}  →  require('${rel}')`); }
    }
    if (looksEsm(src)) { esmSkipped++; continue; }
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
    catch (e) { syntaxErr++; problems.push(`SYNTAX ERROR    ${path.relative(ROOT, f)}: ${String(e.stderr || e.message).split('\n')[0]}`); }
}

console.log(`[require-paths] scanned ${files.length} files (${esmSkipped} ESM syntax-skipped)`);
if (problems.length) { console.log('\nProblems:'); problems.forEach(p => console.log('  ❌ ' + p)); console.log(''); }
const ok = brokenReq === 0 && syntaxErr === 0;
console.log(ok ? '✅ all relative requires resolve + all files parse' : `❌ ${brokenReq} broken require(s), ${syntaxErr} syntax error(s)`);
process.exit(ok ? 0 : 1);
