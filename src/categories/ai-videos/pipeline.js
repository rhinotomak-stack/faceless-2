// src/categories/ai-videos/pipeline.js
// ============================================================================
// The AI Videos pipeline — the isolated "script → generated clips" flow, kept in
// ONE place so the whole feature is self-contained. Every stage is a named seam
// backed by its own module, so "add a feature to AI Videos" means editing one file
// in this folder, never the shared build pipeline.
//
// Stages (buildAiVideosProject runs them in order):
//   1. INPUT      script-input.js   — normalize pasted story/link → clean script   [DONE]
//   2. SCENES     scene-planner.js  — script → quality-aware scene beats
//   3. PROMPTS    prompt-generator.js — per-scene → styled generation prompt
//   4. GENERATE   generate.js       — Kling/Veo generation (dry-run in tests)
//   5. PLAN       plan-builder.js   — renderer-ready video-plan.json
// ============================================================================
'use strict';

const scriptInput = require('./script-input');

// Optional stage modules — loaded only if present, so the pipeline never breaks as
// stages are added one at a time.
function optional(mod) {
    try { return require(mod); } catch (_) { return null; }
}

// ctx is a single object threaded through every stage (the AI Videos BuildContext).
// Stages mutate/extend it and return it. Keeping ONE ctx makes adding a stage that
// needs data from an earlier one trivial.
async function buildAiVideosProject(input = {}, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const ctx = {
        rawInput: input.script != null ? input.script : input,
        opts,
        scriptText: '',
        paragraphs: [],
        scenes: [],
        prompts: [],
        clips: [],
        plan: null,
        stage: 'start',
    };

    // ── Stage 1: INPUT ──────────────────────────────────────────────────────
    ctx.scriptText = scriptInput.normalizeScript(ctx.rawInput);
    ctx.paragraphs = scriptInput.toParagraphs(ctx.scriptText);
    ctx.isLink = scriptInput.isLink(ctx.rawInput);
    ctx.wordCount = scriptInput.wordCount(ctx.scriptText);
    ctx.stage = 'input';
    log(`  [AI Videos] script normalized: ${ctx.wordCount} words, ${ctx.paragraphs.length} paragraph(s)${ctx.isLink ? ' (input resembles an unresolved path/URL)' : ''}`);
    if (!ctx.scriptText) { ctx.stage = 'empty'; return ctx; }

    // ── Stage 2: SCENES ─────────────────────────────────────────────────────
    const scenePlanner = optional('./scene-planner');
    if (scenePlanner && typeof scenePlanner.planScenes === 'function') {
        ctx.scenes = await scenePlanner.planScenes(ctx, opts);
        ctx.stage = 'scenes';
        log(`  [AI Videos] planned ${ctx.scenes.length} scene(s)`);
    }

    // ── Stage 3: PROMPTS ────────────────────────────────────────────────────
    const promptGen = optional('./prompt-generator');
    if (promptGen && typeof promptGen.generateScenePrompts === 'function' && ctx.scenes.length) {
        ctx.prompts = await promptGen.generateScenePrompts(ctx, opts);
        ctx.stage = 'prompts';
    }

    // ── Stage 4: GENERATE ── dry-run by default (opts.generate === true → real Kling/Veo)
    const generate = optional('./generate');
    if (generate && typeof generate.generateClips === 'function' && ctx.prompts.length) {
        ctx.clips = await generate.generateClips(ctx, opts);
        ctx.stage = 'generate';
        const made = ctx.clips.filter((c) => c.file).length;
        log(`  [AI Videos] ${opts.generate ? `generated ${made}/${ctx.clips.length} clip(s)` : `dry-run: ${ctx.clips.length} clip(s) to generate`}`);
    }

    // ── Stage 5: PLAN ── assemble a renderer-ready video-plan
    const planBuilder = optional('./plan-builder');
    if (planBuilder && typeof planBuilder.buildPlan === 'function' && ctx.scenes.length) {
        ctx.plan = planBuilder.buildPlan(ctx, opts);
        ctx.stage = 'plan';
        log(`  [AI Videos] plan assembled: ${ctx.plan.scenes.length} scene(s), ${ctx.plan.totalDuration}s`);
    }

    return ctx;
}

module.exports = { buildAiVideosProject };
