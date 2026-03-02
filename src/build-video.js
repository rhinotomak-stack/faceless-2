const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const { transcribeAudio } = require('./transcribe');
// NEW: Smart AI modules (Phase 1 & 2)
const { createDirectorsBrief } = require('./directors-brief');
const { analyzeAndCreateScenes } = require('./ai-director');
const { planVisuals } = require('./ai-visual-planner');
// Existing modules
const { analyzeSceneVisuals, analyzeSingleScene, createDefaultAnalysis, analyzeArticleHighlights } = require('./ai-vision');
const { processArticleImages } = require('./article-image');
const { processMotionGraphics, FULLSCREEN_MG_TYPES } = require('./ai-motion-graphics');
const { downloadAllMedia, downloadBackgroundCanvas, retryPoorMedia } = require('./footage-manager');
const { loadRecipe } = require('./recipe-loader');

// Clean a folder of old build artifacts (scene files, plans, audio)
function cleanFolder(folderPath, label) {
    if (!fs.existsSync(folderPath)) return;
    const files = fs.readdirSync(folderPath);
    let cleaned = 0;
    for (const file of files) {
        // Remove scene files, plan, and audio files from previous builds
        if (/^(scene-\d+\.(mp4|jpg|png|webp)|overlay-\d+\.(mp4|jpg|jpeg|png|gif|webm|mov)|bg-.+\.(mp4|jpg|jpeg|png|gif|webm|mov)|frame-\d+\.jpg|article-\d+\.(jpg|png|webp))$/.test(file) ||
            file === 'video-plan.json' ||
            file.endsWith('.mp3') || file.endsWith('.wav')) {
            try {
                fs.unlinkSync(path.join(folderPath, file));
                cleaned++;
            } catch (e) { /* ignore locked files */ }
        }
    }
    if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} old files from ${label}`);
}

async function buildVideo() {
    console.log('\n🎬 ==========================================');
    console.log('🎬  FACELESS VIDEO GENERATOR - AUTO BUILD');
    console.log('🎬 ==========================================\n');

    const startTime = Date.now();

    // Step 0: Clean old build artifacts
    console.log('🧹 Step 0: Cleaning old build files...');
    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
    cleanFolder(path.join(PROJECT_DIR, 'public'), 'public');
    cleanFolder(config.paths.temp, 'temp');

    // Step 1: Find voiceover file + create Director's Brief
    console.log('📁 Step 1: Finding audio file...');
    // Use explicit filename from UI if provided via env var
    const explicitAudio = process.env.BUILD_AUDIO_FILE;
    const inputFiles = fs.readdirSync(config.paths.input);
    const audioFile = explicitAudio
        ? inputFiles.find(f => f === explicitAudio)
        : inputFiles.find(f => f.endsWith('.mp3') || f.endsWith('.wav'));

    if (!audioFile) {
        console.error('❌ No audio file found in /input folder!');
        if (explicitAudio) console.error(`   Expected: ${explicitAudio}`);
        console.log('💡 Add your voiceover.mp3 to the input folder and try again.');
        process.exit(1);
    }
    console.log(`   ✅ Found: ${audioFile}`);

    // Create Director's Brief (reads env vars: AI_INSTRUCTIONS, BUILD_FORMAT, BUILD_QUALITY_TIER, BUILD_AUDIENCE)
    const directorsBrief = createDirectorsBrief();
    console.log(`\n📋 Director's Brief:`);
    console.log(`   Format: ${directorsBrief.format} | Quality: ${directorsBrief.qualityTier} | Density: ${directorsBrief.tier.sceneDensity}/min`);
    if (directorsBrief.freeInstructions) console.log(`   Instructions: "${directorsBrief.freeInstructions.substring(0, 80)}${directorsBrief.freeInstructions.length > 80 ? '...' : ''}"`);
    if (directorsBrief.audienceHint) console.log(`   Audience: "${directorsBrief.audienceHint}"`);
    console.log('');

    // Step 2: Transcribe
    console.log('🎙️ Step 2: Transcribing audio...');
    const audioPath = path.join(config.paths.input, audioFile);
    const transcription = await transcribeAudio(audioPath);

    // Step 3: AI Director — Scene creation + context analysis + format detection
    // NEW: Uses ai-director.js which combines scene splitting + context + CTA/hook detection
    // The AI reads the full script and intelligently splits it into scenes
    // based on meaning, pacing, and user instructions. Also extracts rich context
    // (summary, theme, mood, entities, format, CTA, hook, background canvas).
    console.log('═'.repeat(60));
    console.log('🎬 Step 3: AI Director (Scene Creation + Context Analysis)');
    console.log('═'.repeat(60));
    const { scenes, scriptContext } = await analyzeAndCreateScenes(transcription, directorsBrief);
    console.log(`   ✅ Created ${scenes.length} scenes with rich context\n`);
    const actualAudioDuration = transcription.duration || (transcription.segments.length > 0 ? transcription.segments[transcription.segments.length - 1].end : 0);

    // Step 4: Visual Planning — Batch keywords + media type + source hints
    // NEW: Uses ai-visual-planner.js which plans ALL scenes in one AI call
    // This creates visual variety across the video and uses director's context
    console.log('═'.repeat(60));
    console.log('🎨 Step 4: Visual Planner (Batch Keyword Generation)');
    console.log('═'.repeat(60));
    const scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    // Load genre recipe if available (auto-detects from content or BUILD_RECIPE env var)
    const recipeResult = loadRecipe(scriptContext, directorsBrief.freeInstructions);
    if (recipeResult.recipe) {
        console.log(`   🍳 Genre recipe loaded: ${recipeResult.recipe.niche}`);
    }

    // Merge recipe prompt with user instructions — flows to all downstream AI modules
    const aiInstructions = [directorsBrief.freeInstructions, recipeResult.promptText].filter(Boolean).join('\n\n');

    // Step 4.5: Perplexity Research (optional — enriches keywords with real-world sources)
    if (config.perplexity?.apiKey) {
        console.log('═'.repeat(60));
        console.log('🔬 Step 4.5: Media Research (Perplexity)');
        console.log('═'.repeat(60));
        try {
            const { researchSceneMedia } = require('./ai-research');
            await researchSceneMedia(scenesWithKeywords, scriptContext);
        } catch (error) {
            console.log(`   ⚠️ Research step failed: ${error.message} (continuing without)\n`);
        }
    }

    // Step 5: Download media (videos + images from multiple providers)
    console.log('═'.repeat(60));
    console.log('🎥 Step 5: Downloading Media');
    console.log('═'.repeat(60));
    const skipVisionAI = directorsBrief.tier.skipVisionAI;
    const downloadResult = await downloadAllMedia(scenesWithKeywords, scriptContext, {
        inlineVision: true,
        skipVisionAI
    });
    let scenesWithMedia = downloadResult.scenes;
    let inlineVisualAnalysis = downloadResult.visualAnalysis;

    // Step 5.1: Auto-detect aspect ratios + apply AI framing decisions
    console.log('═'.repeat(60));
    console.log('📐 Step 5.1: Aspect Ratio & Framing');
    console.log('═'.repeat(60));
    let autoContainCount = 0;
    let cinematicCount = 0;
    for (const scene of scenesWithMedia) {
        const w = scene.mediaWidth || 0;
        const h = scene.mediaHeight || 0;

        if (w > 0 && h > 0) {
            const ratio = w / h;

            if (ratio < 1.2) {
                // Clearly non-widescreen: vertical (9:16), square (1:1)
                // These MUST use contain + blur — cover would crop too much
                scene.fitMode = 'contain';
                scene.background = 'blur';
                scene.scale = 1;
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;

                const label = ratio < 0.7 ? 'vertical' : ratio < 1.1 ? 'square' : 'near-square';
                console.log(`   📐 Scene ${scene.index}: ${w}x${h} (${label}, ratio ${ratio.toFixed(2)}) → contain + blur`);
            } else if (scene.framing === 'cinematic') {
                // AI recommended cinematic framing — pull back slightly with background
                scene.fitMode = 'cover';
                scene.scale = 0.88;
                // Keep AI's background choice (blur, gradient:id, or pattern:file)
                if (!scene.background || scene.background === 'none') {
                    scene.background = 'blur'; // Fallback if AI didn't set one
                }
                scene.posX = 0;
                scene.posY = 0;
                cinematicCount++;
                console.log(`   🎬 Scene ${scene.index}: ${w}x${h} (cinematic) → scale 0.88 + ${scene.background}`);
            } else {
                // Fullscreen — media fills the frame completely
                scene.fitMode = 'cover';
            }
        } else {
            // Unknown dimensions — default to cover
            scene.fitMode = 'cover';
        }
    }

    const framingTotal = autoContainCount + cinematicCount;
    if (framingTotal > 0) {
        console.log(`   ✅ ${autoContainCount} auto-contained (non-widescreen) + ${cinematicCount} cinematic (AI-descaled)`);
    } else {
        console.log(`   ✅ All scenes fullscreen — no auto-framing needed`);
    }
    console.log('');

    // Step 5.5: Vision Analysis (already done inline with downloads)
    console.log('═'.repeat(60));
    console.log('👁️ Step 5.5: Vision Analysis');
    console.log('═'.repeat(60));
    let visualAnalysis = inlineVisualAnalysis || scenes.map((_, i) => createDefaultAnalysis(i));
    // Fill any gaps with defaults
    for (let i = 0; i < scenes.length; i++) {
        if (!visualAnalysis[i]) visualAnalysis[i] = createDefaultAnalysis(i);
    }
    if (skipVisionAI) {
        console.log(`   ⏭️  Skipped (${directorsBrief.qualityTier} tier)\n`);
    } else {
        const analyzed = visualAnalysis.filter(r => r.description !== 'No visual analysis available').length;
        const poor = visualAnalysis.filter(r => r.suitability === 'poor').length;
        console.log(`\n📊 Vision analysis: ${analyzed}/${scenesWithMedia.length} analyzed (inline with downloads)`);
        if (poor > 0) console.log(`   ⚠️ ${poor} scene(s) with poor footage match`);
        console.log('');
    }

    // Step 5.6: Retry poor footage — keep searching providers until "good" found
    const poorScenes = visualAnalysis
        .map((va, i) => ({ va, i }))
        .filter(({ va }) => va.suitability === 'poor');

    if (poorScenes.length > 0 && !directorsBrief.tier.skipVisionAI) {
        console.log('═'.repeat(60));
        console.log('🔄 Step 5.6: Retrying Poor Footage');
        console.log('═'.repeat(60));

        const SUITABILITY_SCORE = { poor: 1, fair: 2, good: 3 };
        const MAX_SCENES = 5;          // Max scenes to retry (API cost control)
        const MAX_ATTEMPTS_PER_SCENE = 4; // Max provider attempts per scene
        const toRetry = poorScenes.slice(0, MAX_SCENES);

        console.log(`   Found ${poorScenes.length} poor scene(s), retrying up to ${toRetry.length}...\n`);

        let improved = 0;
        for (const { va: originalAnalysis, i } of toRetry) {
            const scene = scenesWithMedia[i];
            if (!scene || !scene.keyword) continue;

            const sceneDuration = (scene.endTime || 0) - (scene.startTime || 0) || 10;
            console.log(`   Scene ${i}: "${scene.keyword}" (was: ${originalAnalysis.suitability} — ${originalAnalysis.suitabilityReason})`);

            // Track best candidate across all attempts
            let bestResult = null;
            let bestAnalysis = originalAnalysis;
            let bestScore = SUITABILITY_SCORE[originalAnalysis.suitability] || 1;
            const triedProviders = [scene.sourceProvider || ''];

            for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_SCENE; attempt++) {
                try {
                    const retryResult = await retryPoorMedia(
                        scene.keyword,
                        scene.mediaType || 'video',
                        `scene-${i}-retry`,
                        sceneDuration,
                        scene.sourceHint || '',
                        triedProviders
                    );

                    if (!retryResult) {
                        console.log(`      ⚠️ No more providers to try\n`);
                        break;
                    }

                    // Add this provider to tried list so next attempt skips it
                    triedProviders.push(retryResult.provider);

                    // Analyze the new footage
                    const retryScene = {
                        ...scene,
                        mediaFile: retryResult.path,
                        mediaExtension: retryResult.ext
                    };

                    console.log(`      🔍 Attempt ${attempt + 1}: [${retryResult.provider}]...`);
                    const newAnalysis = await analyzeSingleScene(retryScene, i, scriptContext);
                    const newScore = SUITABILITY_SCORE[newAnalysis.suitability] || 1;

                    console.log(`         ${newAnalysis.suitability}: "${newAnalysis.description.substring(0, 55)}"`);

                    if (newScore > bestScore) {
                        // Clean up previous best retry file if it exists
                        if (bestResult && bestResult.path !== retryResult.path && fs.existsSync(bestResult.path)) {
                            fs.unlinkSync(bestResult.path);
                        }
                        bestResult = retryResult;
                        bestAnalysis = newAnalysis;
                        bestScore = newScore;
                    } else {
                        // This attempt wasn't better — clean up the file
                        if (fs.existsSync(retryResult.path)) {
                            fs.unlinkSync(retryResult.path);
                        }
                    }

                    // Found "good" footage — stop searching
                    if (bestScore >= 3) {
                        console.log(`      🎯 Found good footage, stopping search`);
                        break;
                    }
                } catch (retryError) {
                    console.log(`      ⚠️ Attempt ${attempt + 1} failed: ${retryError.message}`);
                }
            }

            // Apply best result if it's better than original
            if (bestResult && bestScore > (SUITABILITY_SCORE[originalAnalysis.suitability] || 1)) {
                const origExt = scene.mediaExtension || '.mp4';
                const origPath = path.join(config.paths.temp, `scene-${i}${origExt}`);

                if (fs.existsSync(bestResult.path)) {
                    fs.copyFileSync(bestResult.path, origPath);
                    fs.unlinkSync(bestResult.path);
                }

                scene.mediaFile = origPath;
                scene.mediaExtension = bestResult.ext;
                scene.sourceProvider = bestResult.provider;
                scene.mediaWidth = bestResult.mediaWidth || scene.mediaWidth;
                scene.mediaHeight = bestResult.mediaHeight || scene.mediaHeight;

                visualAnalysis[i] = bestAnalysis;
                improved++;

                console.log(`      ✅ Upgraded: ${originalAnalysis.suitability} → ${bestAnalysis.suitability} [${bestResult.provider}]\n`);
            } else {
                // Clean up any leftover retry file
                if (bestResult && fs.existsSync(bestResult.path)) {
                    fs.unlinkSync(bestResult.path);
                }
                console.log(`      ↩️ Kept original (no better footage found)\n`);
            }
        }

        if (improved > 0) {
            console.log(`   📊 Improved ${improved}/${toRetry.length} scene(s)\n`);
        } else {
            console.log(`   ℹ️ No improvements found — keeping original footage\n`);
        }
    }

    // Step 6: AI Motion Graphics (now with both script context AND visual analysis)
    console.log('═'.repeat(60));
    console.log('✨ Step 6: AI Motion Graphics');
    console.log('═'.repeat(60));
    const mgResult = await processMotionGraphics(scenesWithKeywords, scriptContext, visualAnalysis, aiInstructions);
    let allMGs = mgResult.motionGraphics || mgResult;
    const mgStyle = mgResult.mgStyle || 'clean';
    const mapStyle = mgResult.mapStyle || 'dark';

    // Enforce maxMGs cap from quality tier
    const maxMGs = directorsBrief.tier.maxMGs;
    if (Number.isFinite(maxMGs) && allMGs.length > maxMGs) {
        const before = allMGs.length;
        // Preserve subscribeCTA if present, then take first N from the rest
        const ctaMG = allMGs.find(mg => mg.type === 'subscribeCTA');
        const rest = allMGs.filter(mg => mg.type !== 'subscribeCTA');
        const kept = rest.slice(0, ctaMG ? maxMGs - 1 : maxMGs);
        if (ctaMG) kept.push(ctaMG);
        allMGs = kept;
        console.log(`   📊 MG cap: ${before} → ${allMGs.length} (${directorsBrief.qualityTier} tier, max ${maxMGs})`);
    }

    // Split MGs: overlay types stay in motionGraphics, full-screen types become V3 scenes
    const motionGraphics = allMGs.filter(mg => mg.category !== 'fullscreen');
    const fullscreenMGs = allMGs.filter(mg => mg.category === 'fullscreen');

    // Convert full-screen MGs into scene-like objects for V3
    const mgScenes = fullscreenMGs.map((mg, i) => ({
        ...mg,
        isMGScene: true,
        trackId: 'video-track-3',
        mediaType: 'motion-graphic',
        endTime: mg.startTime + mg.duration,
        keyword: `MG: ${mg.type}`,
    }));

    // Tag each scene with its original download index (for file copying after carving)
    scenesWithMedia.forEach((scene, i) => { scene._fileIndex = i; });

    // Carve out gaps in V2 scenes where full-screen MGs exist
    // Full-screen MGs ARE the visual — no footage should play underneath
    if (mgScenes.length > 0) {
        const mgRanges = mgScenes.map(mg => ({ start: mg.startTime, end: mg.endTime }));
        let carved = [];
        for (const scene of scenesWithMedia) {
            let parts = [{ startTime: scene.startTime, endTime: scene.endTime }];
            for (const range of mgRanges) {
                const newParts = [];
                for (const part of parts) {
                    if (range.start >= part.endTime || range.end <= part.startTime) {
                        // No overlap — keep as is
                        newParts.push(part);
                    } else if (range.start <= part.startTime && range.end >= part.endTime) {
                        // Fully covered — remove (skip)
                    } else if (range.start > part.startTime && range.end < part.endTime) {
                        // MG in the middle — split into two parts
                        newParts.push({ startTime: part.startTime, endTime: range.start });
                        newParts.push({ startTime: range.end, endTime: part.endTime });
                    } else if (range.start <= part.startTime) {
                        // MG covers the start — trim left
                        newParts.push({ startTime: range.end, endTime: part.endTime });
                    } else {
                        // MG covers the end — trim right
                        newParts.push({ startTime: part.startTime, endTime: range.start });
                    }
                }
                parts = newParts;
            }
            // Create scene copies for surviving parts
            for (const part of parts) {
                if (part.endTime - part.startTime < 0.3) continue; // skip tiny fragments
                const trimmedScene = { ...scene };
                const offsetFromOriginal = part.startTime - scene.startTime;
                trimmedScene.startTime = part.startTime;
                trimmedScene.endTime = part.endTime;
                trimmedScene.duration = part.endTime - part.startTime;
                if (offsetFromOriginal > 0) {
                    trimmedScene.mediaOffset = (scene.mediaOffset || 0) + offsetFromOriginal;
                }
                carved.push(trimmedScene);
            }
        }
        const removed = scenesWithMedia.length - carved.length;
        scenesWithMedia = carved;
        if (removed > 0) console.log(`   🔪 Carved ${removed} scene(s) to make room for full-screen MGs`);
    }

    console.log(`   ✅ Placed ${allMGs.length} motion graphics (style: ${mgStyle})`);
    if (mgScenes.length > 0) console.log(`      → ${mgScenes.length} full-screen (V3), ${motionGraphics.length} overlay (MG track)`);
    console.log('');

    // Step 6.05: Download animated background icons (if any animatedIcons MGs exist)
    const iconMGs = allMGs.filter(mg => mg.type === 'animatedIcons');
    if (iconMGs.length > 0) {
        console.log('═'.repeat(60));
        console.log('🎯 Step 6.05: Background Icons');
        console.log('═'.repeat(60));
        try {
            const { downloadAllIcons } = require('./icon-provider');
            const iconCount = await downloadAllIcons(iconMGs, config.paths.temp);
            console.log(`   ✅ Downloaded ${iconCount} icons for ${iconMGs.length} scenes`);
        } catch (e) {
            console.log(`   ⚠️ Icon download failed: ${e.message} (skipping)`);
        }
        console.log('');
    }

    // Step 6.9: Search for article images (if articleHighlight MG exists)
    const hasArticleMG = mgScenes.some(mg => mg.type === 'articleHighlight');
    if (hasArticleMG) {
        console.log('📰 Step 6.9: Searching for article images...');
        try {
            const articleResult = await processArticleImages(mgScenes);
            if (articleResult) {
                const mg = mgScenes[articleResult.mgIndex];
                mg.articleImageFile = articleResult.filename;

                // Use AI Vision to find headline bounding box
                const boxes = await analyzeArticleHighlights(articleResult.filePath);
                if (boxes.length > 0) {
                    mg.highlightBoxes = boxes;
                }

                console.log(`   ✅ Article image ready: ${articleResult.filename}${mg.highlightBoxes ? ' (headline highlight found)' : ''}\n`);
            } else {
                console.log('   ℹ️ No article image found, will use HTML card fallback\n');
            }
        } catch (error) {
            console.log(`   ⚠️ Article image step failed: ${error.message}`);
            console.log('   ℹ️ Continuing with HTML card fallback\n');
        }
    }

    // Step 6.95: Download background canvas for theme
    let backgroundCanvasFile = null;
    let backgroundOpacity = null;
    const bgThemeId = scriptContext?.themeId || 'neutral';
    try {
        const bgPath = await downloadBackgroundCanvas(bgThemeId);
        if (bgPath && fs.existsSync(bgPath)) {
            backgroundCanvasFile = `bg-canvas-${bgThemeId}.mp4`;
            // Get opacity from theme background config
            const { getBackgroundSource } = require('./themes');
            const bgSource = getBackgroundSource(bgThemeId);
            backgroundOpacity = bgSource?.opacity ?? 0.15;
            console.log(`   ✅ Background canvas: ${backgroundCanvasFile} (opacity ${backgroundOpacity})\n`);
        }
    } catch (error) {
        console.log(`   ⚠️ Background canvas skipped: ${error.message}\n`);
    }

    // Assign final scene indices (after carving, these match the file names scene-0, scene-1, etc.)
    scenesWithMedia.forEach((scene, i) => { scene.index = i; });

    // Step 7: Create video plan
    console.log('📋 Step 7: Creating video plan...');
    const videoPlan = {
        audio: audioFile,
        totalDuration: actualAudioDuration,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
        scenes: scenesWithMedia,
        mgScenes: mgScenes,
        motionGraphics: motionGraphics,
        mgStyle: mgStyle,
        mapStyle: mapStyle,
        scriptContext: scriptContext,
        visualAnalysis: visualAnalysis,
        ...(backgroundCanvasFile ? {
            backgroundCanvas: backgroundCanvasFile,
            backgroundOpacity: backgroundOpacity,
            themeId: bgThemeId,
        } : {})
    };

    const planPath = path.join(config.paths.temp, 'video-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(videoPlan, (k, v) => k === '_fileIndex' ? undefined : v, 2));
    console.log(`   ✅ Plan saved\n`);

    // Step 8: Copy files to public folder
    console.log('📂 Step 8: Copying files to public folder...');
    const publicDir = path.join(PROJECT_DIR, 'public');

    // Ensure public folder exists
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
    }

    // Copy video plan
    fs.copyFileSync(planPath, path.join(publicDir, 'video-plan.json'));

    // Copy audio file
    fs.copyFileSync(
        path.join(config.paths.input, audioFile),
        path.join(publicDir, audioFile)
    );

    // Copy media files (videos and images)
    // After gap-carving, scenes may have different indices than their source files
    // Use _fileIndex (original download index) for source, array position for destination
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        const ext = scene.mediaExtension || '.mp4';
        const srcIdx = scene._fileIndex !== undefined ? scene._fileIndex : i;
        const srcMedia = path.join(config.paths.temp, `scene-${srcIdx}${ext}`);
        const destMedia = path.join(publicDir, `scene-${i}${ext}`);
        if (fs.existsSync(srcMedia)) {
            fs.copyFileSync(srcMedia, destMedia);
        }
        // Update scene index to match destination file name
        scene.index = i;
        delete scene._fileIndex;
    }
    // Copy article image files (for articleHighlight image mode)
    for (const mg of mgScenes) {
        if (mg.articleImageFile) {
            const srcArticle = path.join(config.paths.temp, mg.articleImageFile);
            const destArticle = path.join(publicDir, mg.articleImageFile);
            if (fs.existsSync(srcArticle)) {
                fs.copyFileSync(srcArticle, destArticle);
                console.log(`   📰 Copied article image: ${mg.articleImageFile}`);
            }
        }
    }

    // Copy SFX files to public folder
    const sfxDir = path.join(__dirname, '..', 'assets', 'sfx');
    if (fs.existsSync(sfxDir)) {
        const sfxFiles = fs.readdirSync(sfxDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
        for (const sfxFile of sfxFiles) {
            fs.copyFileSync(path.join(sfxDir, sfxFile), path.join(publicDir, sfxFile));
        }
        if (sfxFiles.length > 0) console.log(`   🔊 Copied ${sfxFiles.length} SFX files`);
    }

    // Copy background pattern files referenced by scenes
    const bgDir = path.join(__dirname, '..', 'assets', 'backgrounds');
    const bgFilesCopied = new Set();
    for (const scene of scenesWithMedia) {
        if (scene.background && scene.background.startsWith('pattern:')) {
            const bgFilename = scene.background.replace('pattern:', '');
            if (!bgFilesCopied.has(bgFilename)) {
                const srcBg = path.join(bgDir, bgFilename);
                const destBg = path.join(publicDir, `bg-${bgFilename}`);
                if (fs.existsSync(srcBg)) {
                    fs.copyFileSync(srcBg, destBg);
                    bgFilesCopied.add(bgFilename);
                }
            }
        }
    }
    if (bgFilesCopied.size > 0) console.log(`   🖼️ Copied ${bgFilesCopied.size} background pattern files`);

    // Copy background canvas video if available
    if (backgroundCanvasFile) {
        const bgCanvasSrc = path.join(__dirname, '..', 'assets', 'backgrounds', `${bgThemeId}.mp4`);
        if (fs.existsSync(bgCanvasSrc)) {
            fs.copyFileSync(bgCanvasSrc, path.join(publicDir, backgroundCanvasFile));
            console.log(`   🎨 Copied background canvas: ${backgroundCanvasFile}`);
        }
    }

    // Copy animated icon SVGs
    let iconsCopied = 0;
    for (const mg of allMGs) {
        if (mg.type === 'animatedIcons' && mg.icons) {
            for (const icon of mg.icons) {
                if (icon.file) {
                    const srcIcon = path.join(config.paths.temp, icon.file);
                    const destIcon = path.join(publicDir, icon.file);
                    if (fs.existsSync(srcIcon)) {
                        fs.copyFileSync(srcIcon, destIcon);
                        iconsCopied++;
                    }
                }
            }
        }
    }
    if (iconsCopied > 0) console.log(`   🎯 Copied ${iconsCopied} icon SVGs`);

    console.log(`   ✅ Files copied to public folder\n`);

    // Done!
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('🎬 ==========================================');
    console.log('✅ BUILD COMPLETE!');
    console.log('🎬 ==========================================\n');
    console.log(`⏱️  Total time: ${elapsed} seconds`);
    console.log(`🎵 Audio: ${audioFile}`);
    console.log(`⏱️  Duration: ${videoPlan.totalDuration.toFixed(2)} seconds`);
    console.log(`🎬 Scenes: ${scenes.length}`);
    console.log('\n📊 Keywords used:');
    scenesWithMedia.forEach((scene, i) => {
        const type = scene.mediaType === 'image' ? '🖼️' : '🎥';
        const source = scene.sourceProvider || 'unknown';
        console.log(`   Scene ${i}: "${scene.keyword}" ${type} [${source}]`);
    });

    console.log('\n🚀 Next steps:');
    console.log('   Preview: npx remotion preview');
    console.log('   Render:  npx remotion render FacelessVideo output/video.mp4');
    console.log('');
}

// Run
buildVideo().catch(error => {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
});
