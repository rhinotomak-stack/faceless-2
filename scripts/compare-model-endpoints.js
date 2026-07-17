#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            out[key] = true;
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

function parseList(value) {
    return String(value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function loadEnv(projectDir) {
    dotenv.config({ path: path.join(REPO_ROOT, '.env'), override: false });
    const projectEnv = path.join(projectDir, '.env');
    if (fs.existsSync(projectEnv)) {
        dotenv.config({ path: projectEnv, override: true });
    }
}

function loadProjectContext(projectDir) {
    const styleDir = path.join(projectDir, 'styles');
    const styleFile = fs.existsSync(styleDir)
        ? fs.readdirSync(styleDir).find(name => name.endsWith('.style.json'))
        : null;
    const style = styleFile
        ? fs.readFileSync(path.join(styleDir, styleFile), 'utf8')
        : '{}';

    const transcriptionPath = path.join(projectDir, 'temp', 'transcription.json');
    const transcription = fs.existsSync(transcriptionPath)
        ? JSON.parse(fs.readFileSync(transcriptionPath, 'utf8'))
        : { text: '', segments: [] };

    const fvpFile = fs.readdirSync(projectDir).find(name => name.endsWith('.fvp'));
    let scriptContext = {};
    if (fvpFile) {
        try {
            const fvp = JSON.parse(fs.readFileSync(path.join(projectDir, fvpFile), 'utf8'));
            scriptContext = fvp.videoPlan?.scriptContext || {};
        } catch {
            scriptContext = {};
        }
    }

    return { style, transcription, scriptContext };
}

function buildScenes(transcription, desiredCount = 19) {
    const segments = Array.isArray(transcription.segments) ? transcription.segments : [];
    if (!segments.length) {
        return [{ index: 0, start: 0, end: 8, text: transcription.text || 'No transcript available.' }];
    }

    const totalDuration = Math.max(...segments.map(s => Number(s.end) || 0), Number(transcription.duration) || 0);
    const bucketSec = totalDuration > 0 ? totalDuration / desiredCount : 8;
    const scenes = [];
    let current = [];
    let currentStart = Number(segments[0].start) || 0;
    let targetEnd = currentStart + bucketSec;

    for (const segment of segments) {
        current.push(segment);
        const end = Number(segment.end) || targetEnd;
        if (end >= targetEnd && scenes.length < desiredCount - 1) {
            scenes.push({
                index: scenes.length,
                start: currentStart,
                end,
                text: current.map(s => s.text || '').join(' ').replace(/\s+/g, ' ').trim(),
            });
            current = [];
            currentStart = end;
            targetEnd = currentStart + bucketSec;
        }
    }
    if (current.length) {
        scenes.push({
            index: scenes.length,
            start: currentStart,
            end: Number(current[current.length - 1].end) || currentStart + bucketSec,
            text: current.map(s => s.text || '').join(' ').replace(/\s+/g, ' ').trim(),
        });
    }
    return scenes.slice(0, desiredCount);
}

function buildPlannerPrompt({ style, transcription, scriptContext }, targetChars) {
    const scenes = buildScenes(transcription, 19);
    const compactContext = {
        title: scriptContext.videoTitle || 'Untitled video',
        nicheId: scriptContext.nicheId || 'auto',
        theme: scriptContext.theme || 'auto',
        tone: scriptContext.tone || 'auto',
        mood: scriptContext.mood || 'auto',
        pacing: scriptContext.pacing || 'auto',
        entities: scriptContext.entities || [],
        keyStats: scriptContext.keyStats || [],
        summary: scriptContext.summary || '',
        webContext: scriptContext.webContext || '',
    };

    const base = [
        'You are the Visual Planner for a documentary video builder.',
        'Return ONLY valid compact JSON. No markdown. No commentary.',
        'Task: choose visual treatment per scene while preserving scene count and scene index.',
        'Allowed source values: youtube, reddit, storyblocks, web-image, none, fs-mg.',
        'Allowed visualClass values: footage, template, overlay-mg, fullscreen-mg.',
        'Do not use vague keywords. Search keywords must be literal, concrete, and searchable.',
        'For templates, bgKeyword can be image OR video background search, but mark source separately.',
        'For fullscreen maps, source must be fs-mg and keyword should be empty.',
        'Return schema: {"scenes":[{"index":0,"visualClass":"footage","source":"youtube","keyword":"...","protectedTerms":["..."],"mgHint":"...","templateHint":"","fullscreenMG":""}]}',
        '',
        'PROJECT CONTEXT:',
        JSON.stringify(compactContext),
        '',
        'STYLE PROFILE:',
        style,
        '',
        'SCENES:',
        JSON.stringify(scenes),
    ].join('\n');

    if (base.length >= targetChars) return base;

    const repeatBlock = [
        '',
        'REFERENCE CONTEXT BLOCK - repeat is intentional for long-prompt stress testing. Use it only as background.',
        JSON.stringify({
            transcript: transcription.text || '',
            styleSummary: safeJsonParse(style)?.summary || '',
            entities: compactContext.entities,
            keyStats: compactContext.keyStats,
            webContext: compactContext.webContext,
        }),
    ].join('\n');

    let prompt = base;
    while (prompt.length < targetChars) {
        const remaining = targetChars - prompt.length;
        prompt += repeatBlock.slice(0, Math.min(repeatBlock.length, remaining));
    }
    return prompt;
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function extractJson(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fence ? fence[1].trim() : raw;
    try {
        return JSON.parse(candidate);
    } catch {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch {
                return null;
            }
        }
        return null;
    }
}

async function readOpenAIStream(stream, timeoutMs) {
    let buffer = '';
    let text = '';
    let firstTokenMs = null;
    const start = Date.now();

    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            stream.destroy(new Error(`stream timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        const finish = fn => value => {
            clearTimeout(timer);
            fn(value);
        };
        stream.on('data', chunk => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = trimmed.slice(5).trim();
                if (!payload || payload === '[DONE]') continue;
                try {
                    const json = JSON.parse(payload);
                    const delta = json.choices?.[0]?.delta?.content
                        ?? json.choices?.[0]?.message?.content
                        ?? '';
                    if (delta) {
                        if (firstTokenMs == null) firstTokenMs = Date.now() - start;
                        text += delta;
                    }
                } catch {
                    // Ignore malformed stream keepalive chunks.
                }
            }
        });
        stream.on('error', finish(reject));
        stream.on('end', finish(() => resolve({ text, firstTokenMs })));
    });
}

async function callChatCompletion({ name, baseUrl, key, model, prompt, maxTokens, timeoutMs, stream }) {
    const startedAt = Date.now();
    const body = {
        model,
        messages: [
            { role: 'system', content: 'Return valid JSON only. Keep it compact.' },
            { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        stream,
    };

    const controller = new AbortController();
    const hardTimer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await axios.post(`${baseUrl.replace(/\/$/, '')}/chat/completions`, body, {
            headers: {
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
            },
            timeout: timeoutMs,
            signal: controller.signal,
            responseType: stream ? 'stream' : 'json',
            validateStatus: status => status >= 200 && status < 500,
        });
    } catch (err) {
        clearTimeout(hardTimer);
        throw err;
    }

    if (response.status >= 400) {
        const message = typeof response.data === 'string'
            ? response.data
            : JSON.stringify(response.data || {});
        throw new Error(`${name} ${model} HTTP ${response.status}: ${message.slice(0, 500)}`);
    }

    if (stream) {
        try {
            const elapsed = Date.now() - startedAt;
            const { text, firstTokenMs } = await readOpenAIStream(response.data, Math.max(1000, timeoutMs - elapsed));
            clearTimeout(hardTimer);
            return { text, firstTokenMs, totalMs: Date.now() - startedAt };
        } catch (err) {
            clearTimeout(hardTimer);
            throw err;
        }
    }

    const text = response.data?.choices?.[0]?.message?.content || '';
    clearTimeout(hardTimer);
    return { text, firstTokenMs: null, totalMs: Date.now() - startedAt };
}

async function runOneTarget(target, prompt, options) {
    const keys = target.provider === 'qwen'
        ? parseList(process.env.QWEN_API_KEY)
        : parseList(process.env.NVIDIA_API_KEYS || process.env.NVIDIA_API_KEY);
    const baseUrl = target.provider === 'qwen'
        ? (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')
        : 'https://integrate.api.nvidia.com/v1';

    if (!keys.length) throw new Error(`No keys configured for ${target.provider}`);

    const attempts = [];
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const keyIndex = i + 1;
        try {
            const result = await callChatCompletion({
                name: target.provider,
                baseUrl,
                key,
                model: target.model,
                prompt,
                maxTokens: options.maxTokens,
                timeoutMs: options.timeoutMs,
                stream: options.stream,
            });
            const parsed = extractJson(result.text);
            const sceneCount = Array.isArray(parsed?.scenes) ? parsed.scenes.length : 0;
            return {
                provider: target.provider,
                model: target.model,
                ok: true,
                keyIndex,
                attempts: [...attempts, { keyIndex, ok: true }],
                firstTokenMs: result.firstTokenMs,
                totalMs: result.totalMs,
                chars: result.text.length,
                parseOk: !!parsed,
                sceneCount,
                sample: result.text.slice(0, 700),
            };
        } catch (err) {
            attempts.push({
                keyIndex,
                ok: false,
                error: err.message,
                code: err.code || err.response?.status || '',
            });
            if (!options.tryAllKeys) break;
        }
    }

    return {
        provider: target.provider,
        model: target.model,
        ok: false,
        attempts,
        error: attempts[attempts.length - 1]?.error || 'unknown failure',
    };
}

function parseTargets(raw) {
    if (!raw) {
        return [
            { provider: 'qwen', model: 'qwen3.5-plus' },
            { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-flash' },
            { provider: 'nvidia', model: 'deepseek-ai/deepseek-v4-pro' },
            { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' },
        ];
    }
    return raw.split(',').map(item => {
        const [provider, ...rest] = item.trim().split(':');
        return { provider, model: rest.join(':') };
    }).filter(t => t.provider && t.model);
}

async function main() {
    const args = parseArgs(process.argv);
    const projectDir = path.resolve(args.project || process.env.PROJECT_DIR || 'C:/Users/user/Downloads/Mps Fixing');
    loadEnv(projectDir);

    const promptChars = Number(args['prompt-chars'] || 70000);
    const timeoutMs = Number(args.timeout || 120000);
    const maxTokens = Number(args['max-tokens'] || 1800);
    const stream = args.stream !== 'false';
    const tryAllKeys = args['try-all-keys'] !== 'false';
    const targets = parseTargets(args.models);

    const context = loadProjectContext(projectDir);
    const prompt = buildPlannerPrompt(context, promptChars);

    console.log(`Benchmark prompt: ${prompt.length} chars, max_tokens=${maxTokens}, timeout=${Math.round(timeoutMs / 1000)}s, stream=${stream}`);
    console.log(`Targets: ${targets.map(t => `${t.provider}:${t.model}`).join(' | ')}`);

    const results = [];
    for (const target of targets) {
        const label = `${target.provider}:${target.model}`;
        console.log(`\nTesting ${label}...`);
        const result = await runOneTarget(target, prompt, { timeoutMs, maxTokens, stream, tryAllKeys });
        results.push(result);
        if (result.ok) {
            console.log(`  OK in ${(result.totalMs / 1000).toFixed(1)}s | first token ${result.firstTokenMs == null ? 'n/a' : `${(result.firstTokenMs / 1000).toFixed(1)}s`} | parse=${result.parseOk} | scenes=${result.sceneCount} | key=${result.keyIndex}`);
        } else {
            console.log(`  FAIL | ${result.error}`);
        }
    }

    const report = {
        createdAt: new Date().toISOString(),
        projectDir,
        promptChars: prompt.length,
        maxTokens,
        timeoutMs,
        stream,
        results,
    };
    const outDir = path.join(projectDir, 'temp');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `model-endpoint-benchmark-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nSaved report: ${outPath}`);
}

main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
});
