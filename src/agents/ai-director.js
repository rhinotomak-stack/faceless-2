/**
 * AI Director Module — Step 3 of the pipeline
 *
 * Replaces ai-scenes.js + ai-context.js with a single, richer AI call.
 * Reads the full narration script and:
 *   1. Analyzes content (summary, theme, mood, pacing, entities)
 *   2. Detects format (documentary vs listicle)
 *   3. Detects CTA/sign-off and hook boundary
 *   4. Builds idea-first scenes with word-level timestamps
 *
 * Uses shared ai-provider.js for all AI calls.
 *
 * Exports:
 *   analyzeAndCreateScenes(transcription, directorsBrief) → { scenes, scriptContext }
 */

const axios = require('axios');
const config = require('../settings/config');
const { callAI } = require('../brain/ai-provider');
const { pickNicheFromContent, getNiche, getNicheIds } = require('../data/niches');
const { getTheme, TRANSITION_LIBRARY, resolveThemeForContext } = require('../data/themes');
const { searchWeb, hasAnyWebSearchCredentials } = require('../media/web-search-client');

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Build the AI prompt for context analysis.
 * Prompt is in its own function so it can be tweaked independently.
 */
function buildDirectorPrompt(fullScript, audioDuration, directorsBrief, webContext = null) {
    const { freeInstructions, format, qualityTier, audienceHint, styleBlock, styleProfile } = directorsBrief;
    const selectableNiches = getNicheIds().filter(id => id !== 'explainer' && id !== 'news');
    const nicheIds = selectableNiches.join('|');
    // Give the model the DEFINITION of each niche, not just bare IDs. Without
    // descriptions the AI guesses from surface framing (e.g. a "$1M/Day Plan"
    // geopolitics video reads as "business"). With definitions it classifies on
    // substance. This is how the brain picks the niche — no hardcoded topic words.
    const nicheGuide = selectableNiches.map(id => {
        const n = getNiche(id);
        return `  - ${id}: ${n?.description || n?.name || id}`;
    }).join('\n');

    // Scene count is handled by the idea splitter below, not the context pass.

    const isTalkingHead = directorsBrief.productionMode === 'talkingHead';
    let prompt = (isTalkingHead
        ? `You are a professional video editor for a TALKING-HEAD YouTube video. A single recurring on-camera PRESENTER appears at a FEW key beats (chosen automatically downstream); EVERY OTHER beat is faceless B-roll — footage, images, and motion graphics illustrating the narration. Plan as if B-roll dominates and do NOT assume any OTHER on-camera hosts.

CONTEXT: the viewer mostly sees B-roll, and occasionally the recurring presenter. B-roll options are:
- Stock footage (clips of the events described)
- Images (photos, charts, maps, screenshots)
- Motion graphics (text overlays, stats, titles)`
        : `You are a professional video editor for FACELESS VIDEOS. This is NOT a talking-head video — it's a faceless video where narration is illustrated by footage, images, and motion graphics.

CRITICAL CONTEXT: In faceless videos, the viewer NEVER sees the narrator. Instead, they see:
- Stock footage (clips of the events described)
- Images (photos, charts, maps, screenshots)
- Motion graphics (text overlays, stats, titles)`) + `

Read this narration script and ANALYZE the content deeply: topic, theme, mood, format, structure, hook, CTA, and important entities.

SCRIPT:
"${fullScript}"

AUDIO DURATION: ${audioDuration.toFixed(1)} seconds`;

    // Video title from UI — strongest topic signal
    const videoTitle = (process.env.VIDEO_TITLE || '').trim();
    if (videoTitle) {
        prompt += `\n\nVIDEO TITLE: "${videoTitle}"\nUse this title to understand the video's subject and intent. It helps distinguish between NEWS (breaking events, launches) and EXPLAINER (how things work, deep-dives).`;
    }

    if (webContext) {
        prompt += `\n\nREAL-WORLD CONTEXT (from web search):
${webContext}

Use this context to understand the story better. If this is a real event, treat it with appropriate gravity and split scenes to show key moments (discovery, investigation steps, evidence, etc.).`;
    }

    if (freeInstructions) {
        prompt += `\n\nUSER INSTRUCTIONS (follow these closely, they override defaults):
${freeInstructions}`;
    }

    // Reference style profile (highest priority — overrides niche defaults and AI detection)
    if (styleBlock) {
        prompt += `\n\n${styleBlock}\n\nNOTE: The style inspiration above is a GUIDE, not an override. Use it to inform your pacing feel and shot variety. Your niche rules and format settings still take priority for scene density and structure.`;
        console.log(`   🎨 [Director] Style inspiration injected: "${styleProfile?.name || 'unnamed'}" (${styleBlock.length} chars)`);
    }

    if (audienceHint) {
        prompt += `\nTARGET AUDIENCE: ${audienceHint}`;
    }

    if (format !== 'auto') {
        prompt += `\nFORMAT: This is a ${format} video.`;
    }

    prompt += `

ANALYSIS RULES:
- FORMAT: Is this a "documentary" (flowing narrative) or "listicle" (numbered items, "first... second... third...", "number one...", "top 5...")?
- If listicle, identify the SECTIONS (each numbered item is a section).
- NICHE: Use the VIDEO TITLE plus full script arc to choose the closest production niche ID from the allowed list. Do not use a vague theme word as the niche.
- Niche ID must reflect what footage/search strategy should be used. Examples: consumer durability, repairability, tools, appliances, "buy it for life", and planned-obsolescence advice fit explainer.diy better than explainer.luxury. Use explainer.luxury only for real luxury/fashion/designer/high-end lifestyle subjects.
- HOOK: The first 15-30 seconds is usually the hook/intro. Identify where the main content begins.
- CTA: Does the script end with a call-to-action? ("subscribe", "like and share", "thanks for watching", "let me know in the comments"). If yes, when does it start?
- BACKGROUND: What visual canvas fits behind the footage? Pick based on theme:
  crime/mystery/horror → dark | technology/science/data → tech | nature/travel/wildlife → nature | business/finance/lifestyle → warm | general/education → neutral
- PACING: Determine if this content is "fast" (urgent news, action, breaking stories), "moderate" (standard documentary), or "slow" (emotional, deep dive, mystery).
  This describes editorial feel only. Do not calculate scene count here.

TASK: Analyze the content ONLY. Do NOT split scenes — scene splitting is handled separately.

NICHE GUIDE — pick the nicheHint that best matches the SUBSTANCE of the content (not surface framing like dollar figures or clickbait titles). Definitions:
${nicheGuide}
Note: geopolitical / international-relations / chokepoint / trade-route / sanctions / diplomacy analysis → a politics niche, NOT business (business = companies/markets/earnings) and NOT military (military = weapons/combat/armed forces).

Reply in EXACTLY this format:
summary: <1 sentence, max 20 words>
eventType: <real-past|real-ongoing|speculative|educational|fictional>
nicheHint: <${nicheIds}>
theme: <technology|history|finance|science|health|travel|politics|entertainment|education|sports|nature|business|lifestyle|motivation|crime|mystery>
tone: <informative|dramatic|casual|urgent|inspirational|educational|serious|lighthearted|emotional|suspenseful>
mood: <dark|uplifting|tense|calm|energetic|nostalgic|hopeful|mysterious|intense|playful>
pacing: <fast|moderate|slow>
visualStyle: <cinematic|documentary|corporate|lifestyle|abstract|nature|urban|tech|vintage|minimalist>
entities: <comma-separated, each tagged with type: "Name [person]", "Name [place]", "Name [org]", "Name [event]", or "none". Example: "King Khalid [person], Strait of Hormuz [place], Saudi Aramco [org]">
stats: <comma-separated key numbers/statistics, or "none">
format: <documentary|listicle>
sections: <comma-separated section titles if listicle, or "none">
hookEnd: <approximate seconds where the hook/intro ends, e.g. "18">
ctaStart: <approximate seconds where CTA/sign-off begins, or "none">
background: <dark|tech|nature|warm|neutral>`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

/**
 * Parse the context section of the AI response.
 * Extracts both legacy fields (summary, theme, etc.) and new fields (format, CTA, hook, etc.)
 */
function parseDirectorContext(contextText) {
    const result = {
        // Legacy fields (same as ai-context.js)
        summary: '',
        theme: '',
        tone: '',
        mood: '',
        pacing: '',
        visualStyle: '',
        entities: [],
        keyStats: [],
        mainPoints: [],
        targetAudience: '',
        emotionalArc: '',
        // New fields
        format: 'documentary',
        sections: [],
        ctaDetected: false,
        ctaStartTime: null,
        hookEndTime: null,
        densityTarget: 3,
        nicheId: 'general',  // Content strategy (MG types, footage priority, pacing)
        themeId: 'standard',  // Visual system (colors, fonts, transitions, overlays)
        productionMode: 'faceless'  // Orthogonal mode; build-video stamps the real value from the brief
    };

    const lines = contextText.trim().split('\n');

    for (const line of lines) {
        const lower = line.toLowerCase().trim()
            .replace(/^\*+/, '').replace(/\*+$/, '')
            .replace(/^-\s*/, '')
            .trim();

        const extractValue = () => line.substring(line.indexOf(':') + 1).trim().replace(/^["'*]+|["'*]+$/g, '');

        // Legacy fields
        if (lower.startsWith('summary:')) {
            result.summary = extractValue();
            if (result.summary.length > 120) result.summary = result.summary.substring(0, 120);
        }
        if (lower.startsWith('eventtype:') || lower.startsWith('event type:') || lower.startsWith('event_type:')) {
            const val = extractValue().toLowerCase();
            if (['real-past', 'real-ongoing', 'speculative', 'educational', 'fictional'].includes(val)) {
                result.eventType = val;
            }
        }
        if (lower.startsWith('nichehint:') || lower.startsWith('niche hint:') || lower.startsWith('niche_hint:')) {
            result.nicheHint = extractValue().toLowerCase();
        }
        if (lower.startsWith('theme:')) result.theme = extractValue().toLowerCase();
        if (lower.startsWith('tone:')) result.tone = extractValue().toLowerCase();
        if (lower.startsWith('mood:')) result.mood = extractValue().toLowerCase();
        if (lower.startsWith('pacing:')) result.pacing = extractValue().toLowerCase();
        if (lower.startsWith('visualstyle:') || lower.startsWith('visual style:') || lower.startsWith('visual_style:')) {
            result.visualStyle = extractValue().toLowerCase();
        }
        if (lower.startsWith('entities:')) {
            const val = extractValue();
            if (val.toLowerCase() !== 'none') {
                const raw = val.split(',').map(s => s.trim()).filter(Boolean);
                result.entities = [];
                result.entityTypes = {}; // name → 'person'|'place'|'org'|'event'
                for (const entry of raw) {
                    const tagMatch = entry.match(/^(.+?)\s*\[(person|place|org|event|organization|location)\]\s*$/i);
                    if (tagMatch) {
                        const name = tagMatch[1].trim();
                        let type = tagMatch[2].toLowerCase();
                        if (type === 'organization') type = 'org';
                        if (type === 'location') type = 'place';
                        result.entities.push(name);
                        result.entityTypes[name.toLowerCase()] = type;
                    } else {
                        result.entities.push(entry);
                    }
                }
            }
        }
        if (lower.startsWith('stats:')) {
            const val = extractValue();
            if (val.toLowerCase() !== 'none') {
                result.keyStats = val.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (lower.startsWith('points:')) {
            const val = extractValue();
            result.mainPoints = val.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (lower.startsWith('audience:')) result.targetAudience = extractValue();
        if (lower.startsWith('arc:')) result.emotionalArc = extractValue();

        // New fields
        if (lower.startsWith('format:')) {
            const val = extractValue().toLowerCase();
            if (val === 'listicle' || val === 'documentary') result.format = val;
        }
        if (lower.startsWith('sections:')) {
            const val = extractValue();
            if (val.toLowerCase() !== 'none') {
                result.sections = val.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (lower.startsWith('hookend:') || lower.startsWith('hook end:') || lower.startsWith('hook_end:')) {
            const val = extractValue().replace(/[^0-9.]/g, '');
            const num = parseFloat(val);
            if (!isNaN(num) && num > 0) result.hookEndTime = num;
        }
        if (lower.startsWith('ctastart:') || lower.startsWith('cta start:') || lower.startsWith('cta_start:')) {
            const val = extractValue().toLowerCase();
            if (val !== 'none' && val !== 'n/a') {
                const num = parseFloat(val.replace(/[^0-9.]/g, ''));
                if (!isNaN(num) && num > 0) {
                    result.ctaDetected = true;
                    result.ctaStartTime = num;
                }
            }
        }
        // NOTE: backgroundCanvas removed — now using unified theme system (themeId)
    }

    return result;
}

// ============================================================
// WORD MATCHING (preserved from ai-scenes.js)
// ============================================================

function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _normalizedTokens(text) {
    return normalize(text).split(/\s+/).filter(Boolean);
}

/**
 * Find the index in allWords where the anchor text starts.
 * Uses sliding window matching with fuzzy tolerance.
 */
function findWordIndex(anchorText, allWords, searchFrom) {
    const anchorParts = _normalizedTokens(anchorText);
    if (anchorParts.length === 0) return -1;

    let bestIndex = -1;
    let bestScore = 0;

    for (let i = searchFrom; i < allWords.length; i++) {
        const wordParts = [];
        for (let k = i; k < allWords.length && wordParts.length < anchorParts.length + 4 && k < i + anchorParts.length + 4; k++) {
            wordParts.push(..._normalizedTokens(allWords[k].word));
        }
        if (!wordParts.length) continue;

        let matchCount = 0;
        const maxCheck = Math.min(anchorParts.length, wordParts.length);

        for (let j = 0; j < maxCheck; j++) {
            const wordNorm = wordParts[j];
            const anchorNorm = anchorParts[j];
            if (wordNorm === anchorNorm) {
                matchCount++;
            } else if (wordNorm.includes(anchorNorm) || anchorNorm.includes(wordNorm)) {
                matchCount += 0.7;
            }
        }

        const score = matchCount / anchorParts.length;
        if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
        }

        if (score >= 0.85) break;
    }

    return bestScore >= 0.5 ? bestIndex : -1;
}

// ============================================================
// SCENE BUILDING (preserved from ai-scenes.js)
// ============================================================

/**
 * Parse scene boundaries from AI output and map to word timestamps.
 */
function buildScenesFromAnchors(sceneAnchors, allWords, audioDuration, fps) {
    const mapped = [];
    let searchFrom = 0;

    for (let i = 0; i < sceneAnchors.length; i++) {
        const anchor = sceneAnchors[i];
        const wordIdx = findWordIndex(anchor, allWords, searchFrom);

        if (wordIdx >= 0) {
            mapped.push({ wordIndex: wordIdx, anchor });
            searchFrom = wordIdx + 1;
            console.log(`   ✅ Scene ${i}: "${anchor}" → word #${wordIdx} @${allWords[wordIdx].start.toFixed(2)}s`);
        } else {
            console.log(`   ⚠️ Scene ${i}: "${anchor}" → no match, will interpolate`);
            mapped.push({ wordIndex: -1, anchor });
        }
    }

    // Fix unmatched scenes by interpolation
    for (let i = 0; i < mapped.length; i++) {
        if (mapped[i].wordIndex === -1) {
            const prevIdx = i > 0 ? mapped[i - 1].wordIndex : 0;
            let nextIdx = allWords.length - 1;
            for (let j = i + 1; j < mapped.length; j++) {
                if (mapped[j].wordIndex >= 0) { nextIdx = mapped[j].wordIndex; break; }
            }
            let unmatchedCount = 0;
            for (let j = i; j < mapped.length && mapped[j].wordIndex === -1; j++) unmatchedCount++;

            const step = Math.floor((nextIdx - prevIdx) / (unmatchedCount + 1));
            mapped[i].wordIndex = Math.min(prevIdx + step, allWords.length - 1);
            console.log(`   🔧 Interpolated Scene ${i} → word #${mapped[i].wordIndex} @${allWords[mapped[i].wordIndex].start.toFixed(2)}s`);
        }
    }

    // Build final scene objects
    const scenes = [];
    for (let i = 0; i < mapped.length; i++) {
        const startWordIdx = mapped[i].wordIndex;
        const endWordIdx = i < mapped.length - 1 ? mapped[i + 1].wordIndex : allWords.length;

        const startTime = allWords[startWordIdx].start;
        const endTime = i < mapped.length - 1
            ? allWords[mapped[i + 1].wordIndex].start
            : audioDuration;

        const sceneWords = allWords.slice(startWordIdx, endWordIdx);
        const text = sceneWords.map(w => w.word).join(' ').trim();

        scenes.push({
            index: i,
            text,
            startTime,
            endTime,
            duration: Math.round((endTime - startTime) * fps),
            words: sceneWords
        });
    }

    // Ensure last scene extends to audio end
    if (scenes.length > 0) {
        const last = scenes[scenes.length - 1];
        if (audioDuration > last.endTime + 0.3) {
            last.endTime = audioDuration;
            last.duration = Math.round((last.endTime - last.startTime) * fps);
        }
    }

    return scenes;
}

// ============================================================
// IDEA-FIRST AI SCENE PLANNER
// ============================================================

function _languageName(code) {
    const names = {
        en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian',
        ko: 'Korean', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
        ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', tr: 'Turkish', hi: 'Hindi',
        sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', cs: 'Czech',
        ro: 'Romanian', hu: 'Hungarian', el: 'Greek', th: 'Thai', vi: 'Vietnamese',
        id: 'Indonesian', ms: 'Malay', uk: 'Ukrainian',
    };
    return names[code] || code || 'English';
}

function buildIdeaScenePrompt(fullScript, audioDuration, scriptContext = {}, directorsBrief = {}, webContext = null) {
    const title = (process.env.VIDEO_TITLE || scriptContext.videoTitle || '').trim();
    const buildLang = directorsBrief.language || scriptContext.language || 'en';
    const buildLangName = _languageName(buildLang);
    const entities = Array.isArray(scriptContext.entities) && scriptContext.entities.length
        ? scriptContext.entities.slice(0, 30).join(', ')
        : 'none';
    const stats = Array.isArray(scriptContext.keyStats) && scriptContext.keyStats.length
        ? scriptContext.keyStats.slice(0, 20).join(', ')
        : 'none';
    const sections = Array.isArray(scriptContext.sections) && scriptContext.sections.length
        ? scriptContext.sections.map(s => typeof s === 'string' ? s : s?.title).filter(Boolean).slice(0, 20).join(' | ')
        : 'none';

    return `You are the AI Director acting like a smart human video editor.

Your job: split the narration into visual ideas. Do NOT split by seconds, word count, fixed density, punctuation rules, or generic pacing math.

Every output line is one scene because it needs its own visual decision.

CORE EDITORIAL RULES:
- One scene = one visual idea, claim, named entity, product, place, statistic, reveal, or contrast.
- If a sentence names multiple competitors, people, brands, countries, places, products, events, or stats, give each important item its own scene.
- Example: "It beat Nissan. It beat Kia." must become two scenes:
  S001 | anchor="It beat Nissan" | visual="Nissan vehicle or Nissan logo" | lowerThird="Nissan" | reason="separate competitor beat"
  S002 | anchor="It beat Kia" | visual="Kia vehicle or Kia logo" | lowerThird="Kia" | reason="separate competitor beat"
- Short scenes are allowed when the idea is short. Do not merge short intentional beats.
- Keep scenes in the exact narration order.
- Anchor text must be copied from the narration exactly as written/spoken. Do not translate anchors.
- For multilingual builds, anchors and viewer-facing lowerThird text must stay in the narration language (${buildLangName}) unless the text is a proper noun or brand name.
- Search-oriented visual descriptions may be concise English if useful, but lowerThird/template text must match the build language.
- Do not invent timestamps. We will map your anchors to Whisper word timings.

ANCHOR RULES:
- anchor must be exact consecutive narration words at the START of that scene.
- Use 3-12 words when possible.
- Make anchors unique enough to map reliably.
- Do not paraphrase the anchor.
- Do not output bullets, markdown tables, JSON, or explanations.

VIDEO CONTEXT:
- Duration: ${audioDuration.toFixed(1)} seconds
- Language: ${buildLangName} (${buildLang})
- Niche: ${scriptContext.nicheId || 'general'}
- Format: ${scriptContext.format || 'documentary'}
- Theme: ${scriptContext.theme || 'general'}
- Tone: ${scriptContext.tone || 'informative'}
- Mood: ${scriptContext.mood || 'neutral'}
- Pacing feel: ${scriptContext.pacing || 'moderate'}
- Summary: ${scriptContext.summary || 'none'}
- Entities: ${entities}
- Stats: ${stats}
- Sections: ${sections}
${title ? `- Video title: ${title}` : ''}
${scriptContext.ideaChunkNote ? `- Split scope: ${scriptContext.ideaChunkNote}` : ''}
${directorsBrief.freeInstructions ? `- User instructions: ${directorsBrief.freeInstructions}` : ''}
${webContext ? `\nREAL-WORLD CONTEXT:\n${String(webContext).substring(0, 2500)}` : ''}

NARRATION:
${fullScript}

OUTPUT FORMAT ONLY:
S001 | anchor="<exact narration words>" | visual="<specific visual target for this idea>" | lowerThird="<short on-screen name/text or none>" | reason="<why this is its own visual beat>"
S002 | anchor="<exact narration words>" | visual="<specific visual target for this idea>" | lowerThird="<short on-screen name/text or none>" | reason="<why this is its own visual beat>"`;
}

function _cleanIdeaField(value) {
    return String(value || '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function _ideaKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _extractIdeaFields(line) {
    const fields = {};
    const fieldRe = /([a-zA-Z][a-zA-Z0-9 _-]*)\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|([^|]+))/g;
    let match;
    while ((match = fieldRe.exec(String(line || ''))) !== null) {
        const key = _ideaKey(match[1]);
        const value = _cleanIdeaField(match[2] ?? match[3] ?? match[4] ?? '');
        if (key) fields[key] = value;
    }
    return fields;
}

function parseIdeaScenePlan(rawText) {
    const lines = String(rawText || '').split(/\r?\n/);
    const ideas = [];
    const seenAnchors = new Set();

    for (const rawLine of lines) {
        const line = String(rawLine || '').trim().replace(/^\s*[-*]\s*/, '');
        if (!line || !/\banchor\s*[:=]/i.test(line)) continue;

        const fields = _extractIdeaFields(line);

        const anchor = _cleanIdeaField(fields.anchor || fields.startanchor || fields.start || '');
        if (!anchor) continue;

        const anchorKey = normalize(anchor);
        if (!anchorKey || seenAnchors.has(anchorKey)) continue;
        seenAnchors.add(anchorKey);

        const idMatch = line.match(/^(?:S(?:CENE)?\s*)?0*([0-9]+)/i);
        const lowerThird = _cleanIdeaField(fields.lowerthird || fields.lt || fields.lower || fields.text || '');

        ideas.push({
            id: idMatch ? parseInt(idMatch[1], 10) : ideas.length + 1,
            anchor,
            visual: _cleanIdeaField(fields.visual || fields.shot || fields.intent || ''),
            lowerThird,
            reason: _cleanIdeaField(fields.reason || fields.why || ''),
        });
    }

    return ideas;
}

function _usableLowerThird(value) {
    const text = _cleanIdeaField(value);
    if (!text) return null;
    if (/^(none|null|n\/a|na|-|no lower third)$/i.test(text)) return null;
    return text.substring(0, 80).trim();
}

function _protectedIdeaLabels(scene) {
    const labels = [];
    const lowerThird = _usableLowerThird(scene?.ideaLowerThird);
    if (lowerThird) labels.push(lowerThird);
    if (Array.isArray(scene?.protectedTerms)) {
        labels.push(...scene.protectedTerms.map(term => _cleanIdeaField(term)).filter(Boolean));
    }
    return [...new Set(labels.map(label => label.trim()).filter(Boolean))];
}

function _hasProtectedIdeaBeat(scene) {
    return _protectedIdeaLabels(scene).length > 0;
}

function _shareProtectedIdeaBeat(left, right) {
    const leftLabels = _protectedIdeaLabels(left).map(normalize).filter(Boolean);
    const rightLabels = new Set(_protectedIdeaLabels(right).map(normalize).filter(Boolean));
    return leftLabels.some(label => rightLabels.has(label));
}

function _isFragmentRepairAction(action) {
    const repair = String(action?.repair || '').toLowerCase().replace(/[-_]+/g, ' ');
    const reason = String(action?.reason || '').toLowerCase().replace(/[-_]+/g, ' ');
    const evidence = `${repair} ${reason}`;
    const fragmentEvidence = /\b(fragment|phrase|clause|same sentence|sentence fragment|broken sentence|grammar fragment|dangling|incomplete|continuation)\b/;
    const broadEvidence = /\b(same\s*idea|sameidea|related|topic|context|transition|broad|group|grouping)\b/;

    if (broadEvidence.test(repair)) {
        return false;
    }
    if (broadEvidence.test(reason) && !fragmentEvidence.test(reason)) {
        return false;
    }

    if (/\bfragment\b/.test(repair)) return true;
    if (fragmentEvidence.test(evidence)) {
        return true;
    }

    return false;
}

function _sceneEndsWithSentenceStop(scene) {
    return /[.!?]["')\]]*$/.test(String(scene?.text || '').trim());
}

function _isSafeIdeaMergeAction(action, leftScene = null, _rightScene = null) {
    if (!_isFragmentRepairAction(action)) return false;
    if (leftScene && _sceneEndsWithSentenceStop(leftScene)) return false;
    return true;
}

function _isSafeIdeaMoveAction(action, movedWordCount) {
    const maxWords = Math.max(1, parseInt(process.env.IDEA_MOVE_MAX_WORDS || '6', 10) || 6);
    if (!Number.isFinite(movedWordCount) || movedWordCount <= 0 || movedWordCount > maxWords) {
        return false;
    }

    const repair = String(action?.repair || '').toLowerCase().replace(/[-_]+/g, ' ');
    const reason = String(action?.reason || '').toLowerCase().replace(/[-_]+/g, ' ');
    const evidence = `${repair} ${reason}`;
    const connectorEvidence = /\b(connector|orphan|leading|trailing|belongs|misplaced|dangling|fragment|phrase|clause|grammar|continuation)\b/;
    const broadEvidence = /\b(same\s*idea|sameidea|related|topic|context|transition|broad|group|grouping)\b/;

    if (broadEvidence.test(repair)) return false;
    if (broadEvidence.test(reason) && !connectorEvidence.test(reason)) return false;
    return connectorEvidence.test(evidence) || _isFragmentRepairAction(action);
}

function _ideaSceneMetaLine(scene) {
    const parts = [];
    if (scene?.ideaAnchor) parts.push(`anchor="${String(scene.ideaAnchor).replace(/\s+/g, ' ').trim()}"`);
    if (scene?.ideaVisual) parts.push(`visual="${String(scene.ideaVisual).replace(/\s+/g, ' ').trim()}"`);
    if (scene?.ideaLowerThird) parts.push(`lowerThird="${String(scene.ideaLowerThird).replace(/\s+/g, ' ').trim()}"`);
    const protectedTerms = _protectedIdeaLabels(scene);
    if (protectedTerms.length) parts.push(`protected="${protectedTerms.join('; ')}"`);
    return parts.length ? parts.join(' | ') : 'none';
}

function _ideaSplitterMaxTokens(audioDuration, wordCount = 0, isChunk = false) {
    const envMax = parseInt(process.env.IDEA_SPLITTER_MAX_TOKENS || '', 10);
    if (Number.isFinite(envMax) && envMax > 0) return envMax;

    const minuteBased = Math.round((Math.max(1, audioDuration) / 60) * (isChunk ? 1200 : 900));
    const wordBased = Math.round(Math.max(0, wordCount) * 4.5);
    return Math.max(8000, Math.min(24000, Math.max(minuteBased, wordBased)));
}

function _isMaxTokenStop(meta) {
    const stop = String(meta?.stopReason || meta?.finishReason || '').toLowerCase();
    return stop.includes('max') || stop.includes('length') || stop.includes('token');
}

function _chunkScript(words) {
    return (words || []).map(w => w.word).join(' ').replace(/\s+/g, ' ').trim();
}

function _isIdeaSentenceBoundary(word) {
    return /[.!?]$/.test(String(word?.word || '').trim());
}

function _buildIdeaWordChunks(allWords, audioDuration) {
    const targetSeconds = Math.max(90, parseFloat(process.env.IDEA_SPLITTER_CHUNK_SECONDS || '300') || 300);
    if (!allWords.length || audioDuration <= targetSeconds * 1.25) {
        return [{ startWord: 0, endWord: allWords.length, index: 0, total: 1 }];
    }

    const chunks = [];
    let startWord = 0;
    while (startWord < allWords.length) {
        const startTime = allWords[startWord]?.start || 0;
        const targetTime = startTime + targetSeconds;
        let endWord = allWords.length;

        if (targetTime < audioDuration - 45) {
            let best = -1;
            let bestDist = Infinity;
            for (let i = startWord + 60; i < allWords.length - 1; i++) {
                const t = allWords[i]?.start || 0;
                if (t < targetTime - 45) continue;
                if (t > targetTime + 75) break;
                if (!_isIdeaSentenceBoundary(allWords[i])) continue;
                const dist = Math.abs(t - targetTime);
                if (dist < bestDist) {
                    best = i + 1;
                    bestDist = dist;
                }
            }
            if (best > startWord) {
                endWord = best;
            } else {
                const forced = allWords.findIndex((w, i) => i > startWord + 60 && (w.start || 0) >= targetTime);
                endWord = forced > startWord ? forced : allWords.length;
            }
        }

        if (endWord <= startWord) endWord = Math.min(allWords.length, startWord + 300);
        chunks.push({ startWord, endWord, index: chunks.length, total: 0 });
        startWord = endWord;
    }

    for (const chunk of chunks) chunk.total = chunks.length;
    return chunks;
}

function buildIdeaScenesFromPlan(ideaPlan, allWords, audioDuration, fps) {
    const mapped = [];
    let searchFrom = 0;
    let skipped = 0;

    for (const idea of ideaPlan || []) {
        const wordIdx = findWordIndex(idea.anchor, allWords, searchFrom);
        if (wordIdx < 0) {
            skipped++;
            continue;
        }
        if (mapped.length && wordIdx <= mapped[mapped.length - 1].wordIndex) {
            skipped++;
            continue;
        }
        mapped.push({ wordIndex: wordIdx, idea });
        searchFrom = wordIdx + 1;
    }

    const matched = mapped.length;
    const total = Array.isArray(ideaPlan) ? ideaPlan.length : 0;
    const matchRate = total ? matched / total : 0;

    if (!allWords.length || !mapped.length) {
        return {
            scenes: [],
            mapped,
            stats: { planned: total, matched, skipped, matchRate, scenes: 0 },
        };
    }

    if (mapped[0].wordIndex > 0 && mapped[0].wordIndex <= 2) {
        mapped[0].wordIndex = 0;
    } else if (mapped[0].wordIndex > 2) {
        mapped.unshift({
            wordIndex: 0,
            idea: {
                id: 0,
                anchor: allWords[0]?.word || '',
                visual: mapped[0].idea.visual || 'opening context',
                lowerThird: 'none',
                reason: 'coverage before first AI anchor',
            },
            synthetic: true,
        });
    }

    const scenes = [];
    for (let i = 0; i < mapped.length; i++) {
        const current = mapped[i];
        const next = mapped[i + 1];
        const startWordIdx = Math.max(0, Math.min(current.wordIndex, allWords.length - 1));
        const endWordIdx = next ? Math.max(startWordIdx + 1, next.wordIndex) : allWords.length;
        const sceneWords = allWords.slice(startWordIdx, endWordIdx);
        if (!sceneWords.length) continue;

        const startTime = typeof sceneWords[0].start === 'number' ? sceneWords[0].start : 0;
        const rawEndTime = next && allWords[next.wordIndex]
            ? allWords[next.wordIndex].start
            : audioDuration;
        const wordEnd = sceneWords[sceneWords.length - 1]?.end;
        const endTime = Math.max(
            startTime + 0.05,
            Math.min(audioDuration, typeof rawEndTime === 'number' ? rawEndTime : (typeof wordEnd === 'number' ? wordEnd : audioDuration))
        );
        const lowerThird = _usableLowerThird(current.idea.lowerThird);
        const protectedTerms = lowerThird ? [lowerThird] : [];

        scenes.push({
            index: scenes.length,
            text: sceneWords.map(w => w.word).join(' ').trim(),
            startTime,
            endTime,
            duration: Math.max(1, Math.round((endTime - startTime) * fps)),
            words: sceneWords,
            _ideaLocked: true,
            ideaAnchor: current.idea.anchor || '',
            ideaVisual: current.idea.visual || '',
            ideaLowerThird: lowerThird,
            ideaReason: current.idea.reason || '',
            protectedTerms,
        });
    }

    if (scenes.length > 0 && audioDuration > scenes[scenes.length - 1].endTime + 0.3) {
        const last = scenes[scenes.length - 1];
        last.endTime = audioDuration;
        last.duration = Math.max(1, Math.round((last.endTime - last.startTime) * fps));
    }

    return {
        scenes,
        mapped,
        stats: { planned: total, matched, skipped, matchRate, scenes: scenes.length },
    };
}

function _matchIdeaAnchors(ideas, words) {
    let searchFrom = 0;
    let matched = 0;
    let skipped = 0;
    for (const idea of ideas || []) {
        const idx = findWordIndex(idea.anchor, words, searchFrom);
        if (idx >= 0) {
            matched++;
            searchFrom = idx + 1;
        } else {
            skipped++;
        }
    }
    const planned = Array.isArray(ideas) ? ideas.length : 0;
    return {
        planned,
        matched,
        skipped,
        matchRate: planned ? matched / planned : 0,
    };
}

function _splitIdeaChunk(chunk, allWords) {
    const startTime = allWords[chunk.startWord]?.start || 0;
    const endTime = allWords[Math.max(chunk.startWord, chunk.endWord - 1)]?.end || startTime;
    const midTime = (startTime + endTime) / 2;
    let best = -1;
    let bestDist = Infinity;

    for (let i = chunk.startWord + 40; i < chunk.endWord - 40; i++) {
        if (!_isIdeaSentenceBoundary(allWords[i])) continue;
        const dist = Math.abs((allWords[i].start || 0) - midTime);
        if (dist < bestDist) {
            best = i + 1;
            bestDist = dist;
        }
    }

    if (best <= chunk.startWord || best >= chunk.endWord) {
        best = Math.floor((chunk.startWord + chunk.endWord) / 2);
    }

    return [
        { ...chunk, endWord: best, label: `${chunk.label || chunk.index + 1}a` },
        { ...chunk, startWord: best, label: `${chunk.label || chunk.index + 1}b` },
    ];
}

async function _callIdeaPlanner(prompt, maxTokens, _legacyUseBedrock) {
    // Sonnet-tier planner calls must stay task-router aware. In hybrid modes
    // (AiLink/Vertex beside Bedrock), the router tries the selected brain first
    // and keeps Bedrock Sonnet as fallback. For Bedrock-only, this still routes
    // directly to Bedrock Sonnet.
    const response = await callAI(prompt, {
        maxTokens,
        taskType: 'planner-large',
        returnMeta: true,
    });
    if (typeof response === 'string') return { text: response, meta: null };
    return { text: response?.text || '', meta: response?.meta || null };
}

async function _planIdeaChunkRecursive({ chunk, allWords, scriptContext, directorsBrief, webContext, useBedrock, fps, depth = 0 }) {
    const chunkWords = allWords.slice(chunk.startWord, chunk.endWord);
    const chunkStart = chunkWords[0]?.start || 0;
    const chunkEnd = chunkWords[chunkWords.length - 1]?.end || chunkStart;
    const chunkDuration = Math.max(0.1, chunkEnd - chunkStart);
    const chunkLabel = chunk.label || `${(chunk.index || 0) + 1}/${chunk.total || 1}`;
    const chunkScript = _chunkScript(chunkWords);
    const chunkContext = {
        ...scriptContext,
        ideaChunkNote: `chunk ${chunkLabel}, ${chunkStart.toFixed(1)}s-${chunkEnd.toFixed(1)}s of the full narration. Output only anchors inside this chunk.`,
    };
    const prompt = buildIdeaScenePrompt(chunkScript, chunkDuration, chunkContext, directorsBrief, webContext);
    const maxTokens = _ideaSplitterMaxTokens(chunkDuration, chunkWords.length, true);
    const { text: rawPlan, meta } = await _callIdeaPlanner(prompt, maxTokens, useBedrock);
    const ideas = parseIdeaScenePlan(rawPlan);
    const matchStats = _matchIdeaAnchors(ideas, chunkWords);
    const truncated = _isMaxTokenStop(meta);
    const minChunkSeconds = Math.max(45, parseFloat(process.env.IDEA_SPLITTER_MIN_CHUNK_SECONDS || '75') || 75);
    const minMatchRate = parseFloat(process.env.IDEA_SPLITTER_MIN_MATCH_RATE || '0.55');
    const canSplit = depth < 4 && chunkDuration > minChunkSeconds * 1.5 && (chunk.endWord - chunk.startWord) > 140;

    console.log(`   IdeaSplit chunk ${chunkLabel}: ${chunkDuration.toFixed(1)}s, anchors=${ideas.length}, matched=${matchStats.matched}/${matchStats.planned || 0}${truncated ? ', stop=max_tokens' : ''}`);

    const weakMatch = ideas.length > 0 && matchStats.matchRate < minMatchRate;
    const emptyLongChunk = ideas.length === 0 && chunkDuration > minChunkSeconds;
    if ((truncated || weakMatch || emptyLongChunk) && canSplit) {
        const reason = truncated ? 'max_tokens' : weakMatch ? 'weak anchor match' : 'empty long chunk';
        console.warn(`   IdeaSplit chunk ${chunkLabel} retrying as smaller chunks (${reason})`);
        const halves = _splitIdeaChunk(chunk, allWords);
        const left = await _planIdeaChunkRecursive({ chunk: halves[0], allWords, scriptContext, directorsBrief, webContext, useBedrock, fps, depth: depth + 1 });
        const right = await _planIdeaChunkRecursive({ chunk: halves[1], allWords, scriptContext, directorsBrief, webContext, useBedrock, fps, depth: depth + 1 });
        return {
            ideas: [...left.ideas, ...right.ideas],
            stats: {
                chunks: (left.stats.chunks || 0) + (right.stats.chunks || 0),
                truncatedChunks: (left.stats.truncatedChunks || 0) + (right.stats.truncatedChunks || 0),
                retriedChunks: 1 + (left.stats.retriedChunks || 0) + (right.stats.retriedChunks || 0),
            },
        };
    }

    return {
        ideas,
        stats: {
            chunks: 1,
            truncatedChunks: truncated ? 1 : 0,
            retriedChunks: 0,
        },
    };
}

async function _planIdeaChunks({ allWords, audioDuration, scriptContext, directorsBrief, webContext, useBedrock, fps }) {
    const chunks = _buildIdeaWordChunks(allWords, audioDuration);
    if (chunks.length > 1) {
        console.log(`   IdeaSplit chunking: ${chunks.length} semantic planning chunks (target ${process.env.IDEA_SPLITTER_CHUNK_SECONDS || 300}s)`);
    }

    const ideas = [];
    const stats = { chunks: 0, truncatedChunks: 0, retriedChunks: 0 };
    for (const chunk of chunks) {
        const result = await _planIdeaChunkRecursive({ chunk, allWords, scriptContext, directorsBrief, webContext, useBedrock, fps });
        ideas.push(...result.ideas);
        stats.chunks += result.stats.chunks || 0;
        stats.truncatedChunks += result.stats.truncatedChunks || 0;
        stats.retriedChunks += result.stats.retriedChunks || 0;
    }

    return { ideas, stats };
}

function parseIdeaRefinementPlan(rawText) {
    const refinements = [];
    const seen = new Set();
    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
        const line = String(rawLine || '').trim().replace(/^\s*[-*]\s*/, '');
        if (!line || !/\banchor\s*[:=]/i.test(line)) continue;
        const sceneMatch = line.match(/\bscene\s*#?\s*(\d+)\b/i) || line.match(/^S\s*(\d+)\b/i);
        if (!sceneMatch) continue;
        const sceneIndex = parseInt(sceneMatch[1], 10);
        const fields = _extractIdeaFields(line);
        const anchor = _cleanIdeaField(fields.anchor || fields.startanchor || fields.start || '');
        if (!anchor) continue;
        const key = `${sceneIndex}:${normalize(anchor)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refinements.push({
            sceneIndex,
            anchor,
            visual: _cleanIdeaField(fields.visual || fields.shot || fields.intent || ''),
            lowerThird: _cleanIdeaField(fields.lowerthird || fields.lt || fields.lower || fields.text || ''),
            reason: _cleanIdeaField(fields.reason || fields.why || ''),
        });
    }
    return refinements;
}

function buildIdeaLongSceneRefinementPrompt(scenes, scriptContext = {}, directorsBrief = {}) {
    const buildLang = directorsBrief.language || scriptContext.language || 'en';
    const buildLangName = _languageName(buildLang);
    const sceneBlock = scenes.map(scene => {
        const dur = ((scene.endTime || 0) - (scene.startTime || 0)).toFixed(1);
        return `SCENE ${scene.index} (${dur}s): "${String(scene.text || '').replace(/\s+/g, ' ').trim()}"`;
    }).join('\n');

    return `You are reviewing scenes from an AI video editor.

Some scenes may be too broad because they contain multiple visual ideas. Add internal scene-start anchors ONLY when a scene naturally contains multiple distinct visual beats.

Do NOT split by duration. Split by idea:
- new named entity, brand, product, country, person, or place
- new statistic, price, score, comparison, feature, objection, answer, risk, or conclusion beat
- a list where each item deserves its own visual
- comma-separated strengths, weaknesses, defects, benefits, risks, or features where each item can be shown differently
- a complete setup/context sentence followed by a new sentence that starts the next idea
- a contrast such as "but", "however", "the first question", "the second question"

Rules:
- Anchor must be exact consecutive words from inside the scene text.
- Do NOT output the first words of the scene. Only output anchors where a NEW internal idea begins.
- Short resulting scenes are allowed.
- In any domain, do not keep separate list items bundled just because they are in one sentence: "feature A, feature B, and feature C" can become three visual beats.
- For multilingual builds, anchors and lowerThird text must stay in ${buildLangName} unless they are proper nouns.
- If a scene is truly one idea, output no line for it.

SCENES:
${sceneBlock}

OUTPUT FORMAT ONLY:
SCENE <number> | anchor="<exact words where new idea starts>" | visual="<specific visual target>" | lowerThird="<short on-screen text or none>" | reason="<why this is a separate idea>"`;
}

function buildIdeaMixedSceneAuditPrompt(scenes, scriptContext = {}, directorsBrief = {}) {
    const buildLang = directorsBrief.language || scriptContext.language || 'en';
    const buildLangName = _languageName(buildLang);
    const sceneBlock = scenes.map(scene => {
        const dur = ((scene.endTime || 0) - (scene.startTime || 0)).toFixed(1);
        return `SCENE ${scene.index} (${dur}s)
TEXT: "${String(scene.text || '').replace(/\s+/g, ' ').trim()}"
CURRENT INTENT: ${_ideaSceneMetaLine(scene)}`;
    }).join('\n\n');

    return `You are auditing AI-split video scenes for mixed visual ideas.

Do NOT use duration, word count, pacing, or scene-count rules.
Only split when the scene text itself contains more than one clear visual idea.

Split a scene if it mixes separate visual beats such as:
- multiple named entities, brands, products, people, places, countries, events, or competitors
- multiple features/options/specs/prices/stats that need different visuals
- a claim plus a separate consequence, objection, answer, or conclusion
- a list where each item deserves its own visual
- comma-separated strengths, weaknesses, defects, benefits, risks, or features where each item can be shown differently
- a complete setup/context sentence followed by a new sentence that starts the next idea

Protect intentional short beats. If a scene is already one clean idea, output nothing for it.

Rules:
- Anchor must be exact consecutive words from inside the scene text.
- Do NOT output the first words of the scene. Only output anchors where a NEW internal idea begins.
- Short resulting scenes are allowed when the idea is real.
- In any domain, do not keep separate list items bundled just because they are in one sentence: "feature A, feature B, and feature C" can become three visual beats.
- For multilingual builds, anchors and lowerThird text must stay in ${buildLangName} unless they are proper nouns.
- If unsure, output nothing.

SCENES:
${sceneBlock}

OUTPUT FORMAT ONLY FOR SPLITS:
SCENE <number> | anchor="<exact words where new idea starts>" | visual="<specific visual target>" | lowerThird="<short on-screen text or none>" | reason="<why this is a separate idea>"`;
}

function _splitIdeaScenesWithRefinements(scenes, refinements, fps) {
    const byScene = new Map();
    for (const ref of refinements || []) {
        if (!byScene.has(ref.sceneIndex)) byScene.set(ref.sceneIndex, []);
        byScene.get(ref.sceneIndex).push(ref);
    }

    const out = [];
    let applied = 0;
    let skipped = 0;

    for (const scene of scenes || []) {
        const refs = byScene.get(scene.index) || [];
        if (!refs.length || !Array.isArray(scene.words) || scene.words.length < 4) {
            out.push(scene);
            continue;
        }

        const cuts = [];
        for (const ref of refs) {
            const localIdx = findWordIndex(ref.anchor, scene.words, 0);
            if (localIdx <= 0 || localIdx >= scene.words.length - 1) {
                skipped++;
                continue;
            }
            if (!cuts.some(c => Math.abs(c.localIdx - localIdx) <= 1)) {
                cuts.push({ localIdx, ref });
            }
        }
        cuts.sort((a, b) => a.localIdx - b.localIdx);

        if (!cuts.length) {
            out.push(scene);
            continue;
        }

        const points = [0, ...cuts.map(c => c.localIdx), scene.words.length];
        for (let i = 0; i < points.length - 1; i++) {
            const start = points[i];
            const end = points[i + 1];
            const words = scene.words.slice(start, end);
            if (!words.length) continue;

            const ref = i === 0 ? null : cuts[i - 1]?.ref;
            const startTime = typeof words[0].start === 'number' ? words[0].start : scene.startTime;
            const endTime = i < points.length - 2
                ? scene.words[points[i + 1]].start
                : scene.endTime;
            const lowerThird = ref ? _usableLowerThird(ref.lowerThird) : scene.ideaLowerThird;

            out.push({
                ...scene,
                index: 0,
                text: words.map(w => w.word).join(' ').trim(),
                startTime,
                endTime,
                duration: Math.max(1, Math.round((endTime - startTime) * fps)),
                words,
                _ideaLocked: true,
                ideaAnchor: ref ? ref.anchor : scene.ideaAnchor,
                ideaVisual: ref ? ref.visual : scene.ideaVisual,
                ideaLowerThird: lowerThird || null,
                ideaReason: ref ? ref.reason : scene.ideaReason,
                protectedTerms: lowerThird ? [lowerThird] : (i === 0 ? (scene.protectedTerms || []) : []),
            });
        }
        applied += cuts.length;
    }

    out.forEach((scene, index) => { scene.index = index; });
    return { scenes: out, applied, skipped };
}

async function _refineLongIdeaScenes({ scenes, scriptContext, directorsBrief, useBedrock, fps }) {
    const env = String(process.env.USE_IDEA_LONG_SCENE_REFINER || 'true').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(env)) {
        return { scenes, stats: { refinedAnchors: 0, passes: 0, candidates: 0 } };
    }

    const threshold = Math.max(8, parseFloat(process.env.IDEA_LONG_SCENE_SECONDS || '10') || 10);
    const maxPasses = Math.max(1, parseInt(process.env.IDEA_LONG_SCENE_REFINER_PASSES || '2', 10) || 2);
    const batchSize = Math.max(2, parseInt(process.env.IDEA_LONG_SCENE_REFINER_BATCH || '8', 10) || 8);
    let current = scenes;
    let refinedAnchors = 0;
    let totalCandidates = 0;
    let passes = 0;

    for (let pass = 0; pass < maxPasses; pass++) {
        const candidates = current.filter(scene => {
            const dur = (scene.endTime || 0) - (scene.startTime || 0);
            return dur >= threshold && Array.isArray(scene.words) && scene.words.length >= 10;
        });
        if (!candidates.length) break;

        passes++;
        totalCandidates += candidates.length;
        const refinements = [];
        for (let i = 0; i < candidates.length; i += batchSize) {
            const batch = candidates.slice(i, i + batchSize);
            const prompt = buildIdeaLongSceneRefinementPrompt(batch, scriptContext, directorsBrief);
            const maxTokens = Math.max(3000, Math.min(12000, batch.length * 1200));
            const { text: rawText, meta } = await _callIdeaPlanner(prompt, maxTokens, useBedrock);
            if (_isMaxTokenStop(meta)) {
                console.warn(`   IdeaSplit long-scene refiner batch ${Math.floor(i / batchSize) + 1}: stop=max_tokens; accepting parsed anchors but review may be incomplete`);
            }
            refinements.push(...parseIdeaRefinementPlan(rawText));
        }

        const split = _splitIdeaScenesWithRefinements(current, refinements, fps);
        refinedAnchors += split.applied;
        current = split.scenes;
        console.log(`   IdeaSplit long-scene refiner pass ${pass + 1}: candidates=${candidates.length}, anchors=${refinements.length}, applied=${split.applied}, scenes=${current.length}`);
        if (split.applied === 0) break;
    }

    return {
        scenes: current,
        stats: { refinedAnchors, passes, candidates: totalCandidates, threshold },
    };
}

async function _auditMixedIdeaScenes({ scenes, scriptContext, directorsBrief, useBedrock, fps, audioDuration, label = 'mixed-scene audit' }) {
    const env = String(process.env.USE_IDEA_MIXED_SCENE_AUDIT || 'true').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(env)) {
        return { scenes: normalizeIdeaSceneContinuity(scenes, audioDuration, fps), stats: { candidates: 0, anchors: 0, applied: 0, skipped: 0, passes: 0 } };
    }

    const batchSize = Math.max(8, parseInt(process.env.IDEA_MIXED_SCENE_AUDIT_BATCH || '20', 10) || 20);
    const maxPasses = Math.max(1, parseInt(process.env.IDEA_MIXED_SCENE_AUDIT_PASSES || '1', 10) || 1);
    let current = normalizeIdeaSceneContinuity(scenes, audioDuration, fps);
    let totalAnchors = 0;
    let totalApplied = 0;
    let totalSkipped = 0;
    let passes = 0;

    for (let pass = 0; pass < maxPasses; pass++) {
        passes++;
        const refinements = [];
        const candidates = current.filter(scene => Array.isArray(scene.words) && scene.words.length >= 4);

        for (let i = 0; i < candidates.length; i += batchSize) {
            const batch = candidates.slice(i, i + batchSize);
            const prompt = buildIdeaMixedSceneAuditPrompt(batch, scriptContext, directorsBrief);
            const maxTokens = Math.max(3500, Math.min(14000, batch.length * 650));
            try {
                const { text: rawText, meta } = await _callIdeaPlanner(prompt, maxTokens, useBedrock);
                if (_isMaxTokenStop(meta)) {
                    console.warn(`   IdeaSplit ${label} batch ${Math.floor(i / batchSize) + 1}: stop=max_tokens; accepting parsed anchors but review may be incomplete`);
                }
                refinements.push(...parseIdeaRefinementPlan(rawText));
            } catch (err) {
                console.warn(`   IdeaSplit ${label} batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`);
            }
        }

        const split = _splitIdeaScenesWithRefinements(current, refinements, fps);
        current = normalizeIdeaSceneContinuity(split.scenes, audioDuration, fps);
        totalAnchors += refinements.length;
        totalApplied += split.applied;
        totalSkipped += split.skipped;
        console.log(`   IdeaSplit ${label} pass ${pass + 1}: candidates=${candidates.length}, anchors=${refinements.length}, applied=${split.applied}, skipped=${split.skipped}, scenes=${current.length}`);
        if (split.applied === 0) break;
    }

    return {
        scenes: current,
        stats: {
            candidates: current.length,
            anchors: totalAnchors,
            applied: totalApplied,
            skipped: totalSkipped,
            passes,
        },
    };
}

function buildIdeaMicroSceneCleanupPrompt(candidates, scriptContext = {}, directorsBrief = {}) {
    const buildLang = directorsBrief.language || scriptContext.language || 'en';
    const buildLangName = _languageName(buildLang);
    const blocks = candidates.map(({ scene, prev, next }) => {
        const dur = ((scene.endTime || 0) - (scene.startTime || 0)).toFixed(1);
        const prevLine = prev ? `PREV ${prev.index}: "${String(prev.text || '').replace(/\s+/g, ' ').trim()}"` : 'PREV: none';
        const nextLine = next ? `NEXT ${next.index}: "${String(next.text || '').replace(/\s+/g, ' ').trim()}"` : 'NEXT: none';
        const prevIntent = prev ? `PREV INTENT: ${_ideaSceneMetaLine(prev)}` : '';
        const nextIntent = next ? `NEXT INTENT: ${_ideaSceneMetaLine(next)}` : '';
        return `${prevLine}\n${prevIntent}\nSCENE ${scene.index} (${dur}s): "${String(scene.text || '').replace(/\s+/g, ' ').trim()}"\nSCENE INTENT: ${_ideaSceneMetaLine(scene)}\n${nextLine}\n${nextIntent}`.replace(/\n{3,}/g, '\n\n');
    }).join('\n\n');

    return `You are doing a final semantic cleanup of very short AI-edited scenes.

Do NOT apply duration rules. Use editorial judgement only.

Keep a short scene when it is an intentional visual beat: a named entity, brand, competitor, product, stat, punchline, list item, or call-and-response beat.
Fix a short scene only when it is not a complete visual idea, such as a dangling phrase, grammar fragment, orphan connector, or split that clearly broke one idea across two scenes.
If SCENE has lowerThird/protected intent, treat it as an intentional visual beat. Do not merge it into a different idea; use a small move action if only a connector is misplaced.
If protected scenes are two broken halves of the same sentence, mark repair="fragment" so the structural guard can allow the repair.
Every mergePrev/mergeNext action must be a real fragment repair and must use repair="fragment". Do not merge for repair="sameIdea" or because two beats are merely related.
Move actions are only for tiny misplaced connector/fragment text. Do not move a full clause or complete idea into a neighbor.

Examples:
- "It beat Brand A." + "And it did not..." => keep Brand A separate.
- "Company A outsold" + "Company B and Company C." => merge because the first side is an incomplete claim.
- "market share of over" + "3 percent" => merge because the statistic is split.
- "priced it right," + "and executed..." => merge because the phrase is incomplete.

Allowed actions:
- keep
- mergePrev
- mergeNext
- moveTrailingNext
- moveLeadingPrev

For moveTrailingNext or moveLeadingPrev, provide text="<exact word(s) to move>".
Set repair="<none|fragment|connector>". sameIdea is not a repair; keep related complete beats separate.
For multilingual builds, reason in any language is fine, but text must be exact words from the scene (${buildLangName} narration).
If unsure, choose keep. Do not create new anchors.

CANDIDATES:
${blocks}

OUTPUT FORMAT ONLY:
SCENE <number> | action="<keep|mergePrev|mergeNext|moveTrailingNext|moveLeadingPrev>" | text="<exact moved words or none>" | repair="<none|fragment|connector>" | reason="<brief editorial reason>"`;
}

function parseIdeaMicroCleanupPlan(rawText) {
    const actions = [];
    const seen = new Set();
    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
        const line = String(rawLine || '').trim().replace(/^\s*[-*]\s*/, '');
        if (!line || !/\baction\s*[:=]/i.test(line)) continue;
        const sceneMatch = line.match(/\bscene\s*#?\s*(\d+)\b/i) || line.match(/^S\s*(\d+)\b/i);
        if (!sceneMatch) continue;
        const sceneIndex = parseInt(sceneMatch[1], 10);
        if (seen.has(sceneIndex)) continue;
        seen.add(sceneIndex);

        const fields = _extractIdeaFields(line);
        const action = _cleanIdeaField(fields.action || '').toLowerCase().replace(/[^a-z]/g, '');
        if (!['keep', 'mergeprev', 'mergenext', 'movetrailingnext', 'moveleadingprev'].includes(action)) continue;

        actions.push({
            sceneIndex,
            action,
            text: _cleanIdeaField(fields.text || fields.words || ''),
            repair: _cleanIdeaField(fields.repair || fields.type || fields.kind || ''),
            reason: _cleanIdeaField(fields.reason || fields.why || ''),
        });
    }
    return actions;
}

function _refreshIdeaSceneTiming(scene, fps) {
    if (Array.isArray(scene.words) && scene.words.length > 0) {
        scene.text = scene.words.map(w => w.word).join(' ').trim();
        scene.startTime = typeof scene.words[0].start === 'number' ? scene.words[0].start : scene.startTime;
        const last = scene.words[scene.words.length - 1];
        if (typeof last.end === 'number') {
            scene.endTime = last.end;
        }
    }
    scene.duration = Math.max(1, Math.round(((scene.endTime || 0) - (scene.startTime || 0)) * fps));
    return scene;
}

function normalizeIdeaSceneContinuity(scenes, audioDuration, fps) {
    const out = (scenes || []).map(scene => ({
        ...scene,
        words: Array.isArray(scene.words) ? [...scene.words] : scene.words,
        protectedTerms: Array.isArray(scene.protectedTerms) ? [...scene.protectedTerms] : scene.protectedTerms,
    }));

    for (const scene of out) {
        if (Array.isArray(scene.words) && scene.words.length > 0) {
            scene.text = scene.words.map(w => w.word).join(' ').trim();
            if (typeof scene.words[0].start === 'number') {
                scene.startTime = scene.words[0].start;
            }
        }
    }

    const fallbackEnd = out.length
        ? (out[out.length - 1].endTime || out[out.length - 1].words?.[out[out.length - 1].words.length - 1]?.end || 0)
        : 0;
    const finalEnd = Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : fallbackEnd;

    for (let i = 0; i < out.length; i++) {
        const scene = out[i];
        const startTime = Number.isFinite(scene.startTime) ? scene.startTime : 0;
        const nextStart = out[i + 1] && Number.isFinite(out[i + 1].startTime) ? out[i + 1].startTime : null;
        const lastWordEnd = Array.isArray(scene.words) && scene.words.length
            ? scene.words[scene.words.length - 1]?.end
            : null;

        if (nextStart != null && nextStart > startTime) {
            scene.endTime = nextStart;
        } else if (i === out.length - 1) {
            scene.endTime = Math.max(startTime + 0.05, finalEnd || lastWordEnd || scene.endTime || startTime + 0.05);
        } else {
            scene.endTime = Math.max(startTime + 0.05, lastWordEnd || scene.endTime || startTime + 0.05);
        }
        scene.duration = Math.max(1, Math.round(((scene.endTime || 0) - startTime) * fps));
        scene.index = i;
    }

    return out;
}

function _mergeIdeaScenePair(left, right, fps, reason = '') {
    const protectedTerms = [
        ...(Array.isArray(left.protectedTerms) ? left.protectedTerms : []),
        ...(Array.isArray(right.protectedTerms) ? right.protectedTerms : []),
    ].filter(Boolean);
    const merged = {
        ...left,
        text: `${left.text || ''} ${right.text || ''}`.replace(/\s+/g, ' ').trim(),
        startTime: left.startTime,
        endTime: right.endTime,
        words: [...(left.words || []), ...(right.words || [])],
        duration: Math.max(1, Math.round(((right.endTime || 0) - (left.startTime || 0)) * fps)),
        _ideaLocked: true,
        ideaVisual: [left.ideaVisual, right.ideaVisual].filter(Boolean).join(' / '),
        ideaReason: reason || left.ideaReason || right.ideaReason || '',
        protectedTerms: [...new Set(protectedTerms)],
    };
    const sourceIndexes = [
        ...(Array.isArray(left._qaSourceIndexes) ? left._qaSourceIndexes : [left.index]),
        ...(Array.isArray(right._qaSourceIndexes) ? right._qaSourceIndexes : [right.index]),
    ].filter(index => Number.isInteger(index));
    if (sourceIndexes.length) merged._qaSourceIndexes = [...new Set(sourceIndexes)];
    if (!merged.ideaLowerThird && right.ideaLowerThird) merged.ideaLowerThird = right.ideaLowerThird;
    return merged;
}

function _trailingWordCount(words, text) {
    const target = normalize(text).split(/\s+/).filter(Boolean);
    if (!target.length || target.length >= words.length) return 0;
    const tail = words.slice(-target.length).map(w => normalize(w.word));
    return tail.every((w, i) => w === target[i]) ? target.length : 0;
}

function _leadingWordCount(words, text) {
    const target = normalize(text).split(/\s+/).filter(Boolean);
    if (!target.length || target.length >= words.length) return 0;
    const head = words.slice(0, target.length).map(w => normalize(w.word));
    return head.every((w, i) => w === target[i]) ? target.length : 0;
}

function applyIdeaMicroSceneCleanup(scenes, cleanupActions, fps) {
    const actionByIndex = new Map((cleanupActions || []).map(action => [action.sceneIndex, action]));
    const out = [];
    let applied = 0;
    let skipped = 0;

    for (let i = 0; i < scenes.length; i++) {
        const scene = { ...scenes[i], words: Array.isArray(scenes[i].words) ? [...scenes[i].words] : scenes[i].words };
        const action = actionByIndex.get(scene.index);
        if (!action || action.action === 'keep') {
            out.push(scene);
            continue;
        }

        if (action.action === 'mergeprev') {
            if (!out.length) {
                skipped++;
                out.push(scene);
                continue;
            }
            const prev = out.pop();
            if (!_isSafeIdeaMergeAction(action, prev, scene)) {
                skipped++;
                out.push(prev);
                out.push(scene);
                continue;
            }
            if ((_hasProtectedIdeaBeat(prev) || _hasProtectedIdeaBeat(scene)) && !_shareProtectedIdeaBeat(prev, scene) && !_isFragmentRepairAction(action)) {
                skipped++;
                out.push(prev);
                out.push(scene);
                continue;
            }
            out.push(_mergeIdeaScenePair(prev, scene, fps, action.reason));
            applied++;
            continue;
        }

        if (action.action === 'mergenext') {
            const next = scenes[i + 1];
            if (!next) {
                skipped++;
                out.push(scene);
                continue;
            }
            if (!_isSafeIdeaMergeAction(action, scene, next)) {
                skipped++;
                out.push(scene);
                continue;
            }
            if ((_hasProtectedIdeaBeat(scene) || _hasProtectedIdeaBeat(next)) && !_shareProtectedIdeaBeat(scene, next) && !_isFragmentRepairAction(action)) {
                skipped++;
                out.push(scene);
                continue;
            }
            out.push(_mergeIdeaScenePair(scene, next, fps, action.reason));
            i++;
            applied++;
            continue;
        }

        if (action.action === 'movetrailingnext') {
            const next = scenes[i + 1] ? { ...scenes[i + 1], words: Array.isArray(scenes[i + 1].words) ? [...scenes[i + 1].words] : scenes[i + 1].words } : null;
            const count = Array.isArray(scene.words) ? _trailingWordCount(scene.words, action.text) : 0;
            if (!next || !Array.isArray(next.words) || count <= 0 || !_isSafeIdeaMoveAction(action, count)) {
                skipped++;
                out.push(scene);
                continue;
            }
            const moved = scene.words.splice(scene.words.length - count, count);
            next.words = [...moved, ...next.words];
            _refreshIdeaSceneTiming(scene, fps);
            _refreshIdeaSceneTiming(next, fps);
            out.push(scene);
            scenes[i + 1] = next;
            applied++;
            continue;
        }

        if (action.action === 'moveleadingprev') {
            if (!out.length || !Array.isArray(scene.words)) {
                skipped++;
                out.push(scene);
                continue;
            }
            const prev = out.pop();
            const count = _leadingWordCount(scene.words, action.text);
            if (!Array.isArray(prev.words) || count <= 0 || !_isSafeIdeaMoveAction(action, count)) {
                skipped++;
                out.push(prev);
                out.push(scene);
                continue;
            }
            const moved = scene.words.splice(0, count);
            prev.words = [...prev.words, ...moved];
            _refreshIdeaSceneTiming(prev, fps);
            _refreshIdeaSceneTiming(scene, fps);
            out.push(prev);
            out.push(scene);
            applied++;
            continue;
        }

        out.push(scene);
    }

    out.forEach((scene, index) => { scene.index = index; });
    return { scenes: out, applied, skipped };
}

function buildIdeaBoundaryQaPrompt(boundaries, scriptContext = {}, directorsBrief = {}) {
    const buildLang = directorsBrief.language || scriptContext.language || 'en';
    const buildLangName = _languageName(buildLang);
    const blocks = (boundaries || []).map(({ left, right }) => {
        const leftDur = ((left.endTime || 0) - (left.startTime || 0)).toFixed(1);
        const rightDur = ((right.endTime || 0) - (right.startTime || 0)).toFixed(1);
        return `BOUNDARY ${left.index}
LEFT ${left.index} (${leftDur}s): "${String(left.text || '').replace(/\s+/g, ' ').trim()}"
LEFT INTENT: ${_ideaSceneMetaLine(left)}
RIGHT ${right.index} (${rightDur}s): "${String(right.text || '').replace(/\s+/g, ' ').trim()}"
RIGHT INTENT: ${_ideaSceneMetaLine(right)}`;
    }).join('\n\n');

    return `You are the final boundary QA editor for AI-split faceless-video scenes.

Review each boundary as a human editor. Do NOT use duration rules, scene-count targets, punctuation rules, or fixed pacing rules.

Your job is only to catch semantic edit mistakes:
- one idea was accidentally chopped across two scenes
- a connector, half phrase, or grammar fragment is stuck to the wrong scene
- two unrelated ideas were accidentally mixed inside one side of the boundary
- a list/comparison/feature has a new visual idea that needs its own scene
- RIGHT starts as a dependent fragment in ${buildLangName} and needs earlier words from LEFT to become a complete thought

Important:
- Keep short scenes when they are intentional visual beats: named entities, brands, products, statistics, punchlines, list items, or lower-third moments.
- Do not merge separate competitor/product beats just because they are short.
- If LEFT or RIGHT has lowerThird/protected intent, treat that side as an intentional visual beat. Do not merge it into a different idea; prefer no action or a small move action.
- A merge is allowed only when LEFT and RIGHT are clearly two broken halves of the same sentence/claim, and merge actions must use repair="fragment".
- Do not merge for repair="sameIdea" or because two complete beats are merely related.
- To fix a scene that contains multiple ideas, prefer splitLeft/splitRight over merging across the boundary.
- If RIGHT starts as a dependent fragment and LEFT contains a complete separate setup sentence plus the beginning of RIGHT's sentence, use splitLeft at the beginning of that second sentence. Do not leave RIGHT starting mid-thought.
- If LEFT and RIGHT are only two halves of one sentence, use merge with repair="fragment".
- If protected scenes are two broken halves of the same sentence, mark repair="fragment" so the structural guard can allow the repair.
- If a boundary is clean, output nothing for it.
- If unsure, output nothing.
- For move actions, text must be exact word(s) from LEFT or RIGHT.
- Move actions are only for tiny misplaced connector/fragment text. Do not move a full clause or complete idea into a neighbor.
- For split actions, anchor must be exact consecutive words from the scene being split and must mark where the NEW idea starts.
- For multilingual builds, moved text, anchor, and lowerThird must stay in ${buildLangName} unless they are proper nouns.

Allowed actions:
- merge: remove the boundary; LEFT and RIGHT are one visual idea.
- moveTrailingNext: move exact trailing word(s) from LEFT to the start of RIGHT.
- moveLeadingPrev: move exact leading word(s) from RIGHT to the end of LEFT.
- splitLeft: LEFT contains two visual ideas; create a new scene inside LEFT at anchor.
- splitRight: RIGHT contains two visual ideas; create a new scene inside RIGHT at anchor.

Examples:
- LEFT "Context sentence. And it is worth explaining plainly" + RIGHT "because the decision matters." => splitLeft at "And it is worth explaining plainly", repair="fragment".
- LEFT "The result helps everyone" + RIGHT "because it forces every brand to improve." => merge, repair="fragment".
- LEFT "Feature A, feature B" + RIGHT "and feature C." => no merge if each feature is an intentional separate visual beat.

BOUNDARIES:
${blocks}

OUTPUT FORMAT ONLY FOR REPAIRS:
BOUNDARY <leftSceneNumber> | action="<merge|moveTrailingNext|moveLeadingPrev|splitLeft|splitRight>" | text="<exact moved words or none>" | anchor="<exact split anchor or none>" | visual="<specific visual target or none>" | lowerThird="<short on-screen text or none>" | repair="<none|fragment|connector>" | reason="<brief editorial reason>"`;
}

function buildIdeaFinalFragmentCleanupPrompt(boundaries, scriptContext = {}, directorsBrief = {}) {
    const buildLang = directorsBrief.language || scriptContext.language || 'en';
    const buildLangName = _languageName(buildLang);
    const blocks = (boundaries || []).map(({ left, right }) => {
        const leftDur = ((left.endTime || 0) - (left.startTime || 0)).toFixed(1);
        const rightDur = ((right.endTime || 0) - (right.startTime || 0)).toFixed(1);
        return `BOUNDARY ${left.index}
LEFT ${left.index} (${leftDur}s): "${String(left.text || '').replace(/\s+/g, ' ').trim()}"
LEFT INTENT: ${_ideaSceneMetaLine(left)}
RIGHT ${right.index} (${rightDur}s): "${String(right.text || '').replace(/\s+/g, ' ').trim()}"
RIGHT INTENT: ${_ideaSceneMetaLine(right)}`;
    }).join('\n\n');

    return `You are doing the final cleanup after an AI mixed-scene split pass.

The previous pass may have split real visual ideas correctly, but it can leave grammar fragments, dangling connectors, or chopped phrases.

Do NOT split anything in this pass. Do NOT create new scenes or anchors.
Use only merge/move repairs when a boundary is clearly broken.

Protect real visual beats:
- Keep separate named entities, brands, products, people, places, stats, specs, features, list items, punchlines, and lower-third moments.
- If LEFT or RIGHT has lowerThird/protected intent, treat it as intentional. Do not merge it into a different idea.
- A merge is allowed only when LEFT and RIGHT are broken pieces of the same sentence/claim, and merge actions must use repair="fragment".
- Do not merge for repair="sameIdea" or because two complete beats are merely related.
- Moving a tiny connector such as an exact word/phrase is allowed when it fixes grammar without destroying separate visual beats.
- Move actions are only for tiny misplaced connector/fragment text. Do not move a full clause or complete idea into a neighbor.
- If RIGHT starts as a dependent fragment in ${buildLangName} and LEFT is the beginning of that same sentence/claim, merge with repair="fragment".
- If protected scenes are two broken halves of the same sentence, mark repair="fragment" so the structural guard can allow the repair.

Examples:
- "It beat Brand A." + "And it did not..." => no action; Brand A is a complete visual beat.
- "Company A outsold" + "Company B and Company C." => merge, repair="fragment".
- "market share of over" + "3 percent" => merge, repair="fragment".
- "priced it right," + "and executed..." => merge, repair="fragment".
- "The result helps everyone" + "because it forces every brand to improve." => merge, repair="fragment".

If a boundary is clean or you are unsure, output nothing.
For move actions, text must be exact word(s) from LEFT or RIGHT in ${buildLangName}.

BOUNDARIES:
${blocks}

OUTPUT FORMAT ONLY FOR REPAIRS:
BOUNDARY <leftSceneNumber> | action="<merge|moveTrailingNext|moveLeadingPrev>" | text="<exact moved words or none>" | anchor="none" | visual="none" | lowerThird="none" | repair="<fragment|connector>" | reason="<brief editorial reason>"`;
}

function parseIdeaBoundaryQaPlan(rawText) {
    const actions = [];
    const seen = new Set();

    for (const rawLine of String(rawText || '').split(/\r?\n/)) {
        const line = String(rawLine || '').trim().replace(/^\s*[-*]\s*/, '');
        if (!line || !/\baction\s*[:=]/i.test(line)) continue;

        const boundaryMatch = line.match(/\bboundary\s*#?\s*(\d+)\b/i) || line.match(/^B\s*0*(\d+)\b/i);
        if (!boundaryMatch) continue;
        const boundaryIndex = parseInt(boundaryMatch[1], 10);

        const fields = _extractIdeaFields(line);
        const rawAction = _cleanIdeaField(fields.action || '').toLowerCase().replace(/[^a-z]/g, '');
        const action = ({
            merge: 'merge',
            mergenext: 'merge',
            mergewithnext: 'merge',
            movetrailingnext: 'movetrailingnext',
            moveleadingprev: 'moveleadingprev',
            splitleft: 'splitleft',
            splitright: 'splitright',
            keep: 'keep',
        })[rawAction];
        if (!action || action === 'keep') continue;

        const text = _cleanIdeaField(fields.text || fields.words || '');
        const anchor = _cleanIdeaField(fields.anchor || fields.startanchor || fields.start || '');
        if ((action === 'movetrailingnext' || action === 'moveleadingprev') && !text) continue;
        if ((action === 'splitleft' || action === 'splitright') && !anchor) continue;

        const key = `${boundaryIndex}:${action}:${normalize(text || anchor)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        actions.push({
            boundaryIndex,
            action,
            text,
            anchor,
            visual: _cleanIdeaField(fields.visual || fields.shot || fields.intent || ''),
            lowerThird: _cleanIdeaField(fields.lowerthird || fields.lt || fields.lower || ''),
            repair: _cleanIdeaField(fields.repair || fields.type || fields.kind || ''),
            reason: _cleanIdeaField(fields.reason || fields.why || ''),
        });
    }

    return actions;
}

function _cloneIdeaSceneForQa(scene) {
    return {
        ...scene,
        words: Array.isArray(scene.words) ? [...scene.words] : scene.words,
        protectedTerms: Array.isArray(scene.protectedTerms) ? [...scene.protectedTerms] : scene.protectedTerms,
        _qaSourceIndexes: Array.isArray(scene._qaSourceIndexes) ? [...scene._qaSourceIndexes] : [scene.index],
    };
}

function applyIdeaBoundaryQaActions(scenes, boundaryActions, fps, audioDuration) {
    const work = (scenes || []).map(_cloneIdeaSceneForQa);
    const boundaryActionsByIndex = new Map();
    const splitActions = [];

    for (const action of boundaryActions || []) {
        if (!action || !Number.isInteger(action.boundaryIndex)) continue;
        if (action.action === 'splitleft' || action.action === 'splitright') {
            splitActions.push(action);
            continue;
        }
        if (!boundaryActionsByIndex.has(action.boundaryIndex)) {
            boundaryActionsByIndex.set(action.boundaryIndex, action);
        }
    }

    const moved = [];
    let applied = 0;
    let skipped = 0;
    let merged = 0;
    let movedWords = 0;

    for (let i = 0; i < work.length; i++) {
        const scene = work[i];
        const action = boundaryActionsByIndex.get(scene.index);
        if (!action) {
            moved.push(scene);
            continue;
        }

        const next = work[i + 1] ? _cloneIdeaSceneForQa(work[i + 1]) : null;
        if (!next) {
            skipped++;
            moved.push(scene);
            continue;
        }

        if (action.action === 'merge') {
            if (!_isSafeIdeaMergeAction(action, scene, next)) {
                skipped++;
                moved.push(scene);
                continue;
            }
            if ((_hasProtectedIdeaBeat(scene) || _hasProtectedIdeaBeat(next)) && !_shareProtectedIdeaBeat(scene, next) && !_isFragmentRepairAction(action)) {
                skipped++;
                moved.push(scene);
                continue;
            }
            moved.push(_mergeIdeaScenePair(scene, next, fps, action.reason));
            applied++;
            merged++;
            i++;
            continue;
        }

        if (action.action === 'movetrailingnext') {
            const count = Array.isArray(scene.words) ? _trailingWordCount(scene.words, action.text) : 0;
            if (!Array.isArray(scene.words) || !Array.isArray(next.words) || count <= 0 || !_isSafeIdeaMoveAction(action, count)) {
                skipped++;
                moved.push(scene);
                continue;
            }
            const wordsToMove = scene.words.splice(scene.words.length - count, count);
            next.words = [...wordsToMove, ...next.words];
            _refreshIdeaSceneTiming(scene, fps);
            _refreshIdeaSceneTiming(next, fps);
            moved.push(scene);
            work[i + 1] = next;
            applied++;
            movedWords += count;
            continue;
        }

        if (action.action === 'moveleadingprev') {
            const count = Array.isArray(next.words) ? _leadingWordCount(next.words, action.text) : 0;
            if (!Array.isArray(scene.words) || !Array.isArray(next.words) || count <= 0 || !_isSafeIdeaMoveAction(action, count)) {
                skipped++;
                moved.push(scene);
                continue;
            }
            const wordsToMove = next.words.splice(0, count);
            scene.words = [...scene.words, ...wordsToMove];
            _refreshIdeaSceneTiming(scene, fps);
            _refreshIdeaSceneTiming(next, fps);
            moved.push(scene);
            work[i + 1] = next;
            applied++;
            movedWords += count;
            continue;
        }

        moved.push(scene);
    }

    moved.forEach((scene, index) => { scene.index = index; });

    const refinements = [];
    const seenRefinements = new Set();
    for (const scene of moved) {
        const sources = Array.isArray(scene._qaSourceIndexes) ? scene._qaSourceIndexes : [scene.index];
        for (const action of splitActions) {
            const targetSource = action.action === 'splitleft' ? action.boundaryIndex : action.boundaryIndex + 1;
            if (!sources.includes(targetSource)) continue;
            const key = `${scene.index}:${normalize(action.anchor)}`;
            if (seenRefinements.has(key)) continue;
            seenRefinements.add(key);
            refinements.push({
                sceneIndex: scene.index,
                anchor: action.anchor,
                visual: action.visual,
                lowerThird: action.lowerThird,
                reason: action.reason,
            });
        }
    }

    const split = _splitIdeaScenesWithRefinements(moved, refinements, fps);
    const normalized = normalizeIdeaSceneContinuity(split.scenes, audioDuration, fps);

    return {
        scenes: normalized,
        applied: applied + split.applied,
        skipped: skipped + split.skipped,
        merged,
        movedWords,
        splitAnchors: refinements.length,
        splitApplied: split.applied,
    };
}

async function _reviewIdeaBoundaries({ scenes, scriptContext, directorsBrief, useBedrock, fps, audioDuration }) {
    const env = String(process.env.USE_IDEA_BOUNDARY_QA || 'true').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(env)) {
        return { scenes: normalizeIdeaSceneContinuity(scenes, audioDuration, fps), stats: { boundaries: 0, actions: 0, applied: 0, skipped: 0 } };
    }

    const boundaries = [];
    for (let i = 0; i < scenes.length - 1; i++) {
        boundaries.push({ left: scenes[i], right: scenes[i + 1] });
    }
    if (!boundaries.length) {
        return { scenes: normalizeIdeaSceneContinuity(scenes, audioDuration, fps), stats: { boundaries: 0, actions: 0, applied: 0, skipped: 0 } };
    }

    const batchSize = Math.max(8, parseInt(process.env.IDEA_BOUNDARY_QA_BATCH || '20', 10) || 20);
    const actions = [];
    for (let i = 0; i < boundaries.length; i += batchSize) {
        const batch = boundaries.slice(i, i + batchSize);
        const prompt = buildIdeaBoundaryQaPrompt(batch, scriptContext, directorsBrief);
        const maxTokens = Math.max(3000, Math.min(12000, batch.length * 450));
        try {
            const { text: rawText, meta } = await _callIdeaPlanner(prompt, maxTokens, useBedrock);
            if (_isMaxTokenStop(meta)) {
                console.warn(`   IdeaSplit boundary QA batch ${Math.floor(i / batchSize) + 1}: stop=max_tokens; accepting parsed repairs but review may be incomplete`);
            }
            actions.push(...parseIdeaBoundaryQaPlan(rawText));
        } catch (err) {
            console.warn(`   IdeaSplit boundary QA batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`);
        }
    }

    const applied = applyIdeaBoundaryQaActions(scenes, actions, fps, audioDuration);
    console.log(`   IdeaSplit boundary QA: boundaries=${boundaries.length}, actions=${actions.length}, applied=${applied.applied}, merged=${applied.merged}, movedWords=${applied.movedWords}, split=${applied.splitApplied}/${applied.splitAnchors}, skipped=${applied.skipped}, scenes=${applied.scenes.length}`);
    return {
        scenes: applied.scenes,
        stats: {
            boundaries: boundaries.length,
            actions: actions.length,
            applied: applied.applied,
            skipped: applied.skipped,
            merged: applied.merged,
            movedWords: applied.movedWords,
            splitAnchors: applied.splitAnchors,
            splitApplied: applied.splitApplied,
        },
    };
}

async function _cleanupFinalIdeaFragments({ scenes, scriptContext, directorsBrief, useBedrock, fps, audioDuration }) {
    const env = String(process.env.USE_IDEA_FINAL_FRAGMENT_CLEANUP || 'true').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(env)) {
        return { scenes: normalizeIdeaSceneContinuity(scenes, audioDuration, fps), stats: { boundaries: 0, actions: 0, applied: 0, skipped: 0 } };
    }

    const current = normalizeIdeaSceneContinuity(scenes, audioDuration, fps);
    const boundaries = [];
    for (let i = 0; i < current.length - 1; i++) {
        boundaries.push({ left: current[i], right: current[i + 1] });
    }
    if (!boundaries.length) {
        return { scenes: current, stats: { boundaries: 0, actions: 0, applied: 0, skipped: 0 } };
    }

    const batchSize = Math.max(8, parseInt(process.env.IDEA_FINAL_FRAGMENT_CLEANUP_BATCH || '20', 10) || 20);
    const actions = [];
    for (let i = 0; i < boundaries.length; i += batchSize) {
        const batch = boundaries.slice(i, i + batchSize);
        const prompt = buildIdeaFinalFragmentCleanupPrompt(batch, scriptContext, directorsBrief);
        const maxTokens = Math.max(3000, Math.min(12000, batch.length * 420));
        try {
            const { text: rawText, meta } = await _callIdeaPlanner(prompt, maxTokens, useBedrock);
            if (_isMaxTokenStop(meta)) {
                console.warn(`   IdeaSplit final fragment cleanup batch ${Math.floor(i / batchSize) + 1}: stop=max_tokens; accepting parsed repairs but review may be incomplete`);
            }
            const repairs = parseIdeaBoundaryQaPlan(rawText)
                .filter(action => ['merge', 'movetrailingnext', 'moveleadingprev'].includes(action.action));
            actions.push(...repairs);
        } catch (err) {
            console.warn(`   IdeaSplit final fragment cleanup batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`);
        }
    }

    const applied = applyIdeaBoundaryQaActions(current, actions, fps, audioDuration);
    console.log(`   IdeaSplit final fragment cleanup: boundaries=${boundaries.length}, actions=${actions.length}, applied=${applied.applied}, merged=${applied.merged}, movedWords=${applied.movedWords}, skipped=${applied.skipped}, scenes=${applied.scenes.length}`);

    return {
        scenes: applied.scenes,
        stats: {
            boundaries: boundaries.length,
            actions: actions.length,
            applied: applied.applied,
            skipped: applied.skipped,
            merged: applied.merged,
            movedWords: applied.movedWords,
        },
    };
}

async function _cleanupMicroIdeaScenes({ scenes, scriptContext, directorsBrief, useBedrock, fps, audioDuration, label = 'micro cleanup', thresholdSeconds = null }) {
    const env = String(process.env.USE_IDEA_MICRO_SCENE_CLEANUP || 'true').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(env)) {
        return { scenes, stats: { candidates: 0, actions: 0, applied: 0, skipped: 0 } };
    }

    const configuredThreshold = Number.isFinite(thresholdSeconds)
        ? thresholdSeconds
        : (parseFloat(process.env.IDEA_MICRO_SCENE_SECONDS || '3') || 3);
    const threshold = Math.max(1.2, configuredThreshold);
    const batchSize = Math.max(8, parseInt(process.env.IDEA_MICRO_SCENE_BATCH || '25', 10) || 25);
    const candidates = [];
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const dur = (scene.endTime || 0) - (scene.startTime || 0);
        if (dur <= threshold) {
            candidates.push({ scene, prev: scenes[i - 1] || null, next: scenes[i + 1] || null });
        }
    }
    if (!candidates.length) {
        return { scenes, stats: { candidates: 0, actions: 0, applied: 0, skipped: 0 } };
    }

    const actions = [];
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const prompt = buildIdeaMicroSceneCleanupPrompt(batch, scriptContext, directorsBrief);
        const maxTokens = Math.max(2500, Math.min(9000, batch.length * 360));
        try {
            const { text: rawText, meta } = await _callIdeaPlanner(prompt, maxTokens, useBedrock);
            if (_isMaxTokenStop(meta)) {
                console.warn(`   IdeaSplit ${label} batch ${Math.floor(i / batchSize) + 1}: stop=max_tokens; accepting parsed actions but review may be incomplete`);
            }
            actions.push(...parseIdeaMicroCleanupPlan(rawText));
        } catch (err) {
            console.warn(`   IdeaSplit ${label} batch ${Math.floor(i / batchSize) + 1} failed: ${err.message}`);
        }
    }

    const mergeActions = actions.filter(action => action.action !== 'keep');
    const applied = applyIdeaMicroSceneCleanup(scenes, mergeActions, fps);
    const normalizedScenes = normalizeIdeaSceneContinuity(applied.scenes, audioDuration, fps);
    console.log(`   IdeaSplit ${label}: candidates=${candidates.length}, actions=${mergeActions.length}, applied=${applied.applied}, skipped=${applied.skipped}, scenes=${normalizedScenes.length}`);
    return {
        scenes: normalizedScenes,
        stats: {
            candidates: candidates.length,
            actions: mergeActions.length,
            applied: applied.applied,
            skipped: applied.skipped,
        },
    };
}

async function _tryIdeaScenePlanner({ fullScript, allWords, audioDuration, fps, scriptContext, directorsBrief, webContext, useBedrock }) {
    const env = String(process.env.USE_IDEA_SPLITTER || 'true').trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(env)) {
        console.log('   IdeaSplit disabled by USE_IDEA_SPLITTER');
        return null;
    }

    try {
        const planned = await _planIdeaChunks({
            allWords,
            audioDuration,
            scriptContext,
            directorsBrief,
            webContext,
            useBedrock,
            fps,
        });

        const ideas = planned.ideas;
        const built = buildIdeaScenesFromPlan(ideas, allWords, audioDuration, fps);
        const minMatchRate = parseFloat(process.env.IDEA_SPLITTER_MIN_MATCH_RATE || '0.55');
        const minScenes = Math.max(2, Math.min(30, Math.floor(audioDuration / 35)));

        console.log(`   IdeaSplit: parsed ${ideas.length} anchors, matched ${built.stats.matched}, built ${built.scenes.length} scenes (match ${(built.stats.matchRate * 100).toFixed(0)}%, chunks=${planned.stats.chunks}, retried=${planned.stats.retriedChunks})`);

        if (!ideas.length) {
            console.warn('   IdeaSplit rejected: AI returned no parseable anchors');
            return null;
        }
        if (planned.stats.truncatedChunks > 0) {
            console.warn(`   IdeaSplit rejected: ${planned.stats.truncatedChunks} chunk(s) still stopped at max_tokens after retry`);
            return null;
        }
        if (built.stats.matchRate < minMatchRate) {
            console.warn(`   IdeaSplit rejected: anchor match rate ${(built.stats.matchRate * 100).toFixed(0)}% < ${(minMatchRate * 100).toFixed(0)}%`);
            return null;
        }
        if (built.scenes.length < minScenes) {
            console.warn(`   IdeaSplit rejected: only ${built.scenes.length} scenes for ${audioDuration.toFixed(1)}s audio (minimum ${minScenes})`);
            return null;
        }

        const refined = await _refineLongIdeaScenes({
            scenes: built.scenes,
            scriptContext,
            directorsBrief,
            useBedrock,
            fps,
        });

        const cleaned = await _cleanupMicroIdeaScenes({
            scenes: refined.scenes,
            scriptContext,
            directorsBrief,
            useBedrock,
            fps,
            audioDuration,
            label: 'micro cleanup',
        });

        const boundaryQa = await _reviewIdeaBoundaries({
            scenes: cleaned.scenes,
            scriptContext,
            directorsBrief,
            useBedrock,
            fps,
            audioDuration,
        });

        const mixedAudit = await _auditMixedIdeaScenes({
            scenes: boundaryQa.scenes,
            scriptContext,
            directorsBrief,
            useBedrock,
            fps,
            audioDuration,
            label: 'mixed-scene audit',
        });

        const postAuditMicro = await _cleanupMicroIdeaScenes({
            scenes: mixedAudit.scenes,
            scriptContext,
            directorsBrief,
            useBedrock,
            fps,
            audioDuration,
            label: 'post-audit micro cleanup',
            thresholdSeconds: parseFloat(process.env.IDEA_POST_AUDIT_MICRO_SECONDS || '4') || 4,
        });

        const finalCleanup = await _cleanupFinalIdeaFragments({
            scenes: postAuditMicro.scenes,
            scriptContext,
            directorsBrief,
            useBedrock,
            fps,
            audioDuration,
        });

        return {
            scenes: normalizeIdeaSceneContinuity(finalCleanup.scenes, audioDuration, fps),
            stats: {
                ...built.stats,
                chunks: planned.stats.chunks,
                retriedChunks: planned.stats.retriedChunks,
                refinedAnchors: refined.stats.refinedAnchors,
                refinePasses: refined.stats.passes,
                longSceneCandidates: refined.stats.candidates,
                microCandidates: cleaned.stats.candidates,
                microActions: cleaned.stats.actions,
                microApplied: cleaned.stats.applied,
                boundaryQaBoundaries: boundaryQa.stats.boundaries,
                boundaryQaActions: boundaryQa.stats.actions,
                boundaryQaApplied: boundaryQa.stats.applied,
                boundaryQaMerged: boundaryQa.stats.merged,
                boundaryQaSplitApplied: boundaryQa.stats.splitApplied,
                mixedAuditAnchors: mixedAudit.stats.anchors,
                mixedAuditApplied: mixedAudit.stats.applied,
                mixedAuditPasses: mixedAudit.stats.passes,
                postAuditMicroCandidates: postAuditMicro.stats.candidates,
                postAuditMicroApplied: postAuditMicro.stats.applied,
                finalFragmentActions: finalCleanup.stats.actions,
                finalFragmentApplied: finalCleanup.stats.applied,
                finalFragmentMerged: finalCleanup.stats.merged,
            },
        };
    } catch (err) {
        console.warn(`   IdeaSplit failed: ${err.message}`);
        return null;
    }
}

// ============================================================
// POST-PROCESSING: AUTO-SPLIT LONG SCENES
// ============================================================

/**
 * Automatically split scenes that are longer than maxDuration.
 * Finds natural sentence breaks (words after punctuation or pauses).
 *
 * This is a safety net for when AI ignores scene count rules.
 *
 * @param {Array} scenes - Scene array
 * @param {Array} allWords - Word-level timestamps
 * @param {number} audioDuration - Total audio duration
 * @param {number} fps - Frames per second
 * @param {number} maxDuration - Maximum scene duration in seconds
 * @returns {Array} New scene array with long scenes split
 */
/**
 * Merge scenes shorter than minDuration into their neighbors.
 * Short scenes get merged into whichever neighbor is shorter (to balance lengths).
 */
function _mergeTinyScenes(scenes, minDuration = 3.0, hookEndTime = 0, hookMinDuration = 1.5, opts = {}) {
    if (scenes.length <= 1) return scenes;

    // Zone-aware floors. When opts.zoneBands is provided (from nicheCfg), each
    // zone's lower band bound becomes the effective floor — this works for ALL
    // niches because getNicheSplitConfig() always returns a valid config
    // (falling back to DEFAULT_SCENE_SPLIT when the niche is unknown).
    //
    // This is what stops the recurring "3.1s body scene next to the map"
    // problem: the optimizer's band-violation penalty flags these spans, and
    // this pass finishes the job by absorbing them into their SHORTER
    // neighbor (balances durations instead of always dumping into prev).
    const zoneBands = opts.zoneBands || null;
    const ctaStartTime = parseFloat(opts.ctaStartTime);
    const zoneOf = (scene) => {
        const mid = ((scene.startTime || 0) + (scene.endTime || 0)) / 2;
        if (hookEndTime > 0 && mid < hookEndTime) return 'hook';
        if (!isNaN(ctaStartTime) && mid >= ctaStartTime) return 'cta';
        return 'body';
    };
    const floorFor = (scene) => {
        const zone = zoneOf(scene);
        if (zoneBands && zoneBands[zone]) return zoneBands[zone][0];
        if (zone === 'hook') return hookMinDuration;
        return minDuration;
    };

    let merged = [...scenes];
    let mergeCount = 0;
    const mergeReasons = { hook: 0, body: 0, cta: 0 };

    // Keep merging until no tiny scenes remain
    let changed = true;
    while (changed) {
        changed = false;
        const next = [];
        for (let i = 0; i < merged.length; i++) {
            const scene = merged[i];
            const duration = (scene.endTime || 0) - (scene.startTime || 0);
            const effectiveMin = floorFor(scene);

            if (duration >= effectiveMin) {
                next.push(scene);
                continue;
            }

            const prev = next.length > 0 ? next[next.length - 1] : null;
            const nxt = i + 1 < merged.length ? merged[i + 1] : null;
            const prevDur = prev ? (prev.endTime - prev.startTime) : Infinity;
            const nxtDur  = nxt  ? (nxt.endTime  - nxt.startTime)  : Infinity;

            // Absorb into SHORTER neighbor so durations stay balanced.
            if (prev && prevDur <= nxtDur) {
                prev.endTime = scene.endTime;
                prev.endFrame = scene.endFrame;
                prev.text = (prev.text || '') + ' ' + (scene.text || '');
                if (scene.words) prev.words = [...(prev.words || []), ...scene.words];
                mergeCount++;
                mergeReasons[zoneOf(scene)]++;
                changed = true;
            } else if (nxt) {
                nxt.startTime = scene.startTime;
                nxt.startFrame = scene.startFrame;
                nxt.text = (scene.text || '') + ' ' + (nxt.text || '');
                if (scene.words) nxt.words = [...(scene.words || []), ...(nxt.words || [])];
                mergeCount++;
                mergeReasons[zoneOf(scene)]++;
                changed = true;
            } else {
                next.push(scene);
            }
        }
        merged = next;
    }

    // Re-index
    merged.forEach((s, i) => { s.index = i; });

    if (mergeCount > 0) {
        if (zoneBands) {
            console.log(`   🔀 Merged ${mergeCount} tiny scenes (hook<${zoneBands.hook[0]}s body<${zoneBands.body[0]}s cta<${zoneBands.cta[0]}s) → ${merged.length} scenes [by zone: hook=${mergeReasons.hook} body=${mergeReasons.body} cta=${mergeReasons.cta}]`);
        } else {
            console.log(`   🔀 Merged ${mergeCount} tiny scenes (< ${minDuration}s) → ${merged.length} scenes`);
        }
    }

    return merged;
}

// ============================================================
// WHISPER FALLBACK
// ============================================================

function createScenesFromWhisper(transcription) {
    const fps = config.video.fps;
    const segments = transcription.segments || [];
    const audioDuration = transcription.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    const scenes = segments.map((segment, index) => ({
        index,
        text: segment.text,
        startTime: segment.start,
        endTime: segment.end,
        duration: Math.round((segment.end - segment.start) * fps),
        words: segment.words || []
    }));

    if (scenes.length > 0) {
        const lastSegEnd = segments[segments.length - 1].end;
        if (audioDuration > lastSegEnd + 0.5) {
            scenes[scenes.length - 1].endTime = audioDuration;
            scenes[scenes.length - 1].duration = Math.round((audioDuration - scenes[scenes.length - 1].startTime) * fps);
        }
    }

    return scenes;
}

// ============================================================
// CTA DETECTION + PUNCTUATION MICRO-SPLITTER
// ============================================================

// Lexical sign-off cues for CTA fallback detection. Order matters only for
// logging; the earliest match in the search window wins.
const CTA_CUE_PATTERNS = [
    /\bsubscribe\b/i,
    /\bthanks\s+for\s+watching\b/i,
    /\bthank\s+you\s+for\s+watching\b/i,
    /\blet\s+me\s+know\b/i,
    /\bin\s+the\s+comments?\b/i,
    /\bif\s+you\s+(enjoyed|liked|found)\b/i,
    /\blike\s+and\s+subscribe\b/i,
    /\bhit\s+the\s+(bell|like)\b/i,
    /\bsee\s+you\s+(next|in\s+the\s+next)\b/i,
    /\bcatch\s+you\s+(next|in\s+the\s+next)\b/i,
    /\buntil\s+next\s+time\b/i,
    /\btake\s+care\b/i,
    /\bshare\s+this\s+(video|channel)\b/i,
];

/**
 * Fill scriptContext.ctaStartTime when the AI Director didn't tag one.
 *
 * Strategy: scan the last 30% of the script for a lexical sign-off cue via
 * word-level timestamps from the Whisper transcription. If found, set
 * ctaStartTime to the earliest cue's word start. Never overrides an existing
 * value. Returns a short source string for logging:
 *   'from AI Director'  — value was already present
 *   'lexical fallback'  — this helper set it
 *   'not detected'      — no AI value and no cue found
 */
function _ensureCtaStartTime(scriptContext, transcription, audioDuration) {
    if (scriptContext.ctaStartTime != null && !isNaN(parseFloat(scriptContext.ctaStartTime))) {
        return 'from AI Director';
    }
    if (!transcription || !Array.isArray(transcription.segments)) return 'not detected';

    // Flatten words with timestamps — CTA cues are usually 2+ words, so we
    // stitch a rolling window of ~8 words and regex-match against it.
    const words = [];
    for (const seg of transcription.segments) {
        if (!seg || !seg.words) continue;
        for (const w of seg.words) {
            if (w && typeof w.start === 'number' && w.word) {
                words.push({ word: String(w.word).trim(), start: w.start });
            }
        }
    }
    if (!words.length) return 'not detected';

    const searchFromTime = Math.max(0, audioDuration * 0.70);
    let earliestMatch = null;

    for (let i = 0; i < words.length; i++) {
        if (words[i].start < searchFromTime) continue;
        const windowText = words.slice(i, i + 8).map(w => w.word).join(' ');
        for (const re of CTA_CUE_PATTERNS) {
            if (re.test(windowText)) {
                if (earliestMatch === null || words[i].start < earliestMatch) {
                    earliestMatch = words[i].start;
                }
                break;
            }
        }
    }

    if (earliestMatch != null) {
        scriptContext.ctaStartTime = earliestMatch;
        scriptContext.ctaDetected = true;
        return 'lexical fallback';
    }
    return 'not detected';
}

// Punctuation micro-splitter — retained as a utility for the Style Studio
// "plan scenes" chat command. The main build pipeline uses the deterministic
// smart splitter (speech-units → boundary-scorer → optimizer) instead.
function _splitAtPunctuation(allWords, audioDuration, fps) {
    const scenes = [];
    let currentWords = [];

    for (let i = 0; i < allWords.length; i++) {
        const word = allWords[i];
        currentWords.push(word);

        const text = word.word.trim();
        const isPunctuation = /[.!?,;:]$/.test(text);
        const isLastWord = i === allWords.length - 1;

        if ((isPunctuation || isLastWord) && currentWords.length > 0) {
            const startTime = currentWords[0].start;
            const endTime = (i + 1 < allWords.length) ? allWords[i + 1].start : audioDuration;

            scenes.push({
                index: scenes.length,
                text: currentWords.map(w => w.word).join(' ').trim(),
                startTime,
                endTime,
                duration: Math.round((endTime - startTime) * fps),
                words: [...currentWords]
            });
            currentWords = [];
        }
    }

    return scenes;
}


// ============================================================
// WEB SEARCH FOR CONTEXT (Gemini Search Grounding)
// ============================================================

/**
 * Search the web for context about the story using Gemini Search Grounding.
 * This helps the AI understand if this is a real event vs fictional story.
 *
 * @param {string} fullScript - The narration text
 * @returns {Promise<string|null>} Search results summary or null
 */
async function searchWebContext(fullScript) {
    // Feed AI a large window so it can skip intros and find the real topic
    const preview = fullScript.substring(0, 1500).trim();

    try {
        console.log('   🔍 Extracting search query from script...');

        // Step 0: Use AI to extract a focused 3-5 word search query from the script
        // This avoids the "generic intro" problem where first 100 chars are just "hey everyone welcome back"
        let queryText = '';
        try {
            const aiQuery = await callAI(
                `Extract the CORE FACTUAL SUBJECT from this video script into a web search query.

Script excerpt:
"${preview}"

Rules:
- IGNORE generic YouTube intros, greetings, hooks, subscribe requests, or filler phrases
- Read deep enough to find the ACTUAL topic, noun, event, or subject
- Output ONLY a 3-5 word search query — nothing else
- Focus on proper nouns, specific events, or concrete subjects
- Examples: "Gene Hackman disappearance 2024", "deep sea mining environmental impact", "Tesla Cybertruck recall"
- If the script is about a person, include their full name
- If it's about an event, include what happened and when`,
                { maxTokens: 30, systemPrompt: 'You extract search queries. Output ONLY the query, no explanation.', taskType: 'brain' }
            );
            if (aiQuery && aiQuery.trim().length > 3) {
                queryText = aiQuery.trim()
                    .replace(/^["']+|["']+$/g, '')  // strip quotes
                    .replace(/[^\w\s'-]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, 80);
                console.log(`   ✅ AI extracted query: "${queryText}"`);
            }
        } catch (err) {
            console.log(`   ⚠️ AI query extraction failed: ${err.message} — falling back to raw text`);
        }

        // Fallback: raw substring if AI extraction failed
        if (!queryText) {
            queryText = preview.substring(0, 120)
                .replace(/[^\w\s'-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 80);
        }
        let searchSnippets = '';

        // Scale results by script length: base 10, up to 20 for long scripts
        const scriptWords = fullScript.split(/\s+/).length;
        const numResults = Math.min(20, Math.max(10, Math.round(10 + (scriptWords - 200) / 80)));

        // API-first web search (Tavily -> Google CSE fallback)
        if (hasAnyWebSearchCredentials()) {
            try {
                if (!queryText) {
                    throw new Error('query became empty after normalization');
                }
                const { items, provider, errors } = await searchWeb(queryText, {
                    num: numResults,
                    timeout: 10000,
                    providerOrder: ['tavily', 'googleCSE'],
                });
                if (items.length > 0) {
                    searchSnippets = items.map((it) => `- ${it.title}: ${it.snippet || ''}`).join('\n');
                    console.log(`   ✅ ${provider}: found ${items.length} results`);
                } else if (errors.length > 0) {
                    console.log(`   ⚠️ Web search providers skipped: ${errors.join(' | ')}`);
                }
            } catch (err) {
                console.log(`   ⚠️ Web search skipped: ${err.message}`);
            }
        }

        // Fallback to Wikipedia + DuckDuckGo if no API provider results
        if (!searchSnippets) {
            const [wikiResults, ddgResults] = await Promise.all([
                _searchWikipedia(queryText),
                _searchDDGInstant(queryText)
            ]);
            searchSnippets = [wikiResults, ddgResults].filter(Boolean).join('\n');
        }

        if (!searchSnippets) {
            console.log('   ℹ️ No web search results found\n');
            return null;
        }

        // Step 2: Use Gemini to analyze search results + script (critical context for Director)
        const summary = await callAI(
            `You are analyzing a video narration and web search results to extract context that will help an AI plan visual scenes.

Narration preview: "${preview}..."

Web search results:
${searchSnippets}

Provide a brief analysis (3-5 sentences) covering:
1. What is the main topic/subject? If it mentions real people, places, organizations, ships, or military units — it is a REAL EVENT, not fiction.
2. Key entities: people, places, organizations, objects mentioned
3. Visual context: what real-world imagery, locations, or scenes are associated with this topic?
4. Time period and setting: when and where does this take place?

CRITICAL: If the narration references real-world entities (named ships, real military units, real places, real people), ALWAYS treat it as a REAL EVENT. Do NOT call it "fictional" or "speculative" just because it describes events you haven't heard of — news happens after your training cutoff. Only call something fictional if it involves clearly made-up entities (aliens, magic, fictional countries, etc.).

Return ONLY the analysis, no disclaimers.`,
            { maxTokens: 400, systemPrompt: 'You are a media research assistant for video production. Extract actionable visual context from any topic.', taskType: 'brain' }
        );

        if (summary && summary.trim().length > 10) {
            console.log(`   ✅ Web context analyzed:\n`);
            console.log(`   ${summary.trim()}\n`);
            return { text: summary.trim(), searchQuery: queryText };
        }

        console.log('   ℹ️ Could not extract useful context\n');
        return null;

    } catch (error) {
        console.log(`   ⚠️ Web search failed: ${error.message}`);
        return null;
    }
}

/**
 * Search Wikipedia API (free, no API key, no rate limits, no blocks)
 * Great for finding context about real events, people, and topics
 */
async function _searchWikipedia(query) {
    try {
        const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: {
                action: 'query',
                list: 'search',
                srsearch: query,
                srlimit: 5,
                srprop: 'snippet',
                format: 'json'
            },
            headers: { 'User-Agent': 'FacelessVideoGenerator/1.0' },
            timeout: 10000
        });

        const items = resp.data?.query?.search || [];
        if (items.length > 0) {
            const results = items.map(it => {
                const snippet = it.snippet.replace(/<[^>]+>/g, '').trim();
                return `- ${it.title}: ${snippet}`;
            });
            console.log(`   ✅ Wikipedia: found ${results.length} results`);
            return results.join('\n');
        }

        return null;
    } catch (err) {
        console.log(`   ⚠️ Wikipedia search error: ${err.message}`);
        return null;
    }
}

/**
 * Search DuckDuckGo Instant Answer API (free, no key)
 * Returns topic summaries — good complement to Wikipedia
 */
async function _searchDDGInstant(query) {
    try {
        const resp = await axios.get('https://api.duckduckgo.com/', {
            params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
            timeout: 8000
        });

        const data = resp.data;
        const results = [];

        if (data.AbstractText) {
            results.push(`- ${data.AbstractSource || 'Summary'}: ${data.AbstractText}`);
        }
        if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, 3)) {
                if (topic.Text) results.push(`- ${topic.Text}`);
            }
        }

        if (results.length > 0) {
            console.log(`   ✅ DuckDuckGo: found ${results.length} results`);
            return results.join('\n');
        }

        return null;
    } catch (err) {
        return null;
    }
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Analyze script and create scenes. Single AI call does both.
 *
 * @param {Object} transcription - Whisper output: { text, duration, segments }
 * @param {Object} directorsBrief - From directors-brief.js
 * @returns {{ scenes: Array, scriptContext: Object }}
 */
async function analyzeAndCreateScenes(transcription, directorsBrief) {
    const fps = config.video.fps;
    const segments = transcription.segments || [];
    const audioDuration = transcription.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    // Collect all words with timestamps
    const allWords = [];
    for (const seg of segments) {
        if (seg.words && seg.words.length > 0) {
            allWords.push(...seg.words);
        }
    }

    const fullScript = allWords.length > 0
        ? allWords.map(w => w.word).join(' ').trim()
        : segments.map(s => s.text).join(' ').trim();

    console.log(`\n🎬 AI Director — Step 3`);
    console.log(`📡 Provider: ${config.aiProvider.toUpperCase()}`);
    console.log(`📝 Script: ${fullScript.length} chars, ${audioDuration.toFixed(1)}s, ${allWords.length} words`);
    console.log(`🎯 Quality: ${directorsBrief.qualityTier} | Format: ${directorsBrief.format}`);
    if (directorsBrief.freeInstructions) console.log(`📝 Instructions: "${directorsBrief.freeInstructions}"`);
    console.log('');

    // No word-level timestamps → fallback
    if (allWords.length === 0) {
        console.log('   ⚠️ No word-level timestamps — falling back to Whisper segments');
        return {
            scenes: createScenesFromWhisper(transcription),
            scriptContext: _defaultContext(fullScript)
        };
    }

    try {
        // Search web for real-world context (if Gemini key available)
        const webResult = await searchWebContext(fullScript);
        const webContext = webResult?.text || null;
        const webSearchQuery = webResult?.searchQuery || null;

        if (webContext) {
            console.log(`   💡 AI will use this context to understand the story.\n`);
        }

        // Step A: AI analyzes content (context only, no scene splitting)
        const prompt = buildDirectorPrompt(fullScript, audioDuration, directorsBrief, webContext);
        // Keep Director Sonnet-tier work on the task-aware router. Bedrock-only
        // still uses Sonnet; hybrid modes try the selected brain first.
        const useBedrock = !!(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY);
        console.log(`   [Director] Context analysis using task-aware text router${useBedrock ? ' (Bedrock fallback available)' : ''}`);
        const rawText = await callAI(prompt, {
            maxTokens: 1000,
            taskType: 'brain',
        });

        if (!rawText) throw new Error('Empty AI response');

        // Parse context — no --- separator needed (no scene section)
        const contextPart = rawText.split('---')[0] || rawText;

        // Parse context (legacy + new fields)
        const scriptContext = parseDirectorContext(contextPart);
        scriptContext.language = directorsBrief.language || transcription.language || scriptContext.language || 'en';

        // Store video title from UI (strong signal for niche detection + keyword guidance)
        const videoTitle = (process.env.VIDEO_TITLE || '').trim();
        if (videoTitle) {
            scriptContext.videoTitle = videoTitle;
        }

        // Store web research context so Visual Planner can use it
        if (webContext) {
            scriptContext.webContext = webContext;
        }
        if (webSearchQuery) {
            scriptContext.eventAnchor = webSearchQuery;
        }

        // Override format if user specified
        if (directorsBrief.format !== 'auto') {
            scriptContext.format = directorsBrief.format;
        }

        // Store density used
        scriptContext.densityTarget = directorsBrief.tier.sceneDensity;

        // Pick niche (content strategy): user override > AI detection
        const nicheSource = (directorsBrief.nicheOverride && directorsBrief.nicheOverride !== 'auto') ? 'preset' : 'auto-detect';
        if (nicheSource === 'preset') {
            scriptContext.nicheId = directorsBrief.nicheOverride;
        } else {
            // Pass fullScript + audioDuration so the politics resolver can
            // score documentary-vs-breaking across the entire narration.
            scriptContext.nicheId = pickNicheFromContent(scriptContext, {
                fullScript,
                audioDuration,
            });
        }
        const niche = getNiche(scriptContext.nicheId);

        // Apply preset pacing hint if AI didn't detect one or user specified a preset
        const aiPacing = scriptContext.pacing || 'moderate';
        if (directorsBrief.presetPacing && (!scriptContext.pacing || scriptContext.pacing === 'moderate')) {
            scriptContext.pacing = directorsBrief.presetPacing;
        }
        const pacingSource = directorsBrief.presetPacing && scriptContext.pacing === directorsBrief.presetPacing ? 'preset' : 'ai';

        // Pick theme (visual system): user override > guarded auto resolver
        const themeResolution = resolveThemeForContext(scriptContext, niche, directorsBrief);
        scriptContext.themeId = themeResolution.themeId;
        scriptContext.themeResolution = {
            source: themeResolution.source,
            reason: themeResolution.reason,
            allowedThemes: themeResolution.allowedThemes,
            scores: themeResolution.scores,
        };

        // Log resolution chain
        const category = scriptContext.nicheId.startsWith('news') ? 'NEWS (breaking)' : scriptContext.nicheId.startsWith('explainer') ? 'EXPLAINER (educational)' : 'GENERAL';
        console.log(`\n   🔗 Resolution chain:`);
        console.log(`      Category: ${category}`);
        console.log(`      Niche: ${scriptContext.nicheId} (${nicheSource}${nicheSource === 'auto-detect' ? `, AI theme="${scriptContext.theme || '?'}"` : ''})`);
        console.log(`      Theme: ${scriptContext.themeId} (${themeResolution.source}, allowed=${themeResolution.allowedThemes.join('/')}, reason="${themeResolution.reason}")`);
        console.log(`      Pacing: ${scriptContext.pacing} (${pacingSource}${pacingSource === 'preset' ? `, AI was="${aiPacing}"` : ''})`);
        if (niche.footagePriority?.video) {
            console.log(`      Video sources: ${niche.footagePriority.video.join(' → ')}`);
        }
        if (niche.allowedMGs) {
            console.log(`      Allowed MGs: ${niche.allowedMGs.join(', ')}`);
        }

        // Step B+C: Scene splitting. Primary path is AI idea anchors mapped to
        // Whisper word timings. SmartSplit remains as a deterministic fallback.
        const { getNicheSplitConfig } = require('../data/niches');

        const styleProfile = directorsBrief.styleProfile || null;
        const nicheCfg     = getNicheSplitConfig(scriptContext.nicheId);

        // CTA detection fallback: if AI Director didn't tag ctaStartTime,
        // scan the LAST 30% of the script for lexical sign-off cues and
        // set it to the earliest cue found. Only affects zoneAlignment/
        // ctaBand — never rewrites AI-provided values.
        const ctaSource = _ensureCtaStartTime(scriptContext, transcription, audioDuration);
        console.log(`   CTA: ${scriptContext.ctaStartTime != null ? scriptContext.ctaStartTime.toFixed(1)+'s' : 'none'} (${ctaSource})`);

        const ideaResult = await _tryIdeaScenePlanner({
            fullScript,
            allWords,
            audioDuration,
            fps,
            scriptContext,
            directorsBrief,
            webContext,
            useBedrock,
        });

        let scenes = ideaResult?.scenes || null;
        if (scenes) {
            scriptContext.sceneSplitMode = 'ai-idea';
            scriptContext.ideaSceneStats = ideaResult.stats;
            console.log(`   ✅ Idea splitter locked ${scenes.length} semantic scenes`);
        }

        if (!scenes) {
            scriptContext.sceneSplitMode = 'smart-fallback';
            const { buildSpeechUnits } = require('./speech-units');
            const { scoreBoundaries } = require('./scene-boundary-scorer');
            const { optimizeScenes } = require('./scene-optimizer');

            console.log(`   🎚️  SmartSplit fallback config: niche=${scriptContext.nicheId || 'default'} hookBand=[${nicheCfg.hookBand.join(',')}] bodyBand=[${nicheCfg.bodyBand.join(',')}] ctaBand=[${nicheCfg.ctaBand.join(',')}] pauseSens=${nicheCfg.pauseSensitivity} styleProfile=${styleProfile ? 'YES' : 'no'} entities=${(scriptContext.entities||[]).length}`);

            const units = buildSpeechUnits(transcription, scriptContext, fps, nicheCfg);
            const boundaries = scoreBoundaries(units, scriptContext, styleProfile, nicheCfg, audioDuration);
            scenes = optimizeScenes(units, boundaries, scriptContext, styleProfile, nicheCfg, fps, audioDuration);
            console.log(`   ✅ Smart splitter fallback: ${units.length} units → ${scenes.length} scenes (niche=${scriptContext.nicheId || 'default'})`);

            if (scenes.length === 0) throw new Error('Smart splitter returned no scenes');

            const pacing = scriptContext.pacing || 'moderate';
            const minSceneDur = pacing === 'fast' ? 1.8 : pacing === 'slow' ? 3.0 : 2.2;
            const hookMinDur = 1.5;
            console.log(`   ⚙️ Smart fallback orphan floor (${pacing}): min=${minSceneDur}s, hookMin=${hookMinDur}s`);

            const mergeHookEnd = parseFloat(scriptContext.hookEndTime) || Math.min(25, audioDuration * 0.12);
            const beforeMerge = scenes.length;
            scenes = _mergeTinyScenes(scenes, minSceneDur, mergeHookEnd, hookMinDur, {
                zoneBands: {
                    hook: nicheCfg.hookBand,
                    body: nicheCfg.bodyBand,
                    cta:  nicheCfg.ctaBand,
                },
                ctaStartTime: scriptContext.ctaStartTime,
            });
            if (scenes.length !== beforeMerge) {
                console.log(`   🛡️  Orphan guard: ${beforeMerge} → ${scenes.length} scenes (absorbed ${beforeMerge - scenes.length} tiny scene${beforeMerge - scenes.length === 1 ? '' : 's'})`);
            }
        }

        // ── Scene Classes (flag-gated) ──
        // Classify each scene into one of 8 fixed editorial classes and attach
        // treatment hint, retrievability, fallback ladder. Visual Planner
        // downstream consumes these to pick strategy deterministically instead
        // of inventing a unique approach per scene.
        const useSceneClasses = String(process.env.USE_SCENE_CLASSES || '').toLowerCase() === 'true';
        if (useSceneClasses) {
            try {
                const { classifyScenes } = require('./scene-classifier');
                const {
                    mergeClassBias,
                    deriveRetrievability,
                    deriveFallbackLadder,
                    resolvePreferredSource,
                } = require('../data/class-treatment-map');

                const classifications = await classifyScenes(scenes, scriptContext);
                const byIndex = new Map(classifications.map(c => [c.index, c]));

                for (const scene of scenes) {
                    const cls = byIndex.get(scene.index);
                    if (!cls) continue;
                    const treatment = mergeClassBias(cls.sceneClass, scriptContext.nicheId);
                    const retrievability = deriveRetrievability(cls.sceneClass, cls.classSubSignal);
                    const fallbackLadder = deriveFallbackLadder(cls.sceneClass, retrievability);

                    scene.sceneClass      = cls.sceneClass;
                    scene.classSubSignal  = cls.classSubSignal || '';
                    scene.classConfidence = cls.confidence;
                    scene.treatmentHint   = {
                        primary:          treatment.primary,
                        alternates:       treatment.alternates,
                        blocked:          treatment.blocked,
                        allowedMGs:       treatment.allowedMGs,
                        allowedTemplates: treatment.allowedTemplates,
                        preferredSource:  resolvePreferredSource(treatment.preferredSource, scriptContext.nicheId),
                    };
                    scene.retrievability = retrievability;
                    scene.fallbackLadder = fallbackLadder;
                }
                console.log(`   🏷️  Scene classes attached: ${classifications.length}/${scenes.length} scenes`);
            } catch (err) {
                console.warn(`   ⚠️  Scene classifier failed: ${err.message} — scenes continue without class tags`);
            }
        }

        // Attach style profile early so assignTransitions can use it
        // (build-video.js also attaches it later, but transitions happen here inside the Director)
        if (directorsBrief.styleProfile) {
            scriptContext.styleProfile = directorsBrief.styleProfile;
        }

        // Assign transitions between scenes — UNLESS the Editor Agent owns them.
        // When EDITOR_AGENT=true, the Editor Agent's transitions worker assigns
        // these after download (with framing context); the Director defers so
        // transition ownership lives in one place.
        if (process.env.EDITOR_AGENT === 'true') {
            console.log('   ⏭️  Transitions deferred to Editor Agent (EDITOR_AGENT=true)');
        } else {
            assignTransitions(scenes, scriptContext);
        }

        // Map listicle sections to scene indices
        if (scriptContext.format === 'listicle' && scriptContext.sections.length > 0) {
            scriptContext.sections = _mapSectionsToScenes(scriptContext.sections, scenes);
        }

        // Listicle format: build rich item map, override hook, apply transitions
        if (scriptContext.format === 'listicle') {
            const listicle = require('../formats/listicle-format');

            // Override hookEndTime with listicle-specific detection
            const hookResult = listicle.detectListicleHookEnd(scenes, scriptContext);
            if (hookResult.hookEndTime) {
                scriptContext.hookEndTime = hookResult.hookEndTime;
                console.log(`      [Listicle] Hook ends at ${hookResult.hookEndTime.toFixed(1)}s (${hookResult.hookSceneIndices.length} hook scenes)`);
            }

            // Hook tightening is handled inside scene-optimizer.js via the niche's
            // hookBand. Tag hook scenes with preferred media/transition for the renderer.
            const hookPacing = listicle.getListicleHookPacing();
            scriptContext.listicleHookPacing = hookPacing;
            if (hookResult.hookSceneIndices.length > 0) {
                for (const s of scenes) {
                    if (s.endTime <= (hookResult.hookEndTime || 0)) {
                        s.isListicleHook = true;
                        s.preferredMediaType = hookPacing.preferredMediaType;
                        s.transitionStyle = hookPacing.transitionStyle;
                    }
                }
            }

            // Build rich item map
            const items = listicle.buildListicleItemMap(scenes, scriptContext);
            scriptContext.listicleItems = items;
            if (items.length > 0) {
                console.log(`      [Listicle] Detected ${items.length} items: ${items.map(it => `#${it.itemNumber}`).join(', ')}`);
            }

            // Apply listicle transition rules
            for (let i = 1; i < scenes.length; i++) {
                const rule = listicle.getListicleTransitionRules(i, items, scriptContext);
                if (rule) {
                    scenes[i].transition = rule;
                }
            }
        }

        // Log results
        _logResults(scriptContext, scenes);

        return { scenes, scriptContext };

    } catch (error) {
        console.log(`   ❌ AI Director failed: ${error.message}`);
        console.log('   ↩️ Falling back to Whisper segments...\n');

        const fallbackScenes = createScenesFromWhisper(transcription);
        assignTransitions(fallbackScenes, _defaultContext(fullScript));
        return {
            scenes: fallbackScenes,
            scriptContext: _defaultContext(fullScript)
        };
    }
}

// ============================================================
// TRANSITION ASSIGNMENT
// ============================================================

/**
 * Assign transitions between scenes.
 * Types: "cut" (hard cut), "crossfade", "flash", "fade_to_black"
 *
 * Rules:
 *  - Scene 0 (first scene): always "cut" (no intro transition)
 *  - Last scene: "fade_to_black" (natural ending)
 *  - After a long pause (>0.5s gap between scenes): "fade_to_black"
 *  - Fast pacing / short scenes (<3s): prefer "cut" (70%) or "flash" (30%)
 *  - Topic change (different keywords): prefer "crossfade"
 *  - Default mix: 50% cut, 30% crossfade, 15% flash, 5% fade_to_black
 */
function assignTransitions(scenes, scriptContext) {
    if (!scenes || scenes.length === 0) return;

    const pacing = (scriptContext && scriptContext.pacing) || 'moderate';
    const isFast = pacing === 'fast' || pacing === 'rapid';
    const isSlow = pacing === 'slow' || pacing === 'relaxed';
    const themeId = (scriptContext && scriptContext.themeId) || 'standard';
    const theme = getTheme(themeId);

    // Theme-driven transition pools
    const primaryPool = theme.transitions.primary || ['crossfade'];
    const secondaryPool = theme.transitions.secondary || ['fade'];
    const avoidSet = new Set(theme.transitions.avoid || []);

    // Pacing-driven duration multiplier — fast = snappy, slow = smooth
    let durScale = isFast ? 0.4 : isSlow ? 1.5 : 1.0;

    // Cut ratio: how often to use hard cuts (pacing-driven).
    // CUT is the backbone of real editing — a video where most boundaries carry
    // a visible transition looks amateur. These match the Transition Director's
    // own target (~25-35% visible), so if the director is ever off/errors, this
    // algorithmic floor still cuts like an editor instead of over-transitioning.
    let cutRatio = isFast ? 0.78 : isSlow ? 0.52 : 0.68;

    // Reference style inspiration — nudge toward reference's cut/crossfade ratio (50% blend, not full override)
    const styleTransitions = scriptContext && scriptContext.styleProfile && scriptContext.styleProfile.transitions;
    if (styleTransitions) {
        const nudges = [];
        if (typeof styleTransitions.cutRatio === 'number' && styleTransitions.cutRatio >= 0 && styleTransitions.cutRatio <= 1) {
            const before = cutRatio;
            cutRatio = +(cutRatio * 0.5 + styleTransitions.cutRatio * 0.5).toFixed(2); // 50/50 blend
            nudges.push(`cutRatio ${before.toFixed(2)} → ${cutRatio.toFixed(2)} (ref: ${styleTransitions.cutRatio.toFixed(2)})`);
        }
        if (typeof styleTransitions.avgTransitionDuration === 'number' && styleTransitions.avgTransitionDuration > 0) {
            const before = durScale;
            const refScale = +(styleTransitions.avgTransitionDuration / 0.5).toFixed(2);
            durScale = +(durScale * 0.5 + refScale * 0.5).toFixed(2); // 50/50 blend
            nudges.push(`durScale ${before}x → ${durScale}x (ref: ${refScale}x)`);
        }
        if (nudges.length) {
            console.log(`   🎨 [Transitions] Style inspiration nudge: ${nudges.join(', ')}`);
        }
    }

    // Get duration for a transition type from TRANSITION_LIBRARY, scaled by pacing
    function getDuration(type) {
        const libEntry = TRANSITION_LIBRARY[type];
        const baseDur = libEntry ? libEntry.duration / 1000 : 0.5; // ms → seconds
        return +(baseDur * durScale).toFixed(2);
    }

    // Pick a random transition from theme pools
    // 70% primary pool, 30% secondary pool (gives variety while staying on-theme)
    function pickThemeTransition() {
        const pool = Math.random() < 0.7 ? primaryPool : secondaryPool;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // Track recent transitions to avoid too many repeats
    const recentTypes = [];

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];

        // First scene — no transition in
        if (i === 0) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Last scene — fade out
        if (i === scenes.length - 1) {
            scene.transition = { type: 'fade_to_black', duration: getDuration('fade_to_black') || +(0.4 * durScale).toFixed(2) };
            continue;
        }

        const prev = scenes[i - 1];
        const gap = scene.startTime - prev.endTime;
        const sceneDuration = scene.endTime - scene.startTime;

        // Gap between scenes — natural pause = fade to black
        if (gap > 0.5) {
            scene.transition = { type: 'fade_to_black', duration: getDuration('fade_to_black') || +(0.4 * durScale).toFixed(2) };
            continue;
        }

        // Very short scene — hard cut (transitions look bad on <2s scenes)
        if (sceneDuration < 2) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Roll for cut vs themed transition
        if (Math.random() < cutRatio) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Pick from theme pools, avoid repeating the same type 3x in a row
        let type = pickThemeTransition();
        let attempts = 0;
        while (attempts < 5 && recentTypes.length >= 2 &&
               recentTypes[recentTypes.length - 1] === type &&
               recentTypes[recentTypes.length - 2] === type) {
            type = pickThemeTransition();
            attempts++;
        }

        // Safety: if somehow picked an avoided transition, re-pick
        if (avoidSet.has(type)) {
            type = primaryPool[Math.floor(Math.random() * primaryPool.length)];
        }

        scene.transition = { type, duration: getDuration(type) };
        recentTypes.push(type);
        if (recentTypes.length > 4) recentTypes.shift();
    }

    const counts = {};
    scenes.forEach(s => {
        const t = s.transition?.type || 'cut';
        counts[t] = (counts[t] || 0) + 1;
    });
    console.log(`   🎬 Transitions (theme: ${themeId}, pacing: ${pacing}, speed: ${durScale}x): ${Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(', ')}`);
}

// ============================================================
// HELPERS
// ============================================================

function _defaultContext(fullScript) {
    return {
        summary: fullScript.substring(0, 80).trim(),
        theme: '', tone: '', mood: '', pacing: 'moderate', visualStyle: 'cinematic',
        entities: [], keyStats: [], mainPoints: [], targetAudience: '', emotionalArc: '',
        format: 'documentary', sections: [],
        ctaDetected: false, ctaStartTime: null, hookEndTime: null,
        densityTarget: 3, nicheId: 'general', themeId: 'standard',
        productionMode: 'faceless'
    };
}

/**
 * Map section titles to scene indices by fuzzy matching section names to scene text.
 */
function _mapSectionsToScenes(sectionTitles, scenes) {
    const mapped = [];
    for (const title of sectionTitles) {
        const titleLower = normalize(title);
        let bestScene = 0;
        let bestScore = 0;
        for (let i = 0; i < scenes.length; i++) {
            const sceneLower = normalize(scenes[i].text);
            // Check if section title words appear in scene text
            const titleWords = titleLower.split(/\s+/);
            let matches = 0;
            for (const tw of titleWords) {
                if (sceneLower.includes(tw)) matches++;
            }
            const score = matches / titleWords.length;
            if (score > bestScore) {
                bestScore = score;
                bestScene = i;
            }
        }
        mapped.push({ title, startSceneIndex: bestScene });
    }
    return mapped;
}

function _logResults(ctx, scenes) {
    console.log(`\n   📌 Director's Analysis:`);
    console.log(`      Summary: "${ctx.summary || 'unknown'}"`);
    console.log(`      Theme: ${ctx.theme || '?'} | Tone: ${ctx.tone || '?'} | Mood: ${ctx.mood || '?'}`);
    console.log(`      Pacing: ${ctx.pacing || '?'} | Style: ${ctx.visualStyle || '?'}`);
    console.log(`      Format: ${ctx.format} | Niche: ${ctx.nicheId || 'general'} | Theme: ${ctx.themeId || 'standard'}`);
    if (ctx.entities.length > 0) console.log(`      Entities: ${ctx.entities.join(', ')}`);
    if (ctx.hookEndTime) console.log(`      Hook ends: ~${ctx.hookEndTime}s`);
    if (ctx.ctaDetected) console.log(`      CTA detected: ~${ctx.ctaStartTime}s`);
    if (ctx.sections.length > 0) console.log(`      Sections: ${ctx.sections.map(s => s.title || s).join(' | ')}`);

    console.log(`\n   🎬 Scenes: ${scenes.length}`);
    for (const s of scenes) {
        const dur = (s.endTime - s.startTime).toFixed(1);
        console.log(`      Scene ${s.index}: ${s.startTime.toFixed(2)}s → ${s.endTime.toFixed(2)}s (${dur}s) "${s.text.substring(0, 50)}..."`);
    }
    console.log('');
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    analyzeAndCreateScenes,
    buildDirectorPrompt,
    parseDirectorContext,
    buildIdeaScenePrompt,
    buildIdeaLongSceneRefinementPrompt,
    buildIdeaMixedSceneAuditPrompt,
    buildIdeaBoundaryQaPrompt,
    buildIdeaFinalFragmentCleanupPrompt,
    parseIdeaScenePlan,
    parseIdeaRefinementPlan,
    parseIdeaMicroCleanupPlan,
    parseIdeaBoundaryQaPlan,
    buildIdeaScenesFromPlan,
    _splitIdeaScenesWithRefinements,
    applyIdeaMicroSceneCleanup,
    applyIdeaBoundaryQaActions,
    normalizeIdeaSceneContinuity,
    buildScenesFromAnchors,
    findWordIndex,
    normalize,
    createScenesFromWhisper,
    assignTransitions,
    // Exposed for Style Studio chat-driven scene planning
    _splitAtPunctuation
};
