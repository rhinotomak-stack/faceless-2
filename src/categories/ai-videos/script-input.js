// src/categories/ai-videos/script-input.js
// ============================================================================
// Step 1 of the AI Videos pipeline: turn whatever the creator pasted — a story,
// a script, or (later) a URL/file — into ONE clean, normalized script string the
// scene planner can split. Isolated + pure (no I/O, no AI) so it's trivially
// unit-testable and safe to extend.
// ============================================================================
'use strict';

// A rough URL/file detector — a single line that looks like a link or a path,
// so the caller can decide to fetch it (fetching itself is added later, out of scope
// for this pure module).
function isLink(input) {
    const s = String(input || '').trim();
    if (!s || /\s/.test(s)) return false; // multi-word = it's a script, not a link
    return /^(https?:\/\/|www\.|file:\/\/|[a-zA-Z]:\\|\/)/.test(s) || /\.(txt|md|docx?|pdf)$/i.test(s);
}

// Normalize pasted text into a clean script: strip markdown noise, collapse runs of
// blank lines to paragraph breaks, trim each line, drop zero-width junk. Deterministic.
function normalizeScript(input) {
    let s = String(input == null ? '' : input);
    s = s.replace(/\r\n?/g, '\n');                    // CRLF/CR → LF
    s = s.replace(/[​-‍﻿]/g, '');       // zero-width chars
    s = s.replace(/^#{1,6}\s+/gm, '');                 // markdown headings → plain
    s = s.replace(/[*_`]{1,3}(.+?)[*_`]{1,3}/g, '$1'); // **bold**/_em_/`code` → text
    s = s.replace(/^\s*[-*+]\s+/gm, '');               // list bullets → plain lines
    s = s.split('\n').map((l) => l.trim()).join('\n'); // trim each line
    s = s.replace(/\n{3,}/g, '\n\n');                  // ≤ one blank line between paragraphs
    return s.trim();
}

// Convenience: paragraph blocks (blank-line separated) — a cheap first cut the scene
// planner can refine. Returns [] for empty input.
function toParagraphs(scriptText) {
    const t = normalizeScript(scriptText);
    if (!t) return [];
    return t.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
}

// A quick, cheap word count — used for rough duration/scene-count estimates upstream.
function wordCount(scriptText) {
    const t = normalizeScript(scriptText);
    return t ? t.split(/\s+/).filter(Boolean).length : 0;
}

module.exports = { isLink, normalizeScript, toParagraphs, wordCount };
