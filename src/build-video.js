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
const { processMotionGraphics, FULLSCREEN_MG_TYPES } = require('./ai-motion-graphics');
const { processTemplates, downloadTemplateBackgrounds, downloadTemplateItemImages, TEMPLATE_TYPES } = require('./ai-templates');
const { downloadAllMedia } = require('./footage-manager');
const clipAnalyzer = require('./clip-analyzer');
// const { loadRecipe } = require('./recipe-loader'); // Disabled — recipes caused wrong genre detection
const { preBuildReview, midBuildValidation, postBuildReview } = require('./build-orchestrator');
const log = require('./logger');

// Clean a folder of old build artifacts — removes ALL media and plan files
function cleanFolder(folderPath, label) {
    if (!fs.existsSync(folderPath)) return;
    const files = fs.readdirSync(folderPath);
    let cleaned = 0;
    const mediaExts = new Set(['.mp4', '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.webm', '.mov', '.mkv', '.mp3', '.wav']);

    // Resume detection: if scene-N.mp4/jpg files already exist, this is a restart of a
    // cancelled build — preserve downloaded scenes so footage-manager can skip them.
    const hasSceneFiles = files.some(f => /^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(f));
    if (hasSceneFiles && label === 'temp') {
        // Only clean non-scene files (MG pre-renders, tmp files, etc.) — keep scene-N media
        for (const file of files) {
            if (/^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(file)) continue; // keep
            const ext = path.extname(file).toLowerCase();
            if (mediaExts.has(ext) || file === 'video-plan.json') {
                try { fs.unlinkSync(path.join(folderPath, file)); cleaned++; } catch (e) {}
            }
        }
        if (cleaned > 0) console.log(`   🧹 Cleaned ${cleaned} old files from ${label} (kept scene media for resume)`);
        console.log(`   ♻️  Resume mode: ${files.filter(f => /^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(f)).length} scene file(s) preserved`);
        return;
    }

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

    // Assign theme-driven transitions
    console.log('🎬 Assigning transitions...');
    const defaultContext = { pacing: 'moderate', themeId: 'standard' };
    assignTransitions(scenes, defaultContext);
    console.log('');

    // Download media (no vision AI)
    console.log('═'.repeat(60));
    console.log('🎥 Downloading Media (no vision analysis)');
    console.log('═'.repeat(60));
    const downloadResult = await downloadAllMedia(scenes, defaultContext);
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
        densityTarget: 3, nicheId: 'general', themeId: 'standard'
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
        scriptContext
    };

    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
    const publicDir = path.join(PROJECT_DIR, 'public');
    if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

    // Validate: fix any mediaType/mediaExtension contradictions before writing plan
    // (e.g. resume detection or provider errors can leave mediaType='image' + mediaExtension='.mp4')
    const _videoExts = new Set(['.mp4', '.webm', '.mov', '.mkv']);
    const _imageExts = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
    let _mediaTypeFixes = 0;
    for (const scene of videoPlan.scenes || []) {
        if (!scene.mediaExtension) continue;
        const ext = scene.mediaExtension.toLowerCase();
        if (_videoExts.has(ext) && scene.mediaType === 'image') {
            scene.mediaType = 'video'; _mediaTypeFixes++;
        } else if (_imageExts.has(ext) && scene.mediaType === 'video') {
            scene.mediaType = 'image'; _mediaTypeFixes++;
        }
    }
    if (_mediaTypeFixes > 0) console.log(`   ✅ Fixed ${_mediaTypeFixes} mediaType contradictions before writing plan`);

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

    // Re-link listicle grid thumbnails to updated public scene paths
    // Check both mgScenes (legacy) and templateScenes (new system)
    for (const container of [videoPlan.mgScenes, videoPlan.templateScenes]) {
        if (!container) continue;
        for (const mg of container) {
            if (mg.type === 'listicleGrid' && videoPlan.scriptContext?.listicleItems) {
                mg._itemThumbnails = videoPlan.scriptContext.listicleItems.map(item => {
                    const scene = scenesWithMedia[item.startSceneIndex];
                    return scene?.mediaFile || null;
                });
            }
        }
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
    if (directorsBrief.styleProfile) {
        const sp = directorsBrief.styleProfile;
        log.kv('🎨 Style Profile', `"${sp.name || 'unnamed'}"`);
        const detailParts = [];
        if (sp.pacing?.avgSceneDuration) detailParts.push(`avg ${sp.pacing.avgSceneDuration.toFixed(1)}s/scene`);
        if (sp.pacing?.cutsPerMinute)    detailParts.push(`${sp.pacing.cutsPerMinute} cuts/min`);
        if (sp.pacing?.rhythm)           detailParts.push(`${sp.pacing.rhythm} rhythm`);
        if (detailParts.length) log.kv('   pacing', detailParts.join(', '));
        const fParts = [];
        if (sp.footage?.stockVsReal)        fParts.push(sp.footage.stockVsReal);
        if (sp.footage?.videoToImageRatio)  fParts.push(`${Math.round(sp.footage.videoToImageRatio * 100)}% video`);
        if (sp.footage?.brollPattern)       fParts.push(`${sp.footage.brollPattern} broll`);
        if (fParts.length) log.kv('   footage', fParts.join(', '));
        const mgParts = [];
        if (sp.motionGraphics?.density)             mgParts.push(`${sp.motionGraphics.density} density`);
        if (sp.motionGraphics?.frequencyPerMinute)  mgParts.push(`${sp.motionGraphics.frequencyPerMinute}/min`);
        if (sp.motionGraphics?.preferredTypes?.length) mgParts.push(`prefer: ${sp.motionGraphics.preferredTypes.slice(0, 3).join('/')}`);
        if (mgParts.length) log.kv('   MG', mgParts.join(', '));
        const tParts = [];
        if (typeof sp.transitions?.cutRatio === 'number') tParts.push(`${Math.round(sp.transitions.cutRatio * 100)}% cuts`);
        if (sp.transitions?.avgTransitionDuration)        tParts.push(`avg ${sp.transitions.avgTransitionDuration}s`);
        if (tParts.length) log.kv('   transitions', tParts.join(', '));
        const eParts = [];
        if (sp.effects?.grain && sp.effects.grain !== 'none')         eParts.push(`grain:${sp.effects.grain}`);
        if (sp.effects?.vignette && sp.effects.vignette !== 'none')   eParts.push(`vignette:${sp.effects.vignette}`);
        if (sp.effects?.colorTemperature)                              eParts.push(sp.effects.colorTemperature);
        if (sp.effects?.contrastLevel)                                 eParts.push(`${sp.effects.contrastLevel} contrast`);
        if (eParts.length) log.kv('   effects', eParts.join(', '));
    }
    log.br();

    // Step 2: Transcribe
    log.step('🎙️ Step 2: Transcribing audio');
    const audioPath = path.join(config.paths.input, audioFile);

    // ── Language resolution ──
    // BUILD_LANGUAGE can be: a valid code ('en','es','de','fr','it','ko') to force it,
    // 'auto' (or empty) to auto-detect from Whisper, which is the default.
    const { resolveBuildLanguage, getWhisperLanguage } = require('./language-helper');
    const langOverride = (process.env.BUILD_LANGUAGE || 'auto').trim().toLowerCase();
    const hintCode = langOverride !== 'auto' ? getWhisperLanguage(langOverride) : null;
    if (hintCode) log.kv('Language override', `${langOverride} (hinting Whisper)`);
    else log.kv('Language', 'auto (Whisper will detect)');

    const transcription = await transcribeAudio(audioPath, { languageHint: hintCode });

    // Resolve the final build language: explicit override wins, else Whisper's detection,
    // else fall back to English. Stored on scriptContext so all downstream steps see it.
    const buildLanguage = resolveBuildLanguage(langOverride, transcription.language);
    log.kv('Build language', `${buildLanguage}${buildLanguage !== (transcription.language || 'en') && langOverride === 'auto' ? ' (unsupported auto-detect, falling back)' : ''}`);

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
    let { scenes, scriptContext } = await analyzeAndCreateScenes(transcription, directorsBrief);
    // Attach resolved language to scriptContext so ALL downstream AI steps + the renderer see it.
    // This is the single place language enters the scriptContext — no other code should set it.
    scriptContext.language = buildLanguage;
    // Attach reference style profile (loaded by directors-brief.js) so all downstream steps can read it.
    if (directorsBrief.styleProfile) {
        scriptContext.styleProfile = directorsBrief.styleProfile;
        scriptContext.styleBlock = directorsBrief.styleBlock;
    }
    log.ok(`Created ${scenes.length} scenes with rich context (lang=${buildLanguage})`);
    log.br();
    const actualAudioDuration = transcription.duration || (transcription.segments.length > 0 ? transcription.segments[transcription.segments.length - 1].end : 0);

    // Phase 0 (scene splitting) REMOVED — Director handles scene boundaries with full narrative context.
    // Blind duration-based splitting destroyed story beats and created unfindable keyword fragments.

    // Step 4: Visual Planning — Batch keywords + media type + source hints
    log.step('🎨 Step 4: Visual Planner (Batch Keyword Generation)');
    const scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    // DEBUG: Stop after Visual Planner for testing
    if (process.env.STOP_AFTER === 'visual-planner') {
        log.ok('=== STOP_AFTER=visual-planner — dumping results ===');
        for (const s of scenesWithKeywords) {
            log.info(`Scene ${s.index}: keyword="${s.keyword}" fx=${s.effectPreset || (s.effects||[]).join(',') || 'none'} mgHint=${s.mgHint || 'null'}`);
        }
        log.ok('Visual Planner test complete.');
        process.exit(0);
    }

    // Recipe system disabled — was mis-detecting genres (e.g. "listicle-history" for business videos)
    const aiInstructions = directorsBrief.freeInstructions || '';

    // Step 4.7: Compositor Planner — DISABLED (V2 overlay system needs rework)
    const nicheId = scriptContext.nicheId || 'general';
    const plannedV2Scenes = [];
    const compositorExplainers = [];

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

    // Promote mgHint → fullscreenMG when the hint is a fullscreen MG type
    // This prevents wasted footage downloads for scenes the MG engine will cover entirely
    const { FULLSCREEN_MG_TYPES: _FSMG } = require('./ai-motion-graphics');
    for (const s of scenesWithKeywords) {
        if (s.fullscreenMG) continue; // already set by VP
        if (!s.mgHint) continue;

        // Parse mgHint — format: "type: content" or just "type"
        const hintStr = String(s.mgHint).trim();
        const colonIdx = hintStr.indexOf(':');
        const hintType = colonIdx > 0 ? hintStr.substring(0, colonIdx).trim() : hintStr;

        if (_FSMG.has(hintType)) {
            s.fullscreenMG = s.mgHint;
            s.mgHint = null; // consumed — don't double-place
            // Clear download fields — this scene is now a fullscreen MG
            s.keyword = null;
            s.stockQuery = null;
            s.webQuery = null;
            s.mediaType = null;
            s.sourceHint = null;
            log.info(`   Scene ${s.index}: promoted mgHint "${hintType}" → fullscreenMG (saves a download)`);
        }
    }

    // Mark listicle overview scene as template early — saves a wasted footage download
    // The overview scene (scene before first item) will get a listicleGrid template in Step 6.5
    if (scriptContext.format === 'listicle' && scriptContext.listicleItems?.length > 0) {
        const firstItem = scriptContext.listicleItems.find(it => it.startSceneIndex != null);
        if (firstItem) {
            const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
            const overviewScene = scenesWithKeywords.find(s => s.index === overviewIdx);
            if (overviewScene && !overviewScene.fullscreenMG) {
                overviewScene.fullscreenMG = 'listicleGrid'; // keeps scene excluded from footage download
                overviewScene.templateType = 'listicleGrid'; // signals ai-templates.js ownership
                overviewScene.isListicleOverview = true;
                overviewScene.keyword = null;
                overviewScene.stockQuery = null;
                overviewScene.webQuery = null;
                overviewScene.mediaType = null;
                overviewScene.sourceHint = null;
                log.info(`   Scene ${overviewIdx}: marked as listicleGrid template — skipping footage download`);
            }
        }
    }

    // Pre-filter: clear fullscreenMG if the type isn't allowed in this niche
    // (prevents scenes from being skipped for footage download when the MG won't be rendered)
    const { getNiche } = require('./niches');
    const nicheConfig = getNiche(nicheId);
    const nicheAllowedMGs = nicheConfig.allowedMGs || [];
    for (const s of scenesWithKeywords) {
        if (!s.fullscreenMG) continue;
        const colonIdx = s.fullscreenMG.indexOf(':');
        const mgType = colonIdx > 0 ? s.fullscreenMG.substring(0, colonIdx).trim() : s.fullscreenMG.trim();
        if (nicheAllowedMGs.length > 0 && !nicheAllowedMGs.includes(mgType)) {
            log.warn(`Scene ${s.index}: fullscreenMG "${mgType}" not allowed in "${nicheConfig.name}" niche — will download footage instead`);
            s.fullscreenMG = null;
            // Restore download fields so footage manager can handle this scene
            if (!s.keyword || s.keyword === 'none') {
                s.keyword = s.visualIntent || s.text?.substring(0, 40) || 'abstract background';
            }
            if (!s.mediaType) s.mediaType = 'video';
            if (!s.sourceHint) s.sourceHint = 'stock';
        }
    }

    // ── Orchestrator Phase 1: Pre-Build AI Review ──
    log.step('🧠 Step 4.8: Orchestrator — Pre-Build Review');
    let buildManifest = null;
    try {
        const orchResult = await preBuildReview(scenesWithKeywords, scriptContext);
        buildManifest = orchResult.manifest;
        if (orchResult.changes.length > 0) {
            log.ok(`Orchestrator applied ${orchResult.changes.length} optimization(s)`);
        }
        if (orchResult.warnings.length > 0) {
            log.warn(`${orchResult.warnings.length} warning(s) — check log for details`);
        }
    } catch (error) {
        log.warn(`Orchestrator Phase 1 failed: ${error.message} — continuing without`);
    }
    log.br();

    // Separate fullscreenMG scenes (no footage needed) from footage scenes
    const fullscreenMGScenes = scenesWithKeywords.filter(s => s.fullscreenMG);
    const footageScenes = scenesWithKeywords.filter(s => !s.fullscreenMG);
    if (fullscreenMGScenes.length > 0) {
        log.ok(`${fullscreenMGScenes.length} scene(s) planned as fullscreen MGs — skipping footage download`);
        for (const s of fullscreenMGScenes) {
            log.dim(`   Scene ${s.index}: ${s.fullscreenMG}`);
        }
    }

    // Step 5: Download media (only for footage scenes — fullscreenMG scenes skipped)
    log.step('🎥 Step 5: Downloading Media');
    // Scale Omni frame budget with scene count: 6 frames per scene (one Omni call each)
    const scaledBudget = Math.max(config.clipAnalyzer?.maxFramesPerBuild || 200, footageScenes.length * 6);
    clipAnalyzer.resetBudget(scaledBudget);
    log.info(`   🎯 Omni budget: ${scaledBudget} frames (${footageScenes.length} scenes × 6)`);
    const downloadResult = await downloadAllMedia(footageScenes, scriptContext);
    let scenesWithMedia = downloadResult.scenes;

    // Log clip analyzer usage stats
    const caStats = clipAnalyzer.getStats();
    if (caStats.totalFramesSent > 0) {
        console.log(`  🎬 Clip Analyzer: Omni=${caStats.omniFrames}/${caStats.omniBudget} frames | VL clip scoring=${caStats.clipAnalysisFrames} frames | Omni remaining=${caStats.omniRemaining}`);
    }

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
                const v2Result = await downloadAllMedia([v2Scene], scriptContext);
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

    // Load custom background assets for this theme (auto-discovered from assets/backgrounds/)
    let themeBgAssets = [];
    let themeBgIndex = 0;
    try {
        const { getThemeBackgrounds } = require('./themes');
        const bgThemeId = scriptContext?.themeId || 'standard';
        themeBgAssets = getThemeBackgrounds(bgThemeId);
        if (themeBgAssets.length > 0) {
            log.dim(`🖼️ Theme "${bgThemeId}" has ${themeBgAssets.length} custom background assets`);
        }
    } catch (e) { /* themes.js not available */ }

    let autoContainCount = 0;
    let cinematicCount = 0;
    let fullscreenCount = 0;
    let customBgCount = 0;
    for (const scene of scenesWithMedia) {
        const w = scene.mediaWidth || 0;
        const h = scene.mediaHeight || 0;

        if (w > 0 && h > 0) {
            const ratio = w / h;

            if (ratio < 0.7) {
                // Vertical (9:16, portrait photos) — contain + blur, too tall to crop
                scene.fitMode = 'contain';
                scene.background = 'blur';
                scene.scale = 1;
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (vertical, ratio ${ratio.toFixed(2)}) → contain + blur`);
            } else if (ratio < 0.85) {
                // Portrait (3:4, headshots) — contain + blur
                scene.fitMode = 'contain';
                scene.background = 'blur';
                scene.scale = 1;
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (portrait, ratio ${ratio.toFixed(2)}) → contain + blur`);
            } else if (ratio < 1.2) {
                // Near-square / slightly wide (1:1 to 6:5) — cover with slight crop
                // These are close enough to 16:9 that a moderate scale looks good
                const nearScale = ratio < 0.95 ? 0.85 : ratio < 1.05 ? 0.9 : 0.95;
                scene.fitMode = 'cover';
                scene.scale = nearScale;
                scene.background = 'blur';
                scene.posX = 0;
                scene.posY = 0;
                autoContainCount++;
                const label = ratio < 0.95 ? 'near-square' : ratio < 1.05 ? 'square' : 'near-wide';
                log.dim(`📐 Scene ${scene.index}: ${w}x${h} (${label}, ratio ${ratio.toFixed(2)}) → scale ${nearScale} + blur`);
            } else if (scene.framing === 'floating') {
                // AI recommended floating frame — smaller scale, rounded corners, shadow, styled bg
                const targetRatio = 1920 / 1080;
                const fillFactor = Math.min(1, (ratio - 1.0) / (targetRatio - 1.0));
                const floatingScale = 0.45 + fillFactor * 0.10; // 0.45 → 0.55
                scene.fitMode = 'cover';
                scene.scale = Math.round(floatingScale * 100) / 100;
                scene.borderRadius = scene.borderRadius || 4; // visible rounded corners
                scene.shadow = scene.shadow !== undefined ? scene.shadow : 0.5;
                scene.floatingAnim = scene.floatingAnim || 'slideRight'; // slideRight, slideLeft, slideUp, fadeScale
                // Animation duration driven by pacing (AI Director) + scene length
                const pacing = scriptContext.pacing || 'moderate';
                const sceneDur = (scene.endTime || 0) - (scene.startTime || 0);
                const pacingBase = pacing === 'fast' ? 0.3 : pacing === 'slow' ? 0.7 : 0.5;
                const durationAdj = sceneDur < 4 ? -0.1 : sceneDur > 7 ? 0.15 : 0;
                scene.floatingAnimDuration = scene.floatingAnimDuration || Math.round((pacingBase + durationAdj) * 100) / 100;
                if (!scene.background || scene.background === 'none') {
                    scene.background = 'blur'; // default to blur, AI can override with gradient
                }
                scene.posX = scene.posX || 0;
                scene.posY = scene.posY || 0;
                cinematicCount++;
                log.dim(`🖼️ Scene ${scene.index}: ${w}x${h} (floating) → scale ${scene.scale} + ${scene.floatingAnim} ${scene.floatingAnimDuration}s + shadow ${scene.shadow} + ${scene.background}`);
            } else if (scene.framing === 'cinematic') {
                // AI recommended cinematic framing — scale based on how wide the image is
                // Wider images can fill more of the frame; narrower ones need more pullback
                // Range: 0.75 (barely wide, ratio ~1.2) to 1.0 (very wide, ratio >= 1.78)
                const targetRatio = 1920 / 1080; // 1.78
                const fillFactor = Math.min(1, (ratio - 1.0) / (targetRatio - 1.0));
                const cinematicScale = 0.75 + fillFactor * 0.25; // 0.75 → 1.0
                scene.fitMode = 'cover';
                scene.scale = Math.round(cinematicScale * 100) / 100;
                // Keep AI's background choice (blur, gradient:id, or pattern:file)
                if (!scene.background || scene.background === 'none') {
                    scene.background = 'blur';
                }
                scene.posX = 0;
                scene.posY = 0;
                cinematicCount++;
                log.dim(`🎬 Scene ${scene.index}: ${w}x${h} (cinematic) → scale ${scene.scale} + ${scene.background}`);
            } else {
                // Fullscreen — media fills the frame completely
                scene.fitMode = 'cover';
                fullscreenCount++;
            }
        } else {
            // Unknown dimensions — default to cover
            scene.fitMode = 'cover';
        }
    }

    // Assign custom background assets to some non-widescreen scenes (variety)
    // Every ~3rd blur scene gets a custom asset background instead
    if (themeBgAssets.length > 0) {
        const blurScenes = scenesWithMedia.filter(s => s.background === 'blur');
        for (let i = 0; i < blurScenes.length; i++) {
            if (i % 3 === 1) { // 2nd, 5th, 8th... — roughly 1 in 3
                const bgFile = themeBgAssets[themeBgIndex % themeBgAssets.length];
                blurScenes[i].background = `pattern:${bgFile}`;
                themeBgIndex++;
                customBgCount++;
            }
        }
    }

    const framingTotal = autoContainCount + cinematicCount;
    if (framingTotal > 0) {
        log.ok(`${autoContainCount} auto-framed (non-widescreen) + ${cinematicCount} cinematic + ${fullscreenCount} fullscreen`);
    } else {
        log.ok('All scenes fullscreen — no auto-framing needed');
    }
    if (customBgCount > 0) {
        log.ok(`${customBgCount} scenes using custom background assets`);
    }
    log.br();

    // ── Orchestrator Phase 2: Mid-Build Validation + MG Instructions ──
    let midBuildStats = { footageDownloaded: scenesWithMedia.length, footagePlanned: footageScenes.length, footageFailed: 0, lowVisionScores: 0, providerBreakdown: {} };
    let mgInstructions = null;
    if (buildManifest) {
        try {
            const midResult = midBuildValidation(scenesWithMedia, buildManifest, scriptContext);
            midBuildStats = midResult.stats;
            mgInstructions = midResult.mgInstructions || null;
        } catch (error) {
            log.warn(`Orchestrator Phase 2 failed: ${error.message}`);
        }
    }

    // Step 6: AI Motion Graphics
    log.step('✨ Step 6: AI Motion Graphics');

    // Build combined instructions: user AI instructions + orchestrator MG instructions
    let combinedInstructions = aiInstructions || '';
    if (mgInstructions) {
        const instrParts = [];
        instrParts.push(`\n[ORCHESTRATOR MG DIRECTIVES — niche: ${mgInstructions.nicheName}]`);
        instrParts.push(`Target overlay MG count: ~${mgInstructions.targetMGCount} (density: ${mgInstructions.overlayDensity})`);
        instrParts.push(`Maximum gap without MG: ${mgInstructions.maxGapSec}s`);
        if (mgInstructions.longScenes.length > 0) {
            instrParts.push(`PRIORITY: Scenes ${mgInstructions.longScenes.join(', ')} are >7s — strongly prefer adding overlay MGs to these`);
        }
        if (mgInstructions.shortScenes.length > 0) {
            instrParts.push(`SKIP: Scenes ${mgInstructions.shortScenes.join(', ')} are <2.5s — do NOT add MGs to these`);
        }
        if (mgInstructions.listicleItemScenes && mgInstructions.listicleItemScenes.length > 0) {
            instrParts.push(`LISTICLE ITEM SCENES: ${mgInstructions.listicleItemScenes.join(', ')} — already have auto-generated listicleCounter, DO NOT add any overlay MGs to these scenes`);
        }
        if (mgInstructions.listicleOverviewScene >= 0) {
            instrParts.push(`LISTICLE OVERVIEW SCENE: ${mgInstructions.listicleOverviewScene} — this is a fullscreen listicleGrid, DO NOT add any MGs to this scene`);
        }
        if (mgInstructions.listicleProtectedScenes && mgInstructions.listicleProtectedScenes.length > 0) {
            instrParts.push(`PROTECTED SCENES (no overlay MGs): ${mgInstructions.listicleProtectedScenes.join(', ')}`);
        }
        for (const hint of mgInstructions.formatHints) {
            instrParts.push(hint);
        }
        combinedInstructions += instrParts.join('\n');
    }

    // Append style block (if present) as inspiration for MG placement (niche allowlist still controls types)
    if (scriptContext.styleBlock) {
        combinedInstructions = (combinedInstructions ? combinedInstructions + '\n\n' : '') + scriptContext.styleBlock;
        log.info(`🎨 Style inspiration appended to MG instructions: "${scriptContext.styleProfile?.name || 'unnamed'}" (${scriptContext.styleBlock.length} chars)`);
    }
    const mgResult = await processMotionGraphics(scenesWithKeywords, scriptContext, null, combinedInstructions);
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
    let motionGraphics = allMGs.filter(mg => mg.category !== 'fullscreen');
    const fullscreenMGs = allMGs.filter(mg => mg.category === 'fullscreen');

    // Remove overlay MGs that overlap with fullscreen MG time windows
    // (fullscreen MGs cover the entire screen — stacking overlays on top looks broken)
    if (fullscreenMGs.length > 0) {
        const fsMGRanges = fullscreenMGs.map(mg => ({
            start: mg.startTime,
            end: mg.startTime + (mg.duration || 3)
        }));
        const before = motionGraphics.length;
        // Listicle counters/trackers are designed to overlay on footage, not on the grid —
        // they should NOT be removed even if they slightly overlap the listicleGrid on V3
        const LISTICLE_OVERLAY_TYPES = new Set(['listicleCounter']);
        motionGraphics = motionGraphics.filter(mg => {
            if (LISTICLE_OVERLAY_TYPES.has(mg.type)) return true;
            const mStart = mg.startTime;
            const mEnd = mStart + (mg.duration || 3);
            return !fsMGRanges.some(r => mStart < r.end && mEnd > r.start);
        });
        const removed = before - motionGraphics.length;
        if (removed > 0) log.info(`🚫 Removed ${removed} overlay MG(s) that overlap fullscreen MGs`);
    }

    // Convert full-screen MGs into scene-like objects for V3
    const mgScenes = fullscreenMGs.map((mg, i) => ({
        ...mg,
        isMGScene: true,
        trackId: 'video-track-3',
        mediaType: 'motion-graphic',
        endTime: mg.startTime + mg.duration,
        keyword: `MG: ${mg.type}`,
    }));

    // Tag each scene with its original index (footage-manager uses scene.index for filenames)
    scenesWithMedia.forEach((scene) => { scene._fileIndex = scene.index; });

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

    // Step 6.05: AI Map Animation Planner — enrich mapChart MGs with waypoints
    const mapMGsForPlanning = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGsForPlanning.length > 0) {
        log.step('🗺️ Step 6.05: Map Animation Planner');
        try {
            const { planMapAnimations } = require('./ai-map-planner');
            const enriched = await planMapAnimations(allMGs, scriptContext, combinedInstructions);
            if (enriched > 0) {
                log.ok(`Planned ${enriched} map animation(s) with waypoints`);
            } else {
                log.dim('No map animations enriched (no locations found)');
            }
        } catch (e) {
            log.warn(`Map planner failed: ${e.message} — maps will use basic animation`);
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

        // Propagate map data from allMGs to mgScenes (mgScenes are copies)
        for (const mg of fullscreenMGs) {
            if (mg.type !== 'mapChart') continue;
            const target = mgScenes.find(s => s.type === mg.type && s.startTime === mg.startTime);
            if (!target) continue;
            if (mg.mapImageFile) {
                target.mapImageFile = mg.mapImageFile;
                target._mapView = mg._mapView;
                if (mg._mapPins) target._mapPins = mg._mapPins;
                if (mg._osmBoundaries) target._osmBoundaries = mg._osmBoundaries;
            }
            // Waypoint animation data (from ai-map-planner.js)
            if (mg._mapWaypoints) target._mapWaypoints = mg._mapWaypoints;
            if (mg._bigMapSize) target._bigMapSize = mg._bigMapSize;
            if (mg._wpCoords) target._wpCoords = mg._wpCoords;
            if (mg._mapBigMap) target._mapBigMap = mg._mapBigMap;
        }
    }

    // Step 6.5: AI Templates (fullscreen template cards on V3)
    log.step('🎴 Step 6.5: AI Templates');
    let templateScenes = [];
    try {
        const templateResult = await processTemplates(scenesWithKeywords, scriptContext, mgScenes, combinedInstructions);
        templateScenes = templateResult.templateScenes || [];
        if (templateScenes.length > 0) {
            log.ok(`Placed ${templateScenes.length} template(s)`);
            for (const tpl of templateScenes) {
                log.dim(`🎴 [${tpl.type}] "${tpl.text || ''}" @ ${tpl.startTime.toFixed(1)}s-${tpl.endTime.toFixed(1)}s`);
            }

            // Download background images for templates that need them (locationCard, chapterCard)
            try {
                const bgCount = await downloadTemplateBackgrounds(templateScenes, config.paths.temp, scriptContext);
                if (bgCount > 0) log.ok(`Downloaded ${bgCount} template background(s)`);
            } catch (bgErr) {
                log.warn(`Template backgrounds failed: ${bgErr.message} — continuing without`);
            }

            // Download item images for templates that need them (imageShowcase)
            try {
                const itemImgCount = await downloadTemplateItemImages(templateScenes, config.paths.temp, scriptContext);
                if (itemImgCount > 0) log.ok(`Downloaded ${itemImgCount} template item image(s)`);
            } catch (itemErr) {
                log.warn(`Template item images failed: ${itemErr.message} — continuing without`);
            }

            // Copy the underlying V1 scene's media file to each template
            // (the scene already had footage downloaded in Step 5 — reuse it as template background)
            for (const tpl of templateScenes) {
                const srcScene = scenesWithMedia.find(s =>
                    s.startTime <= tpl.startTime && s.endTime >= tpl.endTime
                ) || scenesWithMedia.find(s =>
                    s.startTime < tpl.endTime && s.endTime > tpl.startTime
                );
                if (srcScene && srcScene.mediaFile) {
                    tpl.templateMediaFile = srcScene.mediaFile;
                    // mediaOffset into the clip for the template's start time
                    const offsetInScene = tpl.startTime - srcScene.startTime;
                    tpl.templateMediaOffset = (srcScene.mediaOffset || 0) + Math.max(0, offsetInScene);
                    log.dim(`   🎬 [${tpl.type}] using scene footage: ${path.basename(srcScene.mediaFile)}`);
                }
            }

            // Carve V1 scenes for template scenes (same logic as fullscreen MG carving)
            if (templateScenes.length > 0) {
                const tplRanges = templateScenes.map(tpl => ({ start: tpl.startTime, end: tpl.endTime }));
                let carved = [];
                for (const scene of scenesWithMedia) {
                    let parts = [{ startTime: scene.startTime, endTime: scene.endTime }];
                    for (const range of tplRanges) {
                        const newParts = [];
                        for (const part of parts) {
                            if (range.start >= part.endTime || range.end <= part.startTime) {
                                newParts.push(part);
                            } else if (range.start <= part.startTime && range.end >= part.endTime) {
                                // Fully covered — remove
                            } else if (range.start > part.startTime && range.end < part.endTime) {
                                newParts.push({ startTime: part.startTime, endTime: range.start });
                                newParts.push({ startTime: range.end, endTime: part.endTime });
                            } else if (range.start <= part.startTime) {
                                newParts.push({ startTime: range.end, endTime: part.endTime });
                            } else {
                                newParts.push({ startTime: part.startTime, endTime: range.start });
                            }
                        }
                        parts = newParts;
                    }
                    for (const part of parts) {
                        if (part.endTime - part.startTime < 0.3) continue;
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
                const tplRemoved = scenesWithMedia.length - carved.length;
                scenesWithMedia = carved;
                if (tplRemoved > 0) log.info(`🔪 Carved ${tplRemoved} scene(s) to make room for templates`);
            }

            // Remove overlay MGs that overlap with template time windows
            if (templateScenes.length > 0) {
                const tplRanges = templateScenes.map(tpl => ({ start: tpl.startTime, end: tpl.endTime }));
                const LISTICLE_OVERLAY_TYPES = new Set(['listicleCounter']);
                const beforeCount = motionGraphics.length;
                motionGraphics = motionGraphics.filter(mg => {
                    if (LISTICLE_OVERLAY_TYPES.has(mg.type)) return true;
                    const mStart = mg.startTime;
                    const mEnd = mStart + (mg.duration || 3);
                    return !tplRanges.some(r => mStart < r.end && mEnd > r.start);
                });
                const tplOverlapRemoved = beforeCount - motionGraphics.length;
                if (tplOverlapRemoved > 0) log.info(`🚫 Removed ${tplOverlapRemoved} overlay MG(s) that overlap templates`);
            }
        } else {
            log.dim('No templates placed');
        }
    } catch (error) {
        log.warn(`Template step failed: ${error.message} — continuing without templates`);
    }
    log.br();

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

    // Inject theme effectParams into scriptContext so the renderer can read them
    const resolvedThemeId = scriptContext?.themeId || 'standard';
    try {
        const { getTheme } = require('./themes');
        const resolvedTheme = getTheme(resolvedThemeId);
        if (resolvedTheme && resolvedTheme.effectParams) {
            scriptContext.effectParams = resolvedTheme.effectParams;
        }
    } catch (e) { /* themes.js not available — skip */ }

    const videoPlan = {
        audio: audioFile,
        totalDuration: actualAudioDuration,
        fps: config.video.fps,
        width: config.video.width,
        height: config.video.height,
        scenes: allScenes,
        mgScenes: mgScenes,
        templateScenes: templateScenes,
        motionGraphics: motionGraphics,
        mgStyle: mgStyle,
        mapStyle: mapStyle,
        scriptContext: scriptContext,
        themeId: resolvedThemeId
    };

    const planPath = path.join(config.paths.temp, 'video-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(videoPlan, (k, v) => k === '_fileIndex' ? undefined : v, 2));
    log.ok('Plan saved');
    log.br();

    // ── Orchestrator Phase 3: Post-Build Review + Gap-Filling ──
    if (buildManifest) {
        try {
            const reviewResult = await postBuildReview(videoPlan, buildManifest, midBuildStats);
            videoPlan.buildReport = reviewResult.report;
            if (reviewResult.injectedMGs && reviewResult.injectedMGs.length > 0) {
                log.ok(`Orchestrator injected ${reviewResult.injectedMGs.length} overlay MG(s) to fill gaps`);
            }
            // Re-save plan with build report + any injected MGs
            fs.writeFileSync(planPath, JSON.stringify(videoPlan, (k, v) => k === '_fileIndex' ? undefined : v, 2));
        } catch (error) {
            log.warn(`Orchestrator Phase 3 failed: ${error.message}`);
        }
    }

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

    // Copy map image files (for mapChart API mode)
    for (const mg of mgScenes) {
        if (mg.mapImageFile) {
            const srcMap = path.join(config.paths.temp, mg.mapImageFile);
            const destMap = path.join(publicDir, mg.mapImageFile);
            if (fs.existsSync(srcMap)) {
                fs.copyFileSync(srcMap, destMap);
                log.dim(`🗺️ Copied map image: ${mg.mapImageFile}`);
            }
        }
    }
    // Copy template background images
    for (const tpl of templateScenes) {
        if (tpl.templateBgFile) {
            const srcBg = path.join(config.paths.temp, tpl.templateBgFile);
            const destBg = path.join(publicDir, tpl.templateBgFile);
            if (fs.existsSync(srcBg)) {
                fs.copyFileSync(srcBg, destBg);
                log.dim(`🖼️ Copied template bg: ${tpl.templateBgFile}`);
            }
        }
        // Copy item thumbnail images (imageShowcase etc.)
        if (tpl._itemThumbnails && tpl._itemThumbnails.length > 0) {
            for (const thumb of tpl._itemThumbnails) {
                if (!thumb) continue;
                const srcThumb = path.join(config.paths.temp, thumb);
                const destThumb = path.join(publicDir, thumb);
                if (fs.existsSync(srcThumb)) {
                    fs.copyFileSync(srcThumb, destThumb);
                    log.dim(`🖼️ Copied template item image: ${thumb}`);
                }
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

    // Re-link listicle grid thumbnails to updated public scene paths
    // Check both mgScenes (legacy) and templateScenes (new system)
    for (const container of [videoPlan.mgScenes, videoPlan.templateScenes]) {
        if (!container) continue;
        for (const mg of container) {
            if (mg.type === 'listicleGrid' && videoPlan.scriptContext?.listicleItems) {
                mg._itemThumbnails = videoPlan.scriptContext.listicleItems.map(item => {
                    const scene = scenesWithMedia[item.startSceneIndex];
                    return scene?.mediaFile || null;
                });
            }
        }
    }

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
