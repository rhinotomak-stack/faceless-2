// scripts/verify-settings-ui.js
// Proves the schema-driven UI persistence (SettingsIO) round-trips correctly and
// excludes the right settings (special + deprecated). Uses a mocked DOM via the
// injectable getEl, so it runs headless.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const schema = require('../src/settings/schema');
const SettingsIO = require('../ui/js/settings-io');

let pass = 0, fail = 0;
const ok = (n, c) => c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}`));

const CHECKBOX_KEYS = new Set(['smartAI', 'klingAvatar', 'veoAiVideo', 'clipAnalyzer', 'fastMedia', 'buildResume', 'forceFreshFootage']);
function mkEls(fill) {
    const els = {};
    for (const s of schema.SETTINGS) {
        if (!s.el) continue;
        const cb = CHECKBOX_KEYS.has(s.key);
        els[s.el] = { type: cb ? 'checkbox' : 'text', value: '', checked: false, _key: s.key };
        if (fill) { if (cb) els[s.el].checked = true; else els[s.el].value = 'val-' + s.key; }
    }
    return els;
}

// ── Static schema ↔ index.html id parity ──────────────────────────────────
// Every non-deprecated schema `el` MUST exist as an id="…" in the real markup,
// or SettingsIO silently drops that setting (it can't find the control) and
// save/persist break with no error. This is exactly what a mocked DOM can't
// catch — the mock is self-consistent with whatever id the schema declares.
console.log('\n=== schema ↔ index.html id parity ===');
{
    const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
    const htmlIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
    const need = schema.SETTINGS.filter(s => s.el && !s.deprecated);
    const missing = need.filter(s => !htmlIds.has(s.el)).map(s => `${s.key}#${s.el}`);
    ok(`all ${need.length} live schema controls exist in index.html`, missing.length === 0);
    if (missing.length) console.log('     missing: ' + missing.join(', '));
    // Deprecated controls SHOULD have been pruned from the markup (dead settings).
    const zombieDeprecated = schema.SETTINGS.filter(s => s.el && s.deprecated && htmlIds.has(s.el)).map(s => s.key);
    ok('deprecated controls pruned from index.html', zombieDeprecated.length === 0);
    if (zombieDeprecated.length) console.log('     still present: ' + zombieDeprecated.join(', '));
}

console.log('\n=== SettingsIO round-trip (mocked DOM) ===');
const src = mkEls(true);
const getSrc = (id) => src[id];
const collected = SettingsIO.collect('ls', { getEl: getSrc });

// Excluded correctly?
ok('deprecated ollamaModel NOT collected', !('ollamaModel' in collected) && !('ollamaVisionModel' in collected));
ok('special buildStyleProfile NOT collected', !('buildStyleProfile' in collected));

// Included the expected 'ls' element settings (non-special, non-deprecated).
const expectLs = schema.SETTINGS.filter(s => s.el && !s.deprecated && !s.special && (s.persist || []).includes('ls')).map(s => s.key);
ok(`collect('ls') has all ${expectLs.length} expected element keys`, expectLs.every(k => k in collected));

// Round-trip: apply to fresh elements, re-read, compare.
const dst = mkEls(false);
SettingsIO.apply(collected, 'ls', { getEl: (id) => dst[id] });
let rtOk = true;
for (const s of schema.SETTINGS) {
    if (!s.el || s.deprecated || s.special || !(s.persist || []).includes('ls')) continue;
    const a = src[s.el], b = dst[s.el];
    const av = a.type === 'checkbox' ? a.checked : a.value;
    const bv = b.type === 'checkbox' ? b.checked : b.value;
    if (av !== bv) { rtOk = false; console.log(`     mismatch ${s.key}: ${av} !== ${bv}`); }
}
ok('save -> load round-trip preserves every element setting', rtOk);

// collect(null) = all element settings regardless of scope (used for runBuild).
const all = SettingsIO.collect(null, { getEl: getSrc });
const expectAll = schema.SETTINGS.filter(s => s.el && !s.deprecated && !s.special).map(s => s.key);
ok(`collect(null) has all ${expectAll.length} element settings`, expectAll.every(k => k in all));

// apply falls back to defaults for missing keys.
const dst2 = mkEls(false);
SettingsIO.apply({}, 'ls', { getEl: (id) => dst2[id] });
const smartEl = dst2[schema.byKey('smartAI').el];
ok('apply({}) uses schema default for smartAI (true)', smartEl.checked === true);
const qEl = dst2[schema.byKey('buildQuality').el];
ok('apply({}) uses schema default for buildQuality (standard)', qEl.value === 'standard');

console.log(`\n${fail === 0 ? '✅ ALL UI-SETTINGS CHECKS PASSED' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
