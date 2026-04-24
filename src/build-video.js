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

    // Resume detection: if scene-N.mp4/jpg files already exist AND user opted into
    // resume mode, preserve downloaded scenes so footage-manager can skip them.
    // When BUILD_RESUME !== 'true', always wipe everything (fresh build).
    const resumeAllowed = process.env.BUILD_RESUME === 'true';
    const hasSceneFiles = files.some(f => /^scene-\d+\.(mp4|jpg|jpeg|png|webp)$/i.test(f));
    if (resumeAllowed && hasSceneFiles && label === 'temp') {
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

// ═══════════════════════════════════════════════════════════════
// Time-Targeted Directive Parser
// Parses user AI instructions for time/scene-targeted commands:
//   "Use map animation in the first 22s"
//   "splitScreen at 3:58"
//   "No maps after 1:00"
//   "Use infographic on scene 5"
// ═══════════════════════════════════════════════════════════════

const DIRECTIVE_MG_ALIASES = {
    'map': 'mapChart', 'maps': 'mapChart', 'map animation': 'mapChart', 'map chart': 'mapChart',
    'split screen': 'splitScreen', 'split-screen': 'splitScreen', 'splitscreen': 'splitScreen',
    'infographic': 'infographic', 'infographics': 'infographic',
    'comparison': 'comparisonCard', 'compare': 'comparisonCard',
    'stat': 'statCard', 'stats': 'statCard', 'statistics': 'statCard',
    'fact': 'factCard', 'facts': 'factCard',
    'chart': 'barChart', 'bar chart': 'barChart',
    'timeline': 'timelineCard',
    'quote': 'quoteCard',
    'chapter': 'chapterCard',
    'person': 'personIntro', 'person intro': 'personIntro',
    'location': 'locationCard',
    'image showcase': 'imageShowcase', 'showcase': 'imageShowcase',
    'donut': 'donutChart', 'donut chart': 'donutChart',
    'ranking': 'rankingList',
};

function _parseTimestamp(str) {
    // "22s" → 22, "1:30" → 90, "0:22" → 22, "3m" → 180, "first 22s" → 22
    if (!str) return null;
    str = str.trim().toLowerCase();
    // MM:SS
    const mmss = str.match(/^(\d{1,3}):(\d{2})$/);
    if (mmss) return parseInt(mmss[1]) * 60 + parseInt(mmss[2]);
    // N.MM (dot-typo for colon MM:SS — "0.22s" is almost always "0:22" = 22s,
    // not a literal 0.22 seconds). Only triggers when the fractional part is
    // exactly 2 digits AND ≤ 59, so real sub-second values like "0.5s" or
    // "1.25s" keep their literal meaning.
    const dotMMSS = str.match(/^(\d{1,3})\.(\d{2})\s*s?(?:ec(?:onds?)?)?$/);
    if (dotMMSS) {
        const mm = parseInt(dotMMSS[1]);
        const ss = parseInt(dotMMSS[2]);
        if (ss <= 59) return mm * 60 + ss;
    }
    // Ns or N seconds
    const sec = str.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/);
    if (sec) return parseFloat(sec[1]);
    // Nm or N minutes
    const min = str.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?$/);
    if (min) return parseFloat(min[1]) * 60;
    // bare number (assume seconds)
    const bare = str.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) return parseFloat(bare[1]);
    return null;
}

function _loadStudioPlan(audioDuration) {
    const projectDir = process.env.PROJECT_DIR || process.cwd();
    const planPath = path.join(projectDir, 'styles', '.studio-plan.json');
    if (!fs.existsSync(planPath)) return null;

    try {
        const raw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        if (!raw || raw.version !== 2 || !Array.isArray(raw.scenes) || raw.scenes.length < 2) return null;
        if (Math.abs((raw.audioDuration || 0) - audioDuration) > 2) {
            console.log(`   ⚠️ Studio plan duration ${raw.audioDuration?.toFixed?.(1)}s doesn't match audio ${audioDuration.toFixed(1)}s — skipping`);
            return null;
        }

        const fps = config.video.fps;
        const scenes = raw.scenes.map((s, i) => ({
            index: i,
            text: s.text || '',
            startTime: s.startTime,
            endTime: s.endTime,
            duration: Math.round((s.endTime - s.startTime) * fps),
            words: Array.isArray(s.words) ? s.words : [],
            // Visual fields (if studio plan includes them)
            ...(s.keyword && { keyword: s.keyword }),
            ...(s.stockQuery && { stockQuery: s.stockQuery }),
            ...(s.webQuery && { webQuery: s.webQuery }),
            ...(s.sourceHint && { sourceHint: s.sourceHint }),
            ...(s.framing && { framing: s.framing }),
            ...(s.effectPreset && { effectPreset: s.effectPreset }),
            ...(s.mgHint && { mgHint: s.mgHint }),
            ...(s.fullscreenMG && { fullscreenMG: s.fullscreenMG }),
            ...(s.templateHint && { templateHint: s.templateHint }),
            ...(s.visualIntent && { visualIntent: s.visualIntent }),
            ...(s.backgroundId && { backgroundId: s.backgroundId }),
            ...(s.floatingAnim && { floatingAnim: s.floatingAnim }),
            ...(s.mediaType && { mediaType: s.mediaType }),
        }));

        // Build scriptContext from brief (or defaults)
        const brief = raw.brief || {};
        const { pickNicheFromContent } = require('./niches');
        const scriptContext = {
            summary: brief.summary || '',
            theme: brief.tone || '',
            tone: brief.tone || '',
            mood: '',
            pacing: brief.pacing || 'moderate',
            visualStyle: '',
            entities: brief.entities || [],
            entityTypes: brief.entityTypes || {},
            keyStats: [],
            mainPoints: [],
            targetAudience: '',
            emotionalArc: '',
            format: brief.format || 'documentary',
            sections: [],
            ctaDetected: brief.ctaDetected || false,
            ctaStartTime: brief.ctaStartTime || null,
            hookEndTime: brief.hookEndTime || null,
            eventType: brief.eventType || 'educational',
            densityTarget: 3,
            nicheId: brief.nicheId || 'general',
            themeId: brief.themeId || 'standard',
        };

        // If niche wasn't in brief, try to detect from summary
        if (!brief.nicheId && scriptContext.summary) {
            try {
                const detected = pickNicheFromContent(scriptContext);
                if (detected) scriptContext.nicheId = detected;
            } catch (_) {}
        }

        return { scenes, scriptContext, hasVisualPlan: raw.hasVisualPlan === true };
    } catch (e) {
        console.log(`   ⚠️ Studio plan load failed: ${e.message}`);
        return null;
    }
}

function _applyTimeDirectives(instructions, scenes, scriptContext) {
    if (!instructions || scenes.length === 0) return 0;

    let applied = 0;
    // Split by newlines and sentences
    const lines = instructions.split(/[.\n]/).map(l => l.trim()).filter(Boolean);

    for (const line of lines) {
        const lower = line.toLowerCase();

        // ── Pattern: "Use <MG type> in the first <time>" ──
        // "Use map animation in the first 22s"
        // "Use splitScreen in first 0:30"
        let m = lower.match(/use\s+(.+?)\s+(?:in|for|during)\s+(?:the\s+)?first\s+(.+)/);
        if (m) {
            const mgType = _resolveMGAlias(m[1]);
            let endTime = _parseTimestamp(m[2]);
            if (mgType && endTime != null) {
                // Safety net: if the parsed window is shorter than the first scene
                // (typically means the user typed a malformed time like "0.22s"),
                // clamp to at least the first scene's end so the directive applies
                // to the opening scene instead of silently matching zero scenes.
                const firstSceneEnd = scenes[0]?.endTime || 0;
                if (endTime < firstSceneEnd) {
                    console.log(`   ⚠️ Directive "${line}" — parsed end ${endTime.toFixed(2)}s is shorter than scene 0 (${firstSceneEnd.toFixed(1)}s); clamping to first scene`);
                    endTime = firstSceneEnd;
                }
                applied += _forceFullscreenMG(scenes, mgType, 0, endTime, line);
                continue;
            }
        }

        // ── Pattern: "Use <MG type> at <time>" / "Use <MG type> around <time>" ──
        // "Use splitScreen at 3:58"
        m = lower.match(/use\s+(.+?)\s+(?:at|around|near)\s+(.+)/);
        if (m) {
            const mgType = _resolveMGAlias(m[1]);
            const targetTime = _parseTimestamp(m[2]);
            if (mgType && targetTime != null) {
                // Find closest scene to this timestamp
                applied += _forceFullscreenMG(scenes, mgType, targetTime - 2, targetTime + 4, line);
                continue;
            }
        }

        // ── Pattern: "Use <MG type> from <time> to <time>" / "between <time> and <time>" ──
        m = lower.match(/use\s+(.+?)\s+(?:from|between)\s+(.+?)\s+(?:to|and|-)\s+(.+)/);
        if (m) {
            const mgType = _resolveMGAlias(m[1]);
            const startTime = _parseTimestamp(m[2]);
            const endTime = _parseTimestamp(m[3]);
            if (mgType && startTime != null && endTime != null) {
                applied += _forceFullscreenMG(scenes, mgType, startTime, endTime, line);
                continue;
            }
        }

        // ── Pattern: "No <MG type> after <time>" / "No maps after 1:00" ──
        m = lower.match(/no\s+(.+?)\s+after\s+(.+)/);
        if (m) {
            const mgType = _resolveMGAlias(m[1]);
            const afterTime = _parseTimestamp(m[2]);
            if (mgType && afterTime != null) {
                // Remove any fullscreenMG of this type after the timestamp
                for (const s of scenes) {
                    if (!s.fullscreenMG) continue;
                    const colonIdx = s.fullscreenMG.indexOf(':');
                    const existingType = colonIdx > 0 ? s.fullscreenMG.substring(0, colonIdx).trim() : s.fullscreenMG.trim();
                    if (existingType === mgType && s.startTime > afterTime) {
                        console.log(`   ⚡ Directive "${line}" → removed ${mgType} from scene ${s.index} (${s.startTime.toFixed(1)}s)`);
                        s.fullscreenMG = null;
                        applied++;
                    }
                }
                continue;
            }
        }

        // ── Pattern: "<MG type> on scene <N>" / "scene <N> should be <MG type>" ──
        m = lower.match(/(?:use\s+)?(.+?)\s+(?:on|for)\s+scene\s+(\d+)/);
        if (!m) m = lower.match(/scene\s+(\d+)\s+(?:should\s+(?:be|use|have)\s+)(.+)/);
        if (m) {
            const mgType = _resolveMGAlias(m[1]) || _resolveMGAlias(m[2]);
            const sceneIdx = parseInt(m[2]) || parseInt(m[1]);
            if (mgType && !isNaN(sceneIdx)) {
                const scene = scenes.find(s => s.index === sceneIdx);
                if (scene) {
                    scene.fullscreenMG = mgType + ': ' + (scene.text || '').substring(0, 80);
                    scene.keyword = null;
                    scene.stockQuery = null;
                    scene.sourceHint = null;
                    console.log(`   ⚡ Directive "${line}" → scene ${sceneIdx} forced to ${mgType}`);
                    applied++;
                }
                continue;
            }
        }
    }

    return applied;
}

function _resolveMGAlias(text) {
    if (!text) return null;
    text = text.trim().toLowerCase().replace(/['"]/g, '');
    // Direct match
    if (DIRECTIVE_MG_ALIASES[text]) return DIRECTIVE_MG_ALIASES[text];
    // Check if it's already a valid type
    const { FULLSCREEN_MG_TYPES } = require('./ai-motion-graphics');
    if (FULLSCREEN_MG_TYPES.has(text)) return text;
    const { TEMPLATE_TYPES } = require('./ai-templates');
    if (TEMPLATE_TYPES && TEMPLATE_TYPES.has(text)) return text;
    // Partial match
    for (const [alias, type] of Object.entries(DIRECTIVE_MG_ALIASES)) {
        if (text.includes(alias) || alias.includes(text)) return type;
    }
    return null;
}

function _forceFullscreenMG(scenes, mgType, startTime, endTime, directive) {
    let count = 0;
    // Find scenes that overlap with the time range
    const candidates = scenes.filter(s => {
        const sceneEnd = s.endTime || (s.startTime + 3);
        return s.startTime < endTime && sceneEnd > startTime;
    });

    if (candidates.length === 0) {
        console.log(`   ⚠️ Directive "${directive}" — no scenes found in ${startTime.toFixed(1)}s-${endTime.toFixed(1)}s`);
        return 0;
    }

    // If range is short (< 8s), pick the best single scene
    // If range is longer, force all scenes in range
    const targetScenes = (endTime - startTime) <= 8
        ? [candidates.reduce((best, s) => {
            const sMid = (s.startTime + (s.endTime || s.startTime + 3)) / 2;
            const bMid = (best.startTime + (best.endTime || best.startTime + 3)) / 2;
            const targetMid = (startTime + endTime) / 2;
            return Math.abs(sMid - targetMid) < Math.abs(bMid - targetMid) ? s : best;
        })]
        : candidates;

    for (const s of targetScenes) {
        if (s.fullscreenMG) {
            // Already has a fullscreen MG — check if it's the same type
            const colonIdx = s.fullscreenMG.indexOf(':');
            const existingType = colonIdx > 0 ? s.fullscreenMG.substring(0, colonIdx).trim() : s.fullscreenMG.trim();
            if (existingType === mgType) continue; // already set
        }
        s.fullscreenMG = mgType + ': ' + (s.text || '').substring(0, 80);
        s.keyword = null;
        s.stockQuery = null;
        s.sourceHint = null;
        console.log(`   ⚡ Directive "${directive}" → scene ${s.index} (${s.startTime.toFixed(1)}s) forced to ${mgType}`);
        count++;
    }
    return count;
}

async function buildVideo() {
    log.banner('FACELESS VIDEO GENERATOR - AUTO BUILD');

    const startTime = Date.now();
    const PROJECT_DIR = process.env.PROJECT_DIR || path.join(__dirname, '..');
    const CHECKPOINT_FILE = path.join(PROJECT_DIR, '.build-checkpoint.json');

    // ── Resume from checkpoint? ──
    // If a checkpoint exists from a previous failed build (same audio file),
    // skip Steps 0-4.8 (transcription, AI Director, Visual Planner, Orchestrator)
    // and jump straight to Step 5 (download). Saves time AND AI credits.
    // Gated by BUILD_RESUME env var — when OFF (default), checkpoint is deleted and every step runs fresh.
    const resumeAllowed = process.env.BUILD_RESUME === 'true';
    const resumeMode = resumeAllowed && fs.existsSync(CHECKPOINT_FILE);
    let checkpoint = null;
    if (resumeMode) {
        try {
            checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
            log.ok(`♻️  Build checkpoint found (saved ${new Date(checkpoint._savedAt).toLocaleString()})`);
            log.ok(`   ${checkpoint.scenes.length} scenes, ${checkpoint.scriptContext?.nicheId || 'auto'} niche — skipping Steps 0-4.8`);
        } catch (e) {
            log.warn(`Checkpoint file corrupt — starting fresh build`);
            checkpoint = null;
            try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
        }
    } else if (!resumeAllowed && fs.existsSync(CHECKPOINT_FILE)) {
        // Resume OFF — remove stale checkpoint so it can't accidentally leak into a later build
        try { fs.unlinkSync(CHECKPOINT_FILE); log.info('🧹 Cleared stale checkpoint (Resume Build is OFF)'); } catch (_) {}
    }

    // Step 0: Clean old build artifacts
    log.step('🧹 Step 0: Cleaning old build files');
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

    // AI thinking mode (from UI dropdown — works for Gemini, Qwen, DeepSeek)
    const aiThinkingMode = (process.env.AI_THINKING || process.env.GEMINI_THINKING || 'off').trim().toLowerCase();
    if (aiThinkingMode !== 'off') {
        const { setAIThinking } = require('./ai-provider');
        setAIThinking(aiThinkingMode);
    }

    // Variables that flow from Steps 2-4.8 into Step 5+
    let transcription, buildLanguage, scenesWithKeywords, scriptContext, buildManifest, actualAudioDuration;
    let aiInstructions = '';
    const plannedV2Scenes = [];
    const compositorExplainers = [];

    // ── RESUME PATH: restore from checkpoint ──
    if (checkpoint && checkpoint.audioFile === audioFile) {
        log.step('♻️  Resuming from checkpoint — skipping Steps 2-4.8');
        transcription = checkpoint.transcription;
        buildLanguage = checkpoint.buildLanguage;
        scenesWithKeywords = checkpoint.scenes;
        scriptContext = checkpoint.scriptContext;
        buildManifest = checkpoint.buildManifest || null;
        actualAudioDuration = checkpoint.actualAudioDuration;
        aiInstructions = (process.env.AI_INSTRUCTIONS || '').trim();
        log.ok(`Restored ${scenesWithKeywords.length} scenes, niche=${scriptContext.nicheId}, lang=${buildLanguage}`);
        log.ok(`Saved ${((Date.now() - startTime) / 1000).toFixed(0)}s+ of AI calls & transcription`);
        log.br();
    } else {
    // ── FRESH BUILD PATH: run Steps 2-4.8 ──
    if (checkpoint && checkpoint.audioFile !== audioFile) {
        log.warn(`Checkpoint is for "${checkpoint.audioFile}" but building "${audioFile}" — starting fresh`);
        try { fs.unlinkSync(CHECKPOINT_FILE); } catch (_) {}
    }

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

    transcription = await transcribeAudio(audioPath, { languageHint: hintCode });

    // Resolve the final build language: explicit override wins, else Whisper's detection,
    // else fall back to English. Stored on scriptContext so all downstream steps see it.
    buildLanguage = resolveBuildLanguage(langOverride, transcription.language);
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

    actualAudioDuration = transcription.duration || (transcription.segments.length > 0 ? transcription.segments[transcription.segments.length - 1].end : 0);

    // ── Studio Plan: check if Style Studio produced a combined plan ──
    const studioPlan = _loadStudioPlan(actualAudioDuration);
    if (studioPlan) {
        log.step('🎨 Steps 3+4: Style Studio Plan (pre-built by agent)');
        let scenes = studioPlan.scenes;
        scriptContext = studioPlan.scriptContext;
        scriptContext.language = buildLanguage;
        if (directorsBrief.styleProfile) {
            scriptContext.styleProfile = directorsBrief.styleProfile;
            scriptContext.styleBlock = directorsBrief.styleBlock;
        }
        log.ok(`Loaded ${scenes.length} scenes from Style Studio plan`);

        // Step 3.5: Map Assignment — same deterministic gate as the normal
        // path. Runs once on the studio scenes, then the enforcer is applied
        // once against whichever scenes array reaches the pipeline
        // (pre-built OR VP-output). Slice 1 must gate both entry paths.
        try {
            const { assignMapDispositions, logDispositions } = require('./map-assignment');
            const dispositions = assignMapDispositions(scenes, scriptContext, scriptContext.styleProfile || null, null);
            logDispositions(dispositions, scriptContext);
            scriptContext._mapDispositions = dispositions;
        } catch (err) {
            log.warn(`Map assignment failed (studio): ${err.message} — enforcement skipped`);
            scriptContext._mapDispositions = null;
        }

        if (studioPlan.hasVisualPlan) {
            log.ok(`Visual plan included — skipping Step 4 (Visual Planner)`);
            scenesWithKeywords = scenes;
        } else {
            log.ok(`No visual plan — running Step 4 normally`);
            scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);
        }

        if (scriptContext._mapDispositions) {
            try {
                const { enforceDispositions } = require('./map-assignment');
                const { blocked, upgraded, upgradeSkipped } = enforceDispositions(scenesWithKeywords, scriptContext._mapDispositions);
                const finalMap = scenesWithKeywords.filter(s => typeof s.fullscreenMG === 'string' && s.fullscreenMG.toLowerCase().startsWith('mapchart'));
                console.log(`   [VP] Map disposition enforcement (studio): blocked=${blocked} upgraded=${upgraded} skipped=${upgradeSkipped}`);
                console.log(`   [VP] Final map scenes: ${finalMap.map(s => s.index).join(', ') || 'none'}  (${finalMap.length} of ${scenesWithKeywords.length})`);
            } catch (err) {
                log.warn(`Map disposition enforcement failed (studio): ${err.message}`);
            }
        }
        log.br();
    } else {
    // ── Normal path: AI Director + Visual Planner ──

    // Step 3: AI Director — Scene creation + context analysis + format detection
    log.step('🎬 Step 3: AI Director (Scene Creation + Context Analysis)');
    const dirResult = await analyzeAndCreateScenes(transcription, directorsBrief);
    let scenes = dirResult.scenes;
    scriptContext = dirResult.scriptContext;
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

    // Step 3.5: Map Assignment — deterministic per-scene disposition
    // (must_map | can_map | must_not_map). Runs BEFORE VP so the planner's
    // output can be gated. Part of the map-system rebuild (slice 1).
    try {
        const { assignMapDispositions, logDispositions } = require('./map-assignment');
        const dispositions = assignMapDispositions(scenes, scriptContext, scriptContext.styleProfile || null, null);
        logDispositions(dispositions, scriptContext);
        scriptContext._mapDispositions = dispositions;
    } catch (err) {
        log.warn(`Map assignment failed: ${err.message} — VP will run without disposition gate`);
        scriptContext._mapDispositions = null;
    }

    // Step 4: Visual Planning — Batch keywords + media type + source hints
    log.step('🎨 Step 4: Visual Planner (Batch Keyword Generation)');
    scenesWithKeywords = await planVisuals(scenes, scriptContext, directorsBrief);

    // Apply map-disposition gate: strip mapChart from must_not_map, upgrade must_map.
    if (scriptContext._mapDispositions) {
        try {
            const { enforceDispositions } = require('./map-assignment');
            const { blocked, upgraded, upgradeSkipped } = enforceDispositions(scenesWithKeywords, scriptContext._mapDispositions);
            const finalMap = scenesWithKeywords.filter(s => typeof s.fullscreenMG === 'string' && s.fullscreenMG.toLowerCase().startsWith('mapchart'));
            console.log(`   [VP] Map disposition enforcement: blocked=${blocked} upgraded=${upgraded} skipped=${upgradeSkipped}`);
            console.log(`   [VP] Final map scenes: ${finalMap.map(s => s.index).join(', ') || 'none'}  (${finalMap.length} of ${scenesWithKeywords.length})`);
        } catch (err) {
            log.warn(`Map disposition enforcement failed: ${err.message}`);
        }
    }

    // DEBUG: Stop after Visual Planner for testing
    if (process.env.STOP_AFTER === 'visual-planner') {
        log.ok('=== STOP_AFTER=visual-planner — dumping results ===');
        for (const s of scenesWithKeywords) {
            log.info(`Scene ${s.index}: keyword="${s.keyword}" fx=${s.effectPreset || (s.effects||[]).join(',') || 'none'} mgHint=${s.mgHint || 'null'}`);
        }
        log.ok('Visual Planner test complete.');
        process.exit(0);
    }

    } // end of studioPlan else (normal Director + VP path)

    // ── Step 4.1: Parse time-targeted directives from AI Instructions ──
    aiInstructions = directorsBrief.freeInstructions || '';
    if (aiInstructions) {
        const directiveCount = _applyTimeDirectives(aiInstructions, scenesWithKeywords, scriptContext);
        if (directiveCount > 0) {
            log.ok(`Applied ${directiveCount} time-targeted directive(s) from AI Instructions`);
        }
    }

    // Step 4.7: Compositor Planner — DISABLED (V2 overlay system needs rework)
    const nicheId = scriptContext.nicheId || 'general';

    // Promote mgHint → fullscreenMG when the hint is a fullscreen MG type.
    // This prevents wasted footage downloads for scenes the MG engine will cover
    // entirely — BUT only when it's safe:
    //   - not a hook scene (needs strong visual footage to grab attention)
    //   - not a CTA scene (needs closing footage, handled upstream by VP guard too)
    //   - not a scene the planner already chose a templateHint for (templates win)
    // Otherwise we silently swallow the AI's editorial intent.
    const { FULLSCREEN_MG_TYPES: _FSMG } = require('./ai-motion-graphics');
    const _hookEnd = parseFloat(scriptContext.hookEndTime);
    const _ctaStart = parseFloat(scriptContext.ctaStartTime);
    const _ctaOn = !!scriptContext.ctaDetected;
    const _phaseOf = (s) => {
        const st = s.startTime || 0;
        if (!Number.isNaN(_hookEnd) && st < _hookEnd) return 'hook';
        if (_ctaOn && !Number.isNaN(_ctaStart) && st >= _ctaStart) return 'cta';
        return 'body';
    };
    let _promoted = 0, _promoSkipped = 0;
    for (const s of scenesWithKeywords) {
        if (s.fullscreenMG) continue; // already set by VP
        if (!s.mgHint) continue;
        if (s.templateHint) continue; // planner chose a template — respect it

        const hintStr = String(s.mgHint).trim();
        const colonIdx = hintStr.indexOf(':');
        const hintType = colonIdx > 0 ? hintStr.substring(0, colonIdx).trim() : hintStr;
        if (!_FSMG.has(hintType)) continue;

        const phase = _phaseOf(s);
        if (phase === 'hook' || phase === 'cta') {
            _promoSkipped++;
            log.info(`   Scene ${s.index}: kept mgHint "${hintType}" as overlay (${phase} zone — no fullscreen promotion)`);
            continue;
        }

        s.fullscreenMG = s.mgHint;
        s.mgHint = null;
        s.keyword = null;
        s.stockQuery = null;
        s.webQuery = null;
        s.mediaType = null;
        s.sourceHint = null;
        _promoted++;
        log.info(`   Scene ${s.index}: promoted mgHint "${hintType}" → fullscreenMG (saves a download)`);
    }
    if (_promoted > 0 || _promoSkipped > 0) {
        log.info(`   🎛️  mgHint promoter: ${_promoted} promoted, ${_promoSkipped} kept as overlay`);
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
    buildManifest = null;
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

    // Slice 2: compile authoritative MapScene objects for every surviving map scene.
    // Runs ONCE on the FINAL post-orchestration state — after directives, mgHint promotion,
    // listicle injection, niche filtering, AND preBuildReview mutations — so MapScene
    // reflects the true fullscreen map state that will actually render.
    // Shared by both studio and normal paths (branch split ended above).
    try {
        const { compileMapScenes, logCompiledMapScenes } = require('./map-compiler');
        const { compiled, skipped } = compileMapScenes(scenesWithKeywords, scriptContext, scriptContext._mapDispositions || []);
        scriptContext._mapScenes = compiled;
        logCompiledMapScenes(compiled, skipped);
    } catch (err) {
        log.warn(`Map compiler failed: ${err.message} — downstream will use legacy payload only`);
    }

    // ── Save checkpoint (Steps 2-4.8 complete) ──
    // If the build fails later (download, MG, etc.), next build resumes from here.
    try {
        const checkpointData = {
            _savedAt: Date.now(),
            audioFile,
            transcription,
            buildLanguage,
            scenes: scenesWithKeywords,
            scriptContext,
            buildManifest,
            actualAudioDuration,
        };
        fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpointData));
        log.ok(`💾 Checkpoint saved — next build will resume from Step 5 if same audio`);
    } catch (e) {
        log.warn(`Checkpoint save failed: ${e.message}`);
    }

    } // end of fresh build else block

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

    // ── Explainer floating bias ──
    // Explainer videos (educational/documentary) feel more premium with floating
    // scenes mixed in. Convert ~40% of fullscreen wide scenes to floating with
    // slide animations. News stays as-is (urgent/raw look). Cinematic untouched.
    let explainerFloatingCount = 0;
    const isExplainer = (scriptContext?.nicheId || '').startsWith('explainer');
    if (isExplainer) {
        const FLOATING_BIAS = 0.4; // ~40% of eligible scenes flip to floating
        const FLOATING_ANIMS = ['slideRight', 'slideLeft', 'slideUp', 'fadeScale'];
        const pacing = scriptContext.pacing || 'moderate';
        const pacingBase = pacing === 'fast' ? 0.3 : pacing === 'slow' ? 0.7 : 0.5;

        // Eligible: wide-enough scenes with no AI framing tag (i.e. fellthrough to fullscreen)
        const eligible = scenesWithMedia.filter(s => {
            const w = s.mediaWidth || 0, h = s.mediaHeight || 0;
            if (w <= 0 || h <= 0) return false;
            const ratio = w / h;
            if (ratio < 1.2) return false;       // narrow — math already handled it
            if (s._framingLocked) return false;  // Visual Planner explicitly chose the framing
            if (s.framing === 'cinematic') return false; // AI chose cinematic, leave alone
            if (s.framing === 'floating') return false;  // already floating
            if (s.fullscreenMG) return false;    // MG scene, no footage framing
            return true;
        });

        // Deterministic stride pick — every Nth eligible scene becomes floating
        const stride = Math.max(2, Math.round(1 / FLOATING_BIAS)); // FLOATING_BIAS=0.4 → stride=3
        for (let i = 0; i < eligible.length; i++) {
            if (i % stride !== 1) continue; // pick 2nd, 5th, 8th...
            const scene = eligible[i];
            const w = scene.mediaWidth, h = scene.mediaHeight;
            const ratio = w / h;
            const targetRatio = 1920 / 1080;
            const fillFactor = Math.min(1, (ratio - 1.0) / (targetRatio - 1.0));
            const floatingScale = 0.45 + fillFactor * 0.10;

            scene.framing = 'floating';
            scene.fitMode = 'cover';
            scene.scale = Math.round(floatingScale * 100) / 100;
            scene.borderRadius = scene.borderRadius || 4;
            scene.shadow = scene.shadow !== undefined ? scene.shadow : 0.5;
            // Vary animation across scenes for visual rhythm
            scene.floatingAnim = scene.floatingAnim || FLOATING_ANIMS[i % FLOATING_ANIMS.length];
            const sceneDur = (scene.endTime || 0) - (scene.startTime || 0);
            const durationAdj = sceneDur < 4 ? -0.1 : sceneDur > 7 ? 0.15 : 0;
            scene.floatingAnimDuration = scene.floatingAnimDuration || Math.round((pacingBase + durationAdj) * 100) / 100;
            if (!scene.background || scene.background === 'none') {
                scene.background = 'blur';
            }
            scene.posX = scene.posX || 0;
            scene.posY = scene.posY || 0;
            // Bookkeeping — was counted as fullscreen, now floating
            fullscreenCount--;
            cinematicCount++;
            explainerFloatingCount++;
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
    if (explainerFloatingCount > 0) {
        log.ok(`Explainer bias: ${explainerFloatingCount} wide scenes flipped to floating with slide animation`);
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

    // Merge adjacent same-type fullscreen MGs into one continuous MG.
    // When the Visual Planner assigns (e.g.) mapChart to two consecutive scenes, each
    // becomes its own MG with a tiny gap between them — V1 footage from before the
    // first map peeks through that gap. Merging collapses them into a single animated
    // visual covering both scenes' data, which is the smarter planner behavior.
    const MERGE_GAP_THRESHOLD = 2.5; // seconds
    {
        const fsList = allMGs
            .filter(mg => mg.category === 'fullscreen')
            .sort((a, b) => a.startTime - b.startTime);
        const toRemove = new Set();
        let mergedCount = 0;
        const _normMapMode = (v) => {
            const s = String(v || '').toLowerCase();
            if (s === 'regionhighlight') return 'region';
            if (s === 'route' || s === 'locator' || s === 'region' || s === 'comparison') return s;
            return null;
        };
        const _mapModeOf = (mg) => {
            // _mapScene.mapMode is authoritative (reflects compiler promotions);
            // fall back to MG's own mapVariant/subType when the compiler didn't run.
            const owner = scenesWithKeywords.find(s => s && s.index === mg.sceneIndex);
            return _normMapMode(owner?._mapScene?.mapMode)
                || _normMapMode(mg.mapVariant || mg.subType);
        };
        for (let i = 0; i < fsList.length; i++) {
            const cur = fsList[i];
            if (toRemove.has(cur)) continue;
            for (let j = i + 1; j < fsList.length; j++) {
                const next = fsList[j];
                if (toRemove.has(next)) continue;
                if (next.type !== cur.type) break;
                const curEnd = cur.startTime + cur.duration;
                const gap = next.startTime - curEnd;
                if (gap > MERGE_GAP_THRESHOLD) break;
                // Policy: never merge adjacent fullscreen mapChart scenes when their
                // semantic purpose differs (route vs comparison vs locator vs region).
                // Prevents a route (Shanghai→Rotterdam) absorbing a neighboring locator
                // (Africa) into a held-wide comparison frame.
                if (cur.type === 'mapChart' && next.type === 'mapChart') {
                    const curMode = _mapModeOf(cur);
                    const nextMode = _mapModeOf(next);
                    if (curMode && nextMode && curMode !== nextMode) {
                        log.info(`   🚫 Refused mapChart merge scenes [${cur.sceneIndex}+${next.sceneIndex}]: semantic mismatch (${curMode} vs ${nextMode})`);
                        break;
                    }
                }
                const nextEnd = next.startTime + next.duration;
                cur.duration = Math.max(curEnd, nextEnd) - cur.startTime;
                const curText = (cur.text || '').trim();
                const nextText = (next.text || '').trim();
                if (nextText && nextText !== curText) {
                    cur.text = curText ? `${curText}, ${nextText}` : nextText;
                }
                const curSub = (cur.subtext || '').trim();
                const nextSub = (next.subtext || '').trim();
                if (nextSub && nextSub !== curSub) {
                    cur.subtext = curSub ? `${curSub} ${nextSub}` : nextSub;
                }
                cur._mergedFrom = (cur._mergedFrom || [cur.sceneIndex]).concat(next.sceneIndex);
                // Promote map variant so the planner produces enough waypoints
                // to pan/zoom from one location to the next across the merged span.
                // locator (1-2 wp) / regionHighlight (1-3 wp) → route (3-6 wp).
                if (cur.type === 'mapChart') {
                    const v = cur.mapVariant || cur.subType;
                    if (v === 'locator' || v === 'regionHighlight' || !v) {
                        cur.mapVariant = 'route';
                        cur.subType = 'route';
                    }
                }
                toRemove.add(next);
                mergedCount++;
            }
        }
        if (mergedCount > 0) {
            allMGs = allMGs.filter(mg => !toRemove.has(mg));
            log.info(`🔀 Merged ${mergedCount} adjacent fullscreen MG(s) with same type (gap ≤ ${MERGE_GAP_THRESHOLD}s) — one continuous visual instead of neighbors with a gap`);

            // Synthesize a unified MapScene for each merged mapChart MG so the
            // planner + provider see subjects from the WHOLE merged span, not
            // just the first owning scene. Without this, a merged route that
            // spans 3 scenes would only geocode the first scene's subjects.
            try {
                const { mergeMapScenes } = require('./map-compiler');
                // Slice 5a: pass the resolved niche map policy so the merged
                // MapScene uses niche-specific caps/minimums, matching what
                // compileMapScenes applied upstream.
                let _mergePolicy = null;
                try {
                    _mergePolicy = require('./niches').getNicheMapPolicy(scriptContext?.nicheId);
                } catch (_) { /* fall through to compiler defaults */ }
                let synthesized = 0;
                for (const mg of allMGs) {
                    if (mg.type !== 'mapChart') continue;
                    if (!Array.isArray(mg._mergedFrom) || mg._mergedFrom.length < 2) continue;
                    const owners = mg._mergedFrom
                        .map(idx => scenesWithKeywords.find(s => s && s.index === idx))
                        .filter(Boolean);
                    const sources = owners.map(s => s._mapScene).filter(Boolean);
                    if (sources.length < 2) continue; // single source → scene lookup suffices
                    const merged = mergeMapScenes(sources, mg.mapVariant, _mergePolicy);
                    if (merged) {
                        mg._mapScene = merged;
                        synthesized++;
                        log.dim(`   🔀 Merged MapScene for MG spanning scenes [${mg._mergedFrom.join(',')}]: ${merged.subjects.map(s => s.name).join(', ')} (${merged.mapMode})`);
                    }
                }
                if (synthesized > 0) {
                    log.info(`🧭 Synthesized ${synthesized} merged MapScene(s) for multi-scene map MG(s)`);
                }
            } catch (err) {
                log.warn(`Merged MapScene synthesis failed: ${err.message} — planner/provider will use first-scene MapScene only`);
            }
        }
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
        // Minimum V1 fragment duration. Anything shorter is a sliver — fullscreen MGs
        // cover those moments visually on V3, and carving them produces duplicate-text
        // fragments. Absorb them into an adjacent full scene instead of keeping them.
        const MIN_FRAGMENT_DUR = 1.5;
        const mgRanges = mgScenes.map(mg => ({ start: mg.startTime, end: mg.endTime }));
        let carved = [];
        let absorbedCount = 0;
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
            // Drop sub-threshold fragments so they don't leak duplicate text onto V1
            const kept = parts.filter(p => (p.endTime - p.startTime) >= MIN_FRAGMENT_DUR);
            absorbedCount += parts.length - kept.length;
            // Create scene copies for surviving parts
            for (const part of kept) {
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
        // Seamless coverage: extend kept scenes to close any sub-threshold gaps
        // created by dropped fragments. V1 should never have a visible gap — the
        // fullscreen MG on V3 covers the intended visual, and V1 bridges under it.
        carved.sort((a, b) => a.startTime - b.startTime);
        const mgIntersects = (s, e) => mgRanges.some(r => s < r.end && e > r.start);
        let bridged = 0;
        for (let i = 0; i < carved.length - 1; i++) {
            const cur = carved[i];
            const nxt = carved[i + 1];
            const gap = nxt.startTime - cur.endTime;
            if (gap > 0.01 && gap < MIN_FRAGMENT_DUR && !mgIntersects(cur.endTime, nxt.startTime)) {
                // Gap is not covered by any MG — extend current scene to close it
                cur.endTime = nxt.startTime;
                cur.duration = cur.endTime - cur.startTime;
                bridged++;
            }
        }
        const removed = scenesWithMedia.length - carved.length;
        scenesWithMedia = carved;
        if (removed > 0) log.info(`🔪 Carved ${removed} scene(s) to make room for full-screen MGs`);
        if (absorbedCount > 0) log.info(`🧹 Absorbed ${absorbedCount} sub-threshold fragment(s) (<${MIN_FRAGMENT_DUR}s) — prevents duplicate-text slivers`);
        if (bridged > 0) log.info(`🔗 Bridged ${bridged} V1 gap(s) left by absorbed fragments`);
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

    // Slice 4 (Apr 23): AI Map Planner deleted. Waypoints are now materialized
    // deterministically from MapScene.subjects inside map-provider.js — no
    // separate pipeline step, no AI narration re-parse.

    // Step 6.06: Download static map images for mapChart MGs (via MapTiler API)
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length > 0) {
        log.step('🗺️ Step 6.06: Map Images');
        try {
            const { downloadMapsForMGs } = require('./map-provider');
            // Slice 3: must pass the full compiled scene set (scenesWithKeywords) —
            // fullscreen map scenes are split out of scenesWithMedia at line 980,
            // so the provider would never find scene._mapScene there.
            const mapCount = await downloadMapsForMGs(allMGs, scriptContext, config.paths.temp, scenesWithKeywords);
            if (mapCount > 0) {
                log.ok(`Downloaded ${mapCount} map image(s) for ${mapMGs.length} mapChart scene(s)`);
            } else {
                log.dim('No map images downloaded (will use Canvas2D fallback)');
            }
        } catch (e) {
            log.warn(`Map download failed: ${e.message} (will use Canvas2D fallback)`);
        }
        log.br();

        // Step 6.07: Download contextual icons for map waypoints
        const mapsWithIcons = allMGs.filter(mg => mg.type === 'mapChart' && (mg._mapWaypoints?.some(wp => wp.icon) || mg._mapSwarms?.length > 0));
        if (mapsWithIcons.length > 0) {
            log.step('🏷️ Step 6.07: Map Waypoint Icons');
            try {
                const { downloadWaypointIcons, downloadMapIcon } = require('./icon-provider');
                let totalIcons = 0;
                for (const mg of mapsWithIcons) {
                    // Waypoint icons
                    const iconMap = await downloadWaypointIcons(mg);
                    // Swarm icons
                    if (mg._mapSwarms) {
                        for (const sw of mg._mapSwarms) {
                            for (const loc of sw.locations) {
                                if (!loc.icon) continue;
                                const iconPath = await downloadMapIcon(loc.icon);
                                if (iconPath) {
                                    iconMap[loc.name] = iconPath;
                                    loc._iconFile = iconPath;
                                }
                            }
                        }
                    }
                    const count = Object.keys(iconMap).length;
                    if (count > 0) {
                        mg._mapIcons = iconMap;
                        totalIcons += count;
                    }
                }
                if (totalIcons > 0) log.ok(`Downloaded ${totalIcons} map icon(s)`);
                else log.dim('No map icons downloaded');
            } catch (e) {
                log.warn(`Map icon download failed: ${e.message}`);
            }
            log.br();
        }

        // Propagate map data from allMGs to mgScenes (mgScenes are copies)
        for (const mg of fullscreenMGs) {
            if (mg.type !== 'mapChart') continue;
            const target = mgScenes.find(s => s.type === mg.type && s.startTime === mg.startTime);
            if (!target) continue;
            const mapSceneMode = mg._mapScene?.mapMode || null;
            const modeVariant = mapSceneMode === 'region' ? 'regionHighlight' : mapSceneMode;
            const effectiveVariant = mg.subType || mg.mapVariant || modeVariant || null;
            if (effectiveVariant && !target.subType) target.subType = effectiveVariant;
            if ((mg.mapVariant || modeVariant) && !target.mapVariant) target.mapVariant = mg.mapVariant || modeVariant;
            if (target.mgData) {
                if (effectiveVariant && !target.mgData.subType) target.mgData.subType = effectiveVariant;
                if ((mg.mapVariant || modeVariant) && !target.mgData.mapVariant) target.mgData.mapVariant = mg.mapVariant || modeVariant;
            }
            if (mg.mapImageFile) {
                target.mapImageFile = mg.mapImageFile;
                target._mapView = mg._mapView;
                if (mg._mapPins) target._mapPins = mg._mapPins;
                if (mg._osmBoundaries) target._osmBoundaries = mg._osmBoundaries;
            }
            // Waypoint animation data (materialized from MapScene in map-provider.js)
            if (mg._mapWaypoints) target._mapWaypoints = mg._mapWaypoints;
            if (mg._bigMapSize) target._bigMapSize = mg._bigMapSize;
            if (mg._wpCoords) target._wpCoords = mg._wpCoords;
            if (mg._mapBigMap) target._mapBigMap = mg._mapBigMap;
            if (mg._mapIcons) target._mapIcons = mg._mapIcons;
            if (mg._mapSwarms) target._mapSwarms = mg._mapSwarms;
            if (mg._mapRoutePath) {
                target._mapRoutePath = mg._mapRoutePath;
                if (target.mgData) target.mgData._mapRoutePath = mg._mapRoutePath;
            }
            if (mg._mapRouteGeometry) {
                target._mapRouteGeometry = mg._mapRouteGeometry;
                if (target.mgData) target.mgData._mapRouteGeometry = mg._mapRouteGeometry;
            }
            if (mg._mapAlternateRouteGeometry) {
                target._mapAlternateRouteGeometry = mg._mapAlternateRouteGeometry;
                if (target.mgData) target.mgData._mapAlternateRouteGeometry = mg._mapAlternateRouteGeometry;
            }
            // Phase B prep: the authoritative MapScene (subjects, cameraPlan,
            // annotationPlan, geometry, renderAssets) rides along on the scene
            // so the renderer can consume it directly in the next slice.
            if (mg._mapScene) target._mapScene = mg._mapScene;
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

            // Copy the underlying V1 scene's media file to each template as a FALLBACK bg.
            // Only when the template did NOT already get a dedicated bg (tpl-bg-*.jpg),
            // since the renderer prefers templateMediaFile over templateBgFile — reusing the
            // scene clip there would make the template visually identical to surrounding footage.
            for (const tpl of templateScenes) {
                if (tpl.templateBgFile) {
                    log.dim(`   🎨 [${tpl.type}] using dedicated bg: ${tpl.templateBgFile}`);
                    continue;
                }
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
                const MIN_FRAGMENT_DUR = 1.5;
                const tplRanges = templateScenes.map(tpl => ({ start: tpl.startTime, end: tpl.endTime }));
                let carved = [];
                let absorbedCount = 0;
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
                    const kept = parts.filter(p => (p.endTime - p.startTime) >= MIN_FRAGMENT_DUR);
                    absorbedCount += parts.length - kept.length;
                    for (const part of kept) {
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
                // Seamless coverage: bridge sub-threshold gaps left by absorbed fragments
                carved.sort((a, b) => a.startTime - b.startTime);
                const tplIntersects = (s, e) => tplRanges.some(r => s < r.end && e > r.start);
                let bridged = 0;
                for (let i = 0; i < carved.length - 1; i++) {
                    const cur = carved[i];
                    const nxt = carved[i + 1];
                    const gap = nxt.startTime - cur.endTime;
                    if (gap > 0.01 && gap < MIN_FRAGMENT_DUR && !tplIntersects(cur.endTime, nxt.startTime)) {
                        cur.endTime = nxt.startTime;
                        cur.duration = cur.endTime - cur.startTime;
                        bridged++;
                    }
                }
                const tplRemoved = scenesWithMedia.length - carved.length;
                scenesWithMedia = carved;
                if (tplRemoved > 0) log.info(`🔪 Carved ${tplRemoved} scene(s) to make room for templates`);
                if (absorbedCount > 0) log.info(`🧹 Absorbed ${absorbedCount} sub-threshold template fragment(s) (<${MIN_FRAGMENT_DUR}s)`);
                if (bridged > 0) log.info(`🔗 Bridged ${bridged} V1 gap(s) left by absorbed template fragments`);
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

    // Step 6.95: Download real SFX from Freesound API
    {
        const transitionTypes = new Set();
        for (const scene of scenesWithMedia) {
            if (scene.transition?.type && scene.transition.type !== 'cut' && scene.transition.type !== 'none') {
                transitionTypes.add(scene.transition.type);
            }
        }
        // Collect MG types too — fullscreenMG on scenes + overlay MGs in allMGs
        const mgTypes = new Set();
        for (const scene of scenesWithMedia) {
            if (scene.fullscreenMG) {
                const colonIdx = scene.fullscreenMG.indexOf(':');
                const t = colonIdx > 0 ? scene.fullscreenMG.substring(0, colonIdx).trim() : scene.fullscreenMG.trim();
                if (t) mgTypes.add(t);
            }
        }
        if (Array.isArray(allMGs)) {
            for (const mg of allMGs) {
                if (mg?.type) mgTypes.add(mg.type);
            }
        }
        if (Array.isArray(templateScenes)) {
            for (const tpl of templateScenes) {
                if (tpl?.type) mgTypes.add(tpl.type);
            }
        }
        if (transitionTypes.size > 0 || mgTypes.size > 0) {
            log.step('🔊 Step 6.95: SFX Download');
            try {
                const { downloadSfxForTransitions } = require('./sfx-provider');
                const sfxResult = await downloadSfxForTransitions([...transitionTypes], { mgTypes: [...mgTypes], log });
                if (sfxResult.noKey) {
                    log.warn('No FREESOUND_API_KEY — using bundled SFX');
                } else if (sfxResult.downloaded > 0) {
                    log.ok(`Downloaded ${sfxResult.downloaded} real SFX (${sfxResult.skipped} cached, ${sfxResult.failed} fallback)`);
                } else {
                    log.ok(`All ${sfxResult.skipped} SFX already cached`);
                }
            } catch (e) {
                log.warn(`SFX download failed: ${e.message} — using bundled SFX`);
            }
            log.br();
        }
    }

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

    // Generate SFX clips for the video plan (used by export muxer)
    const planSfxClips = [];
    try {
        const { TRANSITION_TO_SFX, MG_TO_SFX } = require('./sfx-provider');
        const transitionSfxDurations = {
            fade: 0.5,
            fade_to_black: 0.4,
            dissolve: 0.5,
            crossfade: 0.5,
            blur: 0.5,
            crossBlur: 0.5,
            morph: 0.5,
            dreamFade: 0.5,
            colorFade: 0.5,
            luma: 0.5,
            lumaFade: 0.5,
            lumaDark: 0.5,
            filmBurn: 0.6,
            filmGrain: 0.6,
            reveal: 0.6,
            ink: 0.6,
            shadowWipe: 0.3,
            ripple: 0.7,
            wipe: 0.3,
            slide: 0.4,
            push: 0.4,
            swipe: 0.3,
            splitWipe: 0.3,
            zoom: 0.5,
            zoomBlur: 0.5,
            zoomOut: 0.5,
            zoomRotate: 0.6,
            panLeft: 0.4,
            panRight: 0.4,
            panUp: 0.4,
            panDown: 0.4,
            whip: 0.3,
            whipPan: 0.3,
            directionalBlur: 0.3,
            spin: 0.6,
            bounce: 0.4,
            lightLeak: 0.6,
            warmLeak: 0.6,
            coolLeak: 0.6,
            flare: 0.6,
            flash: 0.3,
            cameraFlash: 0.3,
            vignetteBlink: 0.3,
            glitch: 0.4,
            pixelate: 0.4,
            mosaic: 0.4,
            dataMosh: 0.4,
            scanline: 0.5,
            rgbSplit: 0.4,
            static: 0.5,
            prismShift: 0.5,
            diagonalStripes: 0.3,
            rectangles: 0.3,
            diamonds: 0.4,
            blinds: 0.4,
            circles: 0.5,
            shutterSlice: 0.3,
        };
        const mgSfxDurations = {
            headline: 0.25,
            lowerThird: 0.35,
            callout: 0.35,
            focusWord: 0.25,
            statCounter: 0.15,
            progressBar: 0.15,
            bulletList: 0.25,
            barChart: 0.4,
            donutChart: 0.4,
            comparisonCard: 0.4,
            timeline: 0.5,
            rankingList: 0.5,
            kineticText: 0.2,
            typewriter: 0.3,
            subscribeCTA: 0.5,
            mapChart: 0.4,
            explainer: 0.35,
            listicleCounter: 0.15,
            progressTracker: 0.15,
            splitScreen: 0.35,
            infographic: 0.4,
            factCard: 0.25,
            statCard: 0.4,
            personIntro: 0.35,
            imageShowcase: 0.25,
            listicleGrid: 0.25,
            chapterCard: 0.35,
            locationCard: 0.35,
            quoteCard: 0.5,
            keyTakeaway: 0.4,
            timelineCard: 0.5,
        };

        // Transition SFX — at each scene boundary
        const sortedScenes = [...allScenes].filter(s => !s.isMGScene).sort((a, b) => a.startTime - b.startTime);
        for (let i = 1; i < sortedScenes.length; i++) {
            const prev = sortedScenes[i - 1];
            const curr = sortedScenes[i];
            if (Math.abs(curr.startTime - prev.endTime) > 0.1) continue;
            const transType = curr.transition?.type || 'crossfade';
            if (transType === 'cut' || transType === 'none') continue;
            const sfxFile = TRANSITION_TO_SFX[transType] || 'sfx-fade.mp3';
            const sfxDuration = transitionSfxDurations[transType] || Math.max(0.3, (curr.transition?.duration || 0.5) + 0.1);
            planSfxClips.push({
                file: sfxFile,
                startTime: Math.max(0, curr.startTime - 0.15),
                duration: sfxDuration,
                volume: 0.35,
                transitionType: transType,
            });
        }

        // MG SFX — on MG enter
        const allMGsForSfx = [...(motionGraphics || []), ...(mgScenes || []), ...(templateScenes || [])];
        for (const mg of allMGsForSfx) {
            if (mg.disabled) continue;
            const sfxFile = MG_TO_SFX[mg.type];
            if (!sfxFile) continue;
            planSfxClips.push({
                file: sfxFile,
                startTime: mg.startTime || 0,
                duration: mgSfxDurations[mg.type] || 0.5,
                volume: 0.25,
                transitionType: mg.type,
            });
        }
        if (planSfxClips.length > 0) {
            log.ok(`Generated ${planSfxClips.length} SFX clips for plan (${planSfxClips.filter(s => s.volume > 0.3).length} transition + ${planSfxClips.filter(s => s.volume <= 0.3).length} MG)`);
        }
    } catch (e) { log.warn(`SFX clip generation failed: ${e.message}`); }

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
        sfxClips: planSfxClips,
        sfxEnabled: true,
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

    // ── Clean up checkpoint on successful build ──
    try {
        if (fs.existsSync(CHECKPOINT_FILE)) {
            fs.unlinkSync(CHECKPOINT_FILE);
            log.dim('   🗑️ Build checkpoint cleared (build succeeded)');
        }
    } catch (_) {}
}

// Run
buildVideo().then(() => {
    // Force-exit: some providers (Gemini/Vertex SDK, keep-alive HTTP agents,
    // telegram-sdk sockets) keep the event loop alive after BUILD COMPLETE,
    // so main.js's child_process 'close' never fires and the UI hangs at
    // "Build complete!" with the Cancel button still visible. Flush logs and
    // exit explicitly — this is a CLI, not a server.
    setImmediate(() => process.exit(0));
}).catch(error => {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
});
