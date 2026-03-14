const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const { transcribeAudio } = require('./transcribe');
// NEW: Smart AI modules (Phase 1 & 2)
const { createDirectorsBrief } = require('./directors-brief');
const { analyzeAndCreateScenes } = require('./ai-director');
const { planVisuals } = require('./ai-visual-planner');
const { planCompositorOverlays } = require('./ai-compositor-planner');
// Existing modules
const { analyzeSceneVisuals, analyzeSingleScene, createDefaultAnalysis, analyzeArticleHighlights } = require('./ai-vision');
const { processArticleImages } = require('./article-image');
const { processMotionGraphics, FULLSCREEN_MG_TYPES } = require('./ai-motion-graphics');
const { downloadAllMedia, retryPoorMedia } = require('./footage-manager');
const { loadRecipe } = require('./recipe-loader');
const log = require('./logger');

// Clean a folder of old build artifacts — removes ALL media and plan files
function cleanFolder(folderPath, label) {
    if (!fs.existsSync(folderPath)) return;
    const files = fs.readdirSync(folderPath);
    let cleaned = 0;
    const mediaExts = new Set(['.mp4', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.webm', '.mov', '.mkv', '.mp3', '.wav']);
    for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (mediaExts.has(ext) || file === 'video-plan.json') {
            try {
                fs.unlinkSync(path.join(folderPath, file));
                cleaned++;
            } catch (e) { /* ignore locked files */ }
        }
    }
    if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} old files from ${label}`);
}

// ====================================================================
// DUMB MODE: No AI, uses Whisper segments + random keywords/MGs
// ====================================================================
async function buildDumbVideo(transcription, audioFile, directorsBrief) {
    const { downloadAllMedia } = require('./footage-manager');
    const { createDefaultAnalysis } = require('./ai-vision');
    const { assignTransitions } = require('./ai-director');

    const fps = config.video.fps;
    const segments = transcription.segments || [];
    const audioDuration = transcription.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    // Build scenes from Whisper segments
    console.log('📝 Creating scenes from Whisper segments...');
    const scenes = segments.map((seg, i) => ({
        index: i,
        text: seg.text.trim(),
        startTime: seg.start,
        endTime: seg.end,
        duration: Math.round((seg.end - seg.start) * fps),
        words: seg.words || []
    }));
    // Extend last scene to audio end
    if (scenes.length > 0 && audioDuration > scenes[scenes.length - 1].endTime + 0.3) {
        scenes[scenes.length - 1].endTime = audioDuration;
        scenes[scenes.length - 1].duration = Math.round((audioDuration - scenes[scenes.length - 1].startTime) * fps);
    }
    console.log(`   ✅ ${scenes.length} scenes from Whisper\n`);

    // Generate simple keywords from scene text (extract 2-3 key words)
    console.log('🔑 Generating keywords from text...');
    const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','shall','should','may','might','must','can','could','and','but','or','nor','for','yet','so','in','on','at','to','from','by','with','of','it','its','this','that','these','those','i','you','he','she','we','they','me','him','her','us','them','my','your','his','our','their','not','no','if','then','than','as','just','also','very','really','about','up','out','into','over','after','before']);
    for (const scene of scenes) {
        const words = scene.text.replace(/[^\w\s]/g, '').toLowerCase().split(/\s+/)
            .filter(w => w.length > 3 && !stopWords.has(w));
        const unique = [...new Set(words)].slice(0, 3);
        scene.keyword = unique.join(' ') || 'abstract background';
        scene.mediaType = 'video';
        scene.sourceHint = 'stock';
        scene.framing = 'fullscreen';
        scene.backgroundId = 'none';
        scene.background = 'none';
    }
    console.log(`   ✅ Keywords assigned\n`);

    // Assign random transitions
    console.log('🎬 Assigning random transitions...');
    const defaultContext = { pacing: 'moderate' };
    assignTransitions(scenes, defaultContext);
    console.log('');

    // Download media (no vision AI)
    console.log('═'.repeat(60));
    console.log('🎥 Downloading Media (no vision analysis)');
    console.log('═'.repeat(60));
    const downloadResult = await downloadAllMedia(scenes, defaultContext, {
        inlineVision: false,
        skipVisionAI: true
    });
    let scenesWithMedia = downloadResult.scenes;

    // Generate random MGs (simple overlay types only)
    console.log('\n═'.repeat(60));
    console.log('✨ Generating Random Motion Graphics');
    console.log('═'.repeat(60));
    const overlayTypes = ['lowerThird', 'headline', 'callout', 'focusWord', 'statCounter'];
    const motionGraphics = [];
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        // ~60% chance of getting an MG
        if (Math.random() > 0.6) continue;
        const type = overlayTypes[Math.floor(Math.random() * overlayTypes.length)];
        const dur = scene.endTime - scene.startTime;
        if (dur < 1.5) continue;

        // Extract a short phrase from scene text for MG content
        const mgText = scene.text.split(/[,.!?]/).filter(s => s.trim().length > 3)[0]?.trim() || scene.text.substring(0, 30);

        motionGraphics.push({
            type,
            text: mgText.substring(0, 40),
            subtext: '',
            startTime: scene.startTime + 0.3,
            duration: Math.min(dur - 0.5, 3),
            endTime: scene.startTime + 0.3 + Math.min(dur - 0.5, 3),
            position: ['bottom-left', 'bottom-right', 'center'][Math.floor(Math.random() * 3)],
            sceneIndex: i,
            category: 'overlay',
            style: 'clean'
        });
    }
    console.log(`   ✅ Placed ${motionGraphics.length} random MGs\n`);

    // Create default visual analysis
    const visualAnalysis = scenes.map((_, i) => createDefaultAnalysis(i));

    // Assign final indices
    scenesWithMedia.forEach((scene, i) => { scene._fileIndex = i; scene.index = i; });

    // Build video plan
    console.log('📋 Creating video plan...');
    const scriptContext = {
        summary: scenes[0]?.text?.substring(0, 80) || '',
        theme: '', tone: '', mood: '', pacing: 'moderate', visualStyle: 'cinematic',
        entities: [], keyStats: [], mainPoints: [], targetAudience: '', emotionalArc: '',
        format: 'documentary', sections: [],
        ctaDetected: false, ctaStartTime: null, hookEndTime: null,
        densityTarget: 3, nicheId: 'general', themeId: 'neutral'
    };

    const videoPlan = {
        audio: audioFile,
        totalDuration: audioDuration,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
        scenes: scenesWithMedia,
        mgScenes: [],
        motionGraphics,
        mgStyle: 'clean',
        mapStyle: 'dark',
        scriptContext,
        visualAnalysis
    };

    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
    const publicDir = path.join(PROJECT_DIR, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    // Save plan
    const planPath = path.join(config.paths.temp, 'video-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(videoPlan, (k, v) => k === '_fileIndex' ? undefined : v, 2));
    fs.copyFileSync(planPath, path.join(publicDir, 'video-plan.json'));

    // Copy audio
    fs.copyFileSync(
        path.join(config.paths.input, audioFile),
        path.join(publicDir, audioFile)
    );

    // Copy media files
    console.log('📂 Copying files to public folder...');
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        const ext = scene.mediaExtension || '.mp4';
        const srcIdx = scene._fileIndex !== undefined ? scene._fileIndex : i;
        const srcMedia = path.join(config.paths.temp, `scene-${srcIdx}${ext}`);
        const destName = `scene-${i}-asset${ext}`;
        const destMedia = path.join(publicDir, destName);
        if (fs.existsSync(srcMedia)) fs.copyFileSync(srcMedia, destMedia);
        scene.mediaFile = path.join(publicDir, destName);
        scene.index = i;
        delete scene._fileIndex;
    }

    // Copy SFX
    const sfxDir = path.join(__dirname, '..', 'assets', 'sfx');
    if (fs.existsSync(sfxDir)) {
        const sfxFiles = fs.readdirSync(sfxDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
        for (const sfxFile of sfxFiles) {
            fs.copyFileSync(path.join(sfxDir, sfxFile), path.join(publicDir, sfxFile));
        }
        if (sfxFiles.length > 0) log.dim(`🔊 Copied ${sfxFiles.length} SFX files`);
    }

    // Re-save plan with updated paths
    fs.writeFileSync(
        path.join(publicDir, 'video-plan.json'),
        JSON.stringify(videoPlan, null, 2)
    );
    console.log(`   ✅ Plan saved\n`);

    console.log('🎬 ==========================================');
    console.log('✅ DUMB BUILD COMPLETE! (0 AI credits used)');
    console.log('🎬 ==========================================\n');

    return videoPlan;
}

async function buildVideo() {
    log.banner('FACELESS VIDEO GENERATOR - AUTO BUILD');

    const startTime = Date.now();

    // Step 0: Clean old build artifacts
    log.step('🧹 Step 0: Cleaning old build files');
    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
    cleanFolder(path.join(PROJECT_DIR, 'public'), 'public');
    cleanFolder(config.paths.temp, 'temp');

    // Step 1: Find voiceover file + create Director's Brief
    log.step('📁 Step 1: Finding audio file');
    // Use explicit filename from UI if provided via env var
    const explicitAudio = process.env.BUILD_AUDIO_FILE;
    const inputFiles = fs.readdirSync(config.paths.input);
    const audioFile = explicitAudio
        ? inputFiles.find(f => f === explicitAudio)
        : inputFiles.find(f => f.endsWith('.mp3') || f.endsWith('.wav'));

    if (!audioFile) {
        log.fail('No audio file found in /input folder!');
        if (explicitAudio) log.info(`Expected: ${explicitAudio}`);
        log.info('💡 Add your voiceover.mp3 to the input folder and try again.');
        process.exit(1);
    }
    log.ok(`Found: ${audioFile}`);

    // Create Director's Brief (reads env vars: AI_INSTRUCTIONS, BUILD_FORMAT, BUILD_QUALITY_TIER, BUILD_AUDIENCE)
    const directorsBrief = createDirectorsBrief();
    const rawNiche = (process.env.BUILD_NICHE || 'auto').trim();
    log.substep('📋 Director\'s Brief:');
    log.kv('Format', `${directorsBrief.format} | Quality: ${directorsBrief.qualityTier} | Density: ${directorsBrief.tier.sceneDensity}/min`);
    log.kv('Niche', `${directorsBrief.nicheOverride}${rawNiche !== directorsBrief.nicheOverride ? ` (preset: ${rawNiche})` : ''} | Theme: ${directorsBrief.themeOverride}`);
    if (directorsBrief.presetPacing) log.kv('Pacing', directorsBrief.presetPacing);
    if (directorsBrief.freeInstructions) log.kv('Instructions', `"${directorsBrief.freeInstructions.substring(0, 80)}${directorsBrief.freeInstructions.length > 80 ? '...' : ''}"`);
    if (directorsBrief.audienceHint) log.kv('Audience', `"${directorsBrief.audienceHint}"`);
    log.br();

    // Step 2: Transcribe
    log.step('🎙️ Step 2: Transcribing audio');
    const audioPath = path.join(config.paths.input, audioFile);
    const transcription = await transcribeAudio(audioPath);

    // ====================================================================
    // DUMB MODE: Skip all AI calls, use Whisper segments + random stuff
    // ====================================================================
    const hasDumbFlag = process.argv.includes('--dumb');
    const smartAIEnv = (process.env.SMART_AI || '').trim().toLowerCase();
    const smartAI = !hasDumbFlag && smartAIEnv !== 'false' && smartAIEnv !== '0';
    log.kv('Smart AI', `${smartAI ? log.pc.green('ON') : log.pc.red('OFF')} (env="${process.env.SMART_AI}", flag=${hasDumbFlag})`);
    if (!smartAI) {
        log.warn('DUMB MODE — No AI credits used');
        log.divider();
        const dumbResult = await buildDumbVideo(transcription, audioFile, directorsBrief);
        return dumbResult;
    }

    // Step 3: AI Director — Scene creation + context analysis + format detection
    log.step('🎬 Step 3: AI Director (Scene Creation + Context Analysis)');
    const { scenes, scriptContext } = await analyzeAndCreateScenes(transcription, directorsBrief);
    log.ok(`Created ${scenes.length} scenes with rich context`);
    log.br();
    const actualAudioDuration = transcription.duration || (transcription.segments.length > 0 ? transcription.segments[transcription.segments.length - 1].end : 0);

    // Step 4: Visual Planning — Batch keywords + media type + source hints
    log.step('🎨 Step 4: Visual Planner (Batch Keyword Generation)');
    const scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    // Load genre recipe if available (auto-detects from content or BUILD_RECIPE env var)
    const recipeResult = loadRecipe(scriptContext, directorsBrief.freeInstructions);
    if (recipeResult.recipe) {
        log.ok(`Genre recipe loaded: ${recipeResult.recipe.niche}`);
    }

    // Merge recipe prompt with user instructions — flows to all downstream AI modules
    const aiInstructions = [directorsBrief.freeInstructions, recipeResult.promptText].filter(Boolean).join('\n\n');

    // Step 4.7: Compositor Planner — plan V2 image overlays & explainer cards
    log.step('🎭 Step 4.7: Compositor Planner (V2 Overlays & Explainers)');
    const nicheId = scriptContext.nicheId || 'general';
    const compositorPlan = await planCompositorOverlays(scenesWithKeywords, scriptContext, nicheId);
    const { v2Scenes: plannedV2Scenes, explainerMGs: compositorExplainers } = compositorPlan;

    // Step 4.5: Perplexity Research (optional — enriches keywords with real-world sources)
    if (config.perplexity?.apiKey) {
        log.step('🔬 Step 4.5: Media Research (Perplexity)');
        try {
            const { researchSceneMedia } = require('./ai-research');
            await researchSceneMedia(scenesWithKeywords, scriptContext);
        } catch (error) {
            log.warn(`Research step failed: ${error.message} (continuing without)`);
            log.br();
        }
    }

    // Step 5: Download media (videos + images from multiple providers)
    log.step('🎥 Step 5: Downloading Media');
    // TEMPORARY: Force skip vision AI to save API credits while testing themes
    const skipVisionAI = true; // was: directorsBrief.tier.skipVisionAI
    const downloadResult = await downloadAllMedia(scenesWithKeywords, scriptContext, {
        inlineVision: true,
        skipVisionAI
    });
    let scenesWithMedia = downloadResult.scenes;
    let inlineVisualAnalysis = downloadResult.visualAnalysis;

    // Step 5.05: Download V2 overlay images (from compositor planner)
    if (plannedV2Scenes.length > 0) {
        log.step('📸 Step 5.05: Downloading V2 Overlay Images');
        let v2Downloaded = 0;
        for (let i = 0; i < plannedV2Scenes.length; i++) {
            const v2 = plannedV2Scenes[i];
            const v2Keyword = v2.keyword;
            const v2Filename = `v2-overlay-${i}`;
            try {
                // Download as image using web-image source hint
                const v2Scene = {
                    index: v2Filename,
                    keyword: v2Keyword,
                    mediaType: 'image',
                    sourceHint: 'web-image',
                    text: v2.label || v2Keyword,
                };
                const v2Result = await downloadAllMedia([v2Scene], scriptContext, {
                    inlineVision: false,
                    skipVisionAI: true
                });
                if (v2Result.scenes && v2Result.scenes[0]) {
                    const downloaded = v2Result.scenes[0];
                    v2.mediaFile = downloaded.mediaFile;
                    v2.mediaExtension = downloaded.mediaExtension || '.jpg';
                    v2.mediaWidth = downloaded.mediaWidth;
                    v2.mediaHeight = downloaded.mediaHeight;
                    v2.sourceProvider = downloaded.sourceProvider;
                    v2._fileIndex = v2Filename;
                    v2Downloaded++;
                    log.provider(v2.sourceProvider || 'unknown', 'ok', `V2 ${i}: "${v2Keyword}"`);
                }
            } catch (e) {
                log.provider('download', 'fail', `V2 ${i}: "${v2Keyword}" — ${e.message}`);
            }
        }
        // Remove V2 scenes that failed to download
        const validV2 = plannedV2Scenes.filter(v2 => v2.mediaFile);
        plannedV2Scenes.length = 0;
        plannedV2Scenes.push(...validV2);
        log.ok(`Downloaded ${v2Downloaded}/${plannedV2Scenes.length + (validV2.length - v2Downloaded)} V2 overlay images`);
        log.br();
    }

    // Step 5.1: Auto-detect aspect ratios + apply AI framing decisions
    log.step('📐 Step 5.1: Aspect Ratio & Framing');
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
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (${label}, ratio ${ratio.toFixed(2)}) → contain + blur`);
            } else if (scene.framing === 'cinematic') {
                // AI recommended cinematic framing — pull back with styled background
                const cinematicScale = parseFloat(process.env.CINEMATIC_SCALE) || 0.65;
                scene.fitMode = 'cover';
                scene.scale = cinematicScale;
                // Keep AI's background choice (blur, gradient:id, or pattern:file)
                if (!scene.background || scene.background === 'none') {
                    scene.background = 'blur'; // Fallback if AI didn't set one
                }
                scene.posX = 0;
                scene.posY = 0;
                cinematicCount++;
                log.dim(`🎬 Scene ${scene.index}: ${w}x${h} (cinematic) → scale ${cinematicScale} + ${scene.background}`);
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
        log.ok(`${autoContainCount} auto-contained (non-widescreen) + ${cinematicCount} cinematic (AI-descaled)`);
    } else {
        log.ok('All scenes fullscreen — no auto-framing needed');
    }
    log.br();

    // Step 5.5: Vision Analysis (already done inline with downloads)
    log.step('👁️ Step 5.5: Vision Analysis');
    let visualAnalysis = inlineVisualAnalysis || scenes.map((_, i) => createDefaultAnalysis(i));
    // Fill any gaps with defaults
    for (let i = 0; i < scenes.length; i++) {
        if (!visualAnalysis[i]) visualAnalysis[i] = createDefaultAnalysis(i);
    }
    if (skipVisionAI) {
        log.dim(`⏭️  Skipped (${directorsBrief.qualityTier} tier)`);
        log.br();
    } else {
        const analyzed = visualAnalysis.filter(r => r.description !== 'No visual analysis available').length;
        const poor = visualAnalysis.filter(r => r.suitability === 'poor').length;
        log.info(`📊 Vision analysis: ${analyzed}/${scenesWithMedia.length} analyzed (inline with downloads)`);
        if (poor > 0) log.warn(`${poor} scene(s) with poor footage match`);
        log.br();
    }

    // Step 5.6: Retry poor footage — keep searching providers until "good" found
    const poorScenes = visualAnalysis
        .map((va, i) => ({ va, i }))
        .filter(({ va }) => va.suitability === 'poor');

    if (poorScenes.length > 0 && !directorsBrief.tier.skipVisionAI) {
        log.step('🔄 Step 5.6: Retrying Poor Footage');

        const SUITABILITY_SCORE = { poor: 1, fair: 2, good: 3 };
        const MAX_SCENES = 5;          // Max scenes to retry (API cost control)
        const MAX_ATTEMPTS_PER_SCENE = 4; // Max provider attempts per scene
        const toRetry = poorScenes.slice(0, MAX_SCENES);

        log.info(`Found ${poorScenes.length} poor scene(s), retrying up to ${toRetry.length}...`);
        log.br();

        let improved = 0;
        for (const { va: originalAnalysis, i } of toRetry) {
            const scene = scenesWithMedia[i];
            if (!scene || !scene.keyword) continue;

            const sceneDuration = (scene.endTime || 0) - (scene.startTime || 0) || 10;
            log.info(`Scene ${i}: "${scene.keyword}" (was: ${log.pc.red(originalAnalysis.suitability)} — ${originalAnalysis.suitabilityReason})`);

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
                        log.warn('No more providers to try');
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

                    log.provider(retryResult.provider, 'ok', `Attempt ${attempt + 1}...`);
                    const newAnalysis = await analyzeSingleScene(retryScene, i, scriptContext);
                    const newScore = SUITABILITY_SCORE[newAnalysis.suitability] || 1;

                    log.dim(`   ${newAnalysis.suitability}: "${newAnalysis.description.substring(0, 55)}"`);

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
                        log.ok('Found good footage, stopping search');
                        break;
                    }
                } catch (retryError) {
                    log.provider('retry', 'fail', `Attempt ${attempt + 1}: ${retryError.message}`);
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

                log.ok(`Upgraded: ${log.pc.red(originalAnalysis.suitability)} → ${log.pc.green(bestAnalysis.suitability)} [${bestResult.provider}]`);
            } else {
                // Clean up any leftover retry file
                if (bestResult && fs.existsSync(bestResult.path)) {
                    fs.unlinkSync(bestResult.path);
                }
                log.dim('↩️ Kept original (no better footage found)');
            }
        }

        if (improved > 0) {
            log.ok(`Improved ${improved}/${toRetry.length} scene(s)`);
        } else {
            log.dim('No improvements found — keeping original footage');
        }
        log.br();
    }

    // Step 5.7: Image-to-MP4 conversion (DISABLED — images sanitized to PNG at download time)

    // Step 6: AI Motion Graphics (now with both script context AND visual analysis)
    log.step('✨ Step 6: AI Motion Graphics');
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
        log.info(`📊 MG cap: ${before} → ${allMGs.length} (${directorsBrief.qualityTier} tier, max ${maxMGs})`);
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
        if (removed > 0) log.info(`🔪 Carved ${removed} scene(s) to make room for full-screen MGs`);
    }

    log.ok(`Placed ${allMGs.length} motion graphics (style: ${log.pc.cyan(mgStyle)})`);
    if (mgScenes.length > 0) {
        log.info(`→ ${mgScenes.length} full-screen (V3), ${motionGraphics.length} overlay (MG track)`);
        for (const mg of mgScenes) {
            log.dim(`🎨 [${mg.type}] "${mg.text || ''}" @ ${mg.startTime.toFixed(1)}s-${mg.endTime.toFixed(1)}s`);
        }
    }
    log.br();

    // Merge compositor planner explainer MGs into the MG pipeline
    if (compositorExplainers.length > 0) {
        allMGs.push(...compositorExplainers);
        motionGraphics.push(...compositorExplainers);
        log.ok(`Merged ${compositorExplainers.length} compositor explainer(s) into MG pipeline`);
    }

    // Step 6.05: Download explainer images (search + bg removal)
    const explainerMGs = allMGs.filter(mg => mg.type === 'explainer');
    if (explainerMGs.length > 0) {
        log.step('🖼️ Step 6.05: Explainer Images');
        try {
            const { downloadExplainerImages } = require('./explainer-image-provider');
            const count = await downloadExplainerImages(explainerMGs, config.paths.temp, scriptContext);
            log.ok(`Processed ${count}/${explainerMGs.length} explainer images`);
        } catch (e) {
            log.warn(`Explainer image download failed: ${e.message} (skipping)`);
        }
        log.br();
    }

    // Step 6.06: Download static map images for mapChart MGs (via MapTiler API)
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length > 0) {
        log.step('🗺️ Step 6.06: Map Images');
        try {
            const { downloadMapsForMGs } = require('./map-provider');
            const mapCount = await downloadMapsForMGs(allMGs, scriptContext, config.paths.temp);
            if (mapCount > 0) {
                log.ok(`Downloaded ${mapCount} map image(s) for ${mapMGs.length} mapChart scene(s)`);
            } else {
                log.dim('No map images downloaded (will use Canvas2D fallback)');
            }
        } catch (e) {
            log.warn(`Map download failed: ${e.message} (will use Canvas2D fallback)`);
        }
        log.br();

        // Propagate mapImageFile + _mapView from allMGs to mgScenes (mgScenes are copies)
        for (const mg of fullscreenMGs) {
            if (mg.mapImageFile) {
                const target = mgScenes.find(s => s.type === mg.type && s.startTime === mg.startTime);
                if (target) {
                    target.mapImageFile = mg.mapImageFile;
                    target._mapView = mg._mapView;
                }
            }
        }
    }

    // Step 6.9: Search for article images (if articleHighlight MG exists)
    const hasArticleMG = mgScenes.some(mg => mg.type === 'articleHighlight');
    if (hasArticleMG) {
        log.substep('📰 Step 6.9: Article Images');
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

                log.ok(`Article image ready: ${articleResult.filename}${mg.highlightBoxes ? ' (headline highlight found)' : ''}`);
            } else {
                log.dim('No article image found, will use HTML card fallback');
            }
        } catch (error) {
            log.warn(`Article image step failed: ${error.message}`);
            log.dim('Continuing with HTML card fallback');
        }
        log.br();
    }

    // Step 6.95: (removed — backgroundCanvas was dead code, never rendered)

    // Assign final scene indices (after carving, these match the file names scene-0, scene-1, etc.)
    scenesWithMedia.forEach((scene, i) => { scene.index = i; });

    // Assign V2 overlay scene indices (after V1 scenes)
    const v2ScenesForPlan = plannedV2Scenes.filter(v2 => v2.mediaFile);
    v2ScenesForPlan.forEach((v2, i) => {
        v2.index = scenesWithMedia.length + i;
    });

    // Step 7: Create video plan
    log.step('📋 Step 7: Creating video plan');
    // Merge V1 + V2 scenes into a single array for the renderer
    const allScenes = [...scenesWithMedia, ...v2ScenesForPlan];
    if (v2ScenesForPlan.length > 0) {
        log.ok(`Merged ${v2ScenesForPlan.length} V2 overlay scenes into plan`);
    }

    const videoPlan = {
        audio: audioFile,
        totalDuration: actualAudioDuration,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
        scenes: allScenes,
        mgScenes: mgScenes,
        motionGraphics: motionGraphics,
        mgStyle: mgStyle,
        mapStyle: mapStyle,
        scriptContext: scriptContext,
        visualAnalysis: visualAnalysis,
        themeId: scriptContext?.themeId || 'neutral'
    };

    const planPath = path.join(config.paths.temp, 'video-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(videoPlan, (k, v) => k === '_fileIndex' ? undefined : v, 2));
    log.ok('Plan saved');
    log.br();

    // Step 8: Copy files to public folder
    log.step('📂 Step 8: Copying files to public folder');
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

    // Copy media files (videos and images) with asset naming convention
    // After gap-carving, scenes may have different indices than their source files
    // Use _fileIndex (original download index) for source, array position for destination
    for (let i = 0; i < scenesWithMedia.length; i++) {
        const scene = scenesWithMedia[i];
        const ext = scene.mediaExtension || '.mp4';
        const srcIdx = scene._fileIndex !== undefined ? scene._fileIndex : i;
        const srcMedia = path.join(config.paths.temp, `scene-${srcIdx}${ext}`);
        const destName = `scene-${i}-asset${ext}`;
        const destMedia = path.join(publicDir, destName);
        if (fs.existsSync(srcMedia)) {
            fs.copyFileSync(srcMedia, destMedia);
        }
        // Update scene to reference public path
        scene.mediaFile = path.join(publicDir, destName);
        scene.index = i;
        delete scene._fileIndex;
    }
    // Copy V2 overlay images
    for (let i = 0; i < v2ScenesForPlan.length; i++) {
        const v2 = v2ScenesForPlan[i];
        if (v2.mediaFile && fs.existsSync(v2.mediaFile)) {
            const ext = v2.mediaExtension || '.jpg';
            const destName = `v2-overlay-${i}-asset${ext}`;
            const destPath = path.join(publicDir, destName);
            fs.copyFileSync(v2.mediaFile, destPath);
            v2.mediaFile = path.join(publicDir, destName);
            log.dim(`📸 Copied V2 overlay: ${destName}`);
        }
        delete v2._fileIndex;
    }

    // Copy article image files (for articleHighlight image mode)
    // Copy map image files (for mapChart API mode)
    for (const mg of mgScenes) {
        if (mg.articleImageFile) {
            const srcArticle = path.join(config.paths.temp, mg.articleImageFile);
            const destArticle = path.join(publicDir, mg.articleImageFile);
            if (fs.existsSync(srcArticle)) {
                fs.copyFileSync(srcArticle, destArticle);
                log.dim(`📰 Copied article image: ${mg.articleImageFile}`);
            }
        }
        if (mg.mapImageFile) {
            const srcMap = path.join(config.paths.temp, mg.mapImageFile);
            const destMap = path.join(publicDir, mg.mapImageFile);
            if (fs.existsSync(srcMap)) {
                fs.copyFileSync(srcMap, destMap);
                log.dim(`🗺️ Copied map image: ${mg.mapImageFile}`);
            }
        }
    }
    // Also check overlay MGs for map images
    for (const mg of motionGraphics) {
        if (mg.mapImageFile) {
            const srcMap = path.join(config.paths.temp, mg.mapImageFile);
            const destMap = path.join(publicDir, mg.mapImageFile);
            if (fs.existsSync(srcMap)) {
                fs.copyFileSync(srcMap, destMap);
                log.dim(`🗺️ Copied map image: ${mg.mapImageFile}`);
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
        if (sfxFiles.length > 0) log.dim(`🔊 Copied ${sfxFiles.length} SFX files`);
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
    if (bgFilesCopied.size > 0) log.dim(`🖼️ Copied ${bgFilesCopied.size} background pattern files`);

    // Copy explainer transparent PNGs
    let explainersCopied = 0;
    for (const mg of allMGs) {
        if (mg.type === 'explainer' && mg.explainerImageFile) {
            const srcImg = path.join(config.paths.temp, mg.explainerImageFile);
            const destImg = path.join(publicDir, mg.explainerImageFile);
            if (fs.existsSync(srcImg)) {
                fs.copyFileSync(srcImg, destImg);
                explainersCopied++;
            }
        }
    }
    if (explainersCopied > 0) log.dim(`🖼️ Copied ${explainersCopied} explainer images`);

    log.ok('Files copied to public folder');

    // Re-save video plan with updated public mediaFile paths
    fs.writeFileSync(
        path.join(publicDir, 'video-plan.json'),
        JSON.stringify(videoPlan, null, 2)
    );
    log.ok('Updated video-plan.json with public paths');
    log.br();

    // Done!
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    log.banner('BUILD COMPLETE!');
    log.timing('Total time', elapsed);
    log.kv('Audio', audioFile);
    log.kv('Duration', `${videoPlan.totalDuration.toFixed(2)} seconds`);
    log.kv('Scenes', `${scenesWithMedia.length} footage + ${mgScenes.length} full-screen MG + ${v2ScenesForPlan.length} V2 overlays`);
    log.br();
    log.substep('📊 All scenes (timeline order):');
    log.divider();
    // Merge footage + MG + V2 scenes and sort by startTime for unified log
    const allScenesSorted = [
        ...scenesWithMedia.map((s, i) => ({ ...s, _logIdx: i, _kind: 'footage' })),
        ...mgScenes.map((s, i) => ({ ...s, _logIdx: i, _kind: 'mg' })),
        ...v2ScenesForPlan.map((s, i) => ({ ...s, _logIdx: i, _kind: 'v2' })),
    ].sort((a, b) => a.startTime - b.startTime);
    allScenesSorted.forEach((scene, i) => {
        if (scene._kind === 'mg') {
            log.scene(i, 'mg', `[${scene.type}] "${scene.text || ''}"`, '');
        } else if (scene._kind === 'v2') {
            log.scene(i, 'v2', scene.keyword, '');
        } else {
            log.scene(i, scene.mediaType === 'image' ? 'image' : 'video', scene.keyword, scene.sourceProvider || 'unknown');
        }
    });
    log.divider();

    log.br();
    log.info(`🚀 Open the app and use the WebGL2 renderer to render your video.`);
    log.br();
}

// Run
buildVideo().catch(error => {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
});
