'use strict';
/**
 * vision-rewake.js — MID-BUILD watchdog for the self-hosted vision GPU.
 *
 * Problem it fixes: the GPU machine (Lightning Studio / AWS box) is started JUST-IN-TIME at the
 * top of the media phase (build-video.js → visionGpu.ensureReady()). If it later SLEEPS mid-scoring
 * (Lightning auto-sleep, credit exhaustion, a crash), the vision chain silently spills every
 * remaining call onto the Bedrock fallback for the WHOLE rest of the build — slower and paid, and
 * the pool's OTHER accounts never get a chance.
 *
 * This watchdog watches which vision provider actually served each call. When the free GPU is down
 * and calls keep landing on Bedrock, it fires visionGpu.ensureReady() ONCE in the background —
 * which ROTATES to the next healthy account and re-boots a studio. Because the Qwen client re-probes
 * the endpoint every ~30s (transient cooldown, not a permanent disable), scoring climbs back onto
 * the free GPU on its own once the endpoint returns.
 *
 * Fire-and-forget, debounced, flag-gated, and it NEVER throws into the caller.
 * Disable with VISION_MIDBUILD_REWAKE=0.
 */

let _consecutiveDown = 0;
let _inFlight = false;
let _lastAttempt = 0;
// The watchdog is only meant to guard the HEAVY vision phase (media scoring + CEO framing).
// The build disarms it once that phase ends, so the light Step 7.6 perfectionist review — which
// runs after the GPU is deliberately stopped — spills to Bedrock instead of triggering a
// pointless multi-minute cold re-boot. Armed by default (each build is a fresh process).
let _armed = true;

/** Re-enable auto re-wake (default state). */
function arm() { _armed = true; _consecutiveDown = 0; }
/** End the auto-rewake session — later Bedrock fallbacks will NOT re-boot the GPU. */
function disarm() { _armed = false; }

function _enabled() {
    if (String(process.env.VISION_MIDBUILD_REWAKE || '1') === '0') return false;
    // Only backends that actually own a machine to wake.
    const b = String(process.env.VISION_BACKEND || 'aws').toLowerCase();
    return b === 'lightning' || b === 'aws';
}

const _THRESHOLD = Math.max(1, Number(process.env.VISION_REWAKE_AFTER || 3));       // consecutive down-signals
const _MIN_GAP_MS = Math.max(30, Number(process.env.VISION_REWAKE_MIN_GAP_SEC || 180)) * 1000; // don't spam re-boots

/** A vision call was served by the free GPU — it's up, clear the streak. */
function signalUp() { _consecutiveDown = 0; }

/** A vision call fell to Bedrock (GPU down). After enough in a row, re-wake in the background. */
function signalDown(reason) {
    if (!_armed) return;      // vision mission is over — don't re-boot for late/light usage
    if (!_enabled()) return;
    _consecutiveDown++;
    if (_consecutiveDown < _THRESHOLD) return;
    if (_inFlight) return;
    if (Date.now() - _lastAttempt < _MIN_GAP_MS) return;
    _lastAttempt = Date.now();
    _inFlight = true;
    _consecutiveDown = 0;
    (async () => {
        try {
            const visionGpu = require('./vision-gpu');
            if (!(visionGpu.isConfigured && visionGpu.isConfigured())) return;
            if (await visionGpu.isVisionReady()) { signalUp(); return; } // already back — nothing to do
            console.log(`  🔁 [vision-rewake] free vision GPU looks down (${reason || 'repeated Bedrock fallbacks'}) — rotating/re-waking in the background…`);
            const r = await visionGpu.ensureReady({ onProgress: (m) => console.log('     ' + m) });
            if (r && r.ok) { console.log('  ✅ [vision-rewake] vision GPU back up — scoring will resume on the free GPU'); signalUp(); }
            else { console.log(`  ⚠️ [vision-rewake] re-wake did not succeed (${(r && r.reason) || 'unknown'}) — staying on Bedrock for now`); }
        } catch (e) {
            console.log('  ⚠️ [vision-rewake] error: ' + (e && e.message));
        } finally {
            _inFlight = false;
        }
    })();
}

/** Route a chain outcome (the provider that served the result) into up/down signals. */
function observe(providerUsed) {
    if (!providerUsed) return;
    if (providerUsed === 'qwen') signalUp();
    else if (/^bedrock/.test(String(providerUsed))) signalDown(`served by ${providerUsed}`);
}

module.exports = { observe, signalUp, signalDown, arm, disarm };
