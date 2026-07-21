#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const { generateHyperframesProject } = require(path.join(ROOT, 'src', 'render', 'hyperframes-bridge'));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-hf-smoke-'));
const projectDir = path.join(smokeRoot, 'project');

try {
    for (const name of ['temp', 'public', 'input']) {
        fs.mkdirSync(path.join(projectDir, name), { recursive: true });
    }
    const smokeImage = new PNG({ width: 8, height: 8 });
    for (let offset = 0; offset < smokeImage.data.length; offset += 4) {
        smokeImage.data[offset] = 48;
        smokeImage.data[offset + 1] = 96;
        smokeImage.data[offset + 2] = 160;
        smokeImage.data[offset + 3] = 255;
    }
    fs.writeFileSync(path.join(projectDir, 'input', 'smoke.png'), PNG.sync.write(smokeImage));

    const plan = {
        audio: null,
        subtitlesEnabled: true,
        captionKaraoke: true,
        captionWordsPerCue: 2,
        captionMaxDuration: 1.2,
        captionStyle: {
            position: 'top',
            background: 'none',
            color: '#ffffff',
            activeColor: '#ef4444',
            fontSize: 38,
        },
        totalDuration: 2,
        fps: 30,
        width: 1920,
        height: 1080,
        scenes: [
            {
                index: 0,
                sourceSceneIndex: 0,
                clipId: 'clip-smoke-a',
                startTime: 0,
                endTime: 1,
                duration: 1,
                text: 'HyperFrames smoke scene A',
                words: [
                    { word: 'HyperFrames', start: 0.05, end: 0.35 },
                    { word: 'smoke', start: 0.36, end: 0.62 },
                    { word: 'scene', start: 0.63, end: 0.82 },
                    { word: 'A', start: 0.83, end: 0.96 },
                ],
                mediaType: 'image',
                mediaFile: 'smoke.png',
                kenBurnsEnabled: false,
                framing: 'cinematic',
                scale: 0.75,
                _effectRecipe: [{
                    id: 'vignette',
                    intensity: 0.3,
                    color: '#000000',
                    userDirected: true,
                }],
                trackId: 'video-track-1',
            },
            {
                index: 0,
                sourceSceneIndex: 0,
                clipId: 'clip-smoke-b',
                startTime: 1,
                endTime: 2,
                duration: 1,
                mediaOffset: 1,
                text: 'HyperFrames smoke scene B',
                mediaType: 'image',
                mediaFile: 'smoke.png',
                kenBurnsSpeed: 1.5,
                trackId: 'video-track-1',
            },
        ],
        mgScenes: [],
        templateScenes: [
            {
                type: 'statCard',
                templateType: 'statCard',
                text: '$640 Project Cost',
                subtext: 'Stage visual behind the overlay',
                items: [{ value: '$640', label: 'Project Cost' }],
                sceneIndex: 0,
                startTime: 0.1,
                endTime: 0.9,
            },
        ],
        motionGraphics: [
            {
                type: 'lowerThird',
                text: '50 Years',
                subtext: 'Numeric directive overlay',
                textStyleRanges: [{
                    match: '50 Years',
                    color: '#ef4444',
                    occurrence: 0,
                    allOccurrences: false,
                }],
                sceneIndex: 0,
                startTime: 0.1,
                endTime: 0.9,
            },
            {
                id: 'smoke-headline',
                clipId: 'smoke-headline',
                type: 'headline',
                text: 'Typed white headline',
                subtext: '',
                sceneIndex: 1,
                startTime: 1.1,
                endTime: 1.9,
                subType: 'typewriter',
                animation: 'typewriter',
                animationManual: true,
                variantManual: true,
                accentRuleVisible: false,
                transparentBackground: true,
                cardStyle: 'transparent',
                colors: {
                    text: '#ffffff',
                    background: 'rgba(0,0,0,0)',
                    surface: 'rgba(0,0,0,0)',
                },
                _authoredComposition: {
                    html: '<div class="stale-authored-headline">STALE CREAM HEADLINE</div>',
                    css: '.stale-authored-headline{background:#ece0c8;color:#2c2218;}',
                    timeline: 'tl.to(".stale-authored-headline",{opacity:1});',
                },
            },
        ],
        transitions: [
            {
                type: 'wipe-left',
                fromSceneIndex: 0,
                toSceneIndex: 1,
                startTime: 0.7,
                endTime: 1.3,
                duration: 0.6,
            },
        ],
        sfxClips: [],
        scriptContext: { title: 'HyperFrames smoke', themeId: 'standard' },
        themeId: 'standard',
    };

    const result = generateHyperframesProject({
        plan,
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });

    assert(result?.success === true, 'bridge did not report success');
    assert(fs.existsSync(result.indexPath), 'bridge did not create index.html');
    assert(fs.existsSync(path.join(result.projectDir, 'video-plan.snapshot.json')), 'bridge did not create a plan snapshot');
    assert(fs.existsSync(path.join(result.projectDir, 'hyperframes-motion-manifest.json')), 'bridge did not create the Motion QA manifest');
    assert(fs.existsSync(path.join(result.projectDir, 'vendor', 'gsap.min.js')), 'bridge did not copy the local GSAP runtime');

    const html = fs.readFileSync(result.indexPath, 'utf8');
    assert(html.includes("window.__timelines['yta-hyperframes']"), 'generated project is missing the HyperFrames timeline');
    assert(html.includes('data-duration="2.000"'), 'generated project has the wrong duration');
    assert(html.includes('data-visible-transition-count="1"'), 'generated project is missing its visible transition diagnostics');
    assert(html.includes('data-motion-transition-count="1"'), 'generated project did not classify the wipe as scene motion');
    assert((html.match(/class="hf-scene-media fit-/g) || []).length >= 2, 'generated project is missing copied scene media');
    assert(html.includes('top: 72px; bottom: auto; align-items: flex-start;'), 'caption position setting did not reach the renderer');
    assert(html.includes('padding: 0; background: transparent; border-radius: 0;'), 'caption background setting did not reach the renderer');
    assert(html.includes('font-size: 38px;'), 'caption font-size setting did not reach the renderer');
    assert(html.includes('color: "#ef4444"'), 'karaoke active color did not reach the timeline');
    assert((html.match(/class="hf-cap-word"/g) || []).length === 4, 'karaoke caption words were not emitted');
    assert(html.includes('id="scene-clip-smoke-a-fx-vig"'), 'user-directed vignette was suppressed on a framed clip');
    assert(html.includes('rgba(0,0,0,'), 'user-directed black vignette color did not reach HyperFrames');
    assert(html.includes('id="scene-clip-smoke-a"'), 'first duplicate-source clip has the wrong DOM identity');
    assert(html.includes('id="scene-clip-smoke-b"'), 'second duplicate-source clip has the wrong DOM identity');
    const lowerThirdTag = html.match(/<[^>]+id="mg-\d+-lower-third"[^>]+>/)?.[0] || '';
    const statCardTag = html.match(/<[^>]+id="mg-\d+-stat-card"[^>]+>/)?.[0] || '';
    const lowerThirdTrack = Number(lowerThirdTag.match(/data-track-index="(\d+)"/)?.[1]);
    const statCardTrack = Number(statCardTag.match(/data-track-index="(\d+)"/)?.[1]);
    assert(lowerThirdTag && statCardTag, 'generated project is missing the overlapping stage/overlay graphics');
    assert(lowerThirdTrack > statCardTrack, 'overlay graphic is not layered above its stage visual');
    assert(
        html.includes('class="hf-agentic-text-range" data-hf-text-range="50 Years" data-hf-text-range-color="#ef4444"'),
        'selective lower-third text color was not rendered as an in-place styled range'
    );
    assert(
        html.includes('.hf-agentic-text-range { color: var(--hf-text-range-color, currentColor); }'),
        'generated project is missing the selective text-range style contract'
    );
    const headlineTag = html.match(/<[^>]+id="mg-\d+-headline"[^>]+>/)?.[0] || '';
    assert(headlineTag.includes('hf-card-transparent'), 'transparent headline card state did not reach HyperFrames');
    assert(headlineTag.includes('hf-variant-typewriter'), 'headline typewriter variant did not reach HyperFrames');
    assert(headlineTag.includes('hf-anim-typewriter'), 'headline typewriter animation did not reach HyperFrames');
    assert(headlineTag.includes('hf-no-accent-rule'), 'headline accent-rule removal did not reach HyperFrames');
    assert(headlineTag.includes('--hf-text: #ffffff'), 'headline text color did not reach HyperFrames');
    assert(!html.includes('STALE CREAM HEADLINE'), 'stale authored headline overrode the explicit Agent edit');
    assert(
        html.includes('class="hf-agentic-title hf-agentic-typewriter"'),
        'agentic headline did not emit a typewriter reveal target'
    );
    assert(
        html.includes('.hf-card-transparent .hf-agentic-copy'),
        'transparent cards do not suppress the agentic composition background'
    );
    assert(
        html.includes("item.animation === 'typewriter' || item.variant === 'typewriter'"),
        'HyperFrames runtime is missing typewriter animation dispatch for headline variants'
    );
    assert(!html.includes('<div class="hf-title">$640 Project Cost</div>'), 'single-item stat card must not repeat its value/label as a second title');
    assert(html.includes('<span class="hf-item-value">$640</span>'), 'single-item stat card must keep the hero value');
    assert(html.includes('<span class="hf-item-label">Project Cost</span>'), 'single-item stat card must keep the value label');
    assert(html.includes('.hf-type-lower-third.hf-variant-underline .hf-agentic-copy { justify-self: start; width: fit-content;'), 'underline lower third must stay content-width instead of drawing a frame-wide rule');
    assert(html.includes('padding: 14px 8px 28px'), 'underline lower third must keep clear vertical space between text and its rule');
    assert(html.includes('src="vendor/gsap.min.js"'), 'generated project does not use the local GSAP runtime');
    assert(!html.includes('cdn.jsdelivr.net'), 'generated project still depends on the GSAP CDN');
    const generatedPackage = JSON.parse(fs.readFileSync(path.join(result.projectDir, 'package.json'), 'utf8'));
    assert(generatedPackage.scripts?.check, 'generated project is missing the HyperFrames check command');
    assert(generatedPackage.scripts?.keyframes, 'generated project is missing the HyperFrames keyframes command');
    assert(generatedPackage.scripts?.snapshot, 'generated project is missing the HyperFrames snapshot command');
    const motionManifest = JSON.parse(fs.readFileSync(path.join(result.projectDir, 'hyperframes-motion-manifest.json'), 'utf8'));
    assert(motionManifest.scenes.find((scene) => scene.id === 'scene-clip-smoke-a')?.hasKenBurns === false, 'explicit Ken Burns disable was ignored');
    assert(motionManifest.scenes.find((scene) => scene.id === 'scene-clip-smoke-b')?.hasKenBurns === true, 'Ken Burns speed-enabled still did not animate');
    const headlineManifest = motionManifest.graphics.find((graphic) => graphic.sourceClipId === 'smoke-headline');
    assert(headlineManifest, 'edited headline is missing from the render manifest');
    assert(headlineManifest.authored === false, 'edited headline still rendered through its stale authored composition');
    assert(headlineManifest.fixedRendererOverride === true, 'edited headline did not declare its fixed-renderer override');
    assert(headlineManifest.transparentBackground === true, 'edited headline lost its transparent background in the render manifest');
    assert(headlineManifest.animation === 'typewriter', 'edited headline lost its typewriter animation in the render manifest');
    assert(headlineManifest.textColor === '#ffffff', 'edited headline lost its white text color in the render manifest');
    assert(headlineManifest.accentRuleVisible === false, 'edited headline restored its decorative accent rule');

    const secondResult = generateHyperframesProject({
        plan: {
            ...plan,
            scriptContext: { ...plan.scriptContext, title: 'HyperFrames immediate regeneration' },
        },
        projectDir,
        appRoot: ROOT,
        tempDir: path.join(projectDir, 'temp'),
        publicDir: path.join(projectDir, 'public'),
        inputDir: path.join(projectDir, 'input'),
        outputRoot: path.join(projectDir, 'hyperframes'),
    });
    assert(secondResult.projectDir !== result.projectDir, 'immediate preview regenerations reused the same project directory');
    assert(fs.existsSync(secondResult.indexPath), 'immediate preview regeneration did not create a distinct index.html');

    console.log('[hyperframes-smoke] generated a valid project, timeline, and unique immediate regeneration');
    console.log('✅ HyperFrames bridge smoke passed');
} finally {
    const resolved = path.resolve(smokeRoot);
    const tempRoot = path.resolve(os.tmpdir());
    const safePrefix = tempRoot.endsWith(path.sep) ? tempRoot : tempRoot + path.sep;
    if (!resolved.startsWith(safePrefix) || !path.basename(resolved).startsWith('yta-hf-smoke-')) {
        throw new Error(`Refusing to clean unsafe smoke directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}
