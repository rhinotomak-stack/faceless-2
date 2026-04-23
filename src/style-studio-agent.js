/**
 * Style Studio Agent — Persistent Conversational Style Analyst
 *
 * Unlike style-learner.js (one-shot JSON extraction), this agent:
 *   - Keeps videos uploaded to Gemini Files API across multiple chat turns
 *   - Lets you ask follow-up questions ("what about the music?", "look at the typography")
 *   - Builds a profile incrementally from the conversation
 *   - Can hold multiple reference videos in one session (channel-style learning)
 *   - Uses gemini-3.1-pro-preview for reasoning + vision model for ingest
 *
 * Session lifecycle:
 *   startSession(input) → upload video, do initial analysis, return sessionId + summary
 *   chat(sessionId, message) → multi-turn Q&A using uploaded files
 *   addVideo(sessionId, input) → upload another reference into same conversation
 *   extractProfile(sessionId) → ask Gemini to emit final structured JSON
 *   saveProfile(sessionId, name, dir) → write .style.json
 *   endSession(sessionId) → delete all uploaded files, free Gemini quota
 */

const axios = require('axios');
const path  = require('path');
const fs    = require('fs');
const crypto = require('crypto');
const config = require('./config');
const vertex = require('./vertex-auth');
const styleLearner = require('./style-learner');

// ============ LOGGING ============

function _log(msg) {
    console.log(`[StyleStudio] ${msg}`);
}

// ============ MODEL SELECTION ============

function _getReasoningModel() {
    // Prefer the smarter pro model for chat reasoning; fall back to vision model.
    return config.gemini?.model || config.gemini?.visionModel || 'gemini-3.1-pro-preview';
}

function _getVisionModel() {
    return config.gemini?.visionModel || config.gemini?.model || 'gemini-3-flash-preview';
}

// ============ KEY ROTATION (delegates to style-learner shared pool) ============

function _getKeys() {
    return styleLearner._getKeys();
}

function _getNextKey() {
    return styleLearner._getNextKey();
}

function _markExhausted(idx, kind) {
    return styleLearner._markExhausted(idx, kind);
}

function _isQuotaError(err) {
    return styleLearner._isQuotaError(err);
}

// ============ CODEBASE SEARCH (opt-in via codeAccess flag) ============

const ROOT_DIR = path.join(__dirname, '..');
const CODE_DIRS = [
    path.join(ROOT_DIR, 'src'),
    path.join(ROOT_DIR, 'ui', 'js'),
    path.join(ROOT_DIR, 'ui', 'js', 'compositor'),
];

/**
 * Map of topic keywords → relevant files. Used for targeted lookups when the
 * user asks about a specific subsystem but doesn't name a file.
 */
const TOPIC_FILE_MAP = {
    transition:   ['ui/js/compositor/TransitionRenderer.js', 'src/build-video.js'],
    mg:           ['src/mg-registry.js', 'src/ai-motion-graphics.js', 'ui/js/compositor/MGRenderer.js'],
    motionGraphic:['src/mg-registry.js', 'src/ai-motion-graphics.js', 'ui/js/compositor/MGRenderer.js'],
    effect:       ['src/effect-presets.js', 'ui/js/compositor/ShaderLib.js'],
    shader:       ['ui/js/compositor/ShaderLib.js', 'src/effect-presets.js'],
    theme:        ['src/themes.js', 'src/directors-brief.js'],
    niche:        ['src/niches.js', 'src/directors-brief.js'],
    template:     ['src/ai-templates.js'],
    footage:      ['src/footage-manager.js'],
    pacing:       ['src/build-video.js', 'src/ai-director.js'],
    director:     ['src/ai-director.js', 'src/directors-brief.js'],
    visual:       ['src/ai-visual-planner.js'],
    compositor:   ['ui/js/compositor/Compositor.js', 'ui/js/compositor/SceneGraph.js'],
    render:       ['ui/js/compositor/Compositor.js', 'ui/js/compositor/ExportPipeline.js'],
    animation:    ['ui/js/compositor/AnimationUtils.js', 'src/mg-registry.js'],
    map:          ['src/map-provider.js', 'src/map-compiler.js', 'src/map-assignment.js'],
    overlay:      ['src/build-video.js'],
    subtitle:     ['ui/js/compositor/Compositor.js'],
    audio:        ['src/build-video.js'],
    listicle:     ['src/listicle-format.js', 'src/ai-templates.js'],
    language:     ['src/languages.js', 'src/language-helper.js'],
    texture:      ['ui/js/compositor/TextureManager.js'],
    export:       ['ui/js/compositor/ExportPipeline.js'],
};

/**
 * Read a source file and return a trimmed snippet (header + exports + key sections).
 * Keeps output under maxLines to avoid blowing up the Gemini context.
 */
function _readFileSnippet(relPath, maxLines = 120) {
    try {
        const abs = path.join(ROOT_DIR, relPath);
        if (!fs.existsSync(abs)) return null;
        const content = fs.readFileSync(abs, 'utf8');
        const lines = content.split('\n');
        if (lines.length <= maxLines) return content;

        // Strategy: take first 30 lines (header + imports), last 30 (exports),
        // and grep for key patterns (function, class, const.*=) in the middle.
        const head = lines.slice(0, 30);
        const tail = lines.slice(-30);
        const middle = lines.slice(30, -30);
        const keyLines = [];
        for (let i = 0; i < middle.length; i++) {
            const l = middle[i];
            if (/^(async\s+)?function\s+\w|^class\s+\w|^const\s+\w+\s*=|^module\.exports|\/\/\s*={3,}/.test(l)) {
                // Include the line + 2 lines of context
                keyLines.push(`... (line ${31 + i})`);
                keyLines.push(middle[i]);
                if (i + 1 < middle.length) keyLines.push(middle[i + 1]);
                if (i + 2 < middle.length) keyLines.push(middle[i + 2]);
            }
        }
        const result = [...head, '\n// ... (middle trimmed, key declarations shown) ...\n', ...keyLines, '\n// ... (end of file) ...\n', ...tail];
        return result.slice(0, maxLines).join('\n');
    } catch (e) {
        return null;
    }
}

/**
 * Search the codebase for a keyword and return matching file:line snippets.
 * Uses simple line-by-line search (no ripgrep dependency).
 */
function _grepCodebase(keyword, maxResults = 15) {
    const results = [];
    const searchPattern = keyword.toLowerCase();

    for (const dir of CODE_DIRS) {
        if (!fs.existsSync(dir)) continue;
        let files;
        try { files = fs.readdirSync(dir).filter(f => f.endsWith('.js')); }
        catch (e) { continue; }

        for (const file of files) {
            const abs = path.join(dir, file);
            let content;
            try { content = fs.readFileSync(abs, 'utf8'); }
            catch (e) { continue; }

            const lines = content.split('\n');
            const relPath = path.relative(ROOT_DIR, abs).replace(/\\/g, '/');

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(searchPattern)) {
                    // Include ±1 line of context
                    const ctx = [];
                    if (i > 0) ctx.push(`${relPath}:${i}  ${lines[i - 1].substring(0, 120)}`);
                    ctx.push(`${relPath}:${i + 1}  ${lines[i].substring(0, 120)}`);
                    if (i + 1 < lines.length) ctx.push(`${relPath}:${i + 2}  ${lines[i + 1].substring(0, 120)}`);
                    results.push(ctx.join('\n'));
                    if (results.length >= maxResults) return results;
                }
            }
        }
    }
    return results;
}

/**
 * Detect explicit file fetch requests in the user's message.
 * Returns { files: string[], keywords: string[] } or null.
 *
 * Patterns:
 *   "fetch src/mg-registry.js"
 *   "show code for transitions"
 *   "look at the shader code"
 *   "check MGRenderer.js"
 */
function _detectCodeRequest(message) {
    const msg = message.toLowerCase().trim();

    // Not a code request at all?
    if (!/\b(fetch|show|look|check|read|code|source|file|implementation|does.*(our|the|this).*(code|system|renderer|pipeline)|do we (have|support)|where.*(add|implement)|how does.*work)\b/i.test(msg)) {
        return null;
    }

    const result = { files: [], keywords: [] };

    // Explicit file name: "fetch src/mg-registry.js" or "check MGRenderer.js"
    const fileMatches = msg.match(/[\w\-/]+\.js/gi);
    if (fileMatches) {
        for (const fm of fileMatches) {
            // Resolve partial names: "MGRenderer.js" → "ui/js/compositor/MGRenderer.js"
            const resolved = _resolveFileName(fm);
            if (resolved) result.files.push(resolved);
        }
    }

    // Topic-based lookup: "show code for transitions" → TOPIC_FILE_MAP
    for (const [topic, files] of Object.entries(TOPIC_FILE_MAP)) {
        if (msg.includes(topic.toLowerCase())) {
            for (const f of files) {
                if (!result.files.includes(f)) result.files.push(f);
            }
            result.keywords.push(topic);
        }
    }

    // Extract search keywords from questions like "does our code support orbit animation?"
    const kwMatch = msg.match(/(?:support|have|implement|handle)\s+(\w[\w\s]{2,30}?)(?:\?|$|\.)/i);
    if (kwMatch) {
        const kws = kwMatch[1].trim().split(/\s+/).filter(w => w.length > 2 && !['the', 'our', 'this', 'does', 'code', 'any'].includes(w));
        result.keywords.push(...kws);
    }

    // Cap files to avoid huge context
    result.files = result.files.slice(0, 4);
    result.keywords = [...new Set(result.keywords)].slice(0, 5);

    return (result.files.length > 0 || result.keywords.length > 0) ? result : null;
}

/**
 * Resolve a partial filename to a relative path from ROOT_DIR.
 */
function _resolveFileName(partial) {
    // Already a relative path with directory?
    const abs1 = path.join(ROOT_DIR, partial);
    if (fs.existsSync(abs1)) return partial.replace(/\\/g, '/');

    // Search CODE_DIRS
    for (const dir of CODE_DIRS) {
        const abs2 = path.join(dir, path.basename(partial));
        if (fs.existsSync(abs2)) return path.relative(ROOT_DIR, abs2).replace(/\\/g, '/');
    }
    return null;
}

/**
 * Build a code context block to inject into the user's message before sending to Gemini.
 */
function _buildCodeContext(codeReq) {
    const sections = [];

    // Fetch requested files
    for (const relPath of codeReq.files) {
        const snippet = _readFileSnippet(relPath, 100);
        if (snippet) {
            sections.push(`── ${relPath} ──\n${snippet}`);
        }
    }

    // Grep for keywords
    for (const kw of codeReq.keywords) {
        // Skip if we already fetched a file that's obviously about this topic
        const grepResults = _grepCodebase(kw, 8);
        if (grepResults.length > 0) {
            sections.push(`── grep "${kw}" ──\n${grepResults.join('\n---\n')}`);
        }
    }

    if (sections.length === 0) return '';
    return `\n\n[CODE CONTEXT — auto-fetched from codebase for this question]\n${sections.join('\n\n')}`;
}

// ============ SESSION STATE ============

/**
 * @typedef {Object} StudioVideo
 * @property {string} fileUri      - Gemini Files API URI or gs:// URI
 * @property {string} fileName     - Name for delete()
 * @property {string} mimeType     - video/mp4 or video/webm
 * @property {boolean} isGCS       - true if uploaded to Vertex GCS
 * @property {string} title        - Display title
 * @property {number} duration     - Actual duration in seconds (from yt-dlp)
 * @property {string} sourceUrl    - Original YouTube URL or local path
 * @property {string} localPath    - Path to downloaded copy (for cleanup)
 * @property {boolean} isTemp      - whether localPath should be deleted on session end
 * @property {boolean} analyzed    - true if initial analysis succeeded
 * @property {string|null} analysisError - error message if analysis failed, null if ok
 * @property {number} uploadedAt   - timestamp when uploaded to Gemini (for 48h TTL tracking)
 */

/**
 * @typedef {Object} StudioSession
 * @property {string} id           - session UUID
 * @property {string} saveDir      - dir where .style.json will be written
 * @property {StudioVideo[]} videos
 * @property {Array} history       - [{role: 'user'|'model', parts: [...]}]
 * @property {Object} profile      - accumulated profile JSON, refined over conversation
 * @property {number} createdAt
 */

const _sessions = new Map();
const _transcriptStores = new Map();

// ============ SESSION PERSISTENCE ============

const SESSION_FILE = '.studio-session.json';
const MEMORY_FILE  = '.studio-memory.json';
const TRANSCRIPT_CACHE_FILE = '.studio-transcript-cache.json';
const TRANSCRIPT_CACHE_VERSION = 1;
const GEMINI_FILE_TTL_MS = 47 * 60 * 60 * 1000; // 47h (safety margin under 48h)

/**
 * Save current session state to disk for restore on relaunch.
 * Strips non-serializable data and keeps chat history intact.
 */
function _saveSessionToDisk(session) {
    try {
        const savePath = path.join(session.saveDir, SESSION_FILE);

        // Build chat messages from history (user/model pairs)
        const chatMessages = [];
        for (const h of session.history) {
            // Extract text from parts, skip file_data parts (they're references)
            const textParts = (h.parts || []).filter(p => p.text).map(p => p.text);
            if (textParts.length > 0) {
                chatMessages.push({ role: h.role, text: textParts.join('\n') });
            }
        }

        const state = {
            version: 1,
            sessionId: session.id,
            createdAt: session.createdAt,
            savedAt: Date.now(),
            thinkingMode: session.thinkingMode,
            fps: session.fps,
            codeAccess: session.codeAccess,
            webSearch: session.webSearch,
            videos: session.videos.map(v => ({
                fileUri: v.fileUri,
                fileName: v.fileName,
                mimeType: v.mimeType,
                isGCS: v.isGCS,
                title: v.title,
                duration: v.duration,
                sourceUrl: v.sourceUrl,
                localPath: v.localPath,
                isTemp: v.isTemp,
                analyzed: v.analyzed,
                analysisError: v.analysisError,
                uploadedAt: v.uploadedAt || session.createdAt,
            })),
            chatMessages,
            profile: session.profile || {},
            projectAnalysis: session.projectAnalysis || null,
            usageTotals: session.usageTotals || null,
            videoCache: session.videoCacheName ? {
                name: session.videoCacheName,
                model: session.videoCacheModel,
                fps: session.videoCacheFps,
                videoCount: session.videoCacheVideoCount,
                expireAt: session.videoCacheExpireAt,
                tokens: session.videoCacheTokens,
                region: session.videoCacheRegion || null,
                signature: session.videoCacheSignature || null,
            } : null,
        };

        fs.writeFileSync(savePath, JSON.stringify(state, null, 2), 'utf8');
        _log(`Session saved to disk (${chatMessages.length} messages, ${state.videos.length} videos)`);
    } catch (e) {
        _log(`Failed to save session: ${e.message}`);
    }
}

/**
 * Load a saved session from disk. Returns null if no saved session or it's invalid.
 * Does NOT restore the Gemini conversation — that requires re-uploading videos.
 */
function loadSavedSession(saveDir) {
    try {
        const savePath = path.join(saveDir, SESSION_FILE);
        if (!fs.existsSync(savePath)) return null;

        const raw = JSON.parse(fs.readFileSync(savePath, 'utf8'));
        if (!raw || raw.version !== 1 || !raw.sessionId) return null;

        // Check if videos are still valid (Gemini files expire after ~48h)
        const now = Date.now();
        const videosExpired = (raw.videos || []).some(v => {
            const age = now - (v.uploadedAt || raw.createdAt || 0);
            return age > GEMINI_FILE_TTL_MS;
        });

        return {
            ...raw,
            videosExpired,
            age: Math.round((now - raw.createdAt) / 60000), // minutes
        };
    } catch (e) {
        _log(`Failed to load saved session: ${e.message}`);
        return null;
    }
}

/**
 * Restore a saved session — re-upload videos to Gemini and rebuild conversation.
 * Returns the same shape as startSession().
 */
async function restoreSession(saveDir, onProgress) {
    const savePath = path.join(saveDir, SESSION_FILE);
    if (!fs.existsSync(savePath)) throw new Error('No saved session to restore');

    const saved = JSON.parse(fs.readFileSync(savePath, 'utf8'));
    if (!saved || !saved.sessionId) throw new Error('Invalid saved session');

    onProgress = onProgress || (() => {});
    onProgress(5, 'Restoring session...');

    const now = Date.now();
    const videos = [];

    // Re-upload each video to Gemini (files expire after 48h)
    for (let i = 0; i < (saved.videos || []).length; i++) {
        const sv = saved.videos[i];
        const age = now - (sv.uploadedAt || saved.createdAt || 0);
        const expired = age > GEMINI_FILE_TTL_MS;

        onProgress(10 + (i / saved.videos.length) * 60, `Re-uploading video ${i + 1}/${saved.videos.length}...`);

        if (expired || !sv.fileUri) {
            // Need to re-upload — check if local file still exists
            const localFile = sv.localPath || sv.sourceUrl;
            if (!localFile) {
                _log(`Video "${sv.title}" has no local path and Gemini file expired — skipping`);
                videos.push({ ...sv, analyzed: false, analysisError: 'Gemini file expired and no local copy available', uploadedAt: 0 });
                continue;
            }

            try {
                const reUploaded = await _ingestVideo(
                    sv.sourceUrl || sv.localPath,
                    saveDir,
                    (p, m) => onProgress(10 + (i / saved.videos.length) * 60 + p * 0.3, m)
                );
                reUploaded.uploadedAt = Date.now();
                reUploaded.analyzed = false; // needs re-analysis
                reUploaded.analysisError = null;
                reUploaded.reUploaded = true; // flag so cache gets invalidated on restore
                videos.push(reUploaded);
                _log(`Re-uploaded expired video "${sv.title}"`);
            } catch (e) {
                _log(`Failed to re-upload "${sv.title}": ${e.message}`);
                videos.push({ ...sv, analyzed: false, analysisError: `Re-upload failed: ${e.message}`, uploadedAt: 0 });
            }
        } else {
            // File URI still valid — reuse it
            sv.uploadedAt = sv.uploadedAt || saved.createdAt;
            videos.push(sv);
        }
    }

    // Create the session
    const session = {
        id: saved.sessionId,
        saveDir,
        videos,
        history: [],
        profile: _normalizeExtractedProfile(saved.profile || {}, {
            videos,
            projectAnalysis: saved.projectAnalysis || null,
        }) || {},
        createdAt: saved.createdAt,
        thinkingMode: saved.thinkingMode || 'off',
        fps: saved.fps || 1,
        codeAccess: saved.codeAccess !== false,
        webSearch: saved.webSearch !== false,
        projectAnalysis: saved.projectAnalysis || null,
        usageTotals: saved.usageTotals || null,
    };

    // Restore video cache handle if saved AND still live. If any video was
    // re-uploaded (new fileUri) the cache is stale — leave it unset so the next
    // _callGemini rebuilds it. Same if the recorded expiry has passed.
    const savedCache = saved.videoCache;
    const videosReUploaded = videos.some(v => v.reUploaded === true);
    if (savedCache && savedCache.name && !videosReUploaded
        && savedCache.expireAt && savedCache.expireAt > Date.now() + 60_000) {
        session.videoCacheName = savedCache.name;
        session.videoCacheModel = savedCache.model;
        session.videoCacheFps = savedCache.fps;
        session.videoCacheVideoCount = savedCache.videoCount;
        session.videoCacheExpireAt = savedCache.expireAt;
        session.videoCacheTokens = savedCache.tokens;
        session.videoCacheSignature = savedCache.signature || null;
        // Prefer stored region; fall back to parsing it from the resource name
        // (format: projects/.../locations/REGION/cachedContents/ID)
        if (savedCache.region) {
            session.videoCacheRegion = savedCache.region;
        } else {
            const m = String(savedCache.name).match(/\/locations\/([^/]+)\//);
            session.videoCacheRegion = m ? m[1] : null;
        }
        _log(`Restored video cache handle (expires ${new Date(savedCache.expireAt).toISOString()})`);
    }

    _sessions.set(session.id, session);

    // Rebuild history from saved chatMessages so future auto-saves don't wipe them.
    // Attach video parts to the FIRST user turn so Gemini sees videos in every call.
    onProgress(75, 'Rebuilding conversation context...');

    const rawMessages = Array.isArray(saved.chatMessages) ? saved.chatMessages : [];
    const validVideos = videos.filter(v => v.fileUri && v.uploadedAt > 0);
    const videoParts = validVideos.length > 0 ? _buildVideoParts(session) : [];

    // Sanitize saved messages: drop empties, normalize role, ensure the sequence starts
    // with 'user' and alternates user/model (Gemini rejects consecutive same-role turns).
    const savedMessages = [];
    for (const m of rawMessages) {
        if (!m || !m.text || !m.text.trim()) continue;
        const role = (m.role === 'user') ? 'user' : 'model';
        // Drop leading model turns before any user turn
        if (savedMessages.length === 0 && role !== 'user') continue;
        // Collapse consecutive same-role turns by merging text (prevents 400)
        const prev = savedMessages[savedMessages.length - 1];
        if (prev && prev.role === role) {
            prev.text = `${prev.text}\n\n${m.text}`;
        } else {
            savedMessages.push({ role, text: m.text });
        }
    }

    let firstUserAttached = false;
    for (const m of savedMessages) {
        if (m.role === 'user') {
            if (!firstUserAttached && videoParts.length > 0) {
                // First user turn carries the video file_data so Gemini can see them
                session.history.push({ role: 'user', parts: [...videoParts, { text: m.text }] });
                firstUserAttached = true;
            } else {
                session.history.push({ role: 'user', parts: [{ text: m.text }] });
            }
        } else {
            session.history.push({ role: 'model', parts: [{ text: m.text }] });
        }
    }

    // Edge case: saved history has no user turn but we have videos — seed a minimal
    // first turn so Gemini has video context for the next chat.
    if (!firstUserAttached && videoParts.length > 0) {
        session.history.push({
            role: 'user',
            parts: [...videoParts, { text: '(Session restored — reference video(s) reloaded.)' }],
        });
        session.history.push({
            role: 'model',
            parts: [{ text: '(Videos are loaded. Ready to continue.)' }],
        });
    }

    onProgress(100, 'Session restored');
    _log(`Session ${session.id} restored — ${videos.length} video(s), ${(saved.chatMessages || []).length} chat messages`);

    return {
        sessionId: session.id,
        videoCount: videos.length,
        videos: videos.map(v => ({
            title: v.title, duration: v.duration, sourceUrl: v.sourceUrl,
            analyzed: v.analyzed, analysisError: v.analysisError,
        })),
        chatMessages: saved.chatMessages || [],
        profile: saved.profile || {},
        restored: true,
        thinkingMode: session.thinkingMode,
        codeAccess: session.codeAccess,
        webSearch: session.webSearch,
    };
}

/**
 * Delete the saved session file from disk.
 */
function deleteSavedSession(saveDir) {
    try {
        const savePath = path.join(saveDir, SESSION_FILE);
        if (fs.existsSync(savePath)) {
            fs.unlinkSync(savePath);
            _log('Saved session file deleted');
        }
    } catch (e) {
        _log(`Failed to delete saved session: ${e.message}`);
    }
}

/**
 * Clear accumulated chat messages from a saved session (keeps video, profile,
 * memory, and settings). Also drops any in-memory session so the next open
 * restores from the pruned file. Safe to call when no session file exists.
 *
 * Called on project switch to prevent long-running conversations from bloating
 * past Gemini's 1M token limit.
 */
function clearChatHistory(saveDir) {
    try {
        // Only purge in-memory sessions — the on-disk session stays intact so the
        // user can resume when they switch back to this project (like ChatGPT/Claude
        // project conversations). Each project's session lives in its own styles/ folder.
        const count = _sessions.size;
        _sessions.clear();
        _liveProjectContext = null;
        if (count > 0) _log(`Detached ${count} in-memory session(s) on project switch (disk untouched)`);
        return { cleared: count };
    } catch (e) {
        _log(`Failed to detach sessions: ${e.message}`);
        return { cleared: 0, error: e.message };
    }
}

// ============ STYLE STUDIO MEMORY ============

/**
 * Persistent memory that survives across sessions. The agent can save observations,
 * user preferences, channel patterns, and reference notes.
 * Stored as a simple JSON array of { text, category, createdAt } entries.
 */
function _getMemoryPath(saveDir) {
    return path.join(saveDir, MEMORY_FILE);
}

function loadMemory(saveDir) {
    try {
        const memPath = _getMemoryPath(saveDir);
        if (!fs.existsSync(memPath)) return [];
        const raw = JSON.parse(fs.readFileSync(memPath, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        return [];
    }
}

function saveMemoryEntry(saveDir, text, category = 'observation') {
    const memories = loadMemory(saveDir);
    memories.push({
        text: text.trim(),
        category,
        createdAt: Date.now(),
        date: new Date().toISOString().split('T')[0],
    });
    fs.writeFileSync(_getMemoryPath(saveDir), JSON.stringify(memories, null, 2), 'utf8');
    _log(`Memory saved: [${category}] ${text.substring(0, 80)}`);
    return memories;
}

function deleteMemoryEntry(saveDir, index) {
    const memories = loadMemory(saveDir);
    if (index < 0 || index >= memories.length) return memories;
    memories.splice(index, 1);
    fs.writeFileSync(_getMemoryPath(saveDir), JSON.stringify(memories, null, 2), 'utf8');
    _log(`Memory entry #${index + 1} deleted`);
    return memories;
}

function clearMemory(saveDir) {
    fs.writeFileSync(_getMemoryPath(saveDir), '[]', 'utf8');
    _log('All memories cleared');
    return [];
}

/**
 * Build a memory context block for injection into the system prompt.
 * Groups learnings by category for structured recall.
 */
function _buildMemoryContext(saveDir) {
    const memories = loadMemory(saveDir);
    if (memories.length === 0) return '';

    // Group by category
    const groups = {};
    for (const m of memories) {
        const cat = m.category || 'general';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(m);
    }

    const sections = [];

    // Auto-learned patterns first (from video analyses)
    const learnedCats = ['pacing', 'color', 'mg', 'transition', 'footage', 'typography', 'audio', 'editing', 'general-pattern'];
    const learnedEntries = [];
    for (const cat of learnedCats) {
        if (groups[cat]) {
            for (const m of groups[cat]) {
                learnedEntries.push(`- [${cat}] ${m.text} (from: ${m.source || 'unknown'}, ${m.date})`);
            }
            delete groups[cat];
        }
    }
    if (learnedEntries.length > 0) {
        sections.push(`LEARNED PATTERNS (auto-extracted from ${_countUniqueSources(memories)} analyzed videos):\n${learnedEntries.join('\n')}`);
    }

    // User notes
    const userEntries = [];
    for (const [cat, items] of Object.entries(groups)) {
        for (const m of items) {
            userEntries.push(`${userEntries.length + 1}. [${cat}] ${m.text} (${m.date})`);
        }
    }
    if (userEntries.length > 0) {
        sections.push(`USER NOTES:\n${userEntries.join('\n')}`);
    }

    if (sections.length === 0) return '';

    return `\n\nSTYLE STUDIO MEMORY — persistent knowledge from previous sessions:\n${sections.join('\n\n')}\n\nUse these patterns to COMPARE new videos against what you've seen before. Mention relevant patterns from memory when they match or contrast with the current video. This is what makes you smarter over time.`;
}

function _countUniqueSources(memories) {
    const sources = new Set();
    for (const m of memories) {
        if (m.source) sources.add(m.source);
    }
    return sources.size || '?';
}

// ============ AUTO-LEARNING ============

/**
 * Auto-learn prompt — ask Gemini to extract reusable style patterns from an analysis.
 * Runs as a lightweight follow-up call after each video analysis.
 */
const AUTO_LEARN_PROMPT = `Based on your analysis of this video, extract 3-5 KEY STYLE PATTERNS worth remembering for future video analyses. Focus on distinctive, reusable observations — NOT generic statements.

Output ONLY lines in this exact format (one per line):
CATEGORY: observation

Categories: pacing, color, mg, transition, footage, typography, audio, editing, general-pattern

RULES:
- Each observation must be specific and measurable (e.g., "8-12 cuts/min" not "fast editing")
- Include what makes this video's style distinctive vs generic
- Focus on patterns our video generation system could actually replicate or learn from
- If you notice a pattern that appeared in previous analyses (from memory), note the connection
- NO generic observations like "uses text overlays" — only distinctive patterns

Example good outputs:
pacing: Hook section uses 18 cuts/min for first 15s, then drops to 6 cuts/min for explanation — creates urgency then relief
color: Dark teal (#1a3a4a) + warm amber (#f5a623) duotone grade throughout — signature look
mg: Uses bold single-word focusWord MGs at emotional peaks, never during narration — punctuation style
transition: Zero crossfades — ALL hard cuts except 1 dissolve at the conclusion. Very deliberate.
audio: Music drops to silence for 2-3s before each key reveal — builds anticipation

Output ONLY the pattern lines, nothing else:`;

/**
 * Extract learnings from an analysis reply and save them to memory.
 * Runs as a non-blocking follow-up after each successful video analysis.
 */
async function _autoLearnFromAnalysis(session, videoTitle, analysisReply) {
    try {
        // Ask Gemini to extract patterns (lightweight call, short output)
        const learnReply = await _callGemini(session, AUTO_LEARN_PROMPT, {
            maxOutputTokens: 600,
            temperature: 0.2,
            requestLabel: 'auto-learn',
        });

        // Remove the auto-learn turn from conversation history — it's a background operation
        // Pop the last 2 entries (user prompt + model reply for the learn call)
        session.history.pop(); // model reply
        session.history.pop(); // user prompt

        // Parse pattern lines: "CATEGORY: observation"
        const lines = learnReply.split('\n').filter(l => l.trim());
        let savedCount = 0;

        for (const line of lines) {
            const match = line.match(/^(pacing|color|mg|transition|footage|typography|audio|editing|general-pattern):\s*(.+)/i);
            if (match) {
                const category = match[1].toLowerCase();
                const text = match[2].trim();
                if (text.length > 10) {
                    const memories = loadMemory(session.saveDir);
                    // Check for near-duplicates (same category + similar text)
                    const isDupe = memories.some(m =>
                        m.category === category &&
                        _textSimilarity(m.text, text) > 0.6
                    );
                    if (!isDupe) {
                        _saveMemoryWithSource(session.saveDir, text, category, videoTitle);
                        savedCount++;
                    }
                }
            }
        }

        if (savedCount > 0) {
            _log(`Auto-learned ${savedCount} pattern(s) from "${videoTitle}"`);
        }
        return savedCount;
    } catch (e) {
        _log(`Auto-learn failed (non-critical): ${e.message}`);
        return 0;
    }
}

/**
 * Save a memory entry with source video attribution.
 */
function _saveMemoryWithSource(saveDir, text, category, source) {
    const memories = loadMemory(saveDir);
    memories.push({
        text: text.trim(),
        category,
        source: source || 'unknown',
        createdAt: Date.now(),
        date: new Date().toISOString().split('T')[0],
    });
    // Cap total memories at 200 to prevent prompt bloat — remove oldest learned entries
    if (memories.length > 200) {
        const learnedCats = new Set(['pacing', 'color', 'mg', 'transition', 'footage', 'typography', 'audio', 'editing', 'general-pattern']);
        // Find oldest auto-learned entry and remove it
        const oldestIdx = memories.findIndex(m => learnedCats.has(m.category));
        if (oldestIdx !== -1) memories.splice(oldestIdx, 1);
    }
    fs.writeFileSync(_getMemoryPath(saveDir), JSON.stringify(memories, null, 2), 'utf8');
}

/**
 * Simple text similarity (Jaccard on word sets) to avoid duplicate learnings.
 */
function _textSimilarity(a, b) {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 3));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) intersection++;
    }
    return intersection / (wordsA.size + wordsB.size - intersection);
}

function _newId() {
    return `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _getSession(sessionId) {
    const s = _sessions.get(sessionId);
    if (!s) throw new Error(`Style Studio session not found: ${sessionId}`);
    return s;
}

// ============ PROMPT BUILDERS ============

function _systemPrompt() {
    // Live feature catalog from the actual codebase — always current.
    // Includes MG registry (types + variants), template registry, themes, recent commits.
    let featureCatalog = '';
    try {
        const qaCtx = require('./qa-features-context');
        featureCatalog = qaCtx.buildFeatureCatalog();
    } catch (e) {
        featureCatalog = '(feature catalog unavailable)';
    }

    // Effect presets — live from registry
    let presetNames = [];
    try {
        const EFFECT_PRESETS = require('./effect-presets');
        presetNames = Object.keys(EFFECT_PRESETS).filter(k => k !== 'none');
    } catch (e) {}

    return `You are a STYLE STUDIO AGENT — an expert video editor analyzing reference YouTube videos so a generative pipeline can match their look and feel.

You have one or more reference videos uploaded to this conversation. You can re-watch any video the user asks about. Be specific, observant, and precise — name actual scene timestamps, MG types you see, transition styles, music character.

TWO DIFFERENT VIDEOS — DO NOT CONFUSE THEM:
1. REFERENCE VIDEO(S) — the file(s) attached to this conversation. You watch these to understand STYLE (pacing, MG types, transitions, colors, music). They are NOT what the user is creating.
2. THE USER'S PROJECT VIDEO — the video they are BUILDING with our pipeline. Its title, niche, AI instructions, and script come from the PROJECT CONTEXT block below (injected at call time). If asked "what is the title of the video I'm building / my video / the project video", ALWAYS answer from PROJECT CONTEXT — never from a title card or on-screen text in the reference video.
When in doubt about which video the user means, assume they mean their PROJECT VIDEO (the one being built). Only quote the reference video's title if they explicitly say "reference video" or "the one I uploaded".

OUR VIDEO GENERATION SYSTEM — LIVE CAPABILITIES (auto-scanned from codebase):

${featureCatalog}

Effect presets:
  ${presetNames.join(', ') || '(presets unavailable)'}
  Available shader effects: grain, dust, vignette, blurVignette, chromatic, lightLeak, scratch, colorGrade, scanLine, flicker, filmFrame

Transitions: cut, crossfade, crossBlur, dissolve, morph, ripple, ink, fade, dreamFade, lightLeak, fade_to_black, wipe, flash, zoom

Framing modes: fullscreen (default), cinematic (pulled back blurred bg), floating (small with shadow + soft bg)

Niches: explainer.* (nature/crime/business/luxury/sport/history/motivation/food/diy/military/politics/tech), news.* (politics/celebrity/military/economy/tech/sport)

CODEBASE AWARENESS:
- When the user asks "does our system support X?" or "do we have Y?" — check the live catalog above. If X is listed, confirm and specify which module. If not, say so clearly and suggest WHERE to add it:
  - New MG type → add to src/mg-registry.js + renderer in ui/js/compositor/MGRenderer.js
  - New transition → add to ui/js/compositor/ shader + transition selection in src/build-video.js
  - New effect/shader → add to ui/js/compositor/ + register in src/effect-presets.js
  - New template → add to src/ai-templates.js
  - New theme → add to src/themes.js
- When identifying system gaps from a reference video, be specific: "Reference uses split-screen comparison at 1:24. Our system doesn't have a splitScreen MG — would need to add it to mg-registry.js and MGRenderer.js."
- The RECENT COMMITS section shows what was changed recently — use this to know what features are new vs established.

WEB SEARCH (built-in):
- You have Google Search built in. When the user asks about a topic, real-world events, facts, statistics, or current affairs related to their video, you can search the web automatically.
- Use web search to: verify facts in the narration, find context about the topic (e.g., "Strait of Hormuz traffic statistics"), identify key entities/events, and suggest better keywords for footage search.
- When you use search results, cite them naturally (e.g., "According to recent data, X ships pass through daily").
- This helps you make better scene plans — you understand what the video is actually about, not just the words.

CODE ACCESS (when enabled):
- When the user asks code-related questions, the system automatically searches the codebase and attaches relevant source snippets below the user's message in a [CODE CONTEXT] block.
- Use this code context to give PRECISE answers about implementation details, supported features, function signatures, and where things are defined.
- When you see a [CODE CONTEXT] block, base your answer on the ACTUAL CODE shown — not on assumptions.
- If the code context doesn't cover what the user asked about, say so and suggest which file they should ask about.
- You can reference specific line numbers and function names from the code context.

TRANSCRIPT ACCESS:
- When the user asks about their project's SCRIPT, NARRATION, TRANSCRIPT, VOICEOVER, HOOK, INTRO, CONCLUSION, or "the first/last words of the video", the system auto-loads the Whisper transcript of their project audio and appends it below the user's message in a [TRANSCRIPT CONTEXT] block.
- This is the user's OWN NARRATION text — what their project video is actually about. It is NOT the reference video's transcript.
- When a [TRANSCRIPT CONTEXT] block is present, answer from that actual text — quote exact words, don't paraphrase or invent.
- If no [TRANSCRIPT CONTEXT] block appears BUT the PROJECT CONTEXT says "TRANSCRIPT: available", tell the user to ask about the "transcript" or "script" so it gets loaded.
- If PROJECT CONTEXT says "TRANSCRIPT: not yet generated", tell the user to run a build first.

INTERACTIVE SCENE PLANNING (you are the AI Director + Visual Planner):
- You are a conversational scene planner AND visual director. The user will ask you to split portions of the transcript into scenes INTERACTIVELY — "split the first 2 minutes", "now do the next part", "make the hook faster", etc.
- ONLY split the portion the user asks about. If they say "first 2 minutes", only output scenes for 0-120s. Do NOT split the full transcript unless they explicitly ask.
- A SCENE = one visual / one footage clip. If the visual would change, that's a NEW scene.
- Think FOOTAGE FIRST: same clip = merge, different clip = split.
- New entity, location, concept, or subject = new scene.
- Scene durations: HOOK (first 15-25s) = 2-4s each. BODY = 4-8s each. CTA/CONCLUSION = 6-10s each.
- Use the reference video's pacing as your guide — you saw how they cut.

OUTPUT FORMAT — each scene on one line, pipe-separated fields. The FIRST field after the time range MUST be the exact narration quote for that scene's time span (the words the viewer will actually hear), in double quotes. This lets the user verify scene boundaries match the audio.

SCENE 1: 0.0s-4.5s | "0527 local time, the Persian Gulf. Day 30." | keyword: oil tanker ocean aerial | sourceHint: stock | framing: fullscreen | effects: none | mgHint: none | visualIntent: aerial wide shot of oil tankers in the Persian Gulf
SCENE 2: 4.5s-9.2s | "An Iranian warship intercepts a US-flagged tanker in the strait." | keyword: Strait of Hormuz Iran warship incident 2024 | sourceHint: youtube | framing: cinematic | effects: grain | mgHint: statCounter: 100 ships stranded | visualIntent: news footage of Iranian warship intercepting tanker

QUOTE RULES:
- Use the EXACT words from the [TRANSCRIPT CONTEXT] block for the scene's time range — do not paraphrase.
- Keep the quote short enough to read at a glance; if the span is long, you can trim to the key sentence(s) and add "…" but stay faithful to the words.
- Never invent narration. If the transcript shows something different than what you'd expect, quote what's actually there so the user sees the mismatch.

FIELD GUIDE (only include fields you're confident about, skip optional ones):
- keyword: search term for footage, TAILORED TO sourceHint (REQUIRED — see KEYWORD × SOURCE rules below)
- sourceHint: stock | youtube | web-image | telegram | reddit (REQUIRED — pick source FIRST, then write the keyword for THAT source)
- framing: fullscreen | cinematic | floating (default: fullscreen. Use cinematic for pulled-back with blur bg, floating for small with shadow)
- effects: none | retroDV | oldFilm | newsArchive | warmVintage | coldDrama | etc (default: none)
- mgHint: MG type with content, e.g. "statCounter: 75% savings" or "mapChart: Persian Gulf" or "headline: Breaking News" (default: none)
- fullscreenMG: for scenes that are ENTIRELY a motion graphic, no footage (e.g. "timeline: 1990: Event A, 2003: Event B")
- templateHint: for template-based scenes (e.g. "statCard: Oil exports dropped 40%")
- visualIntent: 1-sentence shot description (helps footage search)

KEYWORD × SOURCE HINT — CRITICAL (do NOT use the same keyword style for every source):

Pick the source FIRST based on what the scene needs, THEN write the keyword in the style that source expects. A keyword that works on Pexels will fail on YouTube, and vice versa.

1) sourceHint: stock  (Pexels / Pixabay / Unsplash)
   - Audience: stock libraries tagged with generic, visual nouns.
   - KEYWORD STYLE: 2-4 words, visual concrete nouns + 1 descriptor. NO proper nouns, NO dates, NO news terms.
   - GOOD: "oil tanker ocean aerial", "crowded city street night", "factory worker welding", "fighter jet takeoff"
   - BAD: "Iran attacks US tanker March 2024" (stock has no news), "Putin speech Kremlin" (no proper nouns), "the moment everything changed" (not visual)
   - Rule of thumb: if a scene needs a SPECIFIC person/event/place, don't use stock.

2) sourceHint: youtube  (yt-dlp downloads)
   - Audience: YouTube search — understands natural language, dates, event names, proper nouns.
   - KEYWORD STYLE: 4-8 words, specific event + entity + year/context. Natural search phrasing.
   - GOOD: "Strait of Hormuz Iran warship 2024", "Zelensky UN speech September 2023", "Hurricane Helene Florida landfall footage", "SpaceX Starship launch test 4"
   - BAD: "tanker ocean" (too generic, returns random), "war footage" (too broad), "news" (meaningless)
   - Rule of thumb: include at least ONE specific entity or date. Think "what would a journalist type into YouTube to find the raw clip?".

3) sourceHint: web-image  (Bing / Google Image scrape)
   - Audience: web image search — great for portraits, weapons specs, infographics, press photos.
   - KEYWORD STYLE: 3-6 words, entity + descriptor. Proper nouns welcome.
   - GOOD: "Ayatollah Khamenei portrait", "F-35 fighter specifications diagram", "Hurricane Helene damage aerial photo", "Tesla Model S interior"
   - BAD: "person speaking" (no specificity), "damage" (too vague), "aircraft" (pick one)
   - Rule of thumb: anchor on ONE named entity per image.

4) sourceHint: telegram  (war/news channels — see NICHE RULES for which niches allow it)
   - Audience: Telegram channel search — scraped in the channel's native language. Often Arabic/Russian/Ukrainian military channels.
   - KEYWORD STYLE: 1-3 words, raw event/location/weapon name. NO long sentences.
   - GOOD: "Kinzhal missile", "Crimea bridge strike", "Gaza airstrike", "Donetsk front"
   - BAD: "Russian military operation in eastern Ukraine 2024" (too long; channel search truncates), "the invasion" (no anchor)
   - Rule of thumb: the provider auto-translates — you write it in English, keep it TIGHT (the translator drops noise words). Lean on weapon/location/operation names.

5) sourceHint: reddit
   - Audience: Reddit search — community-tagged, good for raw event footage + first-person accounts.
   - KEYWORD STYLE: 3-5 words, event-driven, conversational.
   - GOOD: "drone footage Ukraine trench", "wildfire evacuation California", "earthquake aftermath Turkey"
   - BAD: stock-style generic nouns; overly academic phrasing.

GENERAL KEYWORD RULES:
- One keyword per scene. Do not write "A or B" — pick one.
- Strip filler words: "the", "a", "of", "that", "which" usually don't help.
- Match language: if the narration mentions a specific person/place/event and the scene is ABOUT them, include that entity in the keyword. If the scene is a generic cutaway, use visual nouns only.
- When the niche's search policy lists avoidTerms (see NICHE RULES block), do NOT use those terms — they degrade stock results.
- When the niche's search policy lists contextTerms, you may append ONE (e.g., "military", "documentary") to disambiguate on stock.
- If a single scene needs BOTH a specific event AND a generic cutaway, split into two scenes with different sourceHints.

DIRECTOR'S BRIEF — output a BRIEF block the first time you plan scenes for a project (or when the user explicitly asks for one):
BRIEF:
  niche: explainer.military
  theme: modern
  format: documentary
  pacing: moderate
  summary: Why the US Navy needs Marines to control the Strait of Hormuz
  tone: serious, analytical
  entities: US Navy [org], Marines [org], Strait of Hormuz [place], Persian Gulf [place], Iran [place]
  hookEnd: 15
  ctaStart: none
  eventType: educational

BRIEF RULE — CRITICAL:
- Always analyze the ENTIRE transcript before writing the BRIEF, even when the user only asks you to split a portion (e.g. "first 4 minutes", "just the hook").
- The CTA can be at the END or buried in the MIDDLE. The tone, pacing, or eventType can shift halfway through. Niche/theme/format can only be correctly inferred from the full script arc.
- If you only look at the portion the user asked about, you will mis-detect ctaStart (defaulting to "none" when a CTA exists later), miss format shifts, and lock in a wrong pacing.
- Scene splitting is still partial — ONLY output SCENE lines for the range the user requested. But the BRIEF itself always reflects the whole video.
- If the full transcript hasn't been loaded yet, ask the user to say "transcript" (or any trigger) so it gets auto-loaded, then produce the BRIEF.

The user says "save plan" (or similar) to save everything. The build pipeline will use it to skip Steps 3+4 entirely.

SAVING IS NOT YOUR JOB:
- You CANNOT save files. Saving is handled by the harness — it intercepts the user's "save plan" message BEFORE it reaches you, writes styles/.studio-plan.json, and replies with a ✅ confirmation.
- If you see a save-request in the chat history, it means the harness's detector did NOT match (typo like "plane" instead of "plan", weird phrasing, etc.) and the message fell through to you. In that case: DO NOT claim the plan was saved. Say: "I can't save files myself — try rephrasing as 'save plan' or 'save the scenes' and the app will handle it."
- NEVER say "saved", "has been saved", "the plan is saved", etc. unless you have explicit proof (e.g., the user quotes the ✅ confirmation reply back to you).
- Be conversational: explain WHY you cut where you cut, reference the reference video's pacing, suggest alternatives.

TEMPORAL ANALYSIS (pacing & animation detection):
- Count EVERY cut transition in the video. A "cut" is any abrupt change between two different shots or scenes.
- For pacing: pick THREE 15-second windows (one in intro, one in body, one in conclusion), count cuts in each, then average to get cuts per minute.
- Report timestamps in MM:SS format when citing specific moments.
- For motion graphics: note the exact timestamp when each text overlay/MG appears and disappears.
- For transitions: identify the type AND approximate duration (e.g., "crossfade at 1:24, ~0.4s").
- When a scene has rapid animation or text movement, describe the motion speed and direction.

PACING SEGMENTS — CRITICAL:
- Pacing is NOT uniform. It fluctuates based on the script content: a montage is fast, an explanation is slow, a dramatic buildup accelerates.
- Identify 3-8 SEGMENTS where the pacing noticeably changes. Each segment has:
  - startTime / endTime (seconds)
  - cutsPerMinute for that window
  - avgSceneDuration for that window
  - energy: high / medium / low
  - label: short description of what's happening (e.g., "fast montage", "slow diagram walkthrough", "dramatic buildup", "data breakdown", "aerial showcase")
- If pacing is truly steady throughout, report 1-2 segments. But most videos have at least 3-4 distinct pacing zones.
- This data lets our pipeline match the RHYTHM of the reference — not just the average speed.

CONVERSATIONAL RULES:
- When the user asks a question, look at the actual video — do not guess.
- Be concise. Lead with the answer, then 1-2 short sentences of evidence.
- If asked about pacing, count cuts using the three-window method above.
- If asked about a feature we don't have, flag it as a system gap and explain what we'd need to add.
- If asked to update the profile, return ONLY a JSON object with the fields that change.
- NEVER hallucinate timestamps or video durations. If unsure, say "I'd need to re-check the video".
- When citing frame-level observations, mention which timestamp you're looking at.

AUTO-LEARNING:
- After every video you analyze, the system automatically extracts 3-5 key style patterns and saves them to persistent memory.
- Over time, you build up knowledge of editing patterns, pacing rhythms, color palettes, MG usage, and more across many videos.
- When analyzing a new video, ALWAYS compare it against patterns you've learned from previous videos. Say things like: "This video uses 12 cuts/min — faster than the 6-8 cuts/min I've typically seen in documentary-style content" or "Similar warm amber palette to [previous video name]".
- This cross-reference ability is your key advantage — you get SMARTER with every video.

MEMORY COMMANDS:
- If the user says "remember this: ..." or "save to memory: ...", confirm you'll remember it. The system persists it automatically.
- If the user says "what do you remember?" or "show memory", list all saved memories with their source videos.
- If the user says "forget #N" or "delete memory N", the system will remove that entry.
- Your persistent memories (learned patterns + user notes) are shown below in the STYLE STUDIO MEMORY section.

WHEN USER ASKS FOR THE PROFILE: emit a complete JSON object matching the schema you've been told about, wrapped in a fenced code block: \`\`\`json ... \`\`\``;
}

function _initialAnalysisPrompt(video) {
    return `New reference video added to this session:
- Title: "${video.title}"
- Duration: ${video.duration} seconds (this is the AUTHORITATIVE duration from the file metadata — do not estimate it yourself)
- Source: ${video.sourceUrl || video.localPath}

ANALYZE THIS VIDEO using the temporal analysis method from your instructions. Give me a briefing (under 300 words) covering:

1. Overall editing style in one sentence
2. PACING RHYTHM: Pick a 15-second window near 0:30 and count every cut. Report: "X cuts in 15s near 0:30 → Y cuts/min". Do the same near the video midpoint. Then answer: does the pacing CHANGE throughout, or is it mostly steady? Identify the fastest and slowest sections with timestamps.
3. PACING SEGMENTS: Briefly list 3-5 pacing zones you notice (e.g., "0:00-0:25 fast hook → 0:25-1:30 slow explanation → 1:30-2:10 rapid montage"). This is critical — we need to know HOW the pacing fluctuates, not just the average.
4. Most prominent MG / text overlay style — cite at least 2 timestamps where they appear (e.g., "headline MG at 0:12, focusWord at 0:45")
5. TRANSITIONS: What types do you see? Any that aren't hard cuts? Cite one with timestamp.
6. Music character (genre, energy, does it shift between sections?)
7. COLOR PALETTE: What are the dominant 3 colors? Give hex codes if possible.
8. One thing about it our system probably can't replicate yet (be specific)

Be concrete and cite timestamps. End with: "Ask me anything about this video, or say 'extract profile' when ready."`;
}

function _profileExtractionPrompt(videoCount) {
    const sourceWord = videoCount > 1 ? 'these videos' : 'this video';
    const sentinelWord = videoCount > 1 ? 'merged channel-style' : 'single-video';
    return `Based on everything you've observed in ${sourceWord} during this conversation, emit the FINAL ${sentinelWord} style profile as ONE valid JSON object. Use the SAME schema described in the system prompt's video generation context. Use real numbers (not estimates from memory) — re-watch ${sourceWord} if needed.

For videoDuration, sum the actual durations I gave you in the system messages — do NOT guess.

For each motion graphic you list, ONLY use names from our supported MG type list. If a reference uses something we don't have, put it in systemNotes with priority "important".

Use these EXACT top-level keys and nested keys where relevant:
- summary
- pacing: cutsPerMinute, avgSceneDuration, rhythm, hookDuration, ctaDuration, sections, segments
- footage
- motionGraphics: density, preferredTypes, avoidTypes, frequencyPerMinute, placementTiming, textAnimationSpeed, avgDurationOnScreen, placementPattern, densityBySection
- transitions: cutRatio, crossfadeRatio, otherRatio, preferredTypes, avgTransitionDuration
- effects: closestPreset, colorTemperature, contrastLevel, effectCoverage
- colorPalette
- typography
- audio: musicStyle, musicEnergy, voiceToMusicRatio, sfxTypes, sfxDensity, musicChanges
- hook
- cta
- systemNotes

Do NOT use alternate shapes like:
- pacingSegments (use pacing.segments)
- music (use audio)
- arrays for motionGraphics / transitions / effects when the schema expects an object

OUTPUT ONLY the JSON object, no commentary, no markdown fences.`;
}

function _toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function _clamp01(value) {
    const num = _toFiniteNumber(value);
    if (num == null) return null;
    return Math.max(0, Math.min(1, num));
}

function _dedupeStrings(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map(v => String(v || '').trim())
        .filter(Boolean))];
}

function _avg(values) {
    const nums = (Array.isArray(values) ? values : [])
        .map(_toFiniteNumber)
        .filter(v => v != null);
    if (nums.length === 0) return null;
    return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function _majority(values, fallback = null) {
    const counts = new Map();
    for (const value of (Array.isArray(values) ? values : [])) {
        const key = String(value || '').trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let winner = fallback;
    let best = 0;
    for (const [key, count] of counts.entries()) {
        if (count > best) {
            best = count;
            winner = key;
        }
    }
    return winner;
}

function _normalizePacingSegments(rawSegments) {
    const segments = (Array.isArray(rawSegments) ? rawSegments : [])
        .map(seg => {
            const startTime = _toFiniteNumber(seg?.startTime);
            const endTime = _toFiniteNumber(seg?.endTime);
            if (startTime == null || endTime == null || endTime <= startTime) return null;
            const cutsPerMinute = _toFiniteNumber(seg?.cutsPerMinute);
            const avgSceneDuration = _toFiniteNumber(seg?.avgSceneDuration);
            const energy = ['high', 'medium', 'low'].includes(String(seg?.energy || '').toLowerCase())
                ? String(seg.energy).toLowerCase()
                : null;
            return {
                startTime,
                endTime,
                ...(cutsPerMinute != null && { cutsPerMinute: +cutsPerMinute.toFixed(1) }),
                ...(avgSceneDuration != null && { avgSceneDuration: +avgSceneDuration.toFixed(1) }),
                ...(energy && { energy }),
                ...(seg?.label && { label: String(seg.label).trim() }),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.startTime - b.startTime);
    return segments;
}

function _buildPacingSections(segments, totalDuration) {
    const duration = _toFiniteNumber(totalDuration);
    if (!segments.length || duration == null || duration <= 0) return {};
    const pickSection = (items) => {
        if (!items.length) return null;
        const sectionDuration = items.reduce((sum, seg) => sum + (seg.endTime - seg.startTime), 0);
        return {
            ...( _avg(items.map(seg => seg.avgSceneDuration)) != null && { avgSceneDuration: +_avg(items.map(seg => seg.avgSceneDuration)).toFixed(1) } ),
            ...( _majority(items.map(seg => seg.energy), 'medium') && { energy: _majority(items.map(seg => seg.energy), 'medium') } ),
            durationPercent: +Math.max(0, Math.min(1, sectionDuration / duration)).toFixed(2),
        };
    };

    if (segments.length === 1) {
        return { intro: pickSection(segments) };
    }

    const intro = pickSection([segments[0]]);
    const conclusion = pickSection([segments[segments.length - 1]]);
    const body = pickSection(segments.slice(1, -1));
    const sections = {};
    if (intro) sections.intro = intro;
    if (body) sections.body = body;
    if (conclusion) sections.conclusion = conclusion;
    return sections;
}

function _inferPaletteMood(colorPalette = {}) {
    if (colorPalette.mood) return colorPalette.mood;
    const text = `${colorPalette.primary || ''} ${colorPalette.secondary || ''} ${colorPalette.accent || ''}`.toLowerCase();
    if (/0b3d91|00aeef|#0b3d91|#00aeef|blue|cyan/.test(text)) return 'cool-tech';
    if (/e1c16e|amber|gold|orange|warm/.test(text)) return 'warm-earthy';
    return 'muted-desaturated';
}

function _inferColorTemperature(colorPalette = {}) {
    const mood = _inferPaletteMood(colorPalette);
    if (mood === 'cool-tech') return 'cool';
    if (mood === 'warm-earthy') return 'warm';
    return 'neutral';
}

function _mapMusicStyle(value) {
    const text = String(value || '').toLowerCase();
    if (!text) return 'none';
    if (/electronic|synth|techno/.test(text)) return 'electronic';
    if (/ambient|atmospher/.test(text)) return 'ambient';
    if (/corporate/.test(text)) return 'corporate';
    if (/hip.?hop|trap/.test(text)) return 'hip-hop';
    if (/orchestral|string/.test(text)) return 'orchestral';
    if (/cinematic|documentary|tense|dramatic/.test(text)) return 'cinematic';
    return 'cinematic';
}

function _mapMusicEnergy(value) {
    const text = String(value || '').toLowerCase();
    if (!text || text === 'none') return 'none';
    if (/dynamic|high|intense|fast|driving/.test(text)) return 'high';
    if (/low|calm|soft|subdued/.test(text)) return 'low';
    return 'medium';
}

function _guessClosestPreset(effectEntries, colorPalette = {}) {
    const effects = new Set((Array.isArray(effectEntries) ? effectEntries : [])
        .map(entry => String(entry?.type || '').trim())
        .filter(Boolean));
    if (effects.has('oldFilm')) return 'oldFilm';
    if (effects.has('lightLeak') && effects.has('colorGrade') && effects.has('vignette')) return 'cinematic';
    if (effects.has('lightLeak')) return 'cleanGlow';
    if (effects.has('colorGrade') && effects.has('scanLine')) return 'retroDV';
    if (effects.has('colorGrade') && _inferColorTemperature(colorPalette) === 'warm') return 'vintageWarm';
    if (effects.has('colorGrade')) return 'cinematic';
    return 'none';
}

function _normalizeSystemNotes(notes) {
    return (Array.isArray(notes) ? notes : []).map(note => {
        const priority = ['important', 'nice-to-have'].includes(String(note?.priority || '').toLowerCase())
            ? String(note.priority).toLowerCase()
            : 'nice-to-have';
        return {
            area: note?.area || 'other',
            observation: note?.observation || note?.description || '',
            gap: note?.gap || note?.description || note?.observation || '',
            priority,
            ...(note?.suggestion && { suggestion: note.suggestion }),
        };
    }).filter(note => note.gap || note.observation);
}

function _normalizeExtractedProfile(profile, session = null) {
    if (!profile || typeof profile !== 'object') return profile;

    const normalized = { ...profile };
    const videoDuration = _toFiniteNumber(profile.videoDuration)
        || _toFiniteNumber(session?.videos?.[0]?.duration)
        || _toFiniteNumber(session?.projectAnalysis?.transcriptDuration)
        || 0;

    const rawPacing = (profile.pacing && typeof profile.pacing === 'object' && !Array.isArray(profile.pacing)) ? profile.pacing : {};
    const segments = _normalizePacingSegments(rawPacing.segments || rawPacing.pacingSegments);
    const cutsPerMinute = _toFiniteNumber(rawPacing.cutsPerMinute) ?? _avg(segments.map(seg => seg.cutsPerMinute));
    const avgSceneDuration = _toFiniteNumber(rawPacing.avgSceneDuration) ?? _avg(segments.map(seg => seg.avgSceneDuration));
    const hookDuration = _toFiniteNumber(rawPacing.hookDuration)
        ?? _toFiniteNumber(profile?.hook?.duration)
        ?? _toFiniteNumber(session?.projectAnalysis?.hookEnd);
    const ctaDuration = _toFiniteNumber(rawPacing.ctaDuration)
        ?? _toFiniteNumber(profile?.cta?.duration);
    normalized.pacing = {
        ...rawPacing,
        ...(cutsPerMinute != null && { cutsPerMinute: +cutsPerMinute.toFixed(1) }),
        ...(avgSceneDuration != null && { avgSceneDuration: +avgSceneDuration.toFixed(1) }),
        rhythm: rawPacing.rhythm
            || (cutsPerMinute != null ? (cutsPerMinute >= 14 ? 'fast' : cutsPerMinute >= 8 ? 'moderate' : 'slow') : undefined),
        ...(hookDuration != null && { hookDuration: +hookDuration.toFixed(1) }),
        ...(ctaDuration != null && { ctaDuration: +ctaDuration.toFixed(1) }),
        sections: (rawPacing.sections && typeof rawPacing.sections === 'object' && !Array.isArray(rawPacing.sections))
            ? rawPacing.sections
            : _buildPacingSections(segments, videoDuration),
        segments,
    };
    delete normalized.pacing.pacingSegments;

    const colorPalette = (profile.colorPalette && typeof profile.colorPalette === 'object' && !Array.isArray(profile.colorPalette))
        ? { ...profile.colorPalette }
        : {};
    if (!colorPalette.mood) colorPalette.mood = _inferPaletteMood(colorPalette);
    normalized.colorPalette = colorPalette;

    const rawMG = profile.motionGraphics;
    if (Array.isArray(rawMG)) {
        let MG_REGISTRY = {};
        try { MG_REGISTRY = require('./mg-registry').MG_REGISTRY || {}; } catch (_) {}
        const supportedMgTypes = new Set(Object.keys(MG_REGISTRY));
        const preferredTypes = _dedupeStrings(rawMG.map(entry => entry?.type).filter(type => supportedMgTypes.size === 0 || supportedMgTypes.has(type)));
        const weightedFrequency = rawMG.reduce((sum, entry) => sum + (_toFiniteNumber(entry?.prominence) ?? 0.5), 0) * 1.8;
        const density = weightedFrequency >= 5 ? 'high' : weightedFrequency >= 3 ? 'medium' : weightedFrequency > 0 ? 'low' : 'none';
        normalized.motionGraphics = {
            density,
            preferredTypes,
            avoidTypes: [],
            ...(weightedFrequency > 0 && { frequencyPerMinute: +weightedFrequency.toFixed(1) }),
            placementTiming: 'regular',
            textAnimationSpeed: preferredTypes.includes('kineticText') ? 'fast' : 'moderate',
            avgDurationOnScreen: 2.5,
            placementPattern: 'after-statement',
        };
    } else if (rawMG && typeof rawMG === 'object') {
        normalized.motionGraphics = {
            ...rawMG,
            preferredTypes: _dedupeStrings(rawMG.preferredTypes),
            avoidTypes: _dedupeStrings(rawMG.avoidTypes),
            ...(rawMG.frequencyPerMinute != null && { frequencyPerMinute: +_toFiniteNumber(rawMG.frequencyPerMinute).toFixed(1) }),
        };
    }

    const rawTransitions = profile.transitions;
    if (Array.isArray(rawTransitions)) {
        const totalWeight = rawTransitions.reduce((sum, entry) => sum + (_toFiniteNumber(entry?.prominence) ?? 1), 0) || 1;
        const classifyWeight = (matcher) => rawTransitions
            .filter(entry => matcher(String(entry?.type || '').toLowerCase()))
            .reduce((sum, entry) => sum + (_toFiniteNumber(entry?.prominence) ?? 1), 0);
        const cutWeight = classifyWeight(type => type === 'cut' || type === 'none');
        const crossWeight = classifyWeight(type => ['crossfade', 'crossblur', 'dissolve', 'fade', 'dreamfade'].includes(type));
        const durationHints = rawTransitions
            .map(entry => String(entry?.notes || '').match(/~?\s*(\d+(?:\.\d+)?)\s*s/i))
            .filter(Boolean)
            .map(match => parseFloat(match[1]));
        normalized.transitions = {
            cutRatio: +Math.max(0, Math.min(1, cutWeight / totalWeight)).toFixed(2),
            crossfadeRatio: +Math.max(0, Math.min(1, crossWeight / totalWeight)).toFixed(2),
            otherRatio: +Math.max(0, Math.min(1, 1 - (cutWeight / totalWeight) - (crossWeight / totalWeight))).toFixed(2),
            preferredTypes: _dedupeStrings(rawTransitions.map(entry => entry?.type)),
            ...(durationHints.length > 0 && { avgTransitionDuration: +_avg(durationHints).toFixed(2) }),
        };
    }

    const rawEffects = profile.effects;
    if (Array.isArray(rawEffects)) {
        const coverage = _avg(rawEffects.map(entry => entry?.prominence));
        normalized.effects = {
            closestPreset: _guessClosestPreset(rawEffects, normalized.colorPalette),
            colorTemperature: _inferColorTemperature(normalized.colorPalette),
            contrastLevel: rawEffects.some(entry => ['vignette', 'scratch', 'oldFilm'].includes(String(entry?.type || ''))) ? 'high' : 'normal',
            ...(coverage != null && { effectCoverage: +Math.max(0, Math.min(1, coverage)).toFixed(2) }),
        };
    }

    const rawAudio = (profile.audio && typeof profile.audio === 'object' && !Array.isArray(profile.audio))
        ? profile.audio
        : null;
    const rawMusic = (!rawAudio && profile.music && typeof profile.music === 'object' && !Array.isArray(profile.music))
        ? profile.music
        : null;
    if (rawAudio) {
        normalized.audio = {
            ...rawAudio,
            sfxTypes: _dedupeStrings(rawAudio.sfxTypes),
        };
    } else if (rawMusic) {
        const soundtrack = Array.isArray(rawMusic.soundtrack) ? rawMusic.soundtrack : [];
        normalized.audio = {
            musicStyle: _mapMusicStyle(rawMusic.style),
            musicEnergy: _mapMusicEnergy(rawMusic.energy),
            voiceToMusicRatio: 'voice-dominant',
            sfxTypes: [],
            sfxDensity: 'none',
            musicChanges: soundtrack.length >= 3 ? 'different-per-section' : soundtrack.length >= 2 ? 'shifts-for-emphasis' : 'same-throughout',
        };
    }
    delete normalized.music;
    delete normalized.pacingSegments;

    if (!normalized.typography && normalized.motionGraphics?.preferredTypes?.length) {
        normalized.typography = {
            sizeStyle: normalized.motionGraphics.density === 'high' ? 'large-bold' : 'medium',
            animationType: normalized.motionGraphics.preferredTypes.includes('kineticText') ? 'typewriter' : 'slide',
            fontFeel: normalized.motionGraphics.preferredTypes.includes('headline') ? 'bold-impact' : 'modern-sans',
        };
    }

    if (!normalized.hook) {
        normalized.hook = {
            style: 'cold-open',
            ...(hookDuration != null && { duration: +hookDuration.toFixed(1) }),
            usesMG: !!(normalized.motionGraphics?.preferredTypes?.length),
        };
    }

    if (!normalized.cta) {
        normalized.cta = {
            style: ctaDuration != null ? 'call-to-action' : 'none',
            ...(ctaDuration != null && { duration: +ctaDuration.toFixed(1) }),
        };
    }

    normalized.systemNotes = _normalizeSystemNotes(profile.systemNotes);
    if (!normalized.summary && session?.videos?.length) {
        normalized.summary = `Style profile extracted from ${session.videos.length > 1 ? `${session.videos.length} reference videos` : `"${session.videos[0].title}"`}.`;
    }

    return normalized;
}

// ============ PHASE 1: SCRIPT ANALYSIS + TOPIC RESEARCH ============

// Build the prompt that asks the Director to read the Whisper transcript,
// research the topic, and emit a structured JSON brief that is persisted to
// session.projectAnalysis and injected into every subsequent turn.
function _buildScriptAnalysisPrompt(transcription, projectCtx, nicheIds) {
    const duration = transcription.duration || 0;
    const lang = transcription.language || 'unknown';
    const segments = transcription.segments || [];

    // Build a timestamped, chunked transcript so the agent can cite moments.
    const lines = [];
    for (const seg of segments) {
        const segStart = seg.start || 0;
        const words = seg.words || [];
        if (words.length === 0 && seg.text) {
            lines.push(`[${segStart.toFixed(1)}s] ${seg.text.trim()}`);
        } else if (words.length > 0) {
            let chunkStart = words[0].start || segStart;
            let chunkWords = [];
            for (const w of words) {
                chunkWords.push(w.word);
                if (/[.!?]$/.test(w.word) || chunkWords.length >= 14) {
                    lines.push(`[${chunkStart.toFixed(1)}s] ${chunkWords.join(' ').trim()}`);
                    chunkWords = [];
                    chunkStart = w.end || (w.start + 0.3);
                }
            }
            if (chunkWords.length > 0) {
                lines.push(`[${chunkStart.toFixed(1)}s] ${chunkWords.join(' ').trim()}`);
            }
        }
    }
    const MAX_CHARS = 60000;
    let body = lines.join('\n');
    if (body.length > MAX_CHARS) body = body.substring(0, MAX_CHARS) + '\n... [truncated]';

    const titleLine = projectCtx.videoTitle ? `- Working title: "${projectCtx.videoTitle}"` : '';
    const instrLine = projectCtx.aiInstructions ? `- User AI instructions: "${projectCtx.aiInstructions}"` : '';
    const nicheLine = (projectCtx.buildNiche && projectCtx.buildNiche !== 'auto')
        ? `- Pre-selected niche: ${projectCtx.buildNiche} (confirm or recommend a change)`
        : '- Niche: AUTO — you must pick from the list below';
    const nicheList = (nicheIds || []).join(', ');

    return `PHASE 1 — PROJECT ANALYSIS (run once on session start)

You already have the REFERENCE VIDEO loaded in this session.
Now I am giving you the USER'S PROJECT — the narration (Whisper transcript) that a faceless video will be built around.

PROJECT METADATA:
${titleLine || '- Working title: (none yet)'}
${instrLine}
${nicheLine}
- Audio duration: ${Math.round(duration)}s
- Detected language: ${lang}
- Whisper segments: ${segments.length}

TIMESTAMPED TRANSCRIPT:
"""
${body}
"""

TASK:
1) Read the FULL transcript carefully.
2) Use googleSearch to VERIFY key factual claims (people, places, events, dates, stats) and to build topic context. Only search when needed — not every sentence.
3) Detect the content format (documentary / listicle / news / tutorial / storytelling / other) and cite evidence from the transcript.
4) Mark the HOOK boundary (the timestamp where the opening hook ends and the main body starts) and the CTA start (if any).
5) Extract key entities with types (person, place, org, event, product, stat).
6) Pick the NICHE from this exact list — no invention:
   ${nicheList}
7) Flag any transcript ERRORS you notice — misheard words, wrong names, broken sentences, obvious ASR mistakes. Give the timestamp and the fix.
8) Note tone, pacing, and any pacing shifts.

OUTPUT FORMAT — emit ONE fenced JSON block, nothing else outside the fence:

\`\`\`json
{
  "summary": "2-3 sentence plain-English summary of what this video is about",
  "topic": "the central subject (e.g., 'Okinawa US military bases', 'Mars colonization')",
  "format": "documentary|listicle|news|tutorial|storytelling|other",
  "formatEvidence": "short quote or timestamp that proves the format call",
  "tone": "serious|urgent|casual|dramatic|educational|...",
  "pacing": "slow|moderate|fast|variable",
  "pacingNotes": "one line on how pacing moves across the script",
  "hookEnd": 12.5,
  "ctaStart": null,
  "niche": "<one id from the list above>",
  "nicheReason": "why this niche — 1 sentence",
  "entities": [
    { "name": "Okinawa", "type": "place", "firstMentionAt": 3.2 },
    { "name": "USS Blue Ridge", "type": "product", "firstMentionAt": 41.0 }
  ],
  "keyTopics": ["subtopic 1", "subtopic 2", "subtopic 3"],
  "factChecks": [
    { "claim": "...", "at": 22.0, "verdict": "verified|disputed|unverified", "note": "what the web says" }
  ],
  "transcriptErrors": [
    { "at": 8.4, "heard": "kayback launch", "shouldBe": "cutback launch", "confidence": "high|medium|low" }
  ],
  "notes": "anything important the pipeline should know (incidents, sensitive content, language shifts, etc.)"
}
\`\`\`

Keep it tight — this JSON will be attached to every subsequent turn so you can reason about the project without rereading the transcript. Do NOT emit anything outside the JSON fence.`;
}

// Run Phase 1 script analysis for a session. Reads Whisper transcript, calls
// Gemini with googleSearch grounding, parses JSON, stores on session.projectAnalysis,
// and persists. Returns { ok, analysis?, error? } — never throws.
async function _runScriptAnalysis(session) {
    try {
        const projectDir = process.env.PROJECT_DIR || process.cwd();
        const transcriptPath = path.join(projectDir, 'temp', 'transcription.json');
        if (!fs.existsSync(transcriptPath)) {
            return { ok: false, error: 'no transcript' };
        }
        const transcription = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
        if (!transcription.segments || transcription.segments.length === 0) {
            return { ok: false, error: 'transcript has no segments' };
        }

        const projectCtx = _loadProjectContext();

        let nicheIds = [];
        try { nicheIds = require('./niches').getNicheIds(); } catch (_) {}

        const prompt = _buildScriptAnalysisPrompt(transcription, projectCtx, nicheIds);
        _log(`Phase 1: running script analysis (${Math.round(transcription.duration || 0)}s transcript, ${transcription.segments.length} segments)`);

        const reply = await _callGemini(session, prompt, {
            maxOutputTokens: 4096,
            temperature: 0.25,
            requestLabel: 'phase1-script-analysis',
        });

        const match = reply.match(/```json\s*([\s\S]*?)```/) || reply.match(/\{[\s\S]*\}/);
        if (!match) {
            _log(`Phase 1: no JSON in reply (${reply.length} chars) — keeping raw text`);
            session.projectAnalysis = {
                createdAt: Date.now(),
                raw: reply,
                parseError: 'no JSON fence found',
                transcriptDuration: transcription.duration || 0,
                transcriptLang: transcription.language || 'unknown',
            };
            _saveSessionToDisk(session);
            return { ok: false, error: 'parse failed', raw: reply };
        }

        let parsed;
        try {
            parsed = JSON.parse(match[1] || match[0]);
        } catch (e) {
            _log(`Phase 1: JSON parse error: ${e.message}`);
            session.projectAnalysis = {
                createdAt: Date.now(),
                raw: reply,
                parseError: e.message,
                transcriptDuration: transcription.duration || 0,
                transcriptLang: transcription.language || 'unknown',
            };
            _saveSessionToDisk(session);
            return { ok: false, error: `parse failed: ${e.message}`, raw: reply };
        }

        session.projectAnalysis = {
            ...parsed,
            createdAt: Date.now(),
            transcriptDuration: transcription.duration || 0,
            transcriptLang: transcription.language || 'unknown',
        };

        // Record as a turn so the agent can refer back conversationally
        session.history.push({ role: 'user', parts: [{ text: '[PHASE 1: analyze the transcript — see full prompt attached]' }] });
        session.history.push({ role: 'model', parts: [{ text: reply }] });

        _saveSessionToDisk(session);
        _log(`Phase 1: analysis stored — niche=${parsed.niche || '?'} format=${parsed.format || '?'} entities=${(parsed.entities || []).length}`);
        return { ok: true, analysis: session.projectAnalysis };
    } catch (e) {
        _log(`Phase 1: failed — ${e.message}`);
        return { ok: false, error: e.message };
    }
}

// Public: re-run script analysis on demand for an existing session.
async function analyzeScript(sessionId) {
    const session = _getSession(sessionId);
    return _runScriptAnalysis(session);
}

// ============ UTILITY: BUILD VIDEO PARTS FOR FIRST USER MESSAGE ============

// Gemini bills roughly ~263 tokens per sampled frame + ~32 tokens/sec of audio.
const TOKENS_PER_FRAME = 263;
const TOKENS_PER_AUDIO_SEC = 32;
// Gemini Pro hard limit. We budget below this and reserve room for output + system.
const GEMINI_HARD_LIMIT = 1048576;
const SYSTEM_OVERHEAD_TOKENS = 30000; // system prompt + memory + output reserve
const OUTPUT_RESERVE = 8192;
const MIN_VIDEO_BUDGET = 80000; // never starve the video below this

function _estimateVideoTokens(session, fps) {
    let total = 0;
    for (const v of session.videos) {
        const dur = Math.max(0, v.duration || 0);
        total += dur * fps * TOKENS_PER_FRAME;
        total += dur * TOKENS_PER_AUDIO_SEC;
    }
    return total;
}

function _estimateHistoryTokens(history) {
    let t = 0;
    for (const h of history || []) {
        for (const p of h.parts || []) {
            if (p.text) t += Math.ceil(p.text.length / 4); // ~4 chars/token
        }
    }
    return t;
}

function _estimateTextTokens(text) {
    return Math.ceil(String(text || '').length / 4);
}

function _formatApproxTokens(n) {
    const num = Number(n || 0);
    if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
    if (num >= 1000) return `${Math.round(num / 100) / 10}k`;
    return `${Math.round(num)}`;
}

function _formatChunkRanges(chunks, maxRanges = 4) {
    const list = Array.isArray(chunks) ? chunks : [];
    if (list.length === 0) return 'none';
    const ranges = list.slice(0, maxRanges).map(c => `${_formatTranscriptStamp(c.start)}-${_formatTranscriptStamp(c.end)}`);
    if (list.length > maxRanges) ranges.push(`+${list.length - maxRanges} more`);
    return ranges.join(', ');
}

function _summarizeUsageMetadata(usage) {
    if (!usage || typeof usage !== 'object') return '';
    const parts = [];
    const numericFields = [
        ['promptTokenCount', 'prompt'],
        ['cachedContentTokenCount', 'cached'],
        ['candidatesTokenCount', 'output'],
        ['totalTokenCount', 'total'],
        ['thoughtsTokenCount', 'thoughts'],
        ['toolUsePromptTokenCount', 'toolPrompt'],
    ];
    for (const [field, label] of numericFields) {
        if (typeof usage[field] === 'number') {
            parts.push(`${label}=${_formatApproxTokens(usage[field])}`);
        }
    }
    if (typeof usage.trafficType === 'string' && usage.trafficType) {
        parts.push(`traffic=${usage.trafficType}`);
    }
    return parts.join(', ');
}

function _accumulateSessionUsage(session, usage) {
    if (!session || !usage || typeof usage !== 'object') return;
    if (!session.usageTotals) {
        session.usageTotals = { prompt: 0, cached: 0, output: 0, thoughts: 0, total: 0, calls: 0 };
    }
    const t = session.usageTotals;
    t.calls += 1;
    if (typeof usage.promptTokenCount === 'number')       t.prompt   += usage.promptTokenCount;
    if (typeof usage.cachedContentTokenCount === 'number') t.cached   += usage.cachedContentTokenCount;
    if (typeof usage.candidatesTokenCount === 'number')    t.output   += usage.candidatesTokenCount;
    if (typeof usage.thoughtsTokenCount === 'number')      t.thoughts += usage.thoughtsTokenCount;
    if (typeof usage.totalTokenCount === 'number')         t.total    += usage.totalTokenCount;
}

function _formatSessionTotals(session) {
    const t = session?.usageTotals;
    if (!t || !t.calls) return '';
    const parts = [`calls=${t.calls}`];
    if (t.prompt)   parts.push(`prompt=${_formatApproxTokens(t.prompt)}`);
    if (t.cached)   parts.push(`cached=${_formatApproxTokens(t.cached)}`);
    if (t.output)   parts.push(`output=${_formatApproxTokens(t.output)}`);
    if (t.thoughts) parts.push(`thoughts=${_formatApproxTokens(t.thoughts)}`);
    if (t.total)    parts.push(`total=${_formatApproxTokens(t.total)}`);
    return parts.join(', ');
}

function _effectiveFps(session) {
    const requested = session.fps || 1;

    // If there's already a valid video cache, its fps is pinned — keep using
    // whatever the cache was built with. Recomputing here would tell the
    // budget math a different number and thrash the cache match check.
    // Cached tokens also don't count against the live context window (they're
    // replayed server-side), so history growth should trigger compaction,
    // not an fps downshift.
    if (session.videoCacheName && session.videoCacheFps) {
        return session.videoCacheFps;
    }

    const historyTokens = _estimateHistoryTokens(session.history);
    const videoBudget = Math.max(
        MIN_VIDEO_BUDGET,
        GEMINI_HARD_LIMIT - SYSTEM_OVERHEAD_TOKENS - OUTPUT_RESERVE - historyTokens
    );

    const tokensAt = _estimateVideoTokens(session, requested);
    if (tokensAt <= videoBudget) return requested;

    let audioTokens = 0;
    let frameTokensPerFps = 0;
    for (const v of session.videos) {
        const dur = Math.max(0, v.duration || 0);
        audioTokens += dur * TOKENS_PER_AUDIO_SEC;
        frameTokensPerFps += dur * TOKENS_PER_FRAME;
    }
    if (frameTokensPerFps <= 0) return 1;
    const fitsFps = Math.floor((videoBudget - audioTokens) / frameTokensPerFps * 10) / 10;
    return Math.max(0.1, Math.min(requested, fitsFps));
}

// Soft threshold — if history tokens exceed this, try compaction even before we
// hit the hard limit. Keeps headroom for the next reply + future turns.
const COMPACT_HISTORY_THRESHOLD = 300000;
const COMPACT_KEEP_RECENT = 6; // 3 user/model pairs of recent context

// Parse Retry-After or google.rpc.RetryInfo from a 429 response. Clamped [5s, 60s].
function _parseRetryDelay(err) {
    if (err?.response?.status !== 429) return 30000;
    const retryAfter = err.response.headers?.['retry-after'];
    if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (sec > 0) return Math.min(Math.max(sec, 5), 60) * 1000;
    }
    const details = err.response.data?.error?.details || [];
    for (const d of details) {
        const delay = d?.retryDelay || d?.retry_delay;
        if (typeof delay === 'string') {
            const m = delay.match(/^(\d+)s$/);
            if (m) return Math.min(Math.max(parseInt(m[1], 10), 5), 60) * 1000;
        }
    }
    return 30000;
}

// Low-level Gemini call WITHOUT session history — used for compaction so we
// don't recurse through _callGemini (which would try to compact again).
// Rotates Vertex regions on 429/503 just like ai-provider.js, and rotates keys
// on the direct generativelanguage path.
async function _callGeminiRaw(prompt, opts = {}) {
    const useVertex = vertex.isVertexEnabled();
    const model = opts.model || _getReasoningModel();
    const body = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
            maxOutputTokens: opts.maxOutputTokens || 2000,
            temperature: opts.temperature ?? 0.3,
        },
    };

    const regionCount = useVertex ? (vertex.getRegionCount?.() || 1) : 1;
    const keys = useVertex ? null : _getKeys();
    const maxAttempts = useVertex ? regionCount + 1 : (keys?.length || 1) + 1;
    let backoffUsed = false;
    let lastRegion = null;
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let url, headers;
        try {
            if (useVertex) {
                const auth = await vertex.getVertexAuth(model);
                url = auth.url; headers = auth.headers;
                lastRegion = auth.region;
            } else {
                const next = _getNextKey();
                if (!next) throw new Error('No Gemini keys available');
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${next.key}`;
                headers = { 'Content-Type': 'application/json' };
            }
            const resp = await axios.post(url, body, { headers, timeout: 120000 });
            const rawUsage = _summarizeUsageMetadata(resp.data?.usageMetadata);
            if (rawUsage) _log(`Raw usage: ${rawUsage}`);
            return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } catch (err) {
            lastErr = err;
            const status = err.response?.status;
            const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
            if (useVertex && (status === 429 || status === 503 || isTimeout) && lastRegion) {
                const retryMs = status === 429 ? _parseRetryDelay(err) : undefined;
                if (vertex.markRegionThrottled(lastRegion, retryMs)) {
                    _log(`Raw: region ${lastRegion} throttled (${status || 'timeout'}) — rotating`);
                    continue;
                }
            }
            if (status === 429 && !backoffUsed) {
                const waitMs = _parseRetryDelay(err);
                _log(`Raw: 429 all regions throttled — backing off ${Math.round(waitMs/1000)}s`);
                await new Promise(r => setTimeout(r, waitMs));
                backoffUsed = true;
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('Gemini raw call exhausted retries');
}

// Summarize the middle of the session's chat history into a compact digest and
// replace those turns with a single synthetic model turn. Keeps the first 2
// turns (hold the video file_data) and the last COMPACT_KEEP_RECENT turns for
// immediate context continuity.
//
// Returns the number of turns collapsed (0 = nothing to compact).
async function _compactMiddleHistory(session) {
    const history = session.history;
    if (!history || history.length < 2 + COMPACT_KEEP_RECENT + 2) return 0;

    const head = history.slice(0, 2);
    const middle = history.slice(2, history.length - COMPACT_KEEP_RECENT);
    const tail = history.slice(history.length - COMPACT_KEEP_RECENT);
    if (middle.length === 0) return 0;

    // Serialize middle turns, then chunk if needed so a single summarization call
    // can't overflow Gemini's context. ~600k chars ≈ 150k tokens per chunk.
    const CHUNK_CHAR_LIMIT = 600000;
    const turnStrings = middle.map(h => {
        const text = (h.parts || []).filter(p => p.text).map(p => p.text).join('\n');
        const who = h.role === 'user' ? 'USER' : 'AGENT';
        return `${who}: ${text}`;
    });

    const chunks = [];
    let buf = [];
    let bufLen = 0;
    for (const s of turnStrings) {
        if (bufLen + s.length > CHUNK_CHAR_LIMIT && buf.length > 0) {
            chunks.push(buf.join('\n\n'));
            buf = [];
            bufLen = 0;
        }
        buf.push(s);
        bufLen += s.length + 2;
    }
    if (buf.length > 0) chunks.push(buf.join('\n\n'));

    const summarizePrompt = (transcript, isChunk, chunkIdx, chunkTotal) => {
        const header = isChunk
            ? `You are compacting PART ${chunkIdx + 1} OF ${chunkTotal} of a long conversation. Your digest will be combined with digests of other parts later. Preserve concrete details — don't over-summarize.`
            : `You are compacting a long conversation between a video-analysis agent and a user so the agent can keep working within a token budget.`;
        return `${header}

Produce a dense digest that preserves:
- Decisions made (scene splits, style choices, MG picks, recipe changes, etc.)
- Facts the user shared about their project (title, niche, theme, constraints)
- Preferences the user expressed (what they liked/disliked, corrections)
- Pending questions or unresolved threads
- Any numbers, waypoints, timings, or IDs

Drop small talk and repeated acknowledgments. Write as a factual brief, not a transcript. Aim for ~${isChunk ? '300-500' : '400-800'} words.

CONVERSATION${isChunk ? ' (partial)' : ''}:
${transcript}

Output the digest only:`;
    };

    let digest;
    try {
        if (chunks.length === 1) {
            digest = await _callGeminiRaw(summarizePrompt(chunks[0], false), { maxOutputTokens: 2000 });
        } else {
            _log(`Compacting ${middle.length} turns in ${chunks.length} chunks`);
            const partials = [];
            for (let i = 0; i < chunks.length; i++) {
                const part = await _callGeminiRaw(summarizePrompt(chunks[i], true, i, chunks.length), { maxOutputTokens: 1500 });
                if (part && part.trim().length >= 50) partials.push(`[Part ${i + 1}]\n${part.trim()}`);
            }
            if (partials.length === 0) throw new Error('All chunk summaries empty');
            // Merge the partial digests into one final digest
            const mergePrompt = `Merge these partial digests of one long conversation into a single coherent session digest. Remove duplication, preserve all concrete decisions, facts, and preferences. ~500-900 words.

PARTIAL DIGESTS:
${partials.join('\n\n---\n\n')}

Output the merged digest only:`;
            digest = await _callGeminiRaw(mergePrompt, { maxOutputTokens: 2500 });
        }
    } catch (e) {
        _log(`Compaction failed (${e.message}) — falling back to trim`);
        return 0;
    }
    if (!digest || digest.trim().length < 50) {
        _log('Compaction returned empty/short digest — falling back to trim');
        return 0;
    }

    const digestTurn = {
        role: 'model',
        parts: [{ text: `[SESSION DIGEST — earlier conversation compacted]\n\n${digest.trim()}` }],
    };
    session.history = [...head, digestTurn, ...tail];
    _log(`Compacted ${middle.length} middle turn(s) into digest (${digest.length} chars)`);
    return middle.length;
}

// Try compaction first (preserves context via summary), fall back to hard trim
// if compaction fails or history is already small enough to just drop.
// Returns the number of turns removed/replaced.
async function _trimOrCompactHistory(session) {
    const fps = _effectiveFps(session);
    const videoTokens = _estimateVideoTokens(session, fps);
    const historyTokens = _estimateHistoryTokens(session.history);
    const total = videoTokens + historyTokens + SYSTEM_OVERHEAD_TOKENS + OUTPUT_RESERVE;

    // Soft trigger: try compaction if history alone is large, even if we'd still fit.
    // This keeps future turns from piling up.
    const shouldCompact = historyTokens > COMPACT_HISTORY_THRESHOLD || total > GEMINI_HARD_LIMIT;
    if (!shouldCompact) return 0;

    // Try compaction first (AI summary of middle turns).
    const compacted = await _compactMiddleHistory(session);
    if (compacted > 0) {
        _saveSessionToDisk(session);
        return compacted;
    }

    // Hard fallback: if we're over the hard limit and compaction failed, drop middle.
    const overLimit = (_estimateVideoTokens(session, _effectiveFps(session))
        + _estimateHistoryTokens(session.history)
        + SYSTEM_OVERHEAD_TOKENS + OUTPUT_RESERVE) > GEMINI_HARD_LIMIT;
    if (!overLimit) return 0;

    const history = session.history;
    if (history.length <= 6) return 0;
    const head = history.slice(0, 2);
    const middle = history.slice(2, history.length - COMPACT_KEEP_RECENT);
    const tail = history.slice(history.length - COMPACT_KEEP_RECENT);
    if (middle.length === 0) return 0;
    session.history = [...head, ...tail];
    _log(`Compaction unavailable — dropped ${middle.length} middle turn(s) to fit hard limit`);
    _saveSessionToDisk(session);
    return middle.length;
}

function _buildVideoParts(session) {
    const fps = _effectiveFps(session);
    if (fps !== (session.fps || 1)) {
        _log(`Auto-downshifted fps from ${session.fps} to ${fps} (history=${Math.round(_estimateHistoryTokens(session.history)/1000)}k tokens)`);
    }
    return session.videos.map(v => {
        const part = {
            file_data: { mime_type: v.mimeType, file_uri: v.fileUri },
        };
        if (fps !== 1) {
            part.videoMetadata = { fps };
        }
        return part;
    });
}

// ============ THINKING CONFIG ============

/**
 * Build the thinkingConfig for generationConfig.
 * Gemini 3.1 models use thinkingLevel (minimal/low/medium/high).
 * Gemini 2.5 models use thinkingBudget (integer tokens).
 */
function _buildThinkingConfig(session) {
    if (!session.thinkingMode || session.thinkingMode === 'off') {
        return null;
    }
    const model = _getReasoningModel();
    // Gemini 3.x → thinkingLevel, Gemini 2.x → thinkingBudget
    if (/gemini-3/i.test(model)) {
        return { thinkingLevel: session.thinkingMode }; // 'high', 'medium', 'low', 'minimal'
    }
    // Fallback for 2.5 models: map level name to token budget
    const budgetMap = { high: 16384, medium: 8192, low: 4096, minimal: 1024 };
    return { thinkingBudget: budgetMap[session.thinkingMode] || -1 };
}

// ============ VERTEX CONTEXT CACHE ============
//
// On Vertex we store the reference video(s) in a `cachedContents` resource and
// reference it by name on every generateContent call. Without the cache, each
// turn re-bills the video as input tokens (15-min clip ≈ 270k tokens). With
// the cache, we pay video tokens once (cache create) plus ~25% per reuse.
//
// The cache is bound to (model, region, fps). If any of those change we
// invalidate and rebuild. Cache creation below a minimum token count is
// rejected by Vertex; we catch that and fall back to per-turn file_data.

const CACHE_TTL_SECONDS = 3600;      // 1h cache TTL (refreshed when < 5min left)
const CACHE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

function _makeCacheConfigSignature(cacheConfig = {}) {
    const hash = crypto.createHash('sha1');
    const systemInstruction = cacheConfig.systemInstruction?.parts
        ? cacheConfig.systemInstruction.parts.map(p => p?.text || '').join('\n')
        : '';
    hash.update(systemInstruction);
    hash.update('\n--tools--\n');
    hash.update(JSON.stringify(cacheConfig.tools || []));
    return hash.digest('hex');
}

function _cacheMatchesSession(session, model, cacheSignature) {
    if (!session.videoCacheName) return false;
    if (session.videoCacheModel !== model) return false;
    if ((session.videoCacheSignature || null) !== (cacheSignature || null)) return false;
    // Once created, the cache is pinned. We only invalidate on model change or
    // video-count change — NOT on fps drift. _effectiveFps can shift by 0.1
    // every turn as history grows; a strict equality check would throw away
    // the cache (and re-bill ~650k video tokens) whenever that happens.
    // The cache already contains frames at session.videoCacheFps; reusing it
    // is free regardless of what the "optimal" fps would be for a new cache.
    if (session.videoCacheVideoCount !== session.videos.length) return false;
    return true;
}

function _describeCacheMismatch(session, model, cacheSignature) {
    const reasons = [];
    if (!session.videoCacheName) reasons.push('no-cache');
    if (session.videoCacheModel !== model) reasons.push(`model ${session.videoCacheModel || '?'} -> ${model}`);
    if (session.videoCacheVideoCount !== session.videos.length) {
        reasons.push(`videoCount ${session.videoCacheVideoCount || 0} -> ${session.videos.length}`);
    }
    if ((session.videoCacheSignature || null) !== (cacheSignature || null)) reasons.push('config-signature changed');
    if (session.videoCacheExpireAt && session.videoCacheExpireAt <= Date.now()) reasons.push('expired');
    return reasons.join(', ') || 'stale';
}

// Cooldown after a failed cache create so we don't burn 10 min on every turn
// if creation persistently fails (DNS blip, quota issue, transient Vertex
// hiccup). On success or permanent failure this is cleared / replaced.
const CACHE_CREATE_COOLDOWN_MS = 10 * 60 * 1000;

async function _ensureVideoCache(session, model, cacheConfig = {}) {
    if (!vertex.isVertexEnabled()) return null;
    if (!session.videos || session.videos.length === 0) return null;
    if (session.videoCacheDisabled) return null;

    const now = Date.now();
    const cacheSignature = _makeCacheConfigSignature(cacheConfig);

    // Recent create failure — skip this turn, use per-turn file_data instead
    if (session.videoCacheNextAttempt && session.videoCacheNextAttempt > now) {
        return null;
    }

    // Reuse: cache matches and has > 5min left
    if (_cacheMatchesSession(session, model, cacheSignature) && session.videoCacheExpireAt > now + CACHE_REFRESH_WINDOW_MS) {
        const minsLeft = Math.max(1, Math.round((session.videoCacheExpireAt - now) / 60000));
        _log(`Using video cache (${_formatApproxTokens(session.videoCacheTokens)} tokens cached, ${minsLeft}m left, region=${session.videoCacheRegion || '?'})`);
        return session.videoCacheName;
    }

    // Refresh: cache matches but is near expiry
    if (_cacheMatchesSession(session, model, cacheSignature) && session.videoCacheExpireAt > now) {
        try {
            const r = await vertex.refreshCache(session.videoCacheName, CACHE_TTL_SECONDS);
            session.videoCacheExpireAt = r.expireTime ? Date.parse(r.expireTime) : (now + CACHE_TTL_SECONDS * 1000);
            _log(`Refreshed video cache (expires ${new Date(session.videoCacheExpireAt).toISOString()})`);
            return session.videoCacheName;
        } catch (e) {
            _log(`Cache refresh failed: ${e.message} — recreating`);
            session.videoCacheName = null;
        }
    }

    // Drop stale cache (model/config/video-count changed or expired)
    if (session.videoCacheName) {
        const oldName = session.videoCacheName;
        _log(`Rebuilding video cache: ${_describeCacheMismatch(session, model, cacheSignature)}`);
        session.videoCacheName = null;
        vertex.deleteCache(oldName).catch(() => {});
    }

    // Create new cache
    try {
        const videoParts = _buildVideoParts(session);
        if (videoParts.length === 0) return null;
        const fps = _effectiveFps(session);
        const r = await vertex.createCache({
            model,
            contents: [{ role: 'user', parts: videoParts }],
            systemInstruction: cacheConfig.systemInstruction,
            tools: cacheConfig.tools,
            ttlSeconds: CACHE_TTL_SECONDS,
        });
        session.videoCacheName = r.name;
        session.videoCacheModel = model;
        session.videoCacheFps = fps;
        session.videoCacheVideoCount = session.videos.length;
        session.videoCacheExpireAt = r.expireTime ? Date.parse(r.expireTime) : (Date.now() + CACHE_TTL_SECONDS * 1000);
        session.videoCacheTokens = r.tokenCount;
        session.videoCacheRegion = r.region || null;
        session.videoCacheSignature = cacheSignature;
        session.videoCacheNextAttempt = 0;
        _log(`Created video cache (${r.tokenCount} tokens, 1h TTL, region=${r.region || '?'}): ${r.name.split('/').pop()}`);
        return r.name;
    } catch (e) {
        const msg = e.response?.data?.error?.message || e.message || 'unknown';
        // Minimum-token errors (cache too small) — don't retry this session.
        const permanent = /minimum|too small|INVALID_ARGUMENT|not enough/i.test(msg);
        if (permanent) {
            session.videoCacheDisabled = true;
            _log(`Video cache create failed: ${msg} — disabled for this session`);
        } else {
            // Transient (timeout, DNS, 5xx) — back off so next turn doesn't
            // waste 10 min trying again. User can still chat with per-turn
            // file_data until the cooldown expires.
            session.videoCacheNextAttempt = Date.now() + CACHE_CREATE_COOLDOWN_MS;
            _log(`Video cache create failed: ${msg} — cooldown ${CACHE_CREATE_COOLDOWN_MS / 60000}min before retry`);
        }
        return null;
    }
}

async function _invalidateVideoCache(session, reason) {
    if (!session.videoCacheName) return;
    const old = session.videoCacheName;
    session.videoCacheName = null;
    session.videoCacheExpireAt = 0;
    session.videoCacheSignature = null;
    _log(`Invalidated video cache (${reason}): ${old.split('/').pop()}`);
    vertex.deleteCache(old).catch(() => {});
}

function _rebuildBodyWithoutCache(body, session, userMessage) {
    body.contents = [];
    if (session.history.length === 0) {
        body.contents.push({
            role: 'user',
            parts: [..._buildVideoParts(session), { text: userMessage }],
        });
        return;
    }
    for (const h of session.history) body.contents.push(h);
    body.contents.push({ role: 'user', parts: [{ text: userMessage }] });
}

// ============ GEMINI MULTI-TURN CALL ============

/**
 * Send a message in a session. Builds the full conversation: system instruction +
 * first user turn (with all videos attached as file_data) + history + new message.
 *
 * Gemini caches uploaded files server-side, so re-passing the same fileUri across
 * turns is free — no re-upload, no extra bandwidth.
 */
async function _callGemini(session, userMessage, opts = {}) {
    const useVertex = vertex.isVertexEnabled();
    const model = opts.model || _getReasoningModel();
    const maxOutputTokens = opts.maxOutputTokens || 4096;
    const temperature = opts.temperature ?? 0.4;
    const requestLabel = opts.requestLabel ? String(opts.requestLabel) : '';
    const labelSuffix = requestLabel ? ` [${requestLabel}]` : '';

    // Compose the conversation. Strategy:
    // - Use systemInstruction for the persistent role + capabilities
    // - First user turn carries the video parts (gemini caches the URI internally)
    // - Subsequent turns are just text — Gemini still has video context
    //
    // If session.history is empty, this IS the first turn — embed videos here.
    // Otherwise, embed video parts in the FIRST historical user turn (where they
    // already are) and send only text for the new turn.

    const memoryCtx = _buildMemoryContext(session.saveDir);
    const projectCtx = _buildProjectContextBlock(session);
    const projectSection = projectCtx ? `\n\n${projectCtx}` : '';
    const fullSystemPrompt = _systemPrompt() + projectSection + memoryCtx;
    const systemInstruction = { parts: [{ text: fullSystemPrompt }] };
    const requestTools = session.webSearch !== false
        ? [useVertex ? { googleSearch: {} } : { google_search: {} }]
        : [];

    // Before building contents, compact (or prune) old history if the combined
    // payload would overflow Gemini's 1M context window. Compaction summarizes
    // middle turns via a separate Gemini call so context is preserved.
    await _trimOrCompactHistory(session);

    // On Vertex, cache the video file_data server-side so we don't re-bill 270k+
    // video tokens on every turn. Falls back to per-turn file_data on failure.
    const cacheName = useVertex
        ? await _ensureVideoCache(session, model, {
            systemInstruction,
            tools: requestTools,
        })
        : null;

    const contents = [];

    if (cacheName) {
        // Video lives in the cache — send text-only history + new user message.
        // Strip any file_data parts from history turns so we don't double-bill.
        for (const h of session.history) {
            const textParts = (h.parts || []).filter(p => p.text);
            if (textParts.length > 0) contents.push({ role: h.role, parts: textParts });
        }
        contents.push({ role: 'user', parts: [{ text: userMessage }] });
    } else if (session.history.length === 0) {
        // First turn, no cache — attach videos here
        const parts = [
            ...(_buildVideoParts(session)),
            { text: userMessage },
        ];
        contents.push({ role: 'user', parts });
    } else {
        // Subsequent turn, no cache — replay full history (videos in first turn)
        for (const h of session.history) {
            contents.push(h);
        }
        contents.push({ role: 'user', parts: [{ text: userMessage }] });
    }

    const generationConfig = { maxOutputTokens, temperature };
    const thinkingConfig = _buildThinkingConfig(session);
    if (thinkingConfig) {
        generationConfig.thinkingConfig = thinkingConfig;
    }

    const body = { contents, generationConfig };
    if (cacheName) body.cachedContent = cacheName;
    else body.systemInstruction = systemInstruction;

    // Enable Gemini's built-in Google Search grounding so the agent can research
    // topics, verify facts, and find context about the video subject matter.
    if (!cacheName && requestTools.length > 0) {
        body.tools = requestTools;
    }

    const promptMeta = opts.promptMeta || {};
    const rawUserTokens = typeof promptMeta.rawUserTokens === 'number'
        ? promptMeta.rawUserTokens
        : _estimateTextTokens(userMessage);
    const codeTokens = promptMeta.code?.approxTokens || 0;
    const transcriptTokens = promptMeta.transcript?.approxTokens || 0;
    const augmentedUserTokens = _estimateTextTokens(userMessage);
    const augmentationGap = Math.max(0, augmentedUserTokens - rawUserTokens - codeTokens - transcriptTokens);
    const liveSystemTokens = cacheName ? 0 : _estimateTextTokens(fullSystemPrompt);
    const historyTokens = _estimateHistoryTokens(session.history);
    const effectiveFps = _effectiveFps(session);
    const liveVideoTokens = cacheName ? 0 : _estimateVideoTokens(session, effectiveFps);
    const cacheRefTokens = cacheName ? Number(session.videoCacheTokens || 0) : 0;
    const livePromptTokens = liveSystemTokens + historyTokens + augmentedUserTokens + liveVideoTokens;
    const promptBreakdown = [
        `live~=${_formatApproxTokens(livePromptTokens)}`,
        `history=${_formatApproxTokens(historyTokens)}`,
        `current=${_formatApproxTokens(augmentedUserTokens)}`,
    ];
    if (liveSystemTokens > 0) promptBreakdown.push(`system=${_formatApproxTokens(liveSystemTokens)}`);
    if (rawUserTokens > 0) promptBreakdown.push(`base=${_formatApproxTokens(rawUserTokens)}`);
    if (codeTokens > 0) promptBreakdown.push(`code=${_formatApproxTokens(codeTokens)}`);
    if (transcriptTokens > 0) promptBreakdown.push(`transcript=${_formatApproxTokens(transcriptTokens)}`);
    if (augmentationGap > 0) promptBreakdown.push(`extra=${_formatApproxTokens(augmentationGap)}`);
    if (liveVideoTokens > 0) promptBreakdown.push(`liveVideo=${_formatApproxTokens(liveVideoTokens)} @${effectiveFps}fps`);
    if (cacheRefTokens > 0) promptBreakdown.push(`cacheRef=${_formatApproxTokens(cacheRefTokens)}`);
    if (promptMeta.transcript?.chunkCount) promptBreakdown.push(`chunks=${promptMeta.transcript.chunkCount}`);
    _log(`Prompt estimate${labelSuffix}: ${promptBreakdown.join(', ')}`);

    // Vertex: one attempt per region + one final backoff slot. Direct: one per key + one backoff.
    const regionCount = useVertex ? (vertex.getRegionCount?.() || 1) : 0;
    const directKeys = useVertex ? null : _getKeys();
    const maxAttempts = useVertex ? regionCount + 1 : (directKeys?.length || 1) + 1;
    let lastError = null;
    let lastRegion = null;
    let backoffUsed = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let apiKey = null, keyIdx = 0;
        if (!useVertex) {
            const next = _getNextKey();
            if (!next) break;
            apiKey = next.key;
            keyIdx = next.index;
        }

        try {
            let url, headers;
            if (useVertex) {
                // If we have a cache attached, pin the call to the cache's
                // region — cached contents are regionally bound and a
                // different region will 400/404.
                const pinnedRegion = body.cachedContent ? session.videoCacheRegion : null;
                const auth = await vertex.getVertexAuth(model, 'generateContent', pinnedRegion);
                url = auth.url;
                headers = auth.headers;
                lastRegion = auth.region;
            } else {
                url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                headers = { 'Content-Type': 'application/json' };
            }

            const thinkLabel = session.thinkingMode !== 'off' ? ` thinking=${session.thinkingMode}` : '';
            const fpsLabel = session.fps > 1 ? ` fps=${session.fps}` : '';
            const target = useVertex ? ` via Vertex (${lastRegion})` : ` key #${keyIdx + 1}`;
            _log(`Calling ${model}${labelSuffix} (turn ${session.history.length / 2 + 1}, ${session.videos.length} video(s)${thinkLabel}${fpsLabel})${target}`);
            const resp = await axios.post(url, body, { headers, timeout: 300000 });
            const candidate = resp.data?.candidates?.[0];
            const text = candidate?.content?.parts?.[0]?.text || '';
            const grounding = candidate?.groundingMetadata;
            const usage = resp.data?.usageMetadata || {};
            const usageSummary = _summarizeUsageMetadata(usage);
            if (usageSummary) {
                _log(`Usage${labelSuffix}: ${usageSummary}`);
            } else {
                _log(`Usage${labelSuffix}: (no usageMetadata returned — raw keys: ${Object.keys(resp.data || {}).join(',') || 'none'})`);
            }
            _accumulateSessionUsage(session, usage);
            const totals = _formatSessionTotals(session);
            if (totals) _log(`Session totals: ${totals}`);
            if (grounding?.searchEntryPoint) {
                const chunks = grounding.groundingChunks || [];
                _log(`Response${labelSuffix}: ${text.length} chars (web search used, ${chunks.length} source(s))`);
            } else {
                _log(`Response${labelSuffix}: ${text.length} chars`);
            }
            return text;

        } catch (err) {
            lastError = err;

            const extractApiMsg = (e) => {
                let msg = e.response?.data?.error?.message;
                if (!msg && Array.isArray(e.response?.data) && e.response.data[0]?.error?.message) {
                    msg = e.response.data[0].error.message;
                }
                if (!msg && e.response?.data) {
                    try {
                        msg = typeof e.response.data === 'string'
                            ? e.response.data.substring(0, 800)
                            : JSON.stringify(e.response.data).substring(0, 800);
                    } catch (_) {}
                }
                if (!msg) msg = e.message;
                return msg;
            };
            const apiMsg = extractApiMsg(err);
            const statusNum = err.response?.status;
            const statusLabel = statusNum ? ` [HTTP ${statusNum}]` : '';
            const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');

            if (useVertex) {
                // Cache 404 / invalid cache reference (region rotated, cache expired
                // server-side, etc.) — drop the cache and retry once without it so
                // the call still succeeds, then rebuild the cache on the next turn.
                const cacheReferenced = !!body.cachedContent;
                const cacheMissing = cacheReferenced && (
                    statusNum === 404
                    || /cached[_ ]?content.*(?:not\s+found|does\s+not\s+exist|expired|deleted)/i.test(apiMsg)
                    || /not\s+found.*cached[_ ]?content/i.test(apiMsg)
                );
                if (cacheMissing) {
                    _log(`Cached video reference rejected (${statusNum || '?'}) — retrying without cache`);
                    await _invalidateVideoCache(session, `generate ${statusNum || '?'}: ${apiMsg.substring(0, 160)}`);
                    delete body.cachedContent;
                    _rebuildBodyWithoutCache(body, session, userMessage);
                    body.systemInstruction = systemInstruction;
                    if (requestTools.length > 0) body.tools = requestTools;
                    continue;
                }

                const cachedRequestRejected = cacheReferenced && (
                    statusNum === 400
                    || /cachedContent|cached[_ ]?content/i.test(apiMsg)
                );
                if (cachedRequestRejected) {
                    _log(`Cached request rejected (${statusNum || '?'}) â€” retrying without cache but keeping cache handle: ${apiMsg}`);
                    delete body.cachedContent;
                    _rebuildBodyWithoutCache(body, session, userMessage);
                    body.systemInstruction = systemInstruction;
                    if (requestTools.length > 0) body.tools = requestTools;
                    continue;
                }

                // 429/503/timeout: mark current region throttled, rotate to next healthy region.
                if ((statusNum === 429 || statusNum === 503 || isTimeout) && lastRegion) {
                    const retryMs = statusNum === 429 ? _parseRetryDelay(err) : undefined;
                    if (vertex.markRegionThrottled(lastRegion, retryMs)) {
                        _log(`Region ${lastRegion} throttled (${statusNum || 'timeout'}) — rotating to next region`);
                        // If the cache was region-bound, drop it (the next region can't use it)
                        if (body.cachedContent) {
                            await _invalidateVideoCache(session, 'region rotation');
                            delete body.cachedContent;
                            _rebuildBodyWithoutCache(body, session, userMessage);
                            body.systemInstruction = systemInstruction;
                            if (requestTools.length > 0) body.tools = requestTools;
                        }
                        continue;
                    }
                    // All regions throttled — single backoff then retry before giving up.
                    if (statusNum === 429 && !backoffUsed) {
                        const waitMs = _parseRetryDelay(err);
                        _log(`All ${regionCount} region(s) throttled — backing off ${Math.round(waitMs/1000)}s`);
                        await new Promise(r => setTimeout(r, waitMs));
                        backoffUsed = true;
                        continue;
                    }
                }
                _log(`Vertex error${statusLabel}: ${apiMsg}`);
                throw new Error(`Gemini (Vertex) call failed${statusLabel}: ${apiMsg}`);
            }

            const quotaKind = _isQuotaError(err);
            if (quotaKind) {
                _markExhausted(keyIdx, quotaKind);
                _log(`Key #${keyIdx + 1} ${quotaKind} (HTTP ${statusNum || '?'}) — trying next`);
                if (statusNum === 503) {
                    await new Promise(r => setTimeout(r, 10000));
                }
                continue;
            }
            _log(`Gemini error${statusLabel}: ${apiMsg}`);
            throw new Error(`Gemini call failed${statusLabel}: ${apiMsg}`);
        }
    }

    throw lastError || new Error('All Gemini keys exhausted');
}

// ============ VIDEO INGEST ============

/**
 * Download (if YouTube URL) and upload to Gemini Files API. Returns a StudioVideo.
 */
async function _ingestVideo(input, saveDir, onProgress) {
    if (!input) throw new Error('No video input provided');

    const isYouTubeUrl = /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)/.test(input);
    let localPath = input;
    let title = path.basename(input, path.extname(input || ''));
    let duration = 0;
    let isTemp = false;

    if (isYouTubeUrl) {
        const tempDir = path.join(saveDir, '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const tempFile = path.join(tempDir, `studio-ref-${Date.now()}.mp4`);
        if (onProgress) onProgress(10, 'Downloading from YouTube...');
        const dl = await styleLearner._downloadYouTube(input, tempFile, (p, m) => {
            if (onProgress) onProgress(Math.min(10 + (p * 0.4), 50), m);
        });
        localPath = dl.path;
        title = dl.title;
        duration = dl.duration;
        isTemp = true;
    } else {
        if (!fs.existsSync(input)) throw new Error(`File not found: ${input}`);
        // Probe duration with ffmpeg if available
        try {
            const ffmpegDir = styleLearner._findFfmpegDir();
            const ffmpegBin = ffmpegDir ? path.join(ffmpegDir, 'ffmpeg.exe') : 'ffmpeg';
            const { execFile } = require('child_process');
            duration = await new Promise((resolve) => {
                execFile(ffmpegBin, ['-i', input], { timeout: 10000, windowsHide: true }, (err, _so, stderr) => {
                    const m = (stderr || '').match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
                    if (m) resolve(parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]));
                    else resolve(0);
                });
            });
        } catch (e) {
            duration = 0;
        }
    }

    if (onProgress) onProgress(60, 'Uploading to Gemini Files API...');

    // Pick a key for the upload (Vertex doesn't need one)
    const useVertex = vertex.isVertexEnabled();
    let apiKey = null;
    if (!useVertex) {
        const next = styleLearner._getNextKey();
        if (!next) throw new Error('No Gemini API keys available');
        apiKey = next.key;
    }

    const uploaded = await styleLearner._uploadToGemini(localPath, apiKey);

    if (onProgress) onProgress(85, 'Video uploaded — ready for analysis');

    return {
        fileUri: uploaded.fileUri,
        fileName: uploaded.fileName,
        mimeType: uploaded.mimeType,
        isGCS: !!uploaded.isGCS,
        title,
        duration: Math.round(duration || 0),
        sourceUrl: isYouTubeUrl ? input : null,
        localPath,
        isTemp,
        apiKeyUsedForUpload: apiKey, // needed for delete
        uploadedAt: Date.now(),
    };
}

// ============ PUBLIC API ============

/**
 * Start a new style studio session. Uploads the first video and runs an
 * initial analysis turn so the user immediately sees something useful.
 */
async function startSession(input, options = {}) {
    if (!options.saveDir) throw new Error('startSession: options.saveDir required');
    const onProgress = options.onProgress || (() => {});

    onProgress(5, 'Starting Director session...');
    const video = await _ingestVideo(input, options.saveDir, onProgress);

    // thinkingMode: 'off' (default), 'high', 'medium', 'low', 'minimal'
    // fps: video sampling rate (1 = default, 5 = recommended for pacing analysis)
    // codeAccess: allow agent to search/read source files when answering code questions
    const thinkingMode = options.thinkingMode || 'off';
    const fps = options.fps || (thinkingMode !== 'off' ? 5 : 1);
    const codeAccess = options.codeAccess !== false; // default ON

    const session = {
        id: _newId(),
        saveDir: options.saveDir,
        videos: [video],
        history: [],
        profile: {},
        createdAt: Date.now(),
        thinkingMode,
        fps,
        codeAccess,
        webSearch: true,
    };
    _sessions.set(session.id, session);
    _log(`Session ${session.id} started — video "${video.title}" (${video.duration}s) | thinking=${thinkingMode} fps=${fps}`);

    onProgress(90, 'Running initial analysis...');
    const initialPrompt = _initialAnalysisPrompt(video);

    let initialReply = '';
    try {
        initialReply = await _callGemini(session, initialPrompt, {
            maxOutputTokens: 1500,
            temperature: 0.4,
            requestLabel: 'initial-video-analysis',
        });
        video.analyzed = true;
        video.analysisError = null;
    } catch (e) {
        // Don't fail the whole session if initial analysis errors out — user can retry via chat
        video.analyzed = false;
        video.analysisError = e.message;
        initialReply = `(Initial analysis failed: ${e.message}. You can say "retry video 1" or "re-analyze the failed video" to try again.)`;
    }

    // Record the turn in history
    if (session.history.length === 0) {
        session.history.push({
            role: 'user',
            parts: [..._buildVideoParts(session), { text: initialPrompt }],
        });
    } else {
        session.history.push({ role: 'user', parts: [{ text: initialPrompt }] });
    }
    session.history.push({ role: 'model', parts: [{ text: initialReply }] });

    // Phase 1: analyze the user's project transcript (if one exists) and do
    // topic research. Uses the already-cached reference video so this is cheap.
    // Runs only when the video analysis succeeded (we need a healthy session).
    let scriptAnalysisReply = '';
    if (video.analyzed) {
        const projectDir = process.env.PROJECT_DIR || process.cwd();
        const transcriptPath = path.join(projectDir, 'temp', 'transcription.json');
        if (fs.existsSync(transcriptPath)) {
            onProgress(95, 'Phase 1: analyzing your script + topic research...');
            const result = await _runScriptAnalysis(session);
            _loadTranscriptStore(session.saveDir);
            if (result.ok) {
                const a = result.analysis;
                scriptAnalysisReply = `\n\n---\n**Phase 1 — project brief saved.** ${a.topic ? `Topic: *${a.topic}*. ` : ''}${a.format ? `Format: ${a.format}. ` : ''}${a.niche ? `Niche: \`${a.niche}\`. ` : ''}${a.hookEnd ? `Hook ends ~${a.hookEnd}s. ` : ''}${a.entities?.length ? `${a.entities.length} entities tagged. ` : ''}${a.transcriptErrors?.length ? `${a.transcriptErrors.length} transcript error(s) flagged.` : ''}`;
            } else {
                scriptAnalysisReply = `\n\n---\n(Phase 1 script analysis skipped: ${result.error})`;
            }
        }
    }

    onProgress(100, 'Ready');

    // Auto-save session to disk
    _saveSessionToDisk(session);

    // Auto-learn: extract reusable patterns in the background (non-blocking)
    if (video.analyzed) {
        _autoLearnFromAnalysis(session, video.title, initialReply).catch(() => {});
    }

    return {
        sessionId: session.id,
        videoCount: session.videos.length,
        videos: session.videos.map(v => ({
            title: v.title, duration: v.duration, sourceUrl: v.sourceUrl,
            analyzed: v.analyzed, analysisError: v.analysisError,
        })),
        initialMessage: initialReply + scriptAnalysisReply,
        projectAnalysis: session.projectAnalysis || null,
    };
}

/**
 * Detect retry/re-analyze requests targeting a specific video.
 * Returns the 0-based video index if matched, or -1 if not a retry request.
 *
 * Matches patterns like:
 *   "retry video 2", "re-analyze video 3", "reanalyze the failed video",
 *   "retry the third video", "analyze video 1 again"
 */
function _detectRetryRequest(message, session) {
    const msg = message.toLowerCase().trim();
    if (!/re-?analy[sz]e|retry|try again|analyze.*again/i.test(msg)) return -1;

    // "retry video N" / "re-analyze video N"
    const numMatch = msg.match(/(?:retry|re-?analy[sz]e|analyze)\s+(?:the\s+)?video\s*#?(\d+)/);
    if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1; // user says 1-based
        if (idx >= 0 && idx < session.videos.length) return idx;
    }

    // "retry the failed video" / "re-analyze failed" — find the first failed one
    if (/failed|error/i.test(msg)) {
        const failedIdx = session.videos.findIndex(v => v.analyzed === false);
        if (failedIdx !== -1) return failedIdx;
    }

    // "retry the last video" / "re-analyze last"
    if (/last/i.test(msg)) {
        return session.videos.length - 1;
    }

    // "retry the first video"
    if (/first/i.test(msg)) return 0;

    // Ordinal: "retry the third video"
    const ordinals = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5 };
    for (const [word, idx] of Object.entries(ordinals)) {
        if (msg.includes(word) && idx < session.videos.length) return idx;
    }

    return -1;
}

/**
 * Send a chat message to the session. Returns the assistant's text reply.
 * Detects retry/re-analyze requests and re-runs initial analysis for the target video.
 */
async function chat(sessionId, message, opts = {}) {
    const session = _getSession(sessionId);
    if (!message || !message.trim()) throw new Error('Empty message');
    const trimmedMessage = message.trim();
    const baseUserTokens = _estimateTextTokens(trimmedMessage);

    // Internal planner sub-calls (outline pass, scene-detail pass, etc.) pass
    // opts.skipIntentDetection = true so their long prompts — which contain the
    // full transcript — don't accidentally trip the save-plan / full-plan regex
    // detectors and short-circuit with a coverage-gap warning instead of hitting
    // Gemini.
    const skipIntentDetection = opts.skipIntentDetection === true;

    // Check for retry/re-analyze requests
    if (!skipIntentDetection) {
        const retryIdx = _detectRetryRequest(message, session);
        if (retryIdx !== -1) {
            return _retryAnalysis(session, retryIdx, trimmedMessage);
        }
    }

    // Check for explicit full-pipeline scene-split command (only exact phrases)
    if (!skipIntentDetection && _detectFullScenePlanCommand(message)) {
        try {
            return await _handleSceneSplitRequest(session, trimmedMessage);
        } catch (e) {
            _log(`Scene-split failed: ${e.message}`);
            const reply = `I tried to plan scenes but hit an error: ${e.message}\n\nMake sure you've run at least one build so a transcript exists, and that the reference video is still loaded in this session.`;
            session.history.push({ role: 'user', parts: [{ text: trimmedMessage }] });
            session.history.push({ role: 'model', parts: [{ text: reply }] });
            _saveSessionToDisk(session);
            return { reply, turnCount: session.history.length / 2, scenePlanError: e.message };
        }
    }

    // Check for "save scene plan" / "apply this" — parses SCENE lines from last model reply
    if (!skipIntentDetection && _detectSaveScenePlanRequest(message)) {
        try {
            return await _handleSaveScenePlan(session, trimmedMessage);
        } catch (e) {
            _log(`Save scene plan failed: ${e.message}`);
        }
    }

    // Code access: detect code-related questions and auto-attach source snippets
    let augmentedMessage = trimmedMessage;
    let codeContextUsed = false;
    let transcriptContextUsed = false;
    let codeMeta = null;
    let transcriptMeta = null;
    if (session.codeAccess) {
        const codeReq = _detectCodeRequest(message);
        if (codeReq) {
            const codeCtx = _buildCodeContext(codeReq);
            if (codeCtx) {
                augmentedMessage = augmentedMessage + codeCtx;
                codeContextUsed = true;
                codeMeta = {
                    approxTokens: _estimateTextTokens(codeCtx),
                    chars: codeCtx.length,
                    fileCount: codeReq.files.length,
                    keywordCount: codeReq.keywords.length,
                };
                _log(`Code context injected: ${codeReq.files.length} file(s), ${codeReq.keywords.length} keyword(s), ${codeMeta.chars} chars, ~${_formatApproxTokens(codeMeta.approxTokens)} tokens`);
            }
        }
    }
    // Transcript access: when the user asks about their script/narration, auto-attach
    // the Whisper transcript from <project>/temp/transcription.json.
    const transcriptMode = opts.skipTranscriptInjection
        ? 'none'
        : (opts.transcriptMode || 'auto');
    const isSceneSplitTalk = /\b(?:split|scene|cut|pacing)\b/i.test(message);
    const wantsSceneTranscript = transcriptMode === 'scene'
        || (transcriptMode === 'auto' && isSceneSplitTalk);
    const wantsQueryTranscript = transcriptMode === 'query'
        || (transcriptMode === 'auto' && _detectTranscriptRequest(message));
    if (transcriptMode !== 'none' && (wantsSceneTranscript || wantsQueryTranscript)) {
        const trCtxData = _getRetrievedTranscriptContextData(session, message, {
            mode: wantsSceneTranscript ? 'scene' : 'query',
        });
        if (trCtxData?.text) {
            augmentedMessage = augmentedMessage + trCtxData.text;
            transcriptContextUsed = true;
            transcriptMeta = trCtxData.meta;
            const termLabel = transcriptMeta.terms?.length ? `, terms=${transcriptMeta.terms.join('|')}` : '';
            _log(`Transcript context injected: ${transcriptMeta.chunkCount} chunk(s) [${transcriptMeta.chunkRanges}], ${transcriptMeta.chars} chars, ~${_formatApproxTokens(transcriptMeta.approxTokens)} tokens, mode=${transcriptMeta.mode}, strategy=${transcriptMeta.strategy}, focus=${transcriptMeta.focusLabel}${termLabel}`);
        }
    }

    const outputTokens = isSceneSplitTalk ? 8192 : 4096;
    const reply = await _callGemini(session, augmentedMessage, {
        maxOutputTokens: outputTokens,
        temperature: 0.5,
        requestLabel: opts.requestLabel || 'studio-chat',
        promptMeta: {
            rawUserTokens: baseUserTokens,
            code: codeMeta,
            transcript: transcriptMeta,
        },
    });

    // Store original message in history (without the code context blob)
    session.history.push({ role: 'user', parts: [{ text: trimmedMessage }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    // Detect memory commands
    let memoryAction = null;
    const msgLower = trimmedMessage.toLowerCase();
    const rememberMatch = message.match(/(?:remember\s+(?:this|that)?:?\s*|save\s+(?:to\s+)?memory:?\s*)(.+)/i);
    if (rememberMatch) {
        const memText = rememberMatch[1].trim();
        if (memText.length > 3) {
            saveMemoryEntry(session.saveDir, memText, 'user-note');
            memoryAction = { type: 'saved', text: memText };
        }
    } else if (/what\s+do\s+you\s+remember|show\s+memor|list\s+memor/i.test(msgLower)) {
        memoryAction = { type: 'list', memories: loadMemory(session.saveDir) };
    } else if (/forget\s+#?(\d+)|delete\s+memory\s+#?(\d+)|remove\s+memory\s+#?(\d+)/i.test(msgLower)) {
        const delMatch = msgLower.match(/(?:forget|delete\s+memory|remove\s+memory)\s+#?(\d+)/);
        if (delMatch) {
            const idx = parseInt(delMatch[1], 10) - 1;
            const remaining = deleteMemoryEntry(session.saveDir, idx);
            memoryAction = { type: 'deleted', index: idx, remaining };
        }
    }

    // Auto-save session to disk
    _saveSessionToDisk(session);

    return { reply, turnCount: session.history.length / 2, codeContextUsed, transcriptContextUsed, memoryAction };
}

/**
 * Re-run the initial analysis prompt for a specific video.
 * The video is already uploaded to Gemini — we just re-send the analysis prompt.
 */
async function _retryAnalysis(session, videoIdx, originalMessage) {
    const video = session.videos[videoIdx];
    _log(`Retrying analysis for video #${videoIdx + 1}: "${video.title}"`);

    const prompt = `The user wants to re-analyze video #${videoIdx + 1} ("${video.title}") which had a previous analysis error. ` +
        _initialAnalysisPrompt(video);

    let reply = '';
    try {
        reply = await _callGemini(session, prompt, {
            maxOutputTokens: 1500,
            temperature: 0.4,
            requestLabel: 'retry-video-analysis',
        });
        video.analyzed = true;
        video.analysisError = null;
        _log(`Retry succeeded for video #${videoIdx + 1}`);
    } catch (e) {
        video.analyzed = false;
        video.analysisError = e.message;
        reply = `(Re-analysis of video #${videoIdx + 1} failed again: ${e.message}. The video is still uploaded — you can try again later.)`;
        _log(`Retry failed for video #${videoIdx + 1}: ${e.message}`);
    }

    session.history.push({ role: 'user', parts: [{ text: originalMessage }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    // Auto-save session to disk
    _saveSessionToDisk(session);

    // Auto-learn from retry if it succeeded (non-blocking)
    if (video.analyzed) {
        _autoLearnFromAnalysis(session, video.title, reply).catch(() => {});
    }

    return {
        reply,
        turnCount: session.history.length / 2,
        retried: true,
        retriedVideo: { index: videoIdx, title: video.title, analyzed: video.analyzed, analysisError: video.analysisError },
        // Send updated videos so UI can refresh status badges
        videos: session.videos.map(v => ({
            title: v.title, duration: v.duration, sourceUrl: v.sourceUrl,
            analyzed: v.analyzed, analysisError: v.analysisError,
        })),
    };
}

/**
 * Load the active project's .fvp settings so chat handlers have full build context
 * (video title, AI instructions, niche, theme, language, style profile).
 * Returns an object (possibly with empty fields) — never throws.
 */
/**
 * Transcript retrieval layer. Keeps a lightweight local chunk index on disk so
 * chat turns can pull only the relevant transcript slices instead of replaying
 * the whole narration every time.
 */
function _getTranscriptCachePath(saveDir) {
    const baseDir = saveDir || path.join(process.env.PROJECT_DIR || process.cwd(), 'styles');
    return path.join(baseDir, TRANSCRIPT_CACHE_FILE);
}

function _normalizeRetrievalText(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const RETRIEVAL_STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'my',
    'you', 'are', 'was', 'were', 'have', 'has', 'had', 'about', 'what', 'does',
    'say', 'says', 'line', 'lines', 'word', 'words', 'show', 'tell', 'give',
    'please', 'need', 'want', 'make', 'more', 'less', 'just', 'only', 'than',
    'then', 'them', 'they', 'their', 'there', 'here', 'when', 'where', 'which',
    'while', 'over', 'under', 'scene', 'scenes', 'split', 'cut', 'pacing',
    'transcript', 'script', 'narration', 'voice', 'video', 'project', 'section',
    'part', 'plan',
]);

function _tokenizeRetrievalTerms(text) {
    return _normalizeRetrievalText(text)
        .split(/\s+/)
        .filter(t => t.length >= 3 && !RETRIEVAL_STOP_WORDS.has(t));
}

function _getSegmentText(seg) {
    if (!seg) return '';
    if (seg.text && seg.text.trim()) return seg.text.trim();
    const words = Array.isArray(seg.words) ? seg.words.map(w => w.word).filter(Boolean) : [];
    return words.join(' ').trim();
}

function _formatTranscriptStamp(sec) {
    return `${Number(sec || 0).toFixed(1)}s`;
}

function _readActiveTranscript() {
    try {
        const projectDir = process.env.PROJECT_DIR || process.cwd();
        const transcriptPath = path.join(projectDir, 'temp', 'transcription.json');
        if (!fs.existsSync(transcriptPath)) return null;
        const raw = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
        const stats = fs.statSync(transcriptPath);
        return {
            projectDir,
            transcriptPath,
            fingerprint: `${stats.size}:${Math.round(stats.mtimeMs)}`,
            duration: Number(raw.duration || 0),
            language: raw.language || 'unknown',
            text: (raw.text || '').trim(),
            segments: Array.isArray(raw.segments) ? raw.segments : [],
        };
    } catch (e) {
        _log(`Transcript read failed: ${e.message}`);
        return null;
    }
}

function _buildTranscriptStore(raw) {
    const chunks = [];
    const CHUNK_TARGET_SECONDS = 45;
    const CHUNK_MAX_CHARS = 1600;

    let chunkStart = null;
    let chunkEnd = 0;
    let chunkChars = 0;
    let lines = [];
    let sourceTexts = [];

    const flush = () => {
        if (lines.length === 0) return;
        chunks.push({
            id: chunks.length,
            start: chunkStart || 0,
            end: chunkEnd || chunkStart || 0,
            text: lines.join('\n').trim(),
            preview: lines.slice(0, 2).join(' ').trim(),
            normalizedText: _normalizeRetrievalText(sourceTexts.join(' ')),
        });
        chunkStart = null;
        chunkEnd = 0;
        chunkChars = 0;
        lines = [];
        sourceTexts = [];
    };

    for (const seg of raw.segments) {
        const segText = _getSegmentText(seg);
        if (!segText) continue;
        const segStart = Number(seg.start || 0);
        const segEnd = Number(seg.end || segStart);
        const line = `[${_formatTranscriptStamp(segStart)}] ${segText}`;
        if (chunkStart == null) chunkStart = segStart;
        const wouldOverflowTime = (segEnd - chunkStart) >= CHUNK_TARGET_SECONDS;
        const wouldOverflowChars = (chunkChars + line.length) > CHUNK_MAX_CHARS;
        if (lines.length > 0 && (wouldOverflowTime || wouldOverflowChars)) flush();
        if (chunkStart == null) chunkStart = segStart;
        lines.push(line);
        sourceTexts.push(segText);
        chunkChars += line.length + 1;
        chunkEnd = segEnd;
    }
    flush();

    if (chunks.length === 0 && raw.text) {
        chunks.push({
            id: 0,
            start: 0,
            end: raw.duration || 0,
            text: raw.text,
            preview: raw.text.substring(0, 180),
            normalizedText: _normalizeRetrievalText(raw.text),
        });
    }

    return {
        version: TRANSCRIPT_CACHE_VERSION,
        transcriptPath: raw.transcriptPath,
        fingerprint: raw.fingerprint,
        duration: raw.duration || 0,
        language: raw.language || 'unknown',
        segmentCount: raw.segments.length,
        chunkCount: chunks.length,
        chunks,
    };
}

function _saveTranscriptStore(saveDir, store) {
    try {
        if (!saveDir) return;
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        fs.writeFileSync(_getTranscriptCachePath(saveDir), JSON.stringify(store, null, 2), 'utf8');
    } catch (e) {
        _log(`Transcript cache save failed: ${e.message}`);
    }
}

function _loadTranscriptStore(saveDir) {
    const raw = _readActiveTranscript();
    if (!raw) return null;

    const key = `${raw.transcriptPath}:${raw.fingerprint}`;
    if (_transcriptStores.has(key)) return _transcriptStores.get(key);

    let store = null;
    const cachePath = _getTranscriptCachePath(saveDir);
    if (fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached
                && cached.version === TRANSCRIPT_CACHE_VERSION
                && cached.transcriptPath === raw.transcriptPath
                && cached.fingerprint === raw.fingerprint
                && Array.isArray(cached.chunks)
                && cached.chunks.length > 0) {
                store = cached;
            }
        } catch (_) {}
    }

    if (!store) {
        store = _buildTranscriptStore(raw);
        _saveTranscriptStore(saveDir, store);
    }

    _transcriptStores.set(key, store);
    return store;
}

function _loadCurrentScenePlan() {
    const projectDir = process.env.PROJECT_DIR || process.cwd();
    const candidates = [
        path.join(projectDir, 'styles', '.studio-plan.json'),
        path.join(projectDir, 'styles', '.scene-plan.json'),
    ];

    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length === 0) continue;
            return raw.scenes.map((s, idx) => ({
                index: Number.isInteger(s.index) ? s.index : idx,
                startTime: Number(s.startTime || 0),
                endTime: Number(s.endTime || s.startTime || 0),
                text: s.text || '',
            }));
        } catch (_) {}
    }
    return null;
}

function _extractTranscriptFocus(session, message, duration) {
    const msg = String(message || '').toLowerCase();
    const firstNMin = msg.match(/first\s+(\d+)\s*(?:min(?:ute)?s?|m)\b/);
    const firstNSec = msg.match(/first\s+(\d+)\s*(?:sec(?:ond)?s?|s)\b/);
    const lastNMin = msg.match(/last\s+(\d+)\s*(?:min(?:ute)?s?|m)\b/);
    const lastNSec = msg.match(/last\s+(\d+)\s*(?:sec(?:ond)?s?|s)\b/);
    const fromToMatch = msg.match(/from\s+(\d+)[:.]?(\d*)\s*(?:to|-)\s*(\d+)[:.]?(\d*)/);
    const rangeMatch = msg.match(/(\d+)[:.]?(\d*)\s*(?:to|-)\s*(\d+)[:.]?(\d*)/);
    const sceneMatch = msg.match(/\bscene\s+#?(\d+)\b/);

    const planScenes = _loadCurrentScenePlan();
    if (sceneMatch) {
        const sceneNumber = parseInt(sceneMatch[1], 10);
        if (planScenes && sceneNumber > 0) {
            const scene = planScenes.find(s => (s.index + 1) === sceneNumber) || planScenes[sceneNumber - 1];
            if (scene) {
                return {
                    start: Math.max(0, scene.startTime - 4),
                    end: Math.min(duration, scene.endTime + 4),
                    reason: `scene ${sceneNumber}`,
                };
            }
        }
    }

    if (planScenes && /\b(?:next|remaining|rest)\b/.test(msg)) {
        const coveredUntil = Math.max(...planScenes.map(s => Number(s.endTime || 0)));
        if (coveredUntil < duration - 5) {
            return {
                start: Math.max(0, coveredUntil - 4),
                end: Math.min(duration, coveredUntil + 90),
                reason: 'next unplanned section',
            };
        }
    }

    if (firstNMin) return { start: 0, end: Math.min(duration, parseFloat(firstNMin[1]) * 60), reason: `first ${firstNMin[1]} min` };
    if (firstNSec) return { start: 0, end: Math.min(duration, parseFloat(firstNSec[1])), reason: `first ${firstNSec[1]} sec` };
    if (lastNMin) return { start: Math.max(0, duration - parseFloat(lastNMin[1]) * 60), end: duration, reason: `last ${lastNMin[1]} min` };
    if (lastNSec) return { start: Math.max(0, duration - parseFloat(lastNSec[1])), end: duration, reason: `last ${lastNSec[1]} sec` };

    if (fromToMatch) {
        let start = parseFloat(fromToMatch[1]) + parseFloat(fromToMatch[2] || 0) / 60;
        let end = parseFloat(fromToMatch[3]) + parseFloat(fromToMatch[4] || 0) / 60;
        if (end < 10) { start *= 60; end *= 60; }
        return { start: Math.max(0, start), end: Math.min(duration, end), reason: 'requested time range' };
    }
    if (rangeMatch && /\b(?:split|scene|cut|pacing|script|transcript|narration)\b/.test(msg)) {
        const s1 = parseFloat(rangeMatch[1]);
        const s1m = parseFloat(rangeMatch[2] || 0);
        const s2 = parseFloat(rangeMatch[3]);
        const s2m = parseFloat(rangeMatch[4] || 0);
        return {
            start: Math.max(0, s1m ? s1 * 60 + s1m : s1),
            end: Math.min(duration, s2m ? s2 * 60 + s2m : s2),
            reason: 'requested time range',
        };
    }

    const pa = session?.projectAnalysis || {};
    if (/\b(?:hook|opening|intro)\b/.test(msg)) {
        const hookEnd = Number(pa.hookEnd || pa.hookEndTime || 0);
        return {
            start: 0,
            end: Math.min(duration, hookEnd > 0 ? Math.max(hookEnd + 8, 24) : Math.min(30, duration)),
            reason: 'hook',
        };
    }
    if (/\b(?:cta|outro|ending|conclusion)\b/.test(msg)) {
        const ctaStart = Number(pa.ctaStart || pa.ctaStartTime || 0);
        return {
            start: Math.max(0, ctaStart > 0 ? ctaStart - 8 : duration - Math.min(45, duration)),
            end: duration,
            reason: 'ending',
        };
    }

    return null;
}

function _scoreTranscriptChunk(chunk, terms, focus, duration, mode, message) {
    let score = 0;
    const lower = String(message || '').toLowerCase();

    if (focus) {
        const overlap = Math.max(0, Math.min(chunk.end, focus.end) - Math.max(chunk.start, focus.start));
        if (overlap > 0) score += 60 + overlap;
        else if (chunk.end >= focus.start - 12 && chunk.start <= focus.end + 12) score += 12;
        const focusMid = (focus.start + focus.end) / 2;
        const chunkMid = (chunk.start + chunk.end) / 2;
        score += Math.max(0, 8 - Math.abs(chunkMid - focusMid) / 15);
    }

    for (const term of terms) {
        if (chunk.normalizedText.includes(term)) score += term.length >= 6 ? 8 : 4;
    }

    if (/\b(?:hook|opening|intro)\b/.test(lower)) {
        score += Math.max(0, 8 - chunk.start / 10);
    }
    if (/\b(?:cta|outro|ending|conclusion)\b/.test(lower)) {
        score += Math.max(0, 8 - Math.abs(duration - chunk.end) / 10);
    }
    if (mode === 'scene' && /\bscene\s+#?\d+\b/.test(lower)) {
        score += 6;
    }

    return score;
}

function _pickTranscriptChunks(store, session, message, mode = 'query') {
    const focus = _extractTranscriptFocus(session, message, store.duration);
    const terms = _tokenizeRetrievalTerms(message);
    const limit = mode === 'scene' ? 6 : 4;
    let chosen = [];
    let strategy = 'empty';

    if (focus) {
        strategy = 'focus';
        chosen = store.chunks.filter(c => c.end >= focus.start - 6 && c.start <= focus.end + 6);
        if (chosen.length === 0) {
            chosen = store.chunks
                .map(c => ({ chunk: c, dist: Math.abs(((c.start + c.end) / 2) - ((focus.start + focus.end) / 2)) }))
                .sort((a, b) => a.dist - b.dist)
                .slice(0, limit)
                .map(x => x.chunk);
        }
    } else if (terms.length > 0) {
        strategy = 'terms';
        chosen = store.chunks
            .map(chunk => ({ chunk, score: _scoreTranscriptChunk(chunk, terms, focus, store.duration, mode, message) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(x => x.chunk);
    } else if (mode === 'query') {
        strategy = 'fallback';
        const first = store.chunks[0];
        const middle = store.chunks[Math.floor(store.chunks.length / 2)];
        const last = store.chunks[store.chunks.length - 1];
        chosen = [first, middle, last].filter(Boolean).filter((c, idx, arr) => arr.findIndex(x => x.id === c.id) === idx);
    }

    chosen.sort((a, b) => a.start - b.start);
    return { focus, chunks: chosen, strategy, terms };
}

function _getRetrievedTranscriptContextData(session, message, opts = {}) {
    try {
        const store = _loadTranscriptStore(session?.saveDir);
        if (!store) return null;

        const mode = opts.mode === 'scene' ? 'scene' : 'query';
        const picked = _pickTranscriptChunks(store, session, message, mode);
        if (!picked.chunks || picked.chunks.length === 0) return null;

        const headerLines = [
            '',
            '',
            `[TRANSCRIPT MEMORY - retrieved ${picked.chunks.length} chunk(s) from ${path.basename(store.transcriptPath)}]`,
            `Transcript: ${Math.round(store.duration)}s | Language: ${store.language} | Indexed chunks: ${store.chunkCount}`,
            `Mode: ${mode === 'scene' ? 'scene planning' : 'question answering'}`,
        ];
        if (picked.focus) {
            headerLines.push(`Focus: ${_formatTranscriptStamp(picked.focus.start)}-${_formatTranscriptStamp(picked.focus.end)} (${picked.focus.reason})`);
        } else {
            headerLines.push('Focus: retrieved by relevance');
        }
        headerLines.push('Use PROJECT ANALYSIS for the global brief. Use the retrieved slices below for exact wording, timing, and local visual decisions.');

        const blocks = picked.chunks.map((chunk, idx) =>
            `CHUNK ${idx + 1} (${_formatTranscriptStamp(chunk.start)}-${_formatTranscriptStamp(chunk.end)})\n${chunk.text}`
        );
        const text = `${headerLines.join('\n')}\n\n${blocks.join('\n\n')}`;
        const focusLabel = picked.focus
            ? `${_formatTranscriptStamp(picked.focus.start)}-${_formatTranscriptStamp(picked.focus.end)} (${picked.focus.reason})`
            : 'relevance';
        return {
            text,
            meta: {
                mode,
                strategy: picked.strategy,
                chunkCount: picked.chunks.length,
                chunkRanges: _formatChunkRanges(picked.chunks, 6),
                focusLabel,
                focusReason: picked.focus?.reason || null,
                indexedChunks: store.chunkCount,
                transcriptDuration: store.duration,
                transcriptFile: path.basename(store.transcriptPath),
                chars: text.length,
                approxTokens: _estimateTextTokens(text),
                terms: picked.terms.slice(0, 8),
            },
        };
    } catch (e) {
        _log(`Transcript retrieval failed: ${e.message}`);
        return null;
    }
}

function _buildRetrievedTranscriptContext(session, message, opts = {}) {
    return _getRetrievedTranscriptContextData(session, message, opts)?.text || '';
}

// Detect when the user is asking about the narration/script of their project.
function _detectTranscriptRequest(message) {
    const m = message.toLowerCase();
    const hasRefVideo = /\bref(?:erence)?\s+video\b/.test(m);
    const hasProjectKeyword = /\btranscript\b|\bscript\b|\bnarration\b|\bvoice[- ]?over\b|\bvo\b/.test(m);
    if (hasRefVideo && !hasProjectKeyword) return false;
    return hasProjectKeyword
        || /first\s+(?:few\s+)?words?/.test(m)
        || /last\s+(?:few\s+)?words?/.test(m)
        || /what\s+(?:is|does)\s+(?:my|the|this)\s+(?:video|script|narration)\s+(?:about|say)/.test(m)
        || /\b(?:hook|intro|opening|conclusion|outro|ending)\b.*\b(?:say|words?|lines?)/.test(m)
        || /\b(?:split|scene|cut|pacing)\b.*\b(?:first|last|only|just)\s+\d/.test(m)
        || /\bsplit\b.*\b(?:scene|minute|min|sec)/i.test(m)
        || /\bscene\b.*\b(?:split|plan|cut)/i.test(m);
}

// Compatibility wrapper: scene prompts now use retrieval instead of replaying the
// full transcript, but callers can keep the old helper name.
function _buildTimestampedTranscriptContext(message, session = null) {
    return _buildRetrievedTranscriptContext(session, message, { mode: 'scene' });
}

// Compatibility wrapper for general transcript questions.
function _buildTranscriptContext(message = '', session = null) {
    return _buildRetrievedTranscriptContext(session, message, { mode: 'query' });
}

// In-memory cache of the current project settings pushed by the renderer on
// every settings change. Takes precedence over the .fvp file (which only exists
// after the user has run a build — for new projects it won't be written yet).
let _liveProjectContext = null;

function setLiveProjectContext(ctx) {
    _liveProjectContext = ctx && typeof ctx === 'object' ? { ...ctx, updatedAt: Date.now() } : null;
}

function _loadProjectContext() {
    const ctx = {
        projectDir: process.env.PROJECT_DIR || process.cwd(),
        videoTitle: '',
        aiInstructions: '',
        buildNiche: 'auto',
        buildLanguage: 'auto',
        buildStyleProfile: 'none',
        videoPlanSummary: '',
    };

    // 1. Try the .fvp file (written on save/build)
    try {
        const files = fs.readdirSync(ctx.projectDir).filter(f => f.endsWith('.fvp'));
        if (files.length > 0) {
            const raw = JSON.parse(fs.readFileSync(path.join(ctx.projectDir, files[0]), 'utf8'));
            const s = raw?.settings || {};
            ctx.videoTitle = s.videoTitle || ctx.videoTitle;
            ctx.aiInstructions = s.aiInstructions || ctx.aiInstructions;
            ctx.buildNiche = s.buildNiche || ctx.buildNiche;
            ctx.buildLanguage = s.buildLanguage || ctx.buildLanguage;
            ctx.buildStyleProfile = s.buildStyleProfile || ctx.buildStyleProfile;
            const vp = raw?.videoPlan || {};
            if (vp.scenes?.length) {
                ctx.videoPlanSummary = `last build: ${vp.scenes.length} scenes, ${Math.round(vp.duration || 0)}s`;
            }
        }
    } catch (_) {}

    // 2. Overlay with live settings from the renderer (most recent wins — covers
    //    the case where user edits the UI but hasn't saved/built yet).
    if (_liveProjectContext) {
        if (_liveProjectContext.videoTitle)      ctx.videoTitle      = _liveProjectContext.videoTitle;
        if (_liveProjectContext.aiInstructions)  ctx.aiInstructions  = _liveProjectContext.aiInstructions;
        if (_liveProjectContext.buildNiche)      ctx.buildNiche      = _liveProjectContext.buildNiche;
        if (_liveProjectContext.buildLanguage)   ctx.buildLanguage   = _liveProjectContext.buildLanguage;
        if (_liveProjectContext.buildStyleProfile) ctx.buildStyleProfile = _liveProjectContext.buildStyleProfile;
    }
    return ctx;
}

/**
 * Build an informational block describing the niche's footage/MG rules, so the
 * agent picks source hints and MG types that match the pipeline's real config.
 *
 * INFORMATIONAL ONLY — the agent is free to override when the script demands,
 * but by default it should honor these preferences. This prevents the agent
 * from e.g. spamming `sourceHint: stock` for an explainer.military video where
 * the pipeline prefers youtube/reddit.
 */
function _buildNicheRulesBlock(nicheId) {
    if (!nicheId || nicheId === 'auto') return '';
    let niches;
    try { niches = require('./niches'); } catch (_) { return ''; }
    let niche;
    try { niche = niches.getNiche(nicheId); } catch (_) { return ''; }
    if (!niche || niche.id === 'general' && nicheId !== 'general') return '';

    const lines = [`NICHE RULES for ${niche.id}:`];
    const fp = niche.footagePriority || {};
    if (Array.isArray(fp.video) && fp.video.length) {
        lines.push(`- Preferred VIDEO sources (try in order): ${fp.video.join(', ')}`);
    }
    if (Array.isArray(fp.image) && fp.image.length) {
        lines.push(`- Preferred IMAGE sources (try in order): ${fp.image.join(', ')}`);
    }
    if (Array.isArray(niche.excludeVideoProviders) && niche.excludeVideoProviders.length) {
        lines.push(`- AVOID (excluded for this niche): ${niche.excludeVideoProviders.join(', ')}`);
    }
    if (Array.isArray(niche.allowedMGs) && niche.allowedMGs.length) {
        lines.push(`- Allowed MG / fullscreenMG types: ${niche.allowedMGs.join(', ')}`);
    }
    const sp = niche.searchPolicy || {};
    if (Array.isArray(sp.avoidTerms) && sp.avoidTerms.length) {
        lines.push(`- Search avoidTerms: ${sp.avoidTerms.join(', ')}`);
    }
    if (Array.isArray(sp.contextTerms) && sp.contextTerms.length) {
        lines.push(`- Search contextTerms (append for relevance): ${sp.contextTerms.join(', ')}`);
    }
    if (niche.preferredMediaType) {
        lines.push(`- Preferred media type: ${niche.preferredMediaType}`);
    }
    if (niche.defaultPacing) {
        lines.push(`- Default pacing: ${niche.defaultPacing}`);
    }
    lines.push(`- Note: INFORMATIONAL. Prefer these defaults when choosing sourceHint and mgHint, but you may override when a specific scene demands it (e.g., a generic cutaway might still use stock even for a youtube-first niche).`);
    return `\n${lines.join('\n')}\n`;
}

/**
 * Build a short context block that describes the current project — used in
 * chat prompts that benefit from knowing what video the user is building.
 */
function _buildProjectContextBlock(session) {
    const p = _loadProjectContext();
    const lines = [];
    if (p.videoTitle)       lines.push(`VIDEO TITLE: "${p.videoTitle}"`);
    if (p.aiInstructions)   lines.push(`AI INSTRUCTIONS: "${p.aiInstructions}"`);
    if (p.buildNiche && p.buildNiche !== 'auto')       lines.push(`NICHE: ${p.buildNiche}`);
    if (p.buildLanguage && p.buildLanguage !== 'auto') lines.push(`LANGUAGE: ${p.buildLanguage}`);
    if (p.videoPlanSummary) lines.push(p.videoPlanSummary);
    // Tell the agent whether a transcript exists so it never guesses wrong
    try {
        const projectDir = process.env.PROJECT_DIR || process.cwd();
        const trPath = path.join(projectDir, 'temp', 'transcription.json');
        if (fs.existsSync(trPath)) {
            const trJson = JSON.parse(fs.readFileSync(trPath, 'utf8'));
            const dur = trJson.duration ? `${Math.round(trJson.duration)}s` : '';
            lines.push(`TRANSCRIPT: available (${dur}, ${(trJson.segments || []).length} segments). Ask about it and it will be loaded automatically.`);
        } else {
            lines.push(`TRANSCRIPT: not yet generated (no build has been run).`);
        }
    } catch (_) {}
    let block = lines.length > 0 ? `PROJECT CONTEXT:\n${lines.join('\n')}\n` : '';

    // Attach Phase 1 project analysis (the "what this video is about" brief)
    // when a session carries one — injected on every turn so the Director
    // reasons with verified topic context instead of rereading transcript.
    const pa = session?.projectAnalysis;
    if (pa && !pa.parseError) {
        const parts = [];
        if (pa.summary)    parts.push(`Summary: ${pa.summary}`);
        if (pa.topic)      parts.push(`Topic: ${pa.topic}`);
        if (pa.format)     parts.push(`Format: ${pa.format}${pa.formatEvidence ? ` (${pa.formatEvidence})` : ''}`);
        if (pa.tone)       parts.push(`Tone: ${pa.tone}`);
        if (pa.pacing)     parts.push(`Pacing: ${pa.pacing}${pa.pacingNotes ? ` — ${pa.pacingNotes}` : ''}`);
        if (pa.niche)      parts.push(`Niche: ${pa.niche}${pa.nicheReason ? ` (${pa.nicheReason})` : ''}`);
        if (pa.hookEnd != null)   parts.push(`Hook ends at: ${pa.hookEnd}s`);
        if (pa.ctaStart != null)  parts.push(`CTA starts at: ${pa.ctaStart}s`);
        if (Array.isArray(pa.keyTopics) && pa.keyTopics.length) {
            parts.push(`Key topics: ${pa.keyTopics.join('; ')}`);
        }
        if (Array.isArray(pa.entities) && pa.entities.length) {
            const ents = pa.entities.slice(0, 20).map(e => `${e.name} (${e.type})`).join(', ');
            parts.push(`Entities: ${ents}`);
        }
        if (Array.isArray(pa.factChecks) && pa.factChecks.length) {
            const fc = pa.factChecks.map(f => `[${f.verdict}] ${f.claim}`).join(' | ');
            parts.push(`Fact checks: ${fc}`);
        }
        if (Array.isArray(pa.transcriptErrors) && pa.transcriptErrors.length) {
            const te = pa.transcriptErrors.map(e => `@${e.at}s "${e.heard}" → "${e.shouldBe}"`).join('; ');
            parts.push(`Transcript errors flagged: ${te}`);
        }
        if (pa.notes) parts.push(`Notes: ${pa.notes}`);
        if (parts.length) {
            block += `\nPROJECT ANALYSIS (Phase 1 — pre-computed, trust this over rereading the transcript):\n- ${parts.join('\n- ')}\n`;
        }
    }

    // Append niche rules when niche is known. Prefer the Phase 1 pick over
    // the UI-selected niche when UI is on 'auto', so rules attach automatically.
    const effectiveNiche = (p.buildNiche && p.buildNiche !== 'auto')
        ? p.buildNiche
        : (pa?.niche || p.buildNiche);
    block += _buildNicheRulesBlock(effectiveNiche);
    return block;
}

/**
 * Detect "plan scenes" / "split transcript" style chat requests.
 * Returns true if the message asks for scene-split planning.
 */
function _detectFullScenePlanCommand(message) {
    const msg = message.toLowerCase().trim();
    return /^plan\s+all\s+scenes?$/i.test(msg)
        || /^split\s+(?:the\s+)?(?:full|entire|whole)\s+transcript$/i.test(msg)
        || /^(?:run|do)\s+(?:the\s+)?(?:full|complete)\s+(?:scene\s+)?split$/i.test(msg);
}

function _detectSaveScenePlanRequest(message) {
    const msg = message.toLowerCase().trim();
    // Accept common typos and plurals: "plane", "plans", "planne" → "plan"; "scenes" → "scene"
    const norm = msg
        .replace(/\bplan(?:e|ne|ned|nes|s)?\b/g, 'plan')
        .replace(/\bscenes\b/g, 'scene')
        .replace(/\bsplits\b/g, 'split');
    return /\bsave\b.*\b(?:scene|plan|split|this|these|it)\b/i.test(norm)
        || /\bapply\b.*\b(?:scene|split|plan|this|these|it)\b/i.test(norm)
        || /\buse\s+(?:this|these|the)\b.*\b(?:scene|plan|split)\b/i.test(norm)
        || /\b(?:keep|commit|persist|write|store|lock[ -]?in)\b.*\b(?:scene|plan|split)\b/i.test(norm)
        || /^save\s+(?:it|this|that|plan|all)\b/i.test(norm)
        || /^(?:ok\s+)?save\s+(?:this|the|it|plan)/i.test(norm);
}

/**
 * Handle a chat-driven scene-split request. Loads the current project's Whisper
 * transcript, runs the two-pass split through this session, saves the plan to
 * <project>/styles/.scene-plan.json, and returns a chat reply summarizing it.
 *
 * The build pipeline (ai-director.js) picks up the saved plan on next run.
 */
async function _handleSceneSplitRequest(session, originalMessage) {
    const fs = require('fs');
    const path = require('path');
    const director = require('./ai-director');

    const projectDir = process.env.PROJECT_DIR || process.cwd();
    const transcriptPath = path.join(projectDir, 'temp', 'transcription.json');

    if (!fs.existsSync(transcriptPath)) {
        const reply = `I can't find a transcript to split. Run at least one build (or the transcribe step) first so \`temp/transcription.json\` exists. Then ask me "plan scenes" again.`;
        session.history.push({ role: 'user', parts: [{ text: originalMessage }] });
        session.history.push({ role: 'model', parts: [{ text: reply }] });
        _saveSessionToDisk(session);
        return { reply, turnCount: session.history.length / 2, scenePlan: null };
    }

    let transcription;
    try {
        transcription = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
    } catch (e) {
        throw new Error(`Failed to read transcript: ${e.message}`);
    }

    // Flatten Whisper segments → word array (same shape ai-director expects)
    const allWords = [];
    for (const seg of (transcription.segments || [])) {
        for (const w of (seg.words || [])) allWords.push(w);
    }
    if (allWords.length === 0) throw new Error('Transcript has no word-level timestamps');

    const audioDuration = transcription.duration
        || (allWords[allWords.length - 1].end || 0);
    const fps = 30;

    // Build micro-scenes (punctuation splits)
    const microScenes = director._splitAtPunctuation(allWords, audioDuration, fps);
    _log(`Scene planning: ${microScenes.length} fragments across ${audioDuration.toFixed(1)}s`);

    // Minimal scriptContext + directorsBrief for the two-pass core.
    // Values here only affect per-block density math — the reference video's rhythm dominates.
    const scriptContext = {
        summary: session.profile?.summary || '',
        theme: session.profile?.colorPalette?.mood || '',
        tone: '',
        pacing: session.profile?.pacing?.rhythm || 'moderate',
    };
    const directorsBrief = {
        tier: { sceneDensity: 3 },
    };

    // Run the two-pass split through THIS session (reuses loaded reference video + history)
    const mergedScenes = await _runTwoPassViaSession(session, microScenes, scriptContext, audioDuration, directorsBrief);

    // Save plan for build pickup
    const stylesDir = path.join(projectDir, 'styles');
    if (!fs.existsSync(stylesDir)) fs.mkdirSync(stylesDir, { recursive: true });
    const planPath = path.join(stylesDir, '.scene-plan.json');
    const plan = {
        version: 1,
        createdAt: Date.now(),
        audioDuration,
        transcriptPath,
        sessionId: session.id,
        scenes: mergedScenes.map(s => ({
            index: s.index,
            startTime: s.startTime,
            endTime: s.endTime,
            duration: s.duration,
            text: s.text,
            words: s.words,
        })),
    };
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    _log(`Saved scene plan: ${mergedScenes.length} scenes → ${planPath}`);

    // Build a human-readable reply
    const sample = mergedScenes.slice(0, 6).map((s, i) =>
        `${i + 1}. ${s.startTime.toFixed(1)}s-${s.endTime.toFixed(1)}s — "${(s.text || '').substring(0, 60)}${(s.text || '').length > 60 ? '…' : ''}"`
    ).join('\n');
    const reply = `✅ Planned **${mergedScenes.length} scenes** across ${audioDuration.toFixed(1)}s of narration.

**First scenes:**
${sample}
${mergedScenes.length > 6 ? `\n…and ${mergedScenes.length - 6} more.\n` : ''}
Plan saved to \`styles/.scene-plan.json\`. Your next build will use this split instead of the default AI merge. Ask me to tweak it ("tighten the hook", "merge scenes 4 and 5") or run "plan scenes" again to regenerate.`;

    session.history.push({ role: 'user', parts: [{ text: originalMessage }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });
    _saveSessionToDisk(session);

    return { reply, turnCount: session.history.length / 2, scenePlan: plan };
}

/**
 * Run the two-pass split using the current session directly (no restore).
 * Inlines the two-pass (outline → per-block split) logic here so we can reuse
 * this live Style Studio session instead of restoring a fresh one.
 */
async function _runTwoPassViaSession(session, microScenes, scriptContext, audioDuration, directorsBrief) {
    // Two-pass body: outline → per-block split, using this session's chat().
    //
    // Compact Pass 1: batch fragments into ~5s text groups with sparse timestamp anchors
    // so the prompt stays small (full fragment dump bloats session history and 400s on
    // follow-up calls when the reference video + history already fill a lot of context).
    const ANCHOR_INTERVAL = 5.0; // seconds between timestamp anchors
    const anchoredLines = [];
    let nextAnchor = 0;
    let buf = [];
    for (const s of microScenes) {
        if (s.startTime >= nextAnchor) {
            if (buf.length > 0) anchoredLines.push(buf.join(' '));
            anchoredLines.push(`[${Math.round(s.startTime)}s]`);
            buf = [];
            nextAnchor = s.startTime + ANCHOR_INTERVAL;
        }
        buf.push(s.text);
    }
    if (buf.length > 0) anchoredLines.push(buf.join(' '));
    const compactTranscript = anchoredLines.join(' ').replace(/\s+/g, ' ').trim();

    const projectCtxBlock = _buildProjectContextBlock();

    const primePrompt = `You've already watched and analyzed the reference video — you know its rhythm, idea density, and how the editor structures narrative beats. You also have full access to this codebase and the active project.

${projectCtxBlock}I'm building a NEW faceless YouTube video with this ${audioDuration.toFixed(1)}s narration. Timestamps are in [Ns] markers inline:

${compactTranscript}

TOPIC: ${scriptContext.summary || 'unknown'}
${scriptContext.theme ? `THEME: ${scriptContext.theme}` : ''}

Task: Read the whole transcript end-to-end first. Then give me an IDEA-BLOCK outline — major narrative sections where the visual focus clearly shifts. DO NOT split scenes yet. Just label the high-level blocks.

Output format — one block per line:
BLOCK <LABEL>: <startTime>-<endTime>

Example:
BLOCK HOOK: 0-14
BLOCK CONTEXT: 14-48
BLOCK MAIN_CLAIM: 48-120
BLOCK EVIDENCE: 120-210
BLOCK CONCLUSION: 210-${Math.round(audioDuration)}

Rules:
- First block = the HOOK (usually 8-25s, opens the video)
- Each block ends on a natural topic shift, not mid-sentence
- Cover the entire ${audioDuration.toFixed(1)}s — last block endTime must equal ${audioDuration.toFixed(1)}
- Aim for 4-8 blocks total
- Label with SHORT_UPPERCASE_TOKENS
- Output ONLY BLOCK lines, nothing else.`;

    const primeRes = await chat(session.id, primePrompt, {
        transcriptMode: 'none',
        requestLabel: 'scene-outline-pass',
        skipIntentDetection: true,
    });
    const outlineReply = primeRes?.reply || '';

    // Lenient parser — Gemini tends to decorate replies with markdown, bullets, or extra text.
    // Strip markdown bold/italic, leading bullet markers, and trailing "s" on seconds.
    const cleanLine = (l) => l
        .replace(/\*\*/g, '')
        .replace(/^\s*[-*•]\s*/, '')
        .replace(/^\s*\d+[.)]\s*/, '')
        .trim();

    // Accept multiple forms:
    //   BLOCK HOOK: 0-15
    //   HOOK: 0-15
    //   HOOK: 0s-15s
    //   BLOCK HOOK: 0.0s - 15.0s
    const blockRe = /(?:BLOCK\s+)?([A-Z][A-Z0-9_]{1,30})\s*[:\-–]\s*([0-9.]+)\s*s?\s*[-–—to]+\s*([0-9.]+)\s*s?/i;

    const blocks = [];
    for (const rawLine of outlineReply.split('\n')) {
        const line = cleanLine(rawLine);
        if (!line) continue;
        const m = line.match(blockRe);
        if (!m) continue;
        const start = parseFloat(m[2]);
        const end = parseFloat(m[3]);
        if (isNaN(start) || isNaN(end) || end <= start) continue;
        blocks.push({ label: m[1].toUpperCase(), start, end });
    }
    if (blocks.length < 2) {
        _log(`Outline parse failed. Raw reply (first 500 chars):\n${outlineReply.substring(0, 500)}`);
        throw new Error(`outline returned ${blocks.length} blocks (need ≥2)`);
    }

    blocks.sort((a, b) => a.start - b.start);
    blocks[0].start = 0;
    blocks[blocks.length - 1].end = audioDuration;
    for (let i = 1; i < blocks.length; i++) {
        if (blocks[i].start < blocks[i - 1].end) blocks[i].start = blocks[i - 1].end;
    }

    const fragmentsByBlock = blocks.map(() => []);
    for (let i = 0; i < microScenes.length; i++) {
        const mid = (microScenes[i].startTime + microScenes[i].endTime) / 2;
        let bi = blocks.findIndex(b => mid >= b.start && mid < b.end);
        if (bi === -1) bi = mid >= blocks[blocks.length - 1].start ? blocks.length - 1 : 0;
        fragmentsByBlock[bi].push(i);
    }

    const fps = 30;
    const hookEnd = Math.min(25, audioDuration * 0.12);
    const ctaStart = audioDuration * 0.92;
    const allMerged = [];

    for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];
        const fragIdx = fragmentsByBlock[bi];
        if (fragIdx.length === 0) continue;

        const isHookBlock = block.end <= hookEnd + 3;
        const isCtaBlock = block.start >= ctaStart - 3;
        const zoneLabel = isHookBlock ? 'HOOK' : isCtaBlock ? 'CTA' : 'BODY';
        const pacing = session.profile?.pacing?.rhythm || 'moderate';
        const density = isHookBlock ? (pacing === 'fast' ? 7 : pacing === 'slow' ? 4 : 5.5)
                      : isCtaBlock  ? (pacing === 'fast' ? 2.5 : 1.5)
                      :               (pacing === 'fast' ? 4 : pacing === 'slow' ? 2.5 : 3);
        const blockDur = block.end - block.start;
        const blockTarget = Math.max(1, Math.round((blockDur / 60) * density));

        const sceneRange = isHookBlock ? (pacing === 'fast' ? '2-3.5' : pacing === 'slow' ? '3-5' : '2-4')
                         : isCtaBlock  ? (pacing === 'fast' ? '5-8' : '6-10')
                         :               (pacing === 'fast' ? '3-7' : pacing === 'slow' ? '6-12' : '4-8');

        const fragLines = fragIdx.map(i =>
            `[${i}] (${microScenes[i].startTime.toFixed(1)}s-${microScenes[i].endTime.toFixed(1)}s) "${microScenes[i].text}"`
        ).join('\n');

        const splitPrompt = `Now split block "${block.label}" (${block.start.toFixed(1)}s-${block.end.toFixed(1)}s, ${zoneLabel} zone) into scenes.

A SCENE = one visual / one footage clip. If the visual would change, that's a NEW scene.

Fragments in this block:
${fragLines}

Target: ~${blockTarget} scenes, each ${sceneRange}s long.
Rules:
- Think FOOTAGE FIRST: if two fragments need the SAME clip → merge. Different clip → split.
- Commas mid-sentence are rarely cuts.
- New entity / location / concept / subject → new scene.
- Every fragment index MUST appear in exactly one SCENE line. No skipped indices.
- Match the reference video's pacing for ${zoneLabel} sections — you saw how they cut this kind of zone.

Output format — one line per scene:
SCENE 1: ${fragIdx[0]}${fragIdx.length > 1 ? ',' + fragIdx[1] : ''}
SCENE 2: ...

Output ONLY SCENE lines, nothing else.`;

        const res = await chat(session.id, splitPrompt, {
            transcriptMode: 'none',
            requestLabel: `scene-block-pass:${block.label}`,
            skipIntentDetection: true,
        });
        const reply = res?.reply || '';

        // Parse scene lines. Lenient: strip markdown/bullets, accept "SCENE 1:",
        // "**SCENE 1:**", "- SCENE 1:", "1. SCENE", etc. Extract all integers
        // after the first colon and keep the ones inside this block's frag range.
        const cleanLine = (l) => l
            .replace(/\*\*/g, '')
            .replace(/[*_`]/g, '')
            .replace(/^\s*[-*•]\s*/, '')
            .replace(/^\s*\d+[.)]\s*/, '')
            .trim();
        const lines = reply.trim().split('\n')
            .map(cleanLine)
            .filter(l => /^scene\b/i.test(l));
        const sceneObjs = [];
        const fragStart = fragIdx[0];
        const fragEnd = fragIdx[fragIdx.length - 1] + 1;
        for (const line of lines) {
            const colonIdx = line.indexOf(':');
            if (colonIdx < 0) continue;
            const after = line.substring(colonIdx + 1);
            const allInts = (after.match(/\d+/g) || []).map(n => parseInt(n, 10));
            const indices = allInts.filter(n => !isNaN(n) && n >= fragStart && n < fragEnd);
            if (indices.length === 0) continue;
            const mergedWords = [];
            let startTime = Infinity, endTime = 0;
            for (const idx of indices) {
                const ms = microScenes[idx];
                if (!ms) continue;
                mergedWords.push(...(ms.words || []));
                if (ms.startTime < startTime) startTime = ms.startTime;
                if (ms.endTime > endTime) endTime = ms.endTime;
            }
            if (mergedWords.length === 0) continue;
            sceneObjs.push({
                text: mergedWords.map(w => w.word).join(' ').trim(),
                startTime,
                endTime,
                duration: Math.round((endTime - startTime) * fps),
                words: mergedWords,
                _indices: indices,
            });
        }
        if (sceneObjs.length === 0) {
            _log(`Block ${block.label} parse failed. Raw reply (first 500 chars):\n${reply.substring(0, 500)}`);
            throw new Error(`parse failed on block ${block.label}`);
        }

        const covered = new Set();
        for (const s of sceneObjs) for (const idx of (s._indices || [])) covered.add(idx);
        const missing = fragIdx.filter(i => !covered.has(i));
        for (const idx of missing) {
            const ms = microScenes[idx];
            let best = sceneObjs[sceneObjs.length - 1];
            for (const s of sceneObjs) {
                if (s.endTime <= ms.startTime || Math.abs(s.endTime - ms.startTime) < 0.5) best = s;
            }
            best.text += ' ' + (ms.text || '');
            best.words.push(...(ms.words || []));
            if (ms.endTime > best.endTime) best.endTime = ms.endTime;
            best.duration = Math.round((best.endTime - best.startTime) * fps);
        }

        allMerged.push(...sceneObjs);
    }

    allMerged.forEach((s, i) => { s.index = i; delete s._indices; });
    const last = allMerged[allMerged.length - 1];
    if (audioDuration > last.endTime + 0.3) {
        last.endTime = audioDuration;
        last.duration = Math.round((last.endTime - last.startTime) * fps);
    }
    return allMerged;
}

/**
 * Parse SCENE lines (with visual fields) and optional BRIEF block from the model's
 * recent replies. Saves a combined `.studio-plan.json` that the build pipeline can
 * use to skip Steps 3 (Director) + 4 (Visual Planner) entirely.
 */
async function _handleSaveScenePlan(session, originalMessage) {
    // Collect text from ALL model replies in order (oldest → newest). User may have
    // split the video across many turns; we need every SCENE line. Strip markdown
    // bold (**) and backticks so the regex matches Gemini's styled replies like
    // **SCENE 54: 481.0s-490.2s** | `keyword: X`.
    const modelReplyTexts = session.history
        .filter(h => h.role === 'model')
        .map(h => (h.parts || []).map(p => p.text || '').join('\n')
            .replace(/\*\*/g, '')
            .replace(/`/g, ''));
    const modelReplies = modelReplyTexts.join('\n\n');

    if (!modelReplies.trim()) throw new Error('No model replies to parse');

    // --- Parse BRIEF block ---
    const brief = {};
    const briefMatch = modelReplies.match(/BRIEF\s*:?\s*\n([\s\S]*?)(?=\n\s*SCENE\s+\d|\n\n\n|$)/i);
    if (briefMatch) {
        const briefLines = briefMatch[1].split('\n');
        for (const line of briefLines) {
            const cleaned = line.replace(/^\s*[-•*]\s*/, '').trim();
            const colonIdx = cleaned.indexOf(':');
            if (colonIdx < 0) continue;
            const key = cleaned.substring(0, colonIdx).trim().toLowerCase();
            const val = cleaned.substring(colonIdx + 1).trim();
            if (!val) continue;
            if (key === 'niche') brief.nicheId = val;
            else if (key === 'theme') brief.themeId = val;
            else if (key === 'format') brief.format = val.toLowerCase();
            else if (key === 'pacing') brief.pacing = val.toLowerCase();
            else if (key === 'summary') brief.summary = val;
            else if (key === 'tone') brief.tone = val;
            else if (key === 'entities') {
                brief.entities = [];
                brief.entityTypes = {};
                for (const e of val.split(',').map(s => s.trim()).filter(Boolean)) {
                    const tagM = e.match(/^(.+?)\s*\[(person|place|org|event)\]\s*$/i);
                    if (tagM) {
                        brief.entities.push(tagM[1].trim());
                        brief.entityTypes[tagM[1].trim().toLowerCase()] = tagM[2].toLowerCase();
                    } else {
                        brief.entities.push(e);
                    }
                }
            }
            else if (key === 'hookend' || key === 'hook end') {
                const n = parseFloat(val); if (!isNaN(n)) brief.hookEndTime = n;
            }
            else if (key === 'ctastart' || key === 'cta start') {
                if (val.toLowerCase() !== 'none') {
                    const n = parseFloat(val); if (!isNaN(n)) { brief.ctaDetected = true; brief.ctaStartTime = n; }
                }
            }
            else if (key === 'eventtype' || key === 'event type') brief.eventType = val.toLowerCase();
        }
    }

    // --- Parse SCENE lines with visual fields ---
    // Format: SCENE N: 0.0s-4.5s | keyword: X | sourceHint: Y | ...
    //
    // Newer replies win when ranges overlap. We parse each model reply separately,
    // iterate newest → oldest, and only accept a scene if its range doesn't overlap
    // anything already accepted. This handles the case where the user asked the
    // agent to re-split a range — the newer split wins and the older one is dropped.
    const sceneLineRe = /SCENE\s+\d+\s*:\s*(\d+\.?\d*)\s*s?\s*[-–—to]+\s*(\d+\.?\d*)\s*s?\s*\|(.+)/gmi;
    const simpleSceneRe = /SCENE\s*\d+\s*:\s*(\d+\.?\d*)\s*s?\s*[-–—to]+\s*(\d+\.?\d*)\s*s?\s*[-–—:]+\s*["""]?(.+?)["""]?\s*$/gmi;

    const parseSceneLine = (sm) => {
        const start = parseFloat(sm[1]);
        const end = parseFloat(sm[2]);
        if (isNaN(start) || isNaN(end) || end <= start) return null;
        const scene = { startTime: start, endTime: end };
        const parts = sm[3].split('|').map(p => p.trim());
        for (const part of parts) {
            const ci = part.indexOf(':');
            if (ci < 0) continue;
            const k = part.substring(0, ci).trim().toLowerCase().replace(/\s+/g, '');
            const v = part.substring(ci + 1).trim().replace(/^["']+|["']+$/g, '');
            if (!v || v.toLowerCase() === 'none') continue;
            if (k === 'keyword') scene.keyword = v;
            else if (k === 'stockquery') scene.stockQuery = v;
            else if (k === 'webquery') scene.webQuery = v;
            else if (k === 'sourcehint') scene.sourceHint = v.toLowerCase();
            else if (k === 'framing') scene.framing = v.toLowerCase();
            else if (k === 'effects') scene.effectPreset = v;
            else if (k === 'mghint') scene.mgHint = v;
            else if (k === 'fullscreenmg') scene.fullscreenMG = v;
            else if (k === 'templatehint') scene.templateHint = v;
            else if (k === 'visualintent') scene.visualIntent = v;
            else if (k === 'backgroundid') scene.backgroundId = v;
            else if (k === 'floatinganim') scene.floatingAnim = v;
        }
        return scene;
    };

    // Accepted scenes, sorted by startTime. Reject any candidate that overlaps >0.1s.
    const accepted = [];
    const overlapsAccepted = (s) => {
        for (const a of accepted) {
            if (s.startTime < a.endTime - 0.1 && s.endTime > a.startTime + 0.1) return true;
        }
        return false;
    };
    const insertSorted = (s) => {
        let i = 0;
        while (i < accepted.length && accepted[i].startTime < s.startTime) i++;
        accepted.splice(i, 0, s);
    };

    // Walk replies newest → oldest so the most recent split of any range wins.
    for (let ri = modelReplyTexts.length - 1; ri >= 0; ri--) {
        const text = modelReplyTexts[ri];
        sceneLineRe.lastIndex = 0;
        const replyScenes = [];
        let sm;
        while ((sm = sceneLineRe.exec(text)) !== null) {
            const s = parseSceneLine(sm);
            if (s) replyScenes.push(s);
        }
        // Sort this reply's scenes by startTime so overlap check is stable
        replyScenes.sort((a, b) => a.startTime - b.startTime);
        for (const s of replyScenes) {
            if (!overlapsAccepted(s)) insertSorted(s);
        }
    }

    // Fallback: try simpler format across the full concatenated text
    if (accepted.length < 2) {
        let sm;
        simpleSceneRe.lastIndex = 0;
        while ((sm = simpleSceneRe.exec(modelReplies)) !== null) {
            const start = parseFloat(sm[1]);
            const end = parseFloat(sm[2]);
            const text = sm[3].trim().replace(/^["']+|["']+$/g, '');
            if (!isNaN(start) && !isNaN(end) && end > start && text) {
                const s = { startTime: start, endTime: end, _rawText: text };
                if (!overlapsAccepted(s)) insertSorted(s);
            }
        }
    }

    const scenes = accepted;

    if (scenes.length < 2) {
        const reply = `I couldn't find enough scene definitions in my recent replies to save a plan. Ask me to split a section first (e.g., "split the first 2 minutes into scenes"), then say "save plan" once you're happy.`;
        session.history.push({ role: 'user', parts: [{ text: originalMessage }] });
        session.history.push({ role: 'model', parts: [{ text: reply }] });
        _saveSessionToDisk(session);
        return { reply, turnCount: session.history.length / 2, scenePlan: null };
    }

    // Load transcript for word-level timestamps
    const projectDir = process.env.PROJECT_DIR || process.cwd();
    let transcription = null;
    try {
        const trPath = path.join(projectDir, 'temp', 'transcription.json');
        if (fs.existsSync(trPath)) transcription = JSON.parse(fs.readFileSync(trPath, 'utf8'));
    } catch (_) {}

    const allWords = [];
    if (transcription) {
        for (const seg of (transcription.segments || [])) {
            for (const w of (seg.words || [])) allWords.push(w);
        }
    }

    const fps = 30;
    const planScenes = scenes.map((s, i) => {
        const words = allWords.filter(w => w.start >= s.startTime - 0.1 && w.end <= s.endTime + 0.1);
        return {
            index: i,
            startTime: s.startTime,
            endTime: s.endTime,
            duration: Math.round((s.endTime - s.startTime) * fps),
            text: words.length > 0 ? words.map(w => w.word).join(' ').trim() : (s._rawText || ''),
            words: words.length > 0 ? words : [],
            // Visual fields (from combined format)
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
        };
    });

    const audioDuration = transcription?.duration || scenes[scenes.length - 1].endTime;
    const hasVisualFields = planScenes.some(s => s.keyword);
    const hasBrief = Object.keys(brief).length > 0;

    // Coverage check: refuse to save if the plan leaves more than 5s of the audio
    // unaccounted for (either at the start, between scenes, or at the end).
    const GAP_TOLERANCE = 5.0;
    const gaps = [];
    const firstStart = planScenes[0].startTime;
    if (firstStart > GAP_TOLERANCE) {
        gaps.push(`0s → ${firstStart.toFixed(1)}s (start)`);
    }
    for (let i = 1; i < planScenes.length; i++) {
        const gap = planScenes[i].startTime - planScenes[i - 1].endTime;
        if (gap > GAP_TOLERANCE) {
            gaps.push(`${planScenes[i - 1].endTime.toFixed(1)}s → ${planScenes[i].startTime.toFixed(1)}s`);
        }
    }
    const tailGap = audioDuration - planScenes[planScenes.length - 1].endTime;
    if (tailGap > GAP_TOLERANCE) {
        gaps.push(`${planScenes[planScenes.length - 1].endTime.toFixed(1)}s → ${audioDuration.toFixed(1)}s (end)`);
    }
    if (gaps.length > 0) {
        const reply = `⚠️ I can't save this plan yet — there are coverage gaps against the ${audioDuration.toFixed(1)}s audio:\n\n${gaps.map(g => `- ${g}`).join('\n')}\n\nSplit those ranges first ("split ${gaps[0]}"), then say "save plan" again. The audio must be fully covered before I save.`;
        session.history.push({ role: 'user', parts: [{ text: originalMessage }] });
        session.history.push({ role: 'model', parts: [{ text: reply }] });
        _saveSessionToDisk(session);
        return { reply, turnCount: session.history.length / 2, scenePlan: null };
    }

    const stylesDir = path.join(projectDir, 'styles');
    if (!fs.existsSync(stylesDir)) fs.mkdirSync(stylesDir, { recursive: true });

    const plan = {
        version: 2,
        createdAt: Date.now(),
        audioDuration,
        sessionId: session.id,
        interactive: true,
        ...(hasBrief && { brief }),
        hasVisualPlan: hasVisualFields,
        scenes: planScenes,
    };

    // Save as .studio-plan.json (combined) — build pipeline checks this first
    const planPath = path.join(stylesDir, '.studio-plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    _log(`Saved studio plan: ${planScenes.length} scenes, brief=${hasBrief}, visuals=${hasVisualFields} → ${planPath}`);

    // Also write .scene-plan.json for backward compat (scene boundaries only)
    const scenePlanPath = path.join(stylesDir, '.scene-plan.json');
    const scenePlan = {
        version: 1,
        createdAt: Date.now(),
        audioDuration,
        sessionId: session.id,
        interactive: true,
        scenes: planScenes.map(s => ({
            index: s.index, startTime: s.startTime, endTime: s.endTime,
            duration: s.duration, text: s.text, words: s.words,
        })),
    };
    fs.writeFileSync(scenePlanPath, JSON.stringify(scenePlan, null, 2));

    const parts = [];
    parts.push(`**${planScenes.length} scenes**`);
    if (hasBrief) parts.push(`director's brief (${brief.nicheId || 'auto'} / ${brief.themeId || 'auto'})`);
    if (hasVisualFields) parts.push(`visual plan (keywords, sources, effects)`);

    const reply = `✅ Saved ${parts.join(' + ')} to \`styles/.studio-plan.json\`.\n\nYour next build will use this plan — ${hasBrief ? 'skipping Steps 3+4 entirely' : hasVisualFields ? 'skipping Step 4 (Visual Planner)' : 'using these scene boundaries'}.\n\nKeep refining — "split the next section", "change scene 5 to use youtube footage", or "plan all scenes" for the full transcript.`;
    session.history.push({ role: 'user', parts: [{ text: originalMessage }] });
    session.history.push({ role: 'model', parts: [{ text: reply }] });
    _saveSessionToDisk(session);

    return { reply, turnCount: session.history.length / 2, scenePlan: plan };
}

/**
 * Add another reference video to an existing session. Useful for channel-style
 * learning where you want to compare/merge multiple videos in one conversation.
 */
async function addVideo(sessionId, input, onProgress) {
    const session = _getSession(sessionId);
    if (session.videos.length >= 6) {
        throw new Error('Session already has 6 videos — start a new session for more.');
    }

    const video = await _ingestVideo(input, session.saveDir, onProgress || (() => {}));
    session.videos.push(video);
    _log(`Session ${sessionId}: added video "${video.title}" (now ${session.videos.length} total)`);

    // Video set changed — the existing context cache is stale. Drop it so the
    // next chat turn creates a fresh cache covering all videos.
    await _invalidateVideoCache(session, 'video added').catch(() => {});

    // Tell the model about the new video. Since history already exists, we need
    // to explicitly include the new file_data in this turn.
    const announcePrompt = `A NEW reference video has been added to this session. Watch it and give me a 100-word briefing similar to the first one.

New video:
- Title: "${video.title}"
- Duration: ${video.duration} seconds
- Source: ${video.sourceUrl || video.localPath}`;

    // Build a turn that includes ALL current video parts (re-attaching is free)
    // and the announcement text.
    const contents = [...session.history];
    contents.push({
        role: 'user',
        parts: [
            { file_data: { mime_type: video.mimeType, file_uri: video.fileUri } },
            { text: announcePrompt },
        ],
    });

    const useVertex = vertex.isVertexEnabled();
    const model = _getReasoningModel();
    const body = {
        systemInstruction: { parts: [{ text: _systemPrompt() }] },
        contents,
        generationConfig: { maxOutputTokens: 1500, temperature: 0.4 },
    };

    let reply = '';
    try {
        let url, headers;
        if (useVertex) {
            const auth = await vertex.getVertexAuth(model);
            url = auth.url; headers = auth.headers;
        } else {
            const next = _getNextKey();
            if (!next) throw new Error('No keys available');
            url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${next.key}`;
            headers = { 'Content-Type': 'application/json' };
        }
        const resp = await axios.post(url, body, { headers, timeout: 300000 });
        reply = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        video.analyzed = true;
        video.analysisError = null;
    } catch (e) {
        video.analyzed = false;
        video.analysisError = e.response?.data?.error?.message || e.message;
        reply = `(Could not analyze new video: ${video.analysisError}. Say "retry video ${session.videos.length}" to try again.)`;
    }

    // Persist the turn (with the new video part attached) so future turns see it
    session.history.push({
        role: 'user',
        parts: [
            { file_data: { mime_type: video.mimeType, file_uri: video.fileUri } },
            { text: announcePrompt },
        ],
    });
    session.history.push({ role: 'model', parts: [{ text: reply }] });

    // Auto-save session to disk
    _saveSessionToDisk(session);

    // Auto-learn from the new video analysis (non-blocking)
    if (video.analyzed) {
        _autoLearnFromAnalysis(session, video.title, reply).catch(() => {});
    }

    return {
        videoCount: session.videos.length,
        videos: session.videos.map(v => ({
            title: v.title, duration: v.duration, sourceUrl: v.sourceUrl,
            analyzed: v.analyzed, analysisError: v.analysisError,
        })),
        message: reply,
    };
}

/**
 * Ask the agent to extract a final structured style profile from the conversation.
 * Returns the parsed JSON profile (NOT yet saved).
 */
async function extractProfile(sessionId) {
    const session = _getSession(sessionId);
    if (session.videos.length === 0) throw new Error('No videos in session');

    const prompt = _profileExtractionPrompt(session.videos.length);
    const text = await _callGemini(session, prompt, {
        maxOutputTokens: 8192,
        temperature: 0.2,
        requestLabel: 'extract-profile',
    });

    // Persist the turn so the profile request becomes part of conversation context
    session.history.push({ role: 'user', parts: [{ text: prompt }] });
    session.history.push({ role: 'model', parts: [{ text }] });

    const parsed = styleLearner._parseProfileJSON(text);
    if (!parsed) {
        throw new Error('Could not parse profile JSON. Raw response: ' + text.slice(0, 500));
    }

    const normalized = _normalizeExtractedProfile(parsed, session);

    // Stamp authoritative metadata
    normalized.version = 2;
    normalized.createdAt = new Date().toISOString();
    if (session.videos.length > 1) {
        normalized.mergedFrom = session.videos.length;
        normalized.sourceUrls = session.videos.map(v => v.sourceUrl || v.localPath).filter(Boolean);
    } else {
        normalized.sourceUrl = session.videos[0].sourceUrl;
        normalized.sourceFile = session.videos[0].sourceUrl ? null : session.videos[0].localPath;
    }
    // CRITICAL: Use the actual yt-dlp/ffmpeg duration, never trust Gemini's guess.
    const totalDuration = session.videos.reduce((sum, v) => sum + (v.duration || 0), 0);
    normalized.videoDuration = session.videos.length > 1
        ? Math.round(totalDuration / session.videos.length)
        : (session.videos[0].duration || normalized.videoDuration || 0);

    session.profile = normalized;

    // Auto-save session to disk
    _saveSessionToDisk(session);

    return normalized;
}

/**
 * Save the current session's profile to disk.
 */
function saveProfile(sessionId, profileName) {
    const session = _getSession(sessionId);
    if (!session.profile || Object.keys(session.profile).length === 0) {
        throw new Error('No profile extracted yet — call extractProfile first');
    }
    const profile = {
        ..._normalizeExtractedProfile(session.profile, session),
        name: profileName || session.profile.name || 'Studio Profile',
    };
    const reusePath = session.profile.savedPath && fs.existsSync(session.profile.savedPath)
        ? session.profile.savedPath
        : null;
    const savedPath = styleLearner.saveStyleProfile(profile, session.saveDir, reusePath);
    profile.savedPath = savedPath;
    session.profile = profile;
    _saveSessionToDisk(session);
    return profile;
}

/**
 * Get current session state for the UI (videos, history, profile).
 */
function getSessionInfo(sessionId) {
    const session = _getSession(sessionId);
    return {
        id: session.id,
        videos: session.videos.map(v => ({
            title: v.title,
            duration: v.duration,
            sourceUrl: v.sourceUrl,
            analyzed: v.analyzed,
            analysisError: v.analysisError,
        })),
        turnCount: session.history.length / 2,
        hasProfile: !!(session.profile && Object.keys(session.profile).length > 0),
        profile: _normalizeExtractedProfile(session.profile, session),
        createdAt: session.createdAt,
        thinkingMode: session.thinkingMode,
        fps: session.fps,
        codeAccess: session.codeAccess,
        webSearch: session.webSearch,
        projectAnalysis: session.projectAnalysis || null,
        usageTotals: session.usageTotals || null,
    };
}

/**
 * End a session: delete all uploaded files from Gemini/GCS and clear local state.
 */
async function endSession(sessionId) {
    const session = _sessions.get(sessionId);
    if (!session) return { ok: true, alreadyEnded: true };

    // Delete Vertex context cache if we created one
    if (session.videoCacheName) {
        await vertex.deleteCache(session.videoCacheName).catch(() => {});
    }

    for (const v of session.videos) {
        try {
            await styleLearner._deleteGeminiFile(v.fileName, v.apiKeyUsedForUpload, v.isGCS);
        } catch (e) {
            _log(`Could not delete remote file ${v.fileName}: ${e.message}`);
        }
        if (v.isTemp && v.localPath && fs.existsSync(v.localPath)) {
            try { fs.unlinkSync(v.localPath); } catch (e) {}
        }
    }
    // Delete saved session file (memory persists separately)
    deleteSavedSession(session.saveDir);

    _sessions.delete(sessionId);
    _log(`Session ${sessionId} ended`);
    return { ok: true };
}

/**
 * List all active sessions (for UI sidebar).
 */
function listSessions() {
    return Array.from(_sessions.values()).map(s => ({
        id: s.id,
        videoCount: s.videos.length,
        firstTitle: s.videos[0]?.title || '(empty)',
        turnCount: s.history.length / 2,
        createdAt: s.createdAt,
        hasProfile: !!(s.profile && Object.keys(s.profile).length > 0),
    }));
}

/**
 * Toggle code access for an active session.
 */
function setCodeAccess(sessionId, enabled) {
    const session = _getSession(sessionId);
    session.codeAccess = !!enabled;
    _log(`Session ${sessionId}: codeAccess = ${session.codeAccess}`);
    return { codeAccess: session.codeAccess };
}

module.exports = {
    startSession,
    chat,
    addVideo,
    analyzeScript,
    extractProfile,
    saveProfile,
    getSessionInfo,
    endSession,
    listSessions,
    setCodeAccess,
    // Persistence
    loadSavedSession,
    restoreSession,
    deleteSavedSession,
    clearChatHistory,
    setLiveProjectContext,
    // Memory
    loadMemory,
    saveMemoryEntry,
    deleteMemoryEntry,
    clearMemory,
    // Shared project-context helper (used by ai-director's build-path two-pass)
    _buildProjectContextBlock,
};
