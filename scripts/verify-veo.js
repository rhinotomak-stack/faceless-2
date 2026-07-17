// scripts/verify-veo.js
// Verifies the opt-in Veo AI-video wiring — the key safety property is that it
// is FULLY DORMANT without a VEO_API_KEY, so a normal build is unaffected.
// Run: node scripts/verify-veo.js
'use strict';

let pass = 0, fail = 0;
function ok(name, cond) {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}`); }
}

// Snapshot + restore env so tests don't leak into each other.
function withEnv(vars, fn) {
    const keys = ['VEO_AI_VIDEO', 'VEO_API_KEY', 'VEO_BACKEND', 'VEO_RESOLUTION', 'VEO_SCOPE', 'VEO_MODEL'];
    const saved = {};
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, vars);
    try { return fn(); }
    finally {
        for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
}

// Async-aware variant for arbitrary keys (awaits the body before restoring env).
async function withEnvKV(vars, fn) {
    const keys = Object.keys(vars);
    const saved = {};
    for (const k of keys) saved[k] = process.env[k];
    Object.assign(process.env, vars);
    try { return await fn(); }
    finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

console.log('\n=== Veo provider — dormancy gates ===');
{
    // Fresh require each time so the module re-reads env at call time (it does — accessors are live).
    const veo = require('../src/media/providers/veo-video');

    withEnv({}, () => {
        ok('no env → keyPresent() false', veo.keyPresent() === false);
        ok('no env → isEnabled() false', veo.isEnabled() === false);
    });

    withEnv({ VEO_AI_VIDEO: '1' }, () => {
        ok('flag on but NO key → isEnabled() false (cannot bill without a key)', veo.isEnabled() === false);
    });

    withEnv({ VEO_API_KEY: 'x' }, () => {
        ok('key present but flag off → isEnabled() false (must opt in)', veo.isEnabled() === false);
    });

    withEnv({ VEO_AI_VIDEO: '1', VEO_API_KEY: 'x' }, () => {
        ok('flag on + key → isEnabled() true', veo.isEnabled() === true);
        ok('keyPresent() true', veo.keyPresent() === true);
    });

    // generateVeoClip must be a no-op (null) when inert — never throws, never bills.
    (async () => {
        const inertClip = await withEnv({}, () => veo.generateVeoClip({ prompt: 'x', outFile: 'y.mp4' }));
        ok('generateVeoClip() → null when disabled (no API call)', inertClip === null);

        console.log('\n=== Directive compiler — accepts per-scene ai-video ===');
        const { __test } = require('../src/directives/directive-compiler');
        const coerced = __test._coercePerScene([
            { when: { kind: 'sceneIndex', sceneFrom: 5 }, set: { sourceHint: 'ai-video' } },
            { when: { kind: 'sceneIndex', sceneFrom: 6 }, set: { sourceHint: 'bogus-source' } },
        ]);
        ok('ai-video sourceHint survives coercion', Array.isArray(coerced) && coerced[0]?.set?.sourceHint === 'ai-video');
        ok('bogus sourceHint is dropped', Array.isArray(coerced) && !coerced.find(e => e.set?.sourceHint === 'bogus-source'));

        console.log('\n=== build-video scope pass — cost-safe defaults ===');
        const { __test: bv } = require('../src/pipeline/build-video');
        const mkScenes = () => ([
            { index: 0, sourceHint: '', mediaDiagnostics: { planner: {} } }, // eligible, hero-first
            { index: 1, sourceHint: '', mediaDiagnostics: { planner: {} } }, // eligible
            { index: 2, sourceHint: '', fullscreenMG: 'mapChart', mediaDiagnostics: { planner: {} } }, // MG → excluded
            { index: 3, sourceHint: '', _presenter: true, mediaDiagnostics: { planner: {} } }, // presenter → excluded
            { index: 4, sourceHint: '', _directiveLock: ['sourceHint'], mediaDiagnostics: { planner: {} } }, // user-locked → excluded
        ]);

        // scope 'directives' (default) → stamps NOTHING even when the feature is on.
        let s1 = mkScenes();
        let n1 = withEnv({ VEO_AI_VIDEO: '1', VEO_SCOPE: 'directives' }, () => bv._applyVeoScope(s1, {}));
        ok("scope 'directives' stamps 0 scenes (zero surprise cost)", n1 === 0 && !s1.some(s => s.sourceHint === 'ai-video'));

        // feature OFF → stamps nothing regardless of scope.
        let s0 = mkScenes();
        let n0 = withEnv({ VEO_SCOPE: 'all' }, () => bv._applyVeoScope(s0, {}));
        ok('feature OFF → stamps 0 scenes', n0 === 0);

        // scope 'all' → every eligible scene, never MG/presenter/locked.
        let s2 = mkScenes();
        let n2 = withEnv({ VEO_AI_VIDEO: '1', VEO_SCOPE: 'all' }, () => bv._applyVeoScope(s2, {}));
        ok("scope 'all' stamps only the 2 eligible scenes", n2 === 2);
        ok("scope 'all' skips MG scene", s2[2].sourceHint !== 'ai-video');
        ok("scope 'all' skips presenter scene", s2[3].sourceHint !== 'ai-video');
        ok("scope 'all' respects user directive lock", s2[4].sourceHint !== 'ai-video');
        ok("scope 'all' updates diagnostics", s2[0].mediaDiagnostics.planner.sourceHint === 'ai-video');

        // scope 'hero' → capped, includes the first eligible scene.
        let s3 = mkScenes();
        let n3 = withEnv({ VEO_AI_VIDEO: '1', VEO_SCOPE: 'hero' }, () => bv._applyVeoScope(s3, {}));
        ok("scope 'hero' stamps the first eligible scene", s3[0].sourceHint === 'ai-video' && n3 >= 1 && n3 <= 3);

        console.log('\n=== Kling video bridge — cookie gating (no key needed) ===');
        const os = require('os');
        const fsx = require('fs');
        const pathx = require('path');
        const kv = require('../src/media/providers/kling-video-browser');

        // No cookie file → dormant.
        const missing = pathx.join(os.tmpdir(), 'kling-cookies-does-not-exist-' + 'x.json');
        await withEnvKV({ KLING_COOKIE_FILE: missing }, async () => {
            ok('no cookie file → cookiesPresent() false', kv.cookiesPresent() === false);
            ok('no cookie file → isEnabled() false', kv.isEnabled() === false);
            let threw = false;
            try { await kv.generateVideoClip({ prompt: 'x', outFile: 'y.mp4' }); } catch (e) { threw = /cookies/i.test(e.message); }
            ok('generateVideoClip throws "no cookies" when session missing', threw);
        });

        // Fake cookie file → enabled (bridge could run; we do NOT launch a browser here).
        const fake = pathx.join(os.tmpdir(), 'kling-cookies-fake-' + 'test.json');
        fsx.writeFileSync(fake, JSON.stringify([{ name: 'sid', value: 'x', domain: '.kling.ai' }]));
        await withEnvKV({ KLING_COOKIE_FILE: fake }, async () => {
            ok('cookie file present → cookiesPresent() true', kv.cookiesPresent() === true);
            ok('cookie file present → isEnabled() true (no API key needed)', kv.isEnabled() === true);
            let threw = false;
            try { await kv.generateVideoClip({ prompt: '', outFile: 'y.mp4' }); } catch (e) { threw = /empty prompt/i.test(e.message); }
            ok('empty prompt throws before launching a browser', threw);
        });
        try { fsx.unlinkSync(fake); } catch (_) {}

        console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
        process.exit(fail === 0 ? 0 : 1);
    })();
}
