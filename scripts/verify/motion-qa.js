#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    applyDiagnosticRepairs,
    applyManifestTimingRepairs,
    listSnapshotFrameNames,
    prepareMotionPlan,
} = require('../../src/agents/workers/motion-qa-agent');

const originalFlag = process.env.HF_MOTION_QA;
delete process.env.HF_MOTION_QA;

try {
    const plan = {
        fps: 30,
        totalDuration: 10,
        scenes: [
            { index: 0, startTime: 0, endTime: 5 },
            { index: 1, startTime: 5, endTime: 10 },
        ],
        motionGraphics: [
            {
                type: 'lowerThird',
                text: 'A readable lower third with several important words',
                startTime: 0.5,
                endTime: 1.1,
                duration: 0.6,
                position: 'bottom-left',
                agenticComposition: { motion: { speed: 0.2, stagger: 0.2 } },
            },
            {
                type: 'callout',
                text: 'The next overlay',
                startTime: 3.2,
                endTime: 4.8,
                duration: 1.6,
                position: 'bottom-left',
            },
        ],
        mgScenes: [],
        templateScenes: [],
    };

    const preflight = prepareMotionPlan(plan);
    assert.ok(preflight.repairs.length > 0, 'short/slow motion should be repaired');
    assert.ok(plan.motionGraphics[0].endTime > 1.1, 'readable hold should extend when the scene has room');
    assert.ok(plan.motionGraphics[0].endTime <= plan.motionGraphics[1].startTime - 0.079, 'repair must not collide with the next same-zone overlay');
    assert.ok(plan.motionGraphics[0].animationSpeed >= 0.65, 'unsafe slow motion speed should be clamped');
    assert.strictEqual(plan.motionGraphics[0].durationUnit, 'seconds');
    assert.strictEqual(plan.motionGraphics[0].durationFrames, Math.round(plan.motionGraphics[0].duration * 30));

    const manualPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [{
            type: 'callout',
            text: 'Manual timing',
            startTime: 1,
            endTime: 1.4,
            duration: 0.4,
            timingManual: true,
            animationManual: true,
            animationSpeed: 0.3,
        }],
        mgScenes: [],
        templateScenes: [],
    };
    const manualBefore = JSON.stringify(manualPlan.motionGraphics[0]);
    const manualResult = prepareMotionPlan(manualPlan);
    assert.strictEqual(JSON.stringify(manualPlan.motionGraphics[0]), manualBefore, 'manual motion/timing must be preserved');
    assert.ok(manualResult.findings.some((finding) => finding.code === 'visual_window_too_short'), 'unsafe manual timing should be reported');

    const semanticPlan = {
        fps: 30,
        totalDuration: 9,
        scenes: [
            { index: 0, originalIndex: 0, startTime: 0, endTime: 1.5 },
            { index: 1, originalIndex: 1, startTime: 5, endTime: 9 },
        ],
        motionGraphics: [{
            type: 'lowerThird',
            text: '$1,250 Project Cost',
            startTime: 4.9,
            endTime: 7.2,
            duration: 2.3,
            position: 'bottom-left',
        }],
        mgScenes: [],
        templateScenes: [{
            type: 'statCard',
            text: '$1,250 Project Cost',
            items: [{ value: '$1,250', label: 'Project Cost' }],
            startTime: 1.5,
            endTime: 5,
            duration: 3.5,
            _authoredComposition: {
                html: '<div><strong>$1,250</strong><footer>$1,250 Project Cost</footer></div>',
                css: '',
                timeline: 'tl.to("#x", {opacity:1})',
            },
        }],
    };
    const semanticResult = prepareMotionPlan(semanticPlan);
    assert.strictEqual(semanticPlan.motionGraphics[0].disabled, true, 'adjacent stage/overlay treatments of the same fact should collapse to one');
    assert.strictEqual(semanticPlan.templateScenes[0]._authoredComposition, undefined, 'an authored stat that repeats its hero fact should fall back to the deterministic renderer');
    assert.ok(semanticResult.repairs.some(repair => repair.code === 'semantic_duplicate_suppressed'), 'semantic duplicate repair must be reported');
    assert.ok(semanticResult.repairs.some(repair => repair.code === 'authored_semantic_duplicate_fallback'), 'authored internal duplicate repair must be reported');

    const ownerlessStagePlan = {
        fps: 30,
        totalDuration: 8,
        scenes: [
            { index: 0, startTime: 0, endTime: 2 },
            { index: 1, startTime: 4, endTime: 8 },
        ],
        motionGraphics: [],
        mgScenes: [],
        templateScenes: [{
            type: 'chapterCard',
            text: 'A deliberately dense ownerless stage visual',
            startTime: 2,
            endTime: 2.5,
            duration: 0.5,
        }],
    };
    prepareMotionPlan(ownerlessStagePlan);
    assert.strictEqual(ownerlessStagePlan.templateScenes[0].endTime, 2.5, 'ownerless stage QA must not extend across a carved timeline gap');

    const timingPlan = {
        fps: 30,
        totalDuration: 6,
        scenes: [{ index: 0, startTime: 0, endTime: 6 }],
        motionGraphics: [{ type: 'headline', startTime: 1, endTime: 5, duration: 4 }],
        mgScenes: [],
        templateScenes: [],
    };
    const timingRepairs = applyManifestTimingRepairs(timingPlan, {
        graphics: [{
            id: 'mg-0-headline',
            sourceGroup: 'motionGraphics',
            sourceIndex: 0,
            start: 1,
            duration: 2.25,
            timingClamped: true,
        }],
    });
    assert.strictEqual(timingRepairs.length, 1);
    assert.strictEqual(timingPlan.motionGraphics[0].endTime, 3.25);
    assert.strictEqual(timingPlan.motionGraphics[0].durationFrames, 68);

    const authoredPlan = {
        fps: 30,
        totalDuration: 5,
        scenes: [{ index: 0, startTime: 0, endTime: 5 }],
        motionGraphics: [],
        mgScenes: [{
            type: 'statCard',
            startTime: 0,
            endTime: 4,
            _authoredComposition: { html: '<div></div>', css: '', timeline: 'tl.to("#x", {opacity:1})' },
            _authoredAssets: [{ token: '__HF_ASSET_0__' }],
        }],
        templateScenes: [],
    };
    const diagnosticRepairs = applyDiagnosticRepairs(
        authoredPlan,
        {
            graphics: [{
                id: 'mg-0-stat-card',
                sourceGroup: 'mgScenes',
                sourceIndex: 0,
                authored: true,
            }],
        },
        [{
            code: 'element_outside_frame',
            selector: '#mg-0-stat-card',
            message: 'Element is outside the composition frame',
        }]
    );
    assert.strictEqual(diagnosticRepairs.length, 1);
    assert.strictEqual(authoredPlan.mgScenes[0]._authoredComposition, undefined, 'broken authored motion should safely fall back');
    assert.strictEqual(authoredPlan.mgScenes[0]._authoredAssets, undefined);

    const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-motion-qa-frames-'));
    try {
        for (const name of ['frame-00.png', 'frame-01.jpg', 'contact-sheet.jpg', 'preview.png']) {
            fs.writeFileSync(path.join(snapshotDir, name), '');
        }
        assert.deepStrictEqual(
            listSnapshotFrameNames(snapshotDir),
            ['frame-00.png', 'frame-01.jpg'],
            'proof-frame discovery must never treat the contact sheet or preview image as a timeline frame'
        );
    } finally {
        const resolved = path.resolve(snapshotDir);
        const tempRoot = path.resolve(os.tmpdir()) + path.sep;
        if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('yta-motion-qa-frames-')) {
            throw new Error(`Refusing to clean unsafe Motion QA test directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }

    const mainSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'main.js'), 'utf8');
    const appSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ui', 'js', 'app.js'), 'utf8');
    assert.ok(mainSource.includes("stage: 'preview-preflight'"), 'HyperFrames preview must run Motion QA before generating');
    assert.ok(mainSource.includes("source: 'motion-qa-preview'"), 'preview Motion QA repairs must be pushed back into the editor');
    assert.ok(mainSource.includes("payload?.options?.persistMotionQa !== false"), 'preview Motion QA persistence must support read-only Agent refreshes');
    assert.ok(appSource.includes('_applyStructuralPlanRepairs(plan)'), 'editor must structurally apply preview Motion QA repairs');
    assert.ok(appSource.includes('persistMotionQa: false'), 'Agent plan refreshes must not create hidden Motion QA revisions');
    assert.ok(appSource.includes('pendingRefreshOptions'), 'queued HyperFrames refreshes must preserve the Agent read-only QA policy');
    assert.ok(appSource.includes('projectHydrating: false'), 'renderer must track project hydration');
    assert.ok(appSource.includes('if (state.projectHydrating) return;'), 'autosave must be suppressed while the authoritative project is hydrating');
    assert.ok(appSource.includes('if (result.planHash) state.projectPlanHash = result.planHash;'), 'preview response must synchronize authoritative project metadata');
    assert.ok(appSource.includes('Discarded a stale autosave after an authoritative QA update'), 'superseded QA autosaves must be discarded safely');

    console.log('✅ agentic Motion QA contract checks passed');
} finally {
    if (originalFlag === undefined) delete process.env.HF_MOTION_QA;
    else process.env.HF_MOTION_QA = originalFlag;
}
