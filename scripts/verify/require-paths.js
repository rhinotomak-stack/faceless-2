#!/usr/bin/env node
// scripts/verify/require-paths.js
// ============================================================================
// The FOLDER-REORG GUARDRAIL. After moving files, every relative sibling import
// must still resolve, and every file must still parse. Require resolution is done
// STATICALLY (files are read, never executed → zero side effects); syntax is
// checked in-process with Node's parser. Run before AND after any file move:
//     node scripts/verify/require-paths.js
// Exit 0 = clean; exit 1 = broken require or syntax error (with the list).
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

// Match relative require/require.resolve specifiers (starting with ./ or ../) —
// the ones folder moves break. `require.resolve()` is used for modules that must
// be loaded fresh at runtime, so missing it can let a broken production path pass.
const REQ_RE = /require(?:\.resolve)?\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;

// The regex above deliberately stays simple, but only matches whose `require`
// token starts in executable code are valid. This mask filters examples inside
// comments and strings (including verifier assertions that mention source text).
function buildCodeMask(src) {
    const mask = new Uint8Array(src.length);
    let state = 'code';

    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (state === 'code') {
            if (ch === '/' && next === '/') {
                state = 'line-comment';
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                state = 'block-comment';
                i++;
                continue;
            }
            if (ch === "'") {
                state = 'single-quote';
                continue;
            }
            if (ch === '"') {
                state = 'double-quote';
                continue;
            }
            if (ch === '`') {
                state = 'template';
                continue;
            }
            mask[i] = 1;
            continue;
        }

        if (state === 'line-comment') {
            if (ch === '\n' || ch === '\r') {
                state = 'code';
                mask[i] = 1;
            }
            continue;
        }

        if (state === 'block-comment') {
            if (ch === '*' && next === '/') {
                state = 'code';
                i++;
            }
            continue;
        }

        if (ch === '\\') {
            i++;
            continue;
        }
        if (
            (state === 'single-quote' && ch === "'")
            || (state === 'double-quote' && ch === '"')
            || (state === 'template' && ch === '`')
        ) {
            state = 'code';
        }
    }

    return mask;
}
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
    const codeMask = buildCodeMask(src);
    let m; REQ_RE.lastIndex = 0;
    while ((m = REQ_RE.exec(src))) {
        if (!codeMask[m.index]) continue;
        const rel = m[2];
        if (!resolvesTo(f, rel)) { brokenReq++; problems.push(`BROKEN REQUIRE  ${path.relative(ROOT, f)}  →  ${m[0]}`); }
    }
    if (looksEsm(src)) { esmSkipped++; continue; }
    try { new vm.Script(src, { filename: f }); }
    catch (e) { syntaxErr++; problems.push(`SYNTAX ERROR    ${path.relative(ROOT, f)}: ${String(e.message).split('\n')[0]}`); }
}

console.log(`[require-paths] scanned ${files.length} files (${esmSkipped} ESM syntax-skipped)`);
if (problems.length) { console.log('\nProblems:'); problems.forEach(p => console.log('  ❌ ' + p)); console.log(''); }
const ok = brokenReq === 0 && syntaxErr === 0;
console.log(ok ? '✅ all relative requires resolve + all files parse' : `❌ ${brokenReq} broken require(s), ${syntaxErr} syntax error(s)`);
process.exit(ok ? 0 : 1);
