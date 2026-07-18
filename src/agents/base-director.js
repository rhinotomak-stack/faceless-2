// src/agents/base-director.js
// ============================================================================
// BaseDirector harness — the ONE copy of the 12-step control-flow skeleton that
// the six "triad" brain directors (effects, transition, icon, sound, presenter,
// directive-compiler) each hand-rolled identically. It owns ONLY the sequencing;
// everything behavior-defining (prompt text, callAI taskType, sha1 cache-key
// tuple + version tag, cache payload shape, parser, deterministic floor) stays in
// the leaf director as a DESCRIPTOR, so migrating a director to runDirector() is
// byte-identical by construction (verified via scripts/verify/director-snapshot.js).
//
// The harness NEVER builds a prompt, NEVER picks a taskType, NEVER constructs a
// hash tuple, NEVER defines a cache payload, NEVER defines a floor. It only calls
// the descriptor's closures in the fixed order. Those are the SACRED invariants.
//
// Descriptor shape (all fields the leaf already had; kept in the leaf file):
//   {
//     id, flagEnv,                              // isDisabled = same /^(0|false|off|no)$/i regex on process.env[flagEnv]
//     cacheFile,                                // literal '.hf-x-cache.json' (SACRED)
//     callOpts: { maxTokens, temperature, taskType },  // taskType SACRED — no default
//     collect(subject, opts)      -> ctx | null,       // filter + min-count bail (null → skip)
//     reuse(ctx, subject, opts)   -> result | null,    // saved-project + directive short-circuits (0 AI calls)
//     hashInputs(ctx, opts)       -> [ 'v2', ... ],    // the EXACT tuple incl version tag — harness only sha1+slice(0,16)
//     cacheValid(cached, ctx, opts) -> bool,           // custom (icon file-exists, sound toClips-able)
//     applyCache(cached, ctx, subject, opts) -> result,
//     buildPrompt(ctx, opts)      -> string,           // verbatim — SACRED
//     parse(text, ctx, opts)      -> parsed | null,    // brace-slice / _coerce / strict — per director
//     apply(parsed, ctx, subject, opts) -> { result, payload, decided },  // payload → cache, decided gates write
//     floor(ctx, subject, opts, reason) -> result,     // per-director deterministic fallback
//     writeWhen(result)           -> bool (optional),  // default: result.decided > 0
//     logResult(result, log)      (optional)
//   }
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('./../brain/ai-provider');

// Same disabled regex every triad director used verbatim.
function envDisabled(flagEnv) {
    if (!flagEnv) return false;
    return /^(0|false|off|no)$/i.test(String(process.env[flagEnv] || '').trim());
}

// Same sha1-16 the six directors computed: createHash('sha1').update(JSON.stringify(tuple)).digest('hex').slice(0,16).
function hashOf(tuple) {
    return crypto.createHash('sha1').update(JSON.stringify(tuple)).digest('hex').slice(0, 16);
}

// Sequence the descriptor. `subject` is the director's first arg (plan for most,
// scenes for presenter, directorsBrief for directive-compiler). Returns the
// descriptor's own result object unchanged.
async function runDirector(descriptor, subject, opts = {}) {
    const d = descriptor;
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);

    // 1. disabled gate
    if (envDisabled(d.flagEnv) || (typeof d.isDisabled === 'function' && d.isDisabled(opts))) {
        return typeof d.disabledResult === 'function' ? d.disabledResult() : { decided: 0, skipped: true };
    }

    // 2. collect + min-count guard
    const ctx = await d.collect(subject, opts);
    if (!ctx) return typeof d.emptyResult === 'function' ? d.emptyResult() : { decided: 0 };

    // 3. reuse / directive short-circuits (BEFORE cache + AI — 0 AI calls)
    if (typeof d.reuse === 'function') {
        const reused = await d.reuse(ctx, subject, opts);
        if (reused) return reused;
    }

    // 4. cache key + read
    const cacheFile = d.cacheFile && opts.projectDir ? path.join(opts.projectDir, d.cacheFile) : null;
    const hash = hashOf(d.hashInputs(ctx, opts));
    if (cacheFile && fs.existsSync(cacheFile)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            if (cached && cached.hash === hash && (typeof d.cacheValid !== 'function' || d.cacheValid(cached, ctx, opts))) {
                return await d.applyCache(cached, ctx, subject, opts);
            }
        } catch (_) { /* stale/corrupt → fall through to fresh */ }
    }

    // 5. AI call (verbatim prompt + taskType from the descriptor)
    let parsed = null;
    try {
        const text = await callAI(d.buildPrompt(ctx, opts), d.callOpts);
        parsed = d.parse(text, ctx, opts);
    } catch (e) {
        log(`  [${d.id}] AI call failed (${e.message}) — deterministic floor`);
        return d.floor(ctx, subject, opts, 'ai-error');
    }
    if (parsed == null) return d.floor(ctx, subject, opts, 'unparseable');

    // 6. apply + clamp (SACRED post-processing in the descriptor)
    const applied = await d.apply(parsed, ctx, subject, opts);
    const result = applied && applied.result !== undefined ? applied.result : applied;
    const decided = applied && typeof applied.decided === 'number' ? applied.decided
        : (result && typeof result.decided === 'number' ? result.decided : 0);

    // 7. cache write (per-director payload + guard)
    const shouldWrite = typeof d.writeWhen === 'function' ? d.writeWhen(result, applied) : decided > 0;
    if (cacheFile && shouldWrite && applied && applied.payload) {
        try { fs.writeFileSync(cacheFile, JSON.stringify({ hash, ...applied.payload })); } catch (_) { /* non-fatal */ }
    }

    if (typeof d.logResult === 'function') d.logResult(result, log);
    return result;
}

module.exports = { runDirector, envDisabled, hashOf };
