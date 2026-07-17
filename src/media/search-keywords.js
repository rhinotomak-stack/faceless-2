const STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
    'is', 'are', 'was', 'were', 'that', 'this', 'it', 'as', 'be', 'been', 'being', 'into',
    'near', 'around', 'about', 'after', 'before', 'during', 'while', 'through', 'view', 'shot', 'scene',
    'video', 'clip', 'footage', 'image', 'photo', 'real', 'actual', 'showing', 'featuring',
    'global', 'system', 'systems', 'risk', 'risks', 'scenario', 'case', 'matter', 'matters',
    'critical', 'important', 'overview', 'analysis', 'explained', 'breaking', 'news',
    'daily', 'flow', 'flows', 'trade', 'million', 'billion', 'percent', 'percentage',
    'barrel', 'barrels', 'pass', 'passes', 'policy', 'geopolitical', 'geopolitics',
    'chart', 'barchart', 'donutchart', 'rankinglist', 'comparisoncard',
]);

const SEARCH_NOISE_WORDS = new Set([
    'policy', 'geopolitical', 'geopolitics', 'analysis', 'overview', 'context',
    'explainer', 'explained', 'breaking', 'news', 'view', 'shot', 'scene',
    'video', 'clip', 'footage', 'image', 'photo', 'showing', 'visual',
]);

let _MG_REGISTRY = {};
let _CLASS_TREATMENTS = {};
try {
    _MG_REGISTRY = require('../render/mg-registry').MG_REGISTRY || {};
} catch (_) {}
try {
    _CLASS_TREATMENTS = require('../data/class-treatment-map').CLASS_TREATMENTS || {};
} catch (_) {}

const ANCHORS = [
    'Red Sea',
    'Strait of Hormuz',
    'Bab el-Mandeb',
    'Bab-el-Mandeb',
    'Suez Canal',
    'Persian Gulf',
    'Gulf of Aden',
    'Panama Canal',
    'Strait of Malacca',
];

const VISUAL_PHRASES = [
    { re: /\b(houthi|houthis|missile launch|missiles?|rocket launch|rockets?|drone attack|drone strike|military launch)\b/i, phrase: 'missile launch', score: 31 },
    { re: /\b(oil tanker|tankers?|crude tanker|lng tanker)\b/i, phrase: 'oil tanker', score: 28 },
    { re: /\b(container ship|container ships|cargo ship|cargo ships|freighter|freighters)\b/i, phrase: 'cargo ship', score: 27 },
    { re: /\b(shipping lane|shipping route|trade route|ship traffic|maritime traffic)\b/i, phrase: 'shipping lane', score: 25 },
    { re: /\b(port|harbor|harbour|terminal|container port|cranes?)\b/i, phrase: 'cargo port', score: 26 },
    { re: /\b(warship|warships|naval ship|navy ship|destroyer|carrier)\b/i, phrase: 'warship', score: 24 },
    { re: /\b(protest|protesters|crowd|demonstration)\b/i, phrase: 'protest crowd', score: 23 },
    { re: /\b(logistics|supply chain|supply chains)\b/i, phrase: 'cargo port', score: 23 },
    { re: /\b(factory|factories|assembly line|warehouse|warehouses|manufacturing plant)\b/i, phrase: 'factory logistics', score: 22 },
    { re: /\b(refinery|pipeline|oil terminal|industrial plant)\b/i, phrase: 'oil refinery', score: 23 },
    { re: /\b(street|city|traffic|road|highway)\b/i, phrase: 'city street', score: 20 },
    { re: /\b(office|workers?|meeting|briefing|officials?)\b/i, phrase: 'official briefing', score: 18 },
];

const MOTION_PHRASES = [
    { re: /\b(aerial|drone|overhead)\b/i, phrase: 'aerial', score: 12 },
    { re: /\b(close[-\s]?up|macro)\b/i, phrase: 'close up', score: 10 },
    { re: /\b(timelapse|time lapse)\b/i, phrase: 'timelapse', score: 10 },
];

function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function words(value) {
    return clean(value).split(/\s+/).filter(Boolean);
}

function wordCount(value) {
    return words(value).length;
}

function dedupe(values, max = 12) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = clean(value).replace(/^["']+|["']+$/g, '');
        if (!text || /^none$/i.test(text)) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

function _has(value, re) {
    return re.test(String(value || ''));
}

function _wantsAerial(context, scene = {}) {
    const text = [
        context,
        scene?.text,
    ].filter(Boolean).join(' ');
    return /\b(aerial|overhead|bird'?s[-\s]?eye|from above|top[-\s]?down|satellite|map|locator|route map)\b/i.test(text)
        || /\bdrone\s+(shot|view|footage|video|camera|b[-\s]?roll)\b/i.test(text)
        || /\b(shot|view|footage|video|camera)\s+from\s+(a\s+)?drone\b/i.test(text);
}

function _anchorVariants(combined, scene = {}) {
    const variants = [];
    const wantsAerial = _wantsAerial('', scene);
    if (_has(combined, /\bstrait of hormuz|\bhormuz\b/i)) {
        variants.push(
            'Strait of Hormuz oil tanker',
            'Strait of Hormuz cargo ship',
            'Persian Gulf oil tanker',
            'oil tanker strait',
            'oil tanker sea'
        );
        if (wantsAerial) variants.push('Strait of Hormuz oil tanker aerial');
    }
    if (_has(combined, /\bbab[-\s]el[-\s]mandeb|\bmandeb\b/i)) {
        variants.push(
            'Bab el-Mandeb cargo ship',
            'Bab el-Mandeb oil tanker',
            'Red Sea cargo ship',
            'Gulf of Aden cargo ship',
            'narrow strait cargo ship'
        );
        if (wantsAerial) variants.push('Bab el-Mandeb cargo ship aerial');
    }
    if (_has(combined, /\bsuez canal|\bsuez\b/i)) {
        variants.push(
            'Suez Canal cargo port',
            'Suez Canal cargo ship',
            'Suez Canal oil tanker',
            'canal cargo ship',
            'container ship canal'
        );
        if (wantsAerial) variants.push('Suez Canal cargo ship aerial', 'Suez Canal aerial');
    }
    if (_has(combined, /\bred sea\b/i)) {
        variants.push(
            'Red Sea cargo ship',
            'Red Sea shipping lane',
            'Red Sea oil tanker',
            'Bab el-Mandeb cargo ship',
            'cargo ship sea'
        );
        if (wantsAerial) variants.push('Red Sea cargo ship aerial');
    }
    if (_has(combined, /\bgulf of aden\b/i)) {
        variants.push(
            'Gulf of Aden cargo ship',
            'Gulf of Aden oil tanker',
            'Red Sea cargo ship'
        );
        if (wantsAerial) variants.push('Gulf of Aden cargo ship aerial');
    }
    return variants;
}

function _eventVariants(combined) {
    const variants = [];
    const houthi = _has(combined, /\bhouthis?\b/i);
    const yemen = _has(combined, /\b(?:yemen|sanaa|hodeidah|hodeida)\b/i);
    const missile = _has(combined, /\b(?:missiles?|rocket\s+launch|rockets?)\b/i);
    const drone = _has(combined, /\b(?:drones?|uav)\b/i)
        && _has(combined, /\b(?:houthi|houthis|military|attack|strike|launch|explosion|blast|missile|rocket|uav)\b/i)
        && !_has(combined, /\b(?:camera|view|shot|b[-\s]?roll)\s+drone\b|\bdrone\s+(?:view|shot|camera|b[-\s]?roll)\b|\b(?:aerial|overhead)\s+drone\s+(?:view|shot|camera)\b|\b(?:shot|view|camera)\s+from\s+(?:a\s+)?drone\b/i);
    const strike = _has(combined, /\b(?:attack|strike|explosion|blast|launch)\b/i);

    if (houthi && (missile || drone || strike)) {
        variants.push(
            'Houthi missile launch Yemen',
            'Yemen missile launch footage',
            'Houthi military footage Yemen',
            'military missile launch footage',
            'rocket launch military footage'
        );
        if (drone) variants.push('Houthi drone launch Yemen', 'military drone launch footage');
    } else if (missile || drone || strike) {
        variants.push(
            missile ? 'military missile launch footage' : '',
            drone ? 'military drone launch footage' : '',
            'military strike aftermath footage',
            'explosion aftermath footage'
        );
    }

    return variants.filter(Boolean);
}

function _visualFallbackVariants(combined, scene = {}) {
    const variants = [];
    const wantsAerial = _wantsAerial('', scene);
    if (_has(combined, /\b(global shipping|shipping trade|trade route|shipping route|shipping lane|sea lane|maritime route|maritime trade|global trade|world trade|trade flows?|trade passes?|supply chains?)\b/i)) {
        variants.push(
            'container ship ocean',
            'cargo ship sea',
            'shipping lane',
            'container port logistics',
            'cargo ship ocean'
        );
        if (wantsAerial) variants.push('cargo ship aerial', 'shipping lane aerial');
    }
    if (_has(combined, /\bcontainer ship|cargo ship|freighter\b/i)) {
        variants.push(
            'container ship ocean',
            'cargo ship sea',
            'cargo ship footage',
            'container port cranes'
        );
        if (_has(combined, /\b(?:night|dark|evening)\b/i)) {
            variants.unshift('container ship night', 'port cranes night');
        }
        if (wantsAerial) variants.push('container ship aerial', 'cargo ship aerial');
    }
    if (_has(combined, /\boil tanker|crude tanker|lng tanker|tanker\b/i)) {
        variants.push(
            'oil tanker sea',
            'crude oil tanker',
            'tanker ship ocean'
        );
        if (wantsAerial) variants.push('oil tanker aerial');
    }
    if (_has(combined, /\b(?:port|harbor|harbour|terminal|cranes?)\b/i)) {
        variants.push('container port cranes', 'port logistics', 'shipping port terminal');
        if (wantsAerial) variants.push('port logistics aerial');
    }
    if (_has(combined, /\b(?:navy|naval|warship|patrol)\b/i)) {
        variants.push('naval patrol ship', 'warship sea footage', 'military ship patrol');
    }
    return variants;
}

const DISPLAY_QUERY_WORDS = new Set([
    'animated', 'animation', 'badge', 'bold', 'box', 'callout', 'card', 'cards',
    'chapter', 'chart', 'charts', 'counter', 'data', 'date', 'display', 'focus',
    'fullscreen', 'graphic', 'graphics', 'headline', 'icon', 'icons', 'infographic',
    'kinetic', 'label', 'labels', 'labeled', 'labelled', 'locator', 'lower',
    'mg', 'motion', 'overlay', 'panel', 'reveal', 'stat', 'stats', 'template',
    'text', 'third', 'timeline', 'title', 'typewriter', 'typography',
]);
const DISPLAY_STYLE_WORDS = new Set([
    'abstract', 'background', 'cinematic', 'clean', 'dark', 'dramatic', 'globe',
    'hand', 'hand-drawn', 'highlight', 'highlighted', 'minimal', 'modern',
    'route', 'show', 'showing', 'stylized', 'tracing', 'visual', 'zoom',
    'zooming',
]);
const DATE_ONLY_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{4})\b/i;

function _splitCamel(value) {
    return String(value || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _displayTextForms(value) {
    const spaced = _splitCamel(value);
    const norm = spaced.toLowerCase().replace(/[^\p{L}\p{N}%]+/gu, ' ').replace(/\s+/g, ' ').trim();
    const compact = norm.replace(/\s+/g, '');
    return { norm, compact };
}

function _displayTypeAliases() {
    const names = new Set(Object.keys(_MG_REGISTRY || {}));
    for (const row of Object.values(_CLASS_TREATMENTS || {})) {
        for (const type of row?.allowedTemplates || []) names.add(type);
        for (const type of row?.allowedMGs || []) names.add(type);
    }
    const aliases = new Set();
    for (const name of names) {
        const spaced = _splitCamel(name).toLowerCase();
        if (!spaced) continue;
        aliases.add(spaced);
        aliases.add(spaced.replace(/\s+/g, ''));
        aliases.add(spaced.replace(/\s+/g, '-'));
    }
    return aliases;
}

let _DISPLAY_TYPE_ALIASES = null;
function _getDisplayTypeAliases() {
    if (!_DISPLAY_TYPE_ALIASES) _DISPLAY_TYPE_ALIASES = _displayTypeAliases();
    return _DISPLAY_TYPE_ALIASES;
}

function _hasDisplayComponentType(value) {
    const forms = _displayTextForms(value);
    if (!forms.norm && !forms.compact) return false;
    for (const alias of _getDisplayTypeAliases()) {
        if (!alias) continue;
        const compactAlias = alias.replace(/[^a-z0-9%]+/g, '');
        if (compactAlias && forms.compact.includes(compactAlias)) return true;
        const spacedAlias = alias.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (spacedAlias && new RegExp(`(?:^|\\s)${spacedAlias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i').test(forms.norm)) {
            return true;
        }
    }
    return false;
}

function _displayQueryTokenInfo(value) {
    const tokens = _displayTextForms(value).norm.split(/\s+/).filter(Boolean);
    let display = 0;
    let style = 0;
    let content = 0;
    for (const token of tokens) {
        if (DISPLAY_QUERY_WORDS.has(token)) {
            display++;
        } else if (DISPLAY_STYLE_WORDS.has(token)) {
            style++;
        } else if (!STOP_WORDS.has(token) && !/^\d+(?:[.,:-]\d+)?%?$/.test(token)) {
            content++;
        }
    }
    return { tokens, display, style, content };
}

function isDisplaySearchDirective(value, scene = {}) {
    const text = clean(value);
    if (!text) return false;
    const lower = text.toLowerCase();
    const mediaType = String(scene?.mediaType || '').toLowerCase();
    const sourceHint = String(scene?.sourceHint || '').toLowerCase();
    const referenceMapLane = (mediaType === 'image' || sourceHint === 'web-image')
        && /\b(map|satellite|diagram|chart|graph|infographic)\b/i.test(text);
    const componentType = _hasDisplayComponentType(text);
    const typedPrefix = /^[a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*)?\s*:/i.test(text) && componentType;
    const mapMotionDirective = /\b(?:animated|animation|locator|zoom(?:ing)?|trace|tracing|highlight(?:ed)?|label(?:ed|led)?)\b.*\bmap\b|\bmap\b.*\b(?:animated|animation|locator|zoom(?:ing)?|trace|tracing|highlight(?:ed)?|label(?:ed|led)?)\b/i.test(text);
    const iconDirective = /\bicon\b/i.test(text) && /\b(?:globe|logo|symbol|graphic|card|stat|data)\b/i.test(text);
    const cardDirective = /\b(?:card|graphic|template|overlay|fullscreen|motion graphic)\b/i.test(text)
        && /\b(?:bold|date|stat|fact|chapter|title|headline|comparison|key|takeaway|data|number|icon|globe|map)\b/i.test(text);
    const info = _displayQueryTokenInfo(text);
    const displayDominates = (info.display + info.style) >= 2 && info.content <= 3;
    const dateCardOnly = DATE_ONLY_RE.test(text) && /\b(?:date|card|graphic|headline|title)\b/i.test(text);

    if (referenceMapLane && !componentType && !iconDirective && !cardDirective) return false;
    return componentType || typedPrefix || mapMotionDirective || iconDirective || cardDirective || displayDominates || dateCardOnly;
}

function _removeDisplayAliases(value) {
    let text = _splitCamel(value);
    for (const alias of _getDisplayTypeAliases()) {
        if (!alias) continue;
        const spaced = alias.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (!spaced) continue;
        const re = new RegExp(`\\b${spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        text = text.replace(re, ' ');
    }
    return text;
}

function _stripDisplayQueryWords(value) {
    return _removeDisplayAliases(value)
        .replace(/^[^:]{1,40}:\s*/, ' ')
        .replace(/[|;_()[\]{}"']/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter(word => {
            const key = word.toLowerCase().replace(/[^\p{L}\p{N}%.-]/gu, '');
            if (!key) return false;
            if (DISPLAY_QUERY_WORDS.has(key) || DISPLAY_STYLE_WORDS.has(key)) return false;
            if (STOP_WORDS.has(key)) return false;
            if (/^\d+(?:[.,:-]\d+)?%?$/.test(key)) return false;
            return true;
        })
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _archivedVisualPlannerValues(scene = {}) {
    const out = [];
    const archive = scene?._visualPlannerEditorial;
    if (!archive || typeof archive !== 'object') return out;
    for (const bag of Object.values(archive)) {
        if (!bag || typeof bag !== 'object') continue;
        for (const key of ['templateBgQuery', 'bgQuery', 'stockQuery', 'webQuery', 'searchKeyword', 'keyword', 'visualIntent']) {
            if (typeof bag[key] === 'string' && bag[key].trim()) out.push(bag[key]);
        }
    }
    return out;
}

function _contextForDisplayRepair(scene = {}, scriptContext = {}, original = '') {
    const archived = _archivedVisualPlannerValues(scene);
    return [
        original,
        scene?._editorIntent?.footageKeyword,
        scene?.templateBgQuery,
        scene?.bgQuery,
        scene?.stockQuery,
        scene?.webQuery,
        scene?.visualIntent,
        scene?.text,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...archived,
        scriptContext?.summary,
        scriptContext?.topic,
        scriptContext?.videoTitle,
        scriptContext?.eventAnchor,
        scriptContext?.webContext,
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
    ].filter(Boolean).join(' ');
}

function _localContextForDisplayRepair(scene = {}, original = '') {
    return [
        original,
        scene?._editorIntent?.footageKeyword,
        scene?.templateBgQuery,
        scene?.bgQuery,
        scene?.stockQuery,
        scene?.webQuery,
        scene?.visualIntent,
        scene?.text,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ..._archivedVisualPlannerValues(scene),
    ].filter(Boolean).join(' ');
}

function _displayRepairFallbacks(combined, scene = {}, original = '') {
    const event = _eventVariants(combined);
    const anchors = _anchorVariants(combined, scene);
    const visual = _visualFallbackVariants(combined, scene);
    const isMapDirective = /\b(map|locator|route|trace|tracing|zoom(?:ing)?)\b/i.test(original);
    const variants = isMapDirective
        ? [...event, ...anchors, ...visual]
        : [...event, ...visual, ...anchors];
    const anchor = _firstMaritimeAnchor(combined);
    if (anchor) {
        if (/\b(oil|barrels?|tanker|crude|lng|energy)\b/i.test(combined)) {
            variants.push(`${anchor} oil tanker`);
        }
        if (/\b(container|cargo|shipping|ship|vessel|port|trade|supply chain|route|lane|maritime)\b/i.test(combined)) {
            variants.push(`${anchor} cargo ship`, `${anchor} shipping lane`);
        }
    }
    return variants;
}

function _searchableDisplayRepairCandidate(value, scene = {}) {
    const text = clean(value).replace(/^["']+|["']+$/g, '');
    if (!text || /^none$/i.test(text)) return '';
    if (isDisplaySearchDirective(text, scene)) return '';
    const info = _displayQueryTokenInfo(text);
    if (info.content <= 0) return '';
    if (DATE_ONLY_RE.test(text) && info.content <= 1) return '';
    return text;
}

function repairDisplaySearchQuery(value, scene = {}, scriptContext = {}, opts = {}) {
    const original = clean(value);
    if (!original || !isDisplaySearchDirective(original, scene)) {
        return { changed: false, before: original, after: original, reason: '' };
    }
    const prior = scene?._displayQueryRepair;
    if (prior
        && clean(prior.before).toLowerCase() === original.toLowerCase()
        && _searchableDisplayRepairCandidate(prior.after, scene)) {
        return {
            changed: true,
            before: original,
            after: clean(prior.after),
            reason: prior.reason || 'display-layer search directive repaired to concrete visual subject',
        };
    }

    const localCombined = _localContextForDisplayRepair(scene, original);
    const combined = _contextForDisplayRepair(scene, scriptContext, original);
    const cleaned = _stripDisplayQueryWords(original);
    const candidates = dedupe([
        scene?._editorIntent?.footageKeyword,
        ..._archivedVisualPlannerValues(scene),
        scene?.templateBgQuery,
        scene?.bgQuery,
        scene?.stockQuery,
        scene?.webQuery,
        ..._displayRepairFallbacks(localCombined, scene, original),
        cleaned,
        _coreTokenVariant(localCombined, opts.maxCoreWords || 4),
        ..._displayRepairFallbacks(combined, scene, original),
        _coreTokenVariant(combined, opts.maxCoreWords || 4),
    ], 18);

    for (const candidate of candidates) {
        const usable = _searchableDisplayRepairCandidate(candidate, scene);
        if (!usable) continue;
        const compact = words(usable).slice(0, opts.maxWords || 7).join(' ');
        if (!compact || compact.toLowerCase() === original.toLowerCase()) continue;
        return {
            changed: true,
            before: original,
            after: compact,
            reason: 'display-layer search directive repaired to concrete visual subject',
        };
    }

    return { changed: false, before: original, after: original, reason: 'display-layer directive had no concrete replacement' };
}

const PROSE_STOP = new Set([
    'they', 'them', 'their', 'theirs', 'we', 'us', 'our', 'ours',
    'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
    'i', 'me', 'my', 'mine', 'who', 'whom', 'whose', 'which',
    'when', 'where', 'why', 'how', 'what',
    'then', 'now', 'here', 'also', 'just', 'still', 'only', 'even',
    'still', 'always', 'often', 'sometimes', 'never',
    'tight', 'close', 'wide', 'shallow', 'soft', 'hard',
]);

function _coreTokenVariant(value, maxWords = 4) {
    const storyStop = new Set([
        ...STOP_WORDS,
        ...PROSE_STOP,
        'world', 'around', 'nearly', 'another', 'second', 'could', 'would', 'should',
        'forces', 'force', 'group', 'groups', 'thing', 'things',
    ]);
    const raw = words(value)
        .map(w => w.replace(/[^\p{L}\p{N}-]/gu, ''))
        .filter(w => w && !/^\d+(?:[-.,:]\d+)?%?$/.test(w));
    // Count occurrences (case-insensitive). Words that recur across input fields
    // (keyword + webQuery + stockQuery, etc.) are the real keyword signal; one-off
    // prose words pulled from visual intent get a lower score even when capitalized.
    const counts = new Map();
    for (const w of raw) {
        const k = w.toLowerCase();
        counts.set(k, (counts.get(k) || 0) + 1);
    }
    const scored = raw.map((word, index) => {
        const key = word.toLowerCase();
        if (storyStop.has(key)) return null;
        let score = 2;
        if (VISUAL_PHRASES.some(item => item.re.test(word))) score += 16;
        if (/\b(ship|tanker|cargo|container|port|canal|strait|missile|rocket|drone|houthi|yemen|suez|hormuz|mandeb|red|sea|aerial|night)\b/i.test(key)) score += 10;
        // Caps bonus: all-caps acronyms (LG, USA, FBI) get the full +3 because they
        // are reliable proper-noun signals. Single-leading-capital words only get
        // a smaller +1 because sentence-starters ("Tight", "They") are capitalized
        // for grammar, not because they're proper nouns. Recurrence boost below
        // promotes true proper nouns (Honda, Samsung, Hormuz) via repeat-across-
        // fields signal instead.
        if (/^[A-Z]{2,}$/.test(word)) score += 3;
        else if (/^[A-Z]/.test(word)) score += 1;
        // Recurrence: each repeated occurrence is +2, capped at +8. Outweighs the
        // sentence-start caps bonus for one-off prose words.
        const recur = (counts.get(key) || 1) - 1;
        score += Math.min(8, recur * 2);
        score += Math.max(0, 8 - index) * 0.2;
        return { word, key, score, index };
    }).filter(Boolean);
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const picked = [];
    const seen = new Set();
    for (const item of scored) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        picked.push(item);
        if (picked.length >= maxWords) break;
    }
    return picked.sort((a, b) => a.index - b.index).map(item => item.word).join(' ');
}

function buildSearchKeywordVariants(keyword, scene = {}, opts = {}) {
    const original = clean(keyword);
    if (!original) return [];

    // Intentionally EXCLUDE scene.text here: it's the narration prose ("They have
    // curved glass doors, touch screens,") which seeds keyword variants with
    // pronouns, sentence-starters and conversational adjectives ("They", "Tight"
    // when paired with a "Tight close-up..." visualIntent). The curated search-
    // oriented fields below already cover the same subject matter.
    //
    // Also EXCLUDE scene.visualIntent on MG/template scenes: there it describes the
    // motion-graphic/template ("Single bold EFFICIENCY", "gateway Kinetic text
    // Route") — that's the CEO/MG layer's display text, NOT a footage query, and it
    // poisons footage search with un-findable phrases. Footage queries come only
    // from the Planner's keyword/stockQuery/webQuery fields. (Global, type-driven —
    // no per-niche word lists.)
    const isGraphicScene = !!(scene?.mgHint || scene?.fullscreenMG || scene?.templateHint);
    const combined = [
        original,
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
        isGraphicScene ? null : scene?.visualIntent,
        scene?.stockQuery,
        scene?.webQuery,
    ].filter(Boolean).join(' ');

    const variants = [];
    if (opts.includeOriginal) variants.push(original);
    variants.push(
        ..._eventVariants(combined),
        ..._anchorVariants(combined, scene),
        ..._visualFallbackVariants(combined, scene)
    );

    const relaxed = original
        .replace(/\b(night|dark|evening|dramatic|cinematic|global|trade|route|routes|forces)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (relaxed && relaxed.toLowerCase() !== original.toLowerCase() && wordCount(relaxed) >= 2) variants.push(relaxed);

    const core = _coreTokenVariant(combined, opts.maxCoreWords || 4);
    const coreIsAnchorOnly = core
        && _firstMaritimeAnchor(core)
        && !/\b(ship|ships|shipping|vessel|vessels|cargo|container|tanker|tankers|port|terminal|crane|cranes|canal|strait|sea|gulf|route|lane|chokepoint)\b/i.test(core);
    if (core && wordCount(core) >= 2 && !coreIsAnchorOnly) variants.push(core);

    const trimmed = variants
        .map(v => trimSearchKeyword(v, scene, { maxWords: opts.maxWords || 6 }))
        .filter(v => v && v.toLowerCase() !== original.toLowerCase());

    return dedupe(trimmed, opts.max || 10);
}

function normalizeEntityContext(scene, scriptContext = {}) {
    return dedupe([
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
        scriptContext?.eventAnchor,
    ], 16);
}

function _anchorScore(anchor, scene, keyword) {
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]+/g, '[-\\s]+');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    let score = 0;
    if (re.test(scene?.visualIntent || '')) score += 8;
    if (re.test(scene?.text || '')) score += 6;
    if (re.test(keyword || '')) score += 4;
    if (re.test(scene?.stockQuery || '')) score += 3;
    if (re.test(scene?.webQuery || '')) score += 3;
    return score;
}

function _pickAnchor(scene, keyword) {
    const combined = [
        keyword,
        scene?.visualIntent,
        scene?.text,
        scene?.stockQuery,
        scene?.webQuery,
    ].filter(Boolean).join(' ');
    const hits = ANCHORS
        .filter(anchor => new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]+/g, '[-\\s]+')}\\b`, 'i').test(combined))
        .map(anchor => ({ anchor: anchor === 'Bab-el-Mandeb' ? 'Bab el-Mandeb' : anchor, score: _anchorScore(anchor, scene, keyword) }));
    if (!hits.length) return '';
    hits.sort((a, b) => (b.score - a.score) || (a.anchor.length - b.anchor.length));
    return hits[0].anchor;
}

function _firstMaritimeAnchor(value) {
    const text = String(value || '');
    for (const anchor of ANCHORS) {
        const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-\s]+/g, '[-\\s]+');
        if (new RegExp(`\\b${escaped}\\b`, 'i').test(text)) {
            return anchor === 'Bab-el-Mandeb' ? 'Bab el-Mandeb' : anchor;
        }
    }
    if (/\bmandeb\b/i.test(text)) return 'Bab el-Mandeb';
    if (/\bhormuz\b/i.test(text)) return 'Strait of Hormuz';
    if (/\bsuez\b/i.test(text)) return 'Suez Canal';
    return '';
}

function _hasLiteralIndustrialNeed(scene = {}) {
    const sceneText = [
        scene?.text,
        scene?.visualIntent,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ].filter(Boolean).join(' ');
    return /\b(factory|factories|assembly line|manufacturing plant|warehouse|warehouses|industrial plant|production line)\b/i.test(sceneText);
}

function _stripUnsupportedMaritimeAerial(keyword, scene = {}) {
    const original = clean(keyword);
    if (!/\b(aerial|drone)\b/i.test(original)) return original;
    if (_wantsAerial('', scene)) return original;

    const context = [
        original,
        scene?.visualIntent,
        scene?.text,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
    ].filter(Boolean).join(' ');
    const isMaritime = _firstMaritimeAnchor(context)
        || /\b(ship|ships|shipping|vessel|vessels|cargo|container|tanker|tankers|port|terminal|crane|cranes|canal|strait|sea|gulf|route|lane|chokepoint)\b/i.test(context);
    if (!isMaritime) return original;

    let stripped = original.replace(/\baerial\b/gi, ' ');
    if (!/\b(houthi|houthis|missile|rocket|attack|strike|uav|war|military)\b/i.test(context)) {
        stripped = stripped.replace(/\bdrone\b/gi, ' ');
    }
    return clean(stripped) || original;
}

function _repairMaritimeSearchKeyword(keyword, scene = {}) {
    const original = clean(keyword);
    if (!original) return '';
    const context = [
        original,
        scene?.visualIntent,
        scene?.text,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
    ].filter(Boolean).join(' ');
    const anchor = _pickAnchor(scene, original) || _firstMaritimeAnchor(context);
    if (!anchor) return original;

    const lower = original.toLowerCase();
    const hasConcreteSearchObject = /\b(ship|ships|shipping|vessel|vessels|cargo|container|tanker|tankers|port|terminal|crane|cranes|canal|strait|sea|gulf|route|lane|chokepoint)\b/i.test(original);
    const statOrNarrativeNoise = /\b(daily flow|flow|flows|global trade|world trade|trade share|trade volume|barrels?|million|billion|percent|percentage|rate|data|chart|traffic|transit|movement)\b/i.test(original);
    if (statOrNarrativeNoise && !hasConcreteSearchObject) {
        let phrase = 'cargo ship';
        if (/\bstrait of hormuz|persian gulf\b/i.test(anchor) && /\b(oil|barrels?|tanker)\b/i.test(context)) {
            phrase = 'oil tanker';
        } else if (/\bsuez canal\b/i.test(anchor) && /\b(port|terminal|container|logistics|cranes?)\b/i.test(context)) {
            phrase = 'cargo port';
        }
        return [anchor, phrase].join(' ');
    }

    const hasMaritimeObject = /\b(ship|ships|shipping|vessel|vessels|cargo|container|tanker|tankers|port|terminal|crane|cranes|canal|strait|sea|gulf|route|lane|chokepoint)\b/i.test(context);
    if (!hasMaritimeObject) return original;
    if (_hasLiteralIndustrialNeed(scene)) return original;

    const factoryNoise = /\b(factory logistics|warehouse logistics|supply chain logistics|factory|factories|warehouse|warehouses|assembly line|manufacturing)\b/.test(lower);
    if (!factoryNoise) return original;

    const phrase = /\b(port|terminal|crane|cranes|logistics|supply chain|supply chains|container|containers)\b/i.test(context)
        ? 'cargo port'
        : 'cargo ship';
    if (_wantsAerial('', scene)) return [anchor, phrase, 'aerial'].join(' ');
    return [anchor, phrase].join(' ');
}

function _pushPhrase(parts, phrase, maxWords) {
    for (const word of words(phrase)) {
        if (parts.length >= maxWords) break;
        const key = word.toLowerCase();
        if (!parts.some(p => p.toLowerCase() === key)) parts.push(word);
    }
}

function _tokensByVisualWeight(value, maxWords) {
    const raw = words(value);
    const scored = raw.map((word, index) => {
        const key = word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
        if (/^\d+(?:[-.,:]\d+)?%?$/.test(key)) return null;
        if (!key || STOP_WORDS.has(key)) return null;
        let score = 4;
        if (/\b(ship|ships|tanker|tankers|cargo|container|port|aerial|drone|warship|naval|factory|warehouse|refinery|pipeline|protest|crowd|street|official|briefing)\b/i.test(key)) score += 20;
        if (/^[A-Z][a-z]+/.test(word)) score += 3;
        score += Math.max(0, 6 - index) * 0.2;
        return { word, key, score, index };
    }).filter(Boolean);
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));

    const out = [];
    const seen = new Set();
    for (const item of scored) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        out.push(item.word);
        if (out.length >= maxWords) break;
    }
    return out.join(' ');
}

function _stripSearchNoiseWords(value) {
    const original = words(value);
    const kept = original.filter(word => {
        const key = word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
        return key && !SEARCH_NOISE_WORDS.has(key);
    });
    return kept.length > 0 ? kept.join(' ') : clean(value);
}

function _hasConcreteVisualTerm(value) {
    return /\b(ship|ships|shipping|vessel|vessels|tanker|tankers|cargo|container|port|harbor|harbour|crane|cranes|lane|route|canal|strait|aerial|drone|satellite|map|factory|warehouse|refinery|pipeline|street|crowd|briefing|officials?|warship|naval)\b/i
        .test(String(value || ''));
}

function trimSearchKeyword(keyword, scene = {}, opts = {}) {
    const maxWords = Math.max(3, Math.min(6, Number(opts.maxWords || 5)));
    const displayRepair = repairDisplaySearchQuery(keyword, scene, {}, {
        maxWords,
        maxCoreWords: opts.maxCoreWords || 4,
    });
    const input = displayRepair.changed ? displayRepair.after : clean(keyword);
    const original = _stripSearchNoiseWords(_stripUnsupportedMaritimeAerial(_repairMaritimeSearchKeyword(input, scene), scene));
    if (!original) return '';

    const combined = [
        original,
        scene?.visualIntent,
        scene?.text,
        scene?.stockQuery,
        scene?.webQuery,
    ].filter(Boolean).join(' ');

    const visualHits = VISUAL_PHRASES
        .filter(item => item.re.test(combined))
        .sort((a, b) => b.score - a.score);
    const motionHits = MOTION_PHRASES
        .filter(item => item.re.test(combined))
        .sort((a, b) => b.score - a.score);
    const anchor = _pickAnchor(scene, original);

    const parts = [];
    if (anchor) _pushPhrase(parts, anchor, maxWords);
    if (visualHits[0]) _pushPhrase(parts, visualHits[0].phrase, maxWords);
    if (motionHits[0]) _pushPhrase(parts, motionHits[0].phrase, maxWords);

    if (wordCount(original) <= maxWords) {
        if (anchor && !_hasConcreteVisualTerm(original) && parts.length >= 2) {
            return parts.join(' ');
        }
        return original;
    }

    if (parts.length >= 3) return parts.join(' ');
    return _tokensByVisualWeight(original, maxWords) || words(original).slice(0, maxWords).join(' ');
}

function applySearchKeywordSplit(scene, scriptContext = {}, opts = {}) {
    if (!scene || scene.fullscreenMG || scene.templateHint) return { changed: false };
    const entityContext = normalizeEntityContext(scene, scriptContext);
    if (entityContext.length) scene.entityContext = entityContext;

    const base = clean(scene.searchKeyword || scene.researchKeyword || scene.keyword || '');
    if (!base || /^none$/i.test(base)) return { changed: false };

    const displayRepair = repairDisplaySearchQuery(base, scene, scriptContext, {
        maxWords: opts.maxWords || 7,
        maxCoreWords: opts.maxCoreWords || 4,
    });
    const trimmed = trimSearchKeyword(displayRepair.changed ? displayRepair.after : base, scene, opts);
    if (!trimmed) return { changed: false };
    const before = clean(scene.searchKeyword || scene.keyword || '');
    scene.searchKeyword = trimmed;
    if (displayRepair.changed) {
        scene._displayQueryRepair = displayRepair;
        if (isDisplaySearchDirective(scene.stockQuery, scene)) scene.stockQuery = null;
        if (isDisplaySearchDirective(scene.webQuery, scene)) scene.webQuery = null;
    }
    return {
        changed: before !== trimmed,
        before,
        after: trimmed,
        reason: displayRepair.changed ? displayRepair.reason : 'keyword/query split',
        displayRepair: displayRepair.changed ? displayRepair : null,
    };
}

module.exports = {
    applySearchKeywordSplit,
    buildSearchKeywordVariants,
    isDisplaySearchDirective,
    normalizeEntityContext,
    repairDisplaySearchQuery,
    trimSearchKeyword,
    wordCount,
};
