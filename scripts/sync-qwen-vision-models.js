// Sync Qwen/DashScope vision-capable model pools from the account-visible model catalog.
// Safe by design: discovery failures never edit runtime pools; unsupported probe results
// are excluded, transient/quota results are kept for the health preflight to handle.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { syncQwenVisionModelRegistry } = require('../src/vision/qwen-model-discovery');

function hasArg(name) {
    return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = '') {
    const prefix = `--${name}=`;
    const found = process.argv.find(a => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : fallback;
}

(async () => {
    const dryRun = hasArg('dry-run');
    const force = hasArg('force');
    const noProbe = hasArg('no-probe');
    const probe = hasArg('probe') ? true : noProbe ? false : undefined;
    const result = await syncQwenVisionModelRegistry({
        dryRun,
        force,
        probe,
        concurrency: Number(argValue('concurrency', '0')) || undefined,
        timeoutMs: Number(argValue('timeoutMs', '0')) || undefined,
        catalogTimeoutMs: Number(argValue('catalogTimeoutMs', '0')) || undefined,
        intervalHours: Number(argValue('intervalHours', '0')) || undefined,
    });

    if (result.skipped) {
        console.log(`Qwen model registry is fresh; skipped sync (${result.generatedAt}).`);
        console.log(`Registry: ${result.registryPath}`);
        return;
    }

    const registry = result.registry || {};
    const counts = registry.counts || {};
    console.log(`${dryRun ? 'Dry-run discovered' : 'Synced'} Qwen vision model registry`);
    console.log(`Registry: ${result.registryPath}`);
    console.log(`Catalog models seen: ${registry.catalogCount || 0}`);
    console.log(`Image scoring models: ${counts.image || 0}`);
    console.log(`Omni HTTP models: ${counts.omniHttp || 0}`);
    console.log(`Omni realtime candidates: ${counts.omniRealtime || 0}`);
    console.log(`Rejected/non-vision/unsupported: ${counts.rejected || 0}`);
})().catch((err) => {
    console.error(`Qwen model registry sync failed: ${err.message}`);
    process.exit(1);
});
