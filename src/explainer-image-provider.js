/**
 * Explainer Image Provider
 *
 * Downloads images for "explainer" MG scenes (tools, products, concepts)
 * and removes backgrounds to create transparent PNGs.
 *
 * Pipeline: search query → image providers → download → bg removal → transparent PNG
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// Image providers (reuse existing infrastructure)
const GoogleImagesProvider = require('./providers/google-images');
const BingImagesProvider = require('./providers/bing-images');
const PexelsImageProvider = require('./providers/pexels-image');
const PixabayImageProvider = require('./providers/pixabay-image');


// Background removal (WASM-based, runs locally)
let removeBackground = null;

async function loadBgRemover() {
    if (removeBackground) return removeBackground;
    try {
        const mod = require('@imgly/background-removal-node');
        removeBackground = mod.removeBackground;
        return removeBackground;
    } catch (e) {
        console.log('   ⚠️ @imgly/background-removal-node not installed, skipping bg removal');
        return null;
    }
}

// ── Image search ──

// Ordered: web scrapers first (specific images), then stock APIs (good fallback)
const providers = [
    new GoogleImagesProvider(),
    new BingImagesProvider(),
    new PexelsImageProvider(),
    new PixabayImageProvider(),
];

/**
 * Search for an image matching the query.
 * Tries providers in order with smart query strategies per provider type.
 *
 * @param {string} query - Search query (e.g. "ChatGPT logo")
 * @returns {Object|null} { url, width, height } or null
 */
async function searchImage(query) {
    // Shorten long queries for stock APIs (they work best with 2-4 words)
    const words = query.trim().split(/\s+/);
    const shortQuery = words.length > 4 ? words.slice(0, 4).join(' ') : query;

    for (const provider of providers) {
        if (!provider.isAvailable()) continue;

        // Web scrapers: try transparent/logo variants first, then plain
        // Stock APIs (Pexels/Pixabay): just use the query directly (no "transparent png" nonsense)
        const isStockApi = provider.name.includes('Pexels') || provider.name.includes('Pixabay') || provider.name.includes('Unsplash');
        const queries = isStockApi
            ? [shortQuery, query]
            : [`${query} transparent background png`, `${query} logo png`, query];

        for (const q of queries) {
            try {
                const results = await provider.search(q);
                const filtered = provider.filterResults(results);
                if (filtered.length > 0) {
                    const picked = provider.pickUnused(filtered);
                    if (picked) {
                        console.log(`   ✅ Found on ${provider.name}: ${picked.url.substring(0, 80)}...`);
                        return picked;
                    }
                }
            } catch (e) {
                // Try next query/provider
            }
        }
    }

    return null;
}

// ── Background removal ──

/**
 * Remove background from an image file and save as transparent PNG.
 *
 * @param {string} inputPath - Path to source image
 * @param {string} outputPath - Path to save transparent PNG
 * @param {number} timeoutMs - Timeout in ms (default 60s)
 * @returns {boolean} true if successful
 */
async function removeBg(inputPath, outputPath, timeoutMs = 60000) {
    const bgRemove = await loadBgRemover();
    if (!bgRemove) {
        // No bg remover available — just copy the file as-is
        fs.copyFileSync(inputPath, outputPath);
        return false;
    }

    try {
        const inputBuffer = fs.readFileSync(inputPath);
        const ext = path.extname(inputPath).toLowerCase();
        const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
        const blob = new Blob([inputBuffer], { type: mimeMap[ext] || 'image/jpeg' });

        // Race against timeout
        const result = await Promise.race([
            bgRemove(blob, {
                model: 'medium',
                output: { format: 'image/png' },
            }),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Background removal timed out')), timeoutMs)
            ),
        ]);

        const arrayBuf = await result.arrayBuffer();
        fs.writeFileSync(outputPath, Buffer.from(arrayBuf));
        return true;
    } catch (e) {
        console.log(`   ⚠️ Bg removal failed: ${e.message} — using original image`);
        // Fallback: copy original
        if (fs.existsSync(inputPath)) {
            fs.copyFileSync(inputPath, outputPath);
        }
        return false;
    }
}

// ── Main pipeline ──

/**
 * Download and process explainer images for all explainer MGs.
 *
 * @param {Array} motionGraphics - MG array (filters for type === 'explainer')
 * @param {string} tempDir - Temp directory for intermediate files
 * @param {Object} scriptContext - Script context for theme info
 * @returns {number} Number of images successfully processed
 */
async function downloadExplainerImages(motionGraphics, tempDir, scriptContext) {
    const explainers = motionGraphics.filter(mg => mg.type === 'explainer');
    if (explainers.length === 0) return 0;

    console.log(`\n   Processing ${explainers.length} explainer image(s)...`);

    // Ensure temp dir exists
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let successCount = 0;

    for (let i = 0; i < explainers.length; i++) {
        const mg = explainers[i];
        const query = mg.explainerQuery || mg.keyword || mg.text || '';
        const idx = mg.sceneIndex ?? i;
        const rawFile = path.join(tempDir, `explainer-${idx}-raw.jpg`);
        const finalFile = path.join(tempDir, `explainer-${idx}.png`);

        console.log(`\n   [${i + 1}/${explainers.length}] Searching: "${query}"`);

        // Step 1: Search and download
        const result = await searchImage(query);
        if (!result) {
            console.log(`   ❌ No image found for "${query}"`);
            continue;
        }

        try {
            // Download using the provider's download method
            // download() may sanitize to PNG and return a different path
            const provider = providers.find(p => p.isAvailable());
            let actualRawFile = rawFile;
            if (provider) {
                actualRawFile = await provider.download(result.url, rawFile) || rawFile;
            }

            if (!fs.existsSync(actualRawFile)) {
                console.log(`   ❌ Download failed for "${query}"`);
                continue;
            }

            const rawSize = (fs.statSync(actualRawFile).size / 1024).toFixed(0);
            console.log(`   📥 Downloaded: ${rawSize}KB`);

            // Step 2: Remove background
            console.log(`   🔄 Removing background...`);
            const bgRemoved = await removeBg(actualRawFile, finalFile);
            const finalSize = (fs.statSync(finalFile).size / 1024).toFixed(0);

            if (bgRemoved) {
                console.log(`   ✅ Transparent PNG: ${finalSize}KB`);
            } else {
                console.log(`   ⚠️ Using original image: ${finalSize}KB`);
            }

            // Step 3: Set the file reference on the MG object
            mg.explainerImageFile = `explainer-${idx}.png`;
            successCount++;

            // Clean up raw file
            try { fs.unlinkSync(actualRawFile); } catch (e) { /* ignore */ }

        } catch (e) {
            console.log(`   ❌ Failed: ${e.message}`);
        }
    }

    return successCount;
}

module.exports = { downloadExplainerImages, searchImage, removeBg };
