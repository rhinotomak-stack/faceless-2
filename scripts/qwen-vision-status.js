// Secret-safe Qwen vision runtime status.
// Run with: node scripts/qwen-vision-status.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function argValue(name, fallback = '') {
    const prefix = `--${name}=`;
    const found = process.argv.find(a => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

function printStatus(status) {
    console.log('=== Qwen Vision Runtime Status ===');
    console.log(`Keys: ${status.imageKeys || 0} Image/VL, ${status.omniKeys || 0} Omni (${status.sharedKeys || 0} shared fallback)`);
    console.log(`Endpoint: ${status.endpoint}`);
    console.log(`Configured image model: ${status.visionModel}`);
    if (status.registry) {
        console.log(`Model registry: ${status.registry.source || 'static'}${status.registry.generatedAt ? ` (${status.registry.generatedAt})` : ''}`);
        console.log(`Registry file: ${status.registry.file}`);
        console.log(`Registry pools: image=${status.registry.imageModels}, omni-http=${status.registry.omniHttpModels}, realtime=${status.registry.omniRealtimeModels}`);
    }
    console.log(`Health cache: ${status.health.updatedAt || 'not probed yet'}`);
    if (status.imageKeyTails?.length) {
        console.log(`Image key tails: ${status.imageKeyTails.map((t, i) => `Image ${i + 1}=...${t}`).join(', ')}`);
    }
    if (status.omniKeyTails?.length) {
        console.log(`Omni key tails: ${status.omniKeyTails.map((t, i) => `Omni ${i + 1}=...${t}`).join(', ')}`);
    }
    if (status.sharedKeyTails?.length) {
        console.log(`Shared fallback tails: ${status.sharedKeyTails.map((t, i) => `Shared ${i + 1}=...${t}`).join(', ')}`);
    }
    console.log('');
    console.log(`Image/VL runtime: ${status.image.available}/${status.image.total} available (${status.image.verifiedOk || 0} live-verified ok)`);
    for (const k of status.image.perKey) {
        const tail = k.keyTail || status.imageKeyTails?.[k.keyIndex - 1] || 'unknown';
        console.log(`  Key ${k.keyIndex} (...${tail}): ${k.available}/${k.total} available, ${k.verifiedOk || 0} verified ok, ${k.healthSkipped || 0} health-skipped`);
    }
    console.log('');
    console.log(`Omni HTTP runtime: ${status.omniHttp.available}/${status.omniHttp.total} available (${status.omniHttp.verifiedOk || 0} live-verified ok)`);
    for (const k of status.omniHttp.perKey) {
        const tail = k.keyTail || status.omniKeyTails?.[k.keyIndex - 1] || 'unknown';
        console.log(`  Key ${k.keyIndex} (...${tail}): ${k.available}/${k.total} available, ${k.verifiedOk || 0} verified ok, ${k.healthSkipped || 0} health-skipped`);
    }
    console.log('');
    console.log(`Omni realtime WebSocket runtime: ${status.omniRealtime.available}/${status.omniRealtime.total} available (${status.omniRealtime.verifiedOk || 0} live-verified ok)`);
    for (const k of status.omniRealtime.perKey || []) {
        const tail = k.keyTail || status.omniKeyTails?.[k.keyIndex - 1] || 'unknown';
        console.log(`  Key ${k.keyIndex} (...${tail}): ${k.available}/${k.total} available, ${k.verifiedOk || 0} verified ok, ${k.healthSkipped || 0} health-skipped`);
    }
    console.log(`Omni realtime dashboard pool: ${status.omniRealtime.totalAcrossKeys} candidates`);
    console.log(`  Per key: ${status.omniRealtime.totalPerKey}`);
    console.log(`  Transport: ${status.omniRealtime.transport}`);
    console.log(`  Active in current runtime: ${status.omniRealtime.activeInCurrentRuntime}`);
    console.log('');
    console.log(`OpenAI-compatible unsupported Omni aliases: ${status.omniUnsupportedOpenAI.totalAcrossKeys}`);
    if (status.diagnostics?.warnings?.length) {
        console.log('');
        console.log('Warnings:');
        for (const warning of status.diagnostics.warnings) console.log(`  - ${warning}`);
    }
    if (status.diagnostics?.recommendations?.length) {
        console.log('');
        console.log('Recommended action:');
        for (const rec of status.diagnostics.recommendations) console.log(`  - ${rec}`);
    }
}

(async () => {
    if (process.argv.includes('--sync')) {
        const { syncQwenVisionModelRegistry } = require('../src/vision/qwen-model-discovery');
        const noProbe = process.argv.includes('--no-probe');
        const result = await syncQwenVisionModelRegistry({
            force: process.argv.includes('--force'),
            probe: !noProbe,
            concurrency: Number(argValue('concurrency', '4')) || 4,
            timeoutMs: Number(argValue('timeoutMs', '12000')) || 12000,
            catalogTimeoutMs: Number(argValue('catalogTimeoutMs', '15000')) || 15000,
            intervalHours: Number(argValue('intervalHours', '24')) || 24,
        });
        if (result.skipped) {
            console.log(`Qwen model registry is fresh; skipped sync (${result.generatedAt}).`);
        } else {
            const counts = result.registry?.counts || {};
            console.log(`Qwen model registry synced: image=${counts.image || 0}, omni-http=${counts.omniHttp || 0}, realtime=${counts.omniRealtime || 0}, rejected=${counts.rejected || 0}`);
        }
        console.log('');
    }

    const { getQwenVisionStatus, refreshQwenVisionHealth } = require('../src/brain/ai-provider');
    const live = process.argv.includes('--live');
    if (live) {
        const lanesRaw = argValue('lanes', 'image,omniHttp');
        const lanes = lanesRaw.split(',').map(s => s.trim()).filter(Boolean);
        const concurrency = Number(argValue('concurrency', '4')) || 4;
        const timeoutMs = Number(argValue('timeoutMs', '25000')) || 25000;
        const imageLimit = Number(argValue('imageLimit', '0')) || 0;
        const omniLimit = Number(argValue('omniLimit', '0')) || 0;
        console.log(`Running live Qwen health probe: lanes=${lanes.join(',')} concurrency=${concurrency} timeout=${timeoutMs}ms`);
        const probe = await refreshQwenVisionHealth({ lanes, concurrency, timeoutMs, imageLimit, omniLimit });
        console.log('Live probe summary:');
        for (const [key, lanesSummary] of Object.entries(probe.summary.byKey)) {
            const parts = [];
            for (const [lane, counts] of Object.entries(lanesSummary)) {
                const countText = Object.entries(counts).map(([s, n]) => `${s}:${n}`).join(', ');
                parts.push(`${lane} { ${countText} }`);
            }
            console.log(`  Key ${key}: ${parts.join(' | ')}`);
        }
        console.log('');
    }
    printStatus(getQwenVisionStatus());
})().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
});
