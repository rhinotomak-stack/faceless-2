const axios = require('axios');
const config = require('./config');
const { callAI } = require('./ai-provider');
const { getTheme } = require('./themes');

// Track placed MG types to avoid repetition
let placedTypes = [];
let lastType = '';
let aiInstructionsRef = '';

// Classification: full-screen MGs go on V3, overlay MGs stay on MG track
const FULLSCREEN_MG_TYPES = new Set([
    'barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart', 'articleHighlight'
]);

// Default positions by type
const POSITION_MAP = {
    headline: 'center',
    lowerThird: 'bottom-left',
    statCounter: 'center',
    callout: 'center',
    bulletList: 'center-left',
    focusWord: 'center',
    progressBar: 'center',
    barChart: 'center',
    donutChart: 'center',
    comparisonCard: 'center',
    timeline: 'center',
    rankingList: 'center-left',
    kineticText: 'center',
    mapChart: 'center',
    articleHighlight: 'center',
    animatedIcons: 'center',
};

// Style themes — must match MotionGraphics.jsx STYLES
const STYLE_NAMES = ['clean', 'bold', 'minimal', 'neon', 'cinematic', 'elegant'];

// Map visual styles — must match MotionGraphics.jsx MAP_VISUAL_STYLES
const MAP_STYLE_NAMES = ['dark', 'natural', 'satellite', 'light', 'political'];

// ============ MAP STYLE PICKER ============
// Picks a map visual style based on script context and MG style

function pickMapStyle(scriptContext, mgStyle) {
    // Check user instructions for explicit map style preference
    if (aiInstructionsRef) {
        const instr = aiInstructionsRef.toLowerCase();
        for (const ms of MAP_STYLE_NAMES) {
            if (instr.includes(ms + ' map') || instr.includes('map style: ' + ms) || instr.includes('map style ' + ms)) return ms;
        }
        if (/natural earth|earth style|terrain/.test(instr)) return 'natural';
        if (/satellite|space|aerial/.test(instr)) return 'satellite';
        if (/light map|white map|bright map/.test(instr)) return 'light';
        if (/political|atlas|classic map/.test(instr)) return 'political';
    }

    if (!scriptContext || !scriptContext.summary) {
        // Match to MG style as fallback
        if (mgStyle === 'neon' || mgStyle === 'elegant') return 'satellite';
        if (mgStyle === 'cinematic') return 'natural';
        return 'dark';
    }

    const summary = (scriptContext.summary + ' ' + (scriptContext.tone || '')).toLowerCase();

    if (/nature|environment|climate|geography|earth|wildlife|forest|ocean/.test(summary)) return 'natural';
    if (/space|satellite|tech|cyber|ai|digital/.test(summary)) return 'satellite';
    if (/education|school|academic|research|study/.test(summary)) return 'light';
    if (/politic|govern|election|diplomacy|nation|geopolitic|war|conflict/.test(summary)) return 'political';

    // Fallback: match to MG style
    if (mgStyle === 'neon' || mgStyle === 'elegant') return 'satellite';
    if (mgStyle === 'cinematic') return 'natural';
    if (mgStyle === 'minimal') return 'light';
    return 'dark';
}

// ============ STYLE PICKER ============
// Gets MG style from unified theme system

function pickStyle(scriptContext) {
    // Check if user instructions specify a style preference (override)
    if (aiInstructionsRef) {
        const instr = aiInstructionsRef.toLowerCase();
        for (const style of ['neon', 'elegant', 'cinematic', 'bold', 'minimal', 'clean']) {
            if (instr.includes(style + ' style') || instr.includes('style: ' + style) || instr.includes('style ' + style)) return style;
        }
    }

    // Get style from unified theme (set by AI Director)
    if (scriptContext && scriptContext.themeId) {
        const theme = getTheme(scriptContext.themeId);
        return theme.mgStyle;
    }

    // Fallback
    return 'clean';
}

// ============ WORD-ALIGNED TIMING ============
// Finds the exact timestamp when the MG's display text is spoken in the narration.
// Uses Whisper word-level timestamps for precise sync.

function findWordAlignedStart(mgText, scene) {
    if (!scene.words || scene.words.length === 0) return null;
    if (!mgText) return null;

    // Normalize: lowercase, strip punctuation, split into key words
    const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    const mgWords = normalize(mgText).split(/\s+/).filter(w => w.length > 1);
    if (mgWords.length === 0) return null;

    // Normalize scene words for comparison
    const sceneWords = scene.words.map(w => ({
        ...w,
        normalized: normalize(w.word)
    }));

    // Strategy 1: Find the best consecutive match (sliding window)
    let bestScore = 0;
    let bestStart = null;

    for (let i = 0; i < sceneWords.length; i++) {
        let matched = 0;
        for (let j = 0; j < mgWords.length && (i + j) < sceneWords.length; j++) {
            const sw = sceneWords[i + j].normalized;
            const mw = mgWords[j];
            if (sw === mw || sw.includes(mw) || mw.includes(sw)) {
                matched++;
            }
        }
        if (matched > bestScore) {
            bestScore = matched;
            bestStart = sceneWords[i].start;
        }
    }

    // Strategy 2: If consecutive match is weak, find any key word match
    // Prioritize numbers/stats (most important for MG sync)
    if (bestScore < Math.ceil(mgWords.length * 0.4)) {
        const numberWords = mgWords.filter(w => /\d/.test(w));
        const keyWords = numberWords.length > 0 ? numberWords : mgWords;

        for (const sw of sceneWords) {
            for (const kw of keyWords) {
                if (sw.normalized === kw || sw.normalized.includes(kw) || kw.includes(sw.normalized)) {
                    return sw.start;
                }
            }
        }
    }

    return bestScore >= 1 ? bestStart : null;
}

// ============ DECONFLICT OVERLAY MGs ============
// Prevents overlay MGs from overlapping on the MG track.
// Full-screen MGs live on V3, so only overlay MGs need deconfliction.
function deconflictOverlayMGs(allMGs) {
    const overlayMGs = allMGs.filter(mg => mg.category === 'overlay');
    if (overlayMGs.length <= 1) return;

    // Sort by start time
    overlayMGs.sort((a, b) => a.startTime - b.startTime);
    const GAP = 0.15; // small gap between consecutive MGs

    for (let i = 0; i < overlayMGs.length - 1; i++) {
        const current = overlayMGs[i];
        const next = overlayMGs[i + 1];
        const currentEnd = current.startTime + current.duration;

        if (currentEnd > next.startTime - GAP) {
            // ONLY trim the earlier MG's duration — NEVER shift startTime
            // Shifting startTime desyncs MGs from the narration they belong to
            const newDuration = next.startTime - current.startTime - GAP;
            if (newDuration >= 1.0) {
                current.duration = newDuration;
                console.log(`  ⚠️ Trimmed overlay MG "${current.type}" to ${newDuration.toFixed(1)}s (avoid overlap with "${next.type}")`);
            } else {
                // Barely any room — just give current a minimal duration
                current.duration = Math.max(0.8, newDuration);
                console.log(`  ⚠️ Trimmed overlay MG "${current.type}" to ${current.duration.toFixed(1)}s (tight fit before "${next.type}")`);
            }
        }
    }
}

// ============ SMART DURATION ============
// Calculates duration based on content, not just type defaults.
// Accounts for reading time, animation time, and type-specific needs.

function computeSmartDuration(type, text, subtext) {
    const ANIM_OVERHEAD = 0.8; // ~0.5s enter + 0.3s exit
    const HOLD_PADDING = 3.5;  // extra hold time so MG feels present, not rushed
    const WORDS_PER_SEC = 3;   // average reading speed for on-screen text

    const wordCount = (text || '').split(/\s+/).filter(Boolean).length
                    + (subtext ? subtext.split(/\s+/).filter(Boolean).length : 0);
    const readingTime = wordCount / WORDS_PER_SEC;

    // Minimum time per type (generous — lets the viewer absorb)
    const MIN = {
        headline: 5.0,
        lowerThird: 5.0,
        statCounter: 5.5,
        callout: 5.5,
        bulletList: 6.0,
        focusWord: 4.0,
        progressBar: 5.5,
        barChart: 6.0,
        donutChart: 6.0,
        comparisonCard: 5.0,
        timeline: 6.5,
        rankingList: 6.0,
        kineticText: 5.0,
        mapChart: 6.0,
        articleHighlight: 7.0,
        animatedIcons: 5.0,
    };

    let duration = readingTime + ANIM_OVERHEAD + HOLD_PADDING;

    // Type-specific adjustments
    if (type === 'bulletList') {
        const itemCount = (text || '').split(/[,;]|\d+\.\s/).filter(s => s.trim()).length;
        const staggerTime = itemCount * 0.4;
        duration = Math.max(duration, staggerTime + readingTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'statCounter' || type === 'progressBar') {
        duration = Math.max(duration, 1.5 + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'focusWord') {
        duration = Math.min(duration, 5.5);
    }
    if (type === 'barChart' || type === 'donutChart' || type === 'rankingList' || type === 'mapChart') {
        const itemCount = (subtext || '').split(',').filter(s => s.includes(':')).length;
        const staggerTime = itemCount * 0.3;
        duration = Math.max(duration, staggerTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'timeline') {
        const eventCount = (subtext || '').split(',').filter(s => s.includes(':')).length;
        const staggerTime = eventCount * 0.4;
        duration = Math.max(duration, staggerTime + ANIM_OVERHEAD + HOLD_PADDING);
    }
    if (type === 'kineticText') {
        const kWordCount = (text || '').split(/\s+/).filter(Boolean).length;
        const wordStagger = kWordCount * 0.15;
        duration = Math.max(duration, wordStagger + ANIM_OVERHEAD + HOLD_PADDING);
        duration = Math.min(duration, 8.0);
    }
    if (type === 'articleHighlight') {
        // 1s blur intro + highlight sweeps (0.4s stagger per phrase) + hold
        const highlightCount = ((subtext || '').match(/\*\*[^*]+\*\*/g) || []).length;
        const sweepTime = 1.2 + highlightCount * 0.4 + 0.5; // delay + stagger + last sweep
        duration = Math.max(duration, sweepTime + ANIM_OVERHEAD + HOLD_PADDING);
    }

    // Clamp between minimum and max
    const min = MIN[type] || 5.0;
    const max = 10.0;
    return Math.max(min, Math.min(duration, max));
}

// ============ ARTICLE SUBTEXT FIXER ============
// When AI picks articleHighlight but doesn't use pipe format with **highlights**,
// auto-generate proper article subtext from the narration text.

function fixArticleSubtext(subtext, sceneText, displayText) {
    // Already has pipes → assume correct format, just ensure highlights exist
    if (subtext && subtext.includes('|')) {
        // Check if excerpt part has **highlights**
        const parts = subtext.split('|');
        const excerpt = parts.length >= 4 ? parts.slice(3).join('|') : '';
        if (excerpt && !excerpt.includes('**')) {
            // Has pipe format but no highlights — auto-highlight key phrases in excerpt
            parts[parts.length - 1] = autoHighlight(parts[parts.length - 1]);
            return parts.join('|');
        }
        return subtext;
    }

    // No pipes — build article subtext from scene narration
    const narration = (sceneText || '').trim();
    if (!narration) return subtext || '';

    // Use narration as excerpt, auto-highlight key phrases
    const excerpt = autoHighlight(narration);
    // Try to extract a source hint from the narration
    const sourceMatch = narration.match(/(?:according to|by|from|in)\s+(?:a\s+)?(?:the\s+)?([\w\s]+?)(?:\s+(?:study|report|article|research|survey|analysis|paper|journal|magazine))/i);
    const source = sourceMatch ? sourceMatch[1].trim() : 'Research';

    return `${source}||2024|${excerpt}`;
}

function autoHighlight(text) {
    if (!text || text.includes('**')) return text;
    let result = text;
    // Highlight numbers with context (e.g. "47%", "8 million", "1.4 billion")
    result = result.replace(/(\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?)/gi, (match) => {
        return `**${match.trim()}**`;
    });
    // If no numbers found, highlight capitalized proper nouns (2+ chars, not sentence starters)
    if (!result.includes('**')) {
        const words = result.split(/\s+/);
        let highlighted = 0;
        result = words.map((w, i) => {
            if (i > 0 && /^[A-Z][a-z]{2,}/.test(w) && highlighted < 3) {
                highlighted++;
                return `**${w}**`;
            }
            return w;
        }).join(' ');
    }
    // If still no highlights, pick the 2-3 most important words (longest non-common words)
    if (!result.includes('**')) {
        const common = new Set(['the','a','an','is','are','was','were','and','or','but','in','on','at','to','for','of','with','that','this','from','by','has','have','had','will','can','could','would','should','been','being','their','they','them','which','when','where','what','how','who','than','then','also','just','about','into','over','after','before','between','through','during','each','very','most','more','some','only','other','its','these','those','such','both','here','there']);
        const words = result.split(/\s+/);
        const scored = words
            .map((w, i) => ({ w, i, len: w.replace(/[^a-zA-Z]/g, '').length }))
            .filter(x => x.len >= 4 && !common.has(x.w.toLowerCase()))
            .sort((a, b) => b.len - a.len)
            .slice(0, 2);
        if (scored.length > 0) {
            const indices = new Set(scored.map(s => s.i));
            result = words.map((w, i) => indices.has(i) ? `**${w}**` : w).join(' ');
        }
    }
    return result;
}

function buildPrompt(scene, sceneIndex, totalScenes, scriptContext, sceneVisual, allowedMGs) {
    const sceneDuration = (scene.endTime - scene.startTime).toFixed(1);

    let prompt = '';

    // Script context
    if (scriptContext && scriptContext.summary) {
        prompt += `VIDEO TOPIC: ${scriptContext.summary}\n`;
    }

    // Theme/niche enforcement
    const themeId = scriptContext?.themeId || 'neutral';
    const theme = getTheme(themeId);
    prompt += `NICHE: "${theme.name}" — You are STRICTLY limited to using ONLY the following Motion Graphic types: ${allowedMGs.join(', ')}. Do NOT use or invent any other types.\n`;

    // Visual context
    if (sceneVisual && sceneVisual.description !== 'No visual analysis available') {
        let visualNote = `FOOTAGE: ${sceneVisual.description}`;
        if (sceneVisual.hasText) visualNote += ' [has on-screen text]';
        prompt += visualNote + '\n';
    }

    prompt += `\nScene ${sceneIndex + 1}/${totalScenes}: decide if this narration needs a text overlay.\n`;

    prompt += `\nNARRATION: "${scene.text}"`;
    prompt += `\nSCENE: ${scene.startTime.toFixed(2)}s - ${scene.endTime.toFixed(2)}s (${sceneDuration}s)`;

    // Include word-level timestamps so AI can pick precise trigger word
    if (scene.words && scene.words.length > 0) {
        const wordTimeline = scene.words.map(w => `${w.start.toFixed(2)}:${w.word}`).join(' ');
        prompt += `\nWORD TIMESTAMPS: ${wordTimeline}`;
    }

    // Build type descriptions dynamically based on allowed types
    const TYPE_DESCRIPTIONS = {
        statCounter: 'statCounter: A specific number/percentage is spoken. E.g. "grew by 340%", "5 million users"',
        progressBar: 'progressBar: A percentage or completion stat. E.g. "78% of people", "nearly half"',
        lowerThird: 'lowerThird: First mention of a person, place, or organization. E.g. "CEO John Smith", "at MIT"',
        headline: 'headline: Key thesis or main topic (max 2-3 per video). E.g. opening statement, conclusion',
        bulletList: 'bulletList: 2+ items enumerated. E.g. "first... second... third..."',
        callout: 'callout: Important fact, quote, or insight. E.g. "the key takeaway is..."',
        focusWord: 'focusWord: Single dramatic word for emphasis (max 1-2 per video). E.g. "Revolutionary."',
        rankingList: 'rankingList: Items ranked by value (max 1 per video). E.g. "top 5 countries"',
        comparisonCard: 'comparisonCard: Comparing two things (max 1 per video). E.g. "iPhone vs Android"',
        barChart: 'barChart: 3-5 categories with numbers (max 1 per video). E.g. "sales by region"',
        donutChart: 'donutChart: Percentage breakdown (max 1 per video). E.g. "market share"',
        timeline: 'timeline: Historical progression (max 1 per video). E.g. "from 2010 to 2024"',
        mapChart: 'mapChart: Geographic data with locations/regions (max 1 per video). E.g. "factories in USA, China, Germany"',
        kineticText: 'kineticText: Powerful short statement, word-by-word reveal (max 1 per video). E.g. "The Future Is Now"',
        articleHighlight: `articleHighlight: News article, study, or report reference (max 1 per video).
  WHEN: narration mentions a study, report, article, research, or finding.
  text: the headline (max 8 words)
  subtext: MUST use pipe format: source|author|date|excerpt with **highlighted phrases**
  Example: "Nature|Dr. Jane Smith|Feb 2024|The study found that **AI automation** could affect **47% of jobs** in manufacturing"`,
        animatedIcons: `animatedIcons: Animated background icons for explanation/educational scenes (max 3 per video).
  WHEN: narration explains a concept, process, or abstract idea with no specific data/stats.
  text: 3-5 comma-separated SINGLE-WORD icon names. E.g. "brain,gear,lightbulb,rocket,target"
  subtext: animation style — one of: float, drift, bounce, slideIn, popIn, spin`,
    };

    const typeDescriptions = allowedMGs
        .map(t => TYPE_DESCRIPTIONS[t])
        .filter(Boolean)
        .map(d => `- ${d}`)
        .join('\n');

    prompt += `\n
=== WHEN TO ADD A MOTION GRAPHIC ===
Add a motion graphic when the narration has data, names, places, key statements, or visual concepts. Aim for about 40-60% of scenes to have one. Only use "none" for transitional or very short scenes with no meaningful content.

ALLOWED TYPES for "${theme.name}" niche (pick the best match or none):
${typeDescriptions}
- none: Normal narration, nothing visually noteworthy

POSITION GUIDE (choose where to place it):
- bottom-left: lowerThird, callout — standard TV-style, doesn't block main content
- bottom-right: statCounter, progressBar — data display corner
- center: headline, focusWord, kineticText, comparisonCard, donutChart — big impact center stage
- center-left: bulletList, rankingList — left-aligned vertical lists
- center: barChart, timeline, mapChart — needs full width
- If footage has on-screen text at center → prefer bottom-left or bottom-right

TIMING — triggerWord:
- Pick the EXACT word from the narration that should make the MG appear on screen
- The MG will show the instant the narrator says this word — not before, not after
- Pick the most meaningful word: the number being displayed, the name being introduced, the key term
- Example: narration says "revenue grew by 340 percent" + type statCounter → triggerWord: 340
- Example: narration says "CEO John Smith announced" + type lowerThird → triggerWord: John`;

    if (placedTypes.length > 0) {
        prompt += `\n\nALREADY PLACED: ${placedTypes.join(', ')}`;
        if (lastType) {
            prompt += ` | LAST: ${lastType} (avoid repeating)`;
        }
        const focusCount = placedTypes.filter(t => t === 'focusWord').length;
        if (focusCount >= 2) prompt += `\nfocusWord LIMIT REACHED`;
        const headlineCount = placedTypes.filter(t => t === 'headline').length;
        if (headlineCount >= 3) prompt += `\nheadline LIMIT REACHED`;
        const iconCount = placedTypes.filter(t => t === 'animatedIcons').length;
        if (iconCount >= 3) prompt += `\nanimatedIcons LIMIT REACHED`;
        for (const limitType of ['barChart', 'donutChart', 'comparisonCard', 'timeline', 'rankingList', 'mapChart', 'kineticText', 'articleHighlight']) {
            if (placedTypes.includes(limitType)) prompt += `\n${limitType} LIMIT REACHED`;
        }
    }

    if (aiInstructionsRef) {
        prompt += `\n\nUSER INSTRUCTIONS (follow these preferences):\n${aiInstructionsRef}`;
    }

    const allowedTypesList = [...allowedMGs, 'none'].join('|');
    prompt += `\n\nReply ONLY with these 5 lines (nothing else):
type: <${allowedTypesList}>
text: <display text, max 8 words, extracted from narration>
subtext: <secondary line OR "label1:value1,label2:value2" for charts, OR "source|author|date|excerpt with **highlights**" for articleHighlight, or "none">
position: <center|bottom-left|bottom-right|center-left|top-right>
triggerWord: <the exact word from narration that triggers appearance, or "none">`;

    return prompt;
}

function parseResponse(text, scene, sceneIndex) {
    const lines = text.trim().split('\n');
    let type = 'none';
    let displayText = '';
    let subtext = '';
    let aiPosition = '';
    let triggerWord = '';

    const typeMap = {
        'headline': 'headline',
        'lowerthird': 'lowerThird',
        'lower_third': 'lowerThird',
        'lower third': 'lowerThird',
        'statcounter': 'statCounter',
        'stat_counter': 'statCounter',
        'stat counter': 'statCounter',
        'callout': 'callout',
        'bulletlist': 'bulletList',
        'bullet_list': 'bulletList',
        'bullet list': 'bulletList',
        'focusword': 'focusWord',
        'focus_word': 'focusWord',
        'focus word': 'focusWord',
        'progressbar': 'progressBar',
        'progress_bar': 'progressBar',
        'progress bar': 'progressBar',
        'barchart': 'barChart',
        'bar_chart': 'barChart',
        'bar chart': 'barChart',
        'donutchart': 'donutChart',
        'donut_chart': 'donutChart',
        'donut chart': 'donutChart',
        'piechart': 'donutChart',
        'pie_chart': 'donutChart',
        'pie chart': 'donutChart',
        'comparisoncard': 'comparisonCard',
        'comparison_card': 'comparisonCard',
        'comparison card': 'comparisonCard',
        'comparison': 'comparisonCard',
        'vs': 'comparisonCard',
        'timeline': 'timeline',
        'rankinglist': 'rankingList',
        'ranking_list': 'rankingList',
        'ranking list': 'rankingList',
        'ranking': 'rankingList',
        'toplist': 'rankingList',
        'top list': 'rankingList',
        'kinetictext': 'kineticText',
        'kinetic_text': 'kineticText',
        'kinetic text': 'kineticText',
        'kinetic': 'kineticText',
        'mapchart': 'mapChart',
        'map_chart': 'mapChart',
        'map chart': 'mapChart',
        'map': 'mapChart',
        'articlehighlight': 'articleHighlight',
        'article_highlight': 'articleHighlight',
        'article highlight': 'articleHighlight',
        'article': 'articleHighlight',
        'animatedicons': 'animatedIcons',
        'animated_icons': 'animatedIcons',
        'animated icons': 'animatedIcons',
        'icons': 'animatedIcons',
        'none': 'none'
    };

    for (const line of lines) {
        const lower = line.toLowerCase().trim()
            .replace(/^\*+/, '').replace(/\*+$/, '')  // strip markdown bold
            .replace(/^-\s*/, '').replace(/^\d+\.\s*/, '')  // strip list prefixes
            .trim();

        // Flexible type matching
        const typeMatch = lower.match(/type\s*[:=\-]\s*(.+)/);
        if (typeMatch) {
            const val = typeMatch[1].trim().replace(/['"*]/g, '');
            if (typeMap[val]) type = typeMap[val];
        }

        // Flexible text matching
        const textMatch = lower.match(/^text\s*[:=\-]\s*/);
        if (textMatch) {
            displayText = line.substring(line.search(/[:=\-]\s*/) + 1).trim().replace(/^["'*]+|["'*]+$/g, '');
        }

        // Flexible subtext matching
        const subMatch = lower.match(/^sub\s*text\s*[:=\-]\s*/);
        if (subMatch) {
            subtext = line.substring(line.search(/[:=\-]\s*/) + 1).trim().replace(/^["'*]+|["'*]+$/g, '');
            if (subtext.toLowerCase() === 'none' || subtext === '-') subtext = '';
        }

        // Position (AI-chosen)
        const posMatch = lower.match(/^position\s*[:=\-]\s*(.+)/);
        if (posMatch) {
            aiPosition = posMatch[1].trim().replace(/['"*]/g, '');
        }

        // Trigger word (AI-chosen for timing sync)
        const triggerMatch = lower.match(/^trigger\s*-?\s*word\s*[:=\-]\s*(.+)/);
        if (triggerMatch) {
            triggerWord = triggerMatch[1].trim().replace(/['"*]/g, '');
            if (triggerWord.toLowerCase() === 'none' || triggerWord === '-') triggerWord = '';
        }
    }

    // Fallback: scan full text for type keywords if parser missed them
    if (type === 'none') {
        const fullLower = text.toLowerCase();
        for (const [key, val] of Object.entries(typeMap)) {
            if (key === 'none') continue;
            const pattern = new RegExp(`(?:suggest|recommend|choose|pick|select|type).*?${key.replace(/\s/g, '\\s*')}`, 'i');
            if (pattern.test(fullLower)) {
                type = val;
                break;
            }
        }
    }

    if (type === 'none') return null;

    // Post-process articleHighlight: fix subtext if AI didn't use pipe format
    if (type === 'articleHighlight') {
        subtext = fixArticleSubtext(subtext, scene.text, displayText);
    }

    const finalText = displayText || scene.text.substring(0, 40);
    const sceneDuration = scene.endTime - scene.startTime;
    const isOverlay = !FULLSCREEN_MG_TYPES.has(type);
    // Smart duration based on content
    let mgDuration = computeSmartDuration(type, finalText, subtext);

    // For overlay MGs, cap duration to scene length + small extension
    // This keeps them synced with the narration instead of drifting across scenes
    if (isOverlay) {
        const maxOverlayDuration = sceneDuration + 1.0; // allow 1s bleed into next scene
        if (mgDuration > maxOverlayDuration) {
            mgDuration = Math.max(2.0, maxOverlayDuration);
        }
    }

    // === TIMING: Use AI's triggerWord first, fall back to text-based word matching ===
    let wordStart = null;

    // Strategy 1: AI specified a trigger word — find its exact timestamp
    if (triggerWord && scene.words && scene.words.length > 0) {
        const normalTrigger = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const w of scene.words) {
            const normalWord = w.word.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (normalWord === normalTrigger || normalWord.includes(normalTrigger) || normalTrigger.includes(normalWord)) {
                wordStart = w.start;
                break;
            }
        }
    }

    // Strategy 2: Fall back to heuristic text-based word matching
    if (wordStart === null) {
        wordStart = findWordAlignedStart(finalText, scene);
    }

    let startTime;
    let finalDuration = mgDuration;
    if (wordStart !== null) {
        // Appear right when the word is spoken (tiny 0.05s anticipation)
        startTime = Math.max(scene.startTime, wordStart - 0.05);
    } else {
        // No word match — start near beginning of the scene
        startTime = scene.startTime + 0.2;
    }

    // === POSITION: Use AI's choice, fall back to type defaults ===
    const validPositions = ['center', 'bottom-left', 'bottom-right', 'center-left', 'top-right', 'top-left'];
    const finalPosition = validPositions.includes(aiPosition) ? aiPosition : (POSITION_MAP[type] || 'center');

    return {
        id: `mg-${sceneIndex}`,
        type: type,
        category: FULLSCREEN_MG_TYPES.has(type) ? 'fullscreen' : 'overlay',
        text: finalText,
        subtext: subtext,
        startTime: startTime,
        duration: finalDuration,
        position: finalPosition,
        sceneIndex: sceneIndex,
        style: 'clean' // will be overridden by chosen style
    };
}

// ============ BATCH FALLBACK ============
// NOTE: AI providers moved to shared ai-provider.js module
// If per-scene analysis fails, try a single batch prompt

async function batchFallback(scenes, scriptContext, allowedMGs) {
    const sceneList = scenes.map((s, i) =>
        `${i}: "${s.text.substring(0, 80)}"`
    ).join('\n');

    const topic = scriptContext?.summary || 'unknown';
    const themeId = scriptContext?.themeId || 'neutral';
    const theme = getTheme(themeId);
    const typesList = (allowedMGs || Object.keys(POSITION_MAP)).join(', ');

    let prompt = `Video about: ${topic}
Niche: "${theme.name}" — ONLY use these MG types: ${typesList}

Here are the scenes:
${sceneList}

Pick 2-3 scenes that would benefit most from a text overlay. For each, reply with ONE line:
<scene>|<type>|<display text max 8 words>|<position>|<triggerWord>

Allowed types: ${typesList}
For chart/ranking/timeline, add data after triggerWord: <scene>|<type>|<title>|<position>|<triggerWord>|<label1:val1,label2:val2>

Position guide: center (headlines, charts, focus), bottom-left (lowerThird, callout), bottom-right (stats, progress), center-left (lists)
triggerWord: the exact word from narration that should trigger the MG to appear on screen

Only pick the most impactful scenes. Reply with ONLY the lines, nothing else.`;
    if (aiInstructionsRef) {
        prompt += `\n\nUSER INSTRUCTIONS:\n${aiInstructionsRef}`;
    }

    const rawText = await callAI(prompt);
    console.log(`    [Batch raw]: ${rawText.substring(0, 150).replace(/\n/g, ' | ')}`);

    const results = [];
    const lines = rawText.trim().split('\n');

    for (const line of lines) {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length >= 3) {
            const idx = parseInt(parts[0]);
            const typeRaw = parts[1].toLowerCase().replace(/\s+/g, '');

            const typeMap = {
                'headline': 'headline', 'lowerthird': 'lowerThird',
                'statcounter': 'statCounter', 'callout': 'callout',
                'bulletlist': 'bulletList', 'focusword': 'focusWord',
                'progressbar': 'progressBar', 'barchart': 'barChart',
                'donutchart': 'donutChart', 'piechart': 'donutChart',
                'comparisoncard': 'comparisonCard', 'comparison': 'comparisonCard',
                'timeline': 'timeline', 'rankinglist': 'rankingList',
                'ranking': 'rankingList', 'kinetictext': 'kineticText',
                'kinetic': 'kineticText', 'mapchart': 'mapChart',
                'map': 'mapChart', 'articlehighlight': 'articleHighlight',
                'article': 'articleHighlight',
                'animatedicons': 'animatedIcons',
                'icons': 'animatedIcons'
            };

            const text = parts[2].replace(/^["']+|["']+$/g, '');
            // Parse position (part 3) and triggerWord (part 4)
            const aiPosition = parts.length >= 4 ? parts[3].trim().replace(/['"]/g, '') : '';
            const triggerWord = parts.length >= 5 ? parts[4].trim().replace(/['"]/g, '') : '';
            // Data for chart types (part 5+)
            const data = parts.length >= 6 ? parts.slice(5).join('|').replace(/^["']+|["']+$/g, '') : '';

            if (!isNaN(idx) && idx >= 0 && idx < scenes.length && typeMap[typeRaw]) {
                const scene = scenes[idx];
                const type = typeMap[typeRaw];
                const finalText = text || scene.text.substring(0, 40);
                // Smart duration — NOT capped to scene length
                const mgDuration = computeSmartDuration(type, finalText, data);

                // Timing: AI triggerWord first, then heuristic fallback
                let wordStart = null;
                if (triggerWord && triggerWord.toLowerCase() !== 'none' && scene.words && scene.words.length > 0) {
                    const normalTrigger = triggerWord.toLowerCase().replace(/[^a-z0-9]/g, '');
                    for (const w of scene.words) {
                        const normalWord = w.word.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (normalWord === normalTrigger || normalWord.includes(normalTrigger) || normalTrigger.includes(normalWord)) {
                            wordStart = w.start;
                            break;
                        }
                    }
                }
                if (wordStart === null) {
                    wordStart = findWordAlignedStart(finalText, scene);
                }

                let startTime;
                let finalDuration = mgDuration;
                if (wordStart !== null) {
                    startTime = Math.max(scene.startTime, wordStart - 0.05);
                } else {
                    startTime = scene.startTime + 0.2;
                }

                // Position: AI choice first, then type default
                const validPositions = ['center', 'bottom-left', 'bottom-right', 'center-left', 'top-right', 'top-left'];
                const finalPosition = validPositions.includes(aiPosition) ? aiPosition : (POSITION_MAP[type] || 'center');

                // Fix articleHighlight subtext if AI used wrong format
                const finalData = type === 'articleHighlight' ? fixArticleSubtext(data, scene.text, finalText) : (data || '');

                results.push({
                    id: `mg-${idx}`,
                    type: type,
                    category: FULLSCREEN_MG_TYPES.has(type) ? 'fullscreen' : 'overlay',
                    text: finalText,
                    subtext: finalData,
                    startTime: startTime,
                    duration: finalDuration,
                    position: finalPosition,
                    sceneIndex: idx,
                    style: 'clean'
                });
                console.log(`    [batch] Scene ${idx} -> ${type}: "${text}" pos:${finalPosition}${wordStart !== null ? ` (synced @${wordStart.toFixed(2)}s)` : ' (centered)'}`);
            }
        }
    }

    return results;
}

// ============ MAIN PROCESSOR ============

async function processMotionGraphics(scenes, scriptContext, visualAnalysis, aiInstructions) {
    console.log('\n  AI is analyzing scenes for motion graphics...');
    console.log(`  Using: ${config.aiProvider.toUpperCase()}\n`);

    placedTypes = [];
    lastType = '';
    aiInstructionsRef = aiInstructions || '';

    // Pick style for the entire video
    const mgStyle = pickStyle(scriptContext);
    const mapStyle = pickMapStyle(scriptContext, mgStyle);

    // Resolve allowed MG types from theme (Niche Pack architecture)
    const themeId = scriptContext?.themeId || 'neutral';
    const theme = getTheme(themeId);
    const allowedMGs = theme.allowedMGs || Object.keys(POSITION_MAP);
    console.log(`  MG Style: ${mgStyle} | Niche: ${theme.name}`);
    console.log(`  Allowed MGs: ${allowedMGs.join(', ')}\n`);

    const results = [];

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const sceneVisual = visualAnalysis ? visualAnalysis.find(v => v.sceneIndex === i) : null;
        console.log(`  Scene ${i}: "${scene.text.substring(0, 45)}..."`);

        try {
            const prompt = buildPrompt(scene, i, scenes.length, scriptContext, sceneVisual, allowedMGs);
            const rawText = await callAI(prompt);
            console.log(`    [AI raw]: ${rawText.substring(0, 80).replace(/\n/g, ' | ')}`);
            const mg = parseResponse(rawText, scene, i);

            // Enforce niche pack: reject types not in the allowed list
            if (mg && !allowedMGs.includes(mg.type)) {
                console.log(`    -> Rejected "${mg.type}" (not in ${theme.name} niche), skipping`);
                continue;
            }

            if (mg) {
                // Apply video-wide style
                mg.style = mgStyle;
                if (mg.type === 'mapChart') mg.mapStyle = mapStyle;

                // Post-process animatedIcons: structure icons array from text keywords
                if (mg.type === 'animatedIcons') {
                    const keywords = (mg.text || '').split(',').map(k => k.trim()).filter(Boolean).slice(0, 5);
                    const animStyle = ['float', 'drift', 'bounce', 'slideIn', 'popIn', 'spin'].includes(mg.subtext) ? mg.subtext : 'float';
                    mg.icons = keywords.map((kw, idx) => ({
                        keyword: kw,
                        file: null, // populated by icon-provider.js
                        animation: animStyle,
                        x: 10 + (idx * 18) + Math.floor((idx * 37 + 13) % 15), // spread across screen
                        y: 12 + Math.floor((idx * 53 + 7) % 65),
                        size: 55 + Math.floor((idx * 29 + 11) % 40), // 55-95px
                        delay: idx * 0.35,
                    }));
                    mg.animationStyle = animStyle;
                    mg.iconOpacity = 0.15;
                    mg.sceneIndex = i;
                    // Extend duration to fill scene
                    mg.duration = Math.max(mg.duration, scene.endTime - mg.startTime - 0.2);
                }

                // Adjust position if visual analysis suggests avoiding center
                if (sceneVisual && sceneVisual.suggestedMGPosition === 'avoid-center' && mg.position === 'center') {
                    mg.position = 'bottom-left';
                }
                const wordAligned = findWordAlignedStart(mg.text, scene) !== null;
                console.log(`    -> ${mg.type}: "${mg.text}" @${mg.startTime.toFixed(2)}s pos:${mg.position} ${wordAligned ? '(word-synced)' : '(centered)'}`);
                placedTypes.push(mg.type);
                lastType = mg.type;
                results.push(mg);
            } else {
                console.log(`    -> No motion graphic`);
                lastType = '';
            }
        } catch (error) {
            console.log(`    MG analysis failed: ${error.message}`);
            lastType = '';
        }
    }

    // Cap all MGs so they don't extend past total video duration
    const totalDuration = scenes.length > 0 ? scenes[scenes.length - 1].endTime : 0;
    for (const mg of results) {
        if (mg.startTime + mg.duration > totalDuration) {
            mg.duration = Math.max(1, totalDuration - mg.startTime);
        }
    }

    deconflictOverlayMGs(results);

    // Auto-insert Subscribe CTA if detected
    if (scriptContext && scriptContext.ctaDetected && scriptContext.ctaStartTime !== null) {
        console.log(`\n  📢 CTA detected at ${scriptContext.ctaStartTime.toFixed(1)}s → auto-inserting Subscribe overlay`);

        const ctaMG = {
            type: 'subscribeCTA',
            text: 'Subscribe',
            startTime: scriptContext.ctaStartTime,
            duration: 4.0, // 4 seconds
            position: 'bottom-right',
            sceneIndex: scenes.findIndex(s => s.startTime >= scriptContext.ctaStartTime) || scenes.length - 1,
            style: mgStyle,
            // CTA-specific styling
            ctaStyle: {
                icon: 'bell', // bell icon for subscribe
                animate: 'pulse', // pulse animation
                variant: 'highlight' // highlighted/prominent style
            }
        };

        // Cap to video duration
        if (ctaMG.startTime + ctaMG.duration > totalDuration) {
            ctaMG.duration = Math.max(1, totalDuration - ctaMG.startTime);
        }

        results.push(ctaMG);
        console.log(`    ✅ Subscribe CTA added: ${ctaMG.startTime.toFixed(1)}s → ${(ctaMG.startTime + ctaMG.duration).toFixed(1)}s`);
    }

    // Fallback: if no MGs were generated, try a batch approach
    if (results.length === 0 && scenes.length > 0) {
        console.log('\n  No MGs from per-scene analysis. Trying batch fallback...');
        try {
            const batchResults = await batchFallback(scenes, scriptContext, allowedMGs);
            // Filter to allowed types and apply styles
            const filteredBatch = batchResults.filter(mg => allowedMGs.includes(mg.type));
            filteredBatch.forEach(mg => {
                mg.style = mgStyle;
                if (mg.type === 'mapChart') mg.mapStyle = mapStyle;
                if (mg.startTime + mg.duration > totalDuration) {
                    mg.duration = Math.max(1, totalDuration - mg.startTime);
                }
            });
            results.push(...filteredBatch);
            deconflictOverlayMGs(results);
        } catch (e) {
            console.log(`    Batch fallback failed: ${e.message}`);
        }
    }

    console.log(`\n  Motion graphics placed: ${results.length}/${scenes.length} scenes (style: ${mgStyle})\n`);
    return { motionGraphics: results, mgStyle, mapStyle };
}

module.exports = { processMotionGraphics, STYLE_NAMES, MAP_STYLE_NAMES, pickStyle, pickMapStyle, FULLSCREEN_MG_TYPES };