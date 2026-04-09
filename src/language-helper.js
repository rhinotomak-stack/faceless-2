/**
 * Language Helper — all language-aware logic lives here.
 *
 * Other files should NEVER branch on a language code directly. Instead, they
 * call these helpers which read from the languages.js registry. This way,
 * adding a new language is a config-only change (one entry in languages.js)
 * and NO system code needs to be touched.
 *
 * USAGE PATTERNS:
 *
 *   // In AI prompts (ai-director, ai-motion-graphics, ai-templates):
 *   const { getLanguageBlock } = require('./language-helper');
 *   prompt += getLanguageBlock(scriptContext.language);
 *
 *   // In MG font resolution (MGRenderer, app.js):
 *   const fonts = resolveLanguageFonts(themeFonts, scriptContext.language);
 *   ctx.font = `bold 48px ${fonts.heading}`;
 *
 *   // In transcription:
 *   const code = getWhisperLanguage(scriptContext.language);
 */

const { getLanguage, isValidLanguage, DEFAULT_LANGUAGE } = require('./languages');

/**
 * Build the language instruction block to append to any AI prompt that
 * produces user-facing text. Returns a multi-line string ready to concat.
 *
 * The block is IDEMPOTENT — appending it twice is safe but wasteful.
 * Callers should add it once per prompt, at the end after all other instructions.
 *
 * If the language is 'en' or undefined, returns a minimal English reinforcement
 * (still useful for prompts where default output language might drift).
 *
 * @param {string} lang - language code (e.g. 'en', 'es', 'ko')
 * @returns {string} — a \n\n-prefixed instruction block, or '' if English and no reinforcement wanted
 */
function getLanguageBlock(lang) {
    const language = getLanguage(lang);
    return `\n\n━━━ OUTPUT LANGUAGE ━━━\n${language.promptInstruction}\n━━━━━━━━━━━━━━━━━━━━━━━`;
}

/**
 * Resolve the font chain for a given theme + language + role.
 *
 * Strategy:
 *   - If the language has no fontOverrides (e.g. English, Spanish, German, French, Italian),
 *     return the theme's existing font chain unchanged.
 *   - If the language has fontOverrides (e.g. Korean with CJK fonts), PREPEND them
 *     to the theme's chain. This way Korean headings fall back to Latin display fonts
 *     for mixed Korean+English text, and the visual style of the theme is preserved
 *     where possible.
 *
 * @param {{heading: string, body: string}} themeFonts - the theme's existing font object
 * @param {string} lang - language code
 * @param {string} [role='heading'|'body'] - which font to resolve (default: resolves both)
 * @returns {{heading: string, body: string}} — resolved font chains ready for ctx.font
 */
function resolveLanguageFonts(themeFonts, lang) {
    const language = getLanguage(lang);
    const fallback = {
        heading: themeFonts?.heading || 'Arial, sans-serif',
        body: themeFonts?.body || 'Arial, sans-serif',
    };

    // No override = use theme fonts as-is
    if (!language.fontOverrides) return fallback;

    const merged = { ...fallback };
    if (Array.isArray(language.fontOverrides.heading)) {
        // Prepend language fonts, then append theme chain so mixed scripts still render
        merged.heading = `${language.fontOverrides.heading.join(', ')}, ${fallback.heading}`;
    }
    if (Array.isArray(language.fontOverrides.body)) {
        merged.body = `${language.fontOverrides.body.join(', ')}, ${fallback.body}`;
    }
    return merged;
}

/**
 * Get the Whisper language code for a given language. Whisper's codes match
 * our ISO 639-1 codes so this is a passthrough, but going through the helper
 * means we can remap later (e.g. if we add a language whose Whisper code differs).
 *
 * Returns null if language is unknown — caller should omit the language= param
 * to let Whisper auto-detect.
 */
function getWhisperLanguage(lang) {
    if (!isValidLanguage(lang)) return null;
    return getLanguage(lang).whisperCode;
}

/**
 * Resolve the language to use for a build, given:
 *   - An explicit override (UI dropdown value) — takes priority if valid
 *   - An auto-detected language from Whisper — used if override is 'auto' or empty
 *   - A default fallback (English)
 *
 * @param {string|null} override - user-selected language, or 'auto', or null
 * @param {string|null} detected - language detected by Whisper (e.g. from transcription.language)
 * @returns {string} — final language code to use for this build
 */
function resolveBuildLanguage(override, detected) {
    // Explicit override wins (as long as it's valid and not 'auto')
    if (override && override !== 'auto' && isValidLanguage(override)) {
        return override;
    }
    // Auto-detect from Whisper if the detected lang is one we support
    if (detected && isValidLanguage(detected)) {
        return detected;
    }
    // Fallback to English
    return DEFAULT_LANGUAGE;
}

/**
 * Get Google Fonts import URL for a language's custom fonts.
 * Returns null if the language uses theme fonts (no external load needed).
 * Used by the UI to inject a <link> tag only when needed.
 *
 * @param {string} lang - language code
 * @returns {string|null} — full Google Fonts URL or null
 */
function getGoogleFontsUrl(lang) {
    const language = getLanguage(lang);
    if (!language.googleFontsImport || language.googleFontsImport.length === 0) return null;
    const families = language.googleFontsImport.map(f => `family=${f}`).join('&');
    return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

/**
 * Quick check: does this language need RTL layout? (For future RTL support —
 * Arabic/Hebrew/etc. Currently none of our 6 supported languages are RTL.)
 */
function isRTL(lang) {
    return getLanguage(lang).direction === 'rtl';
}

module.exports = {
    getLanguageBlock,
    resolveLanguageFonts,
    getWhisperLanguage,
    resolveBuildLanguage,
    getGoogleFontsUrl,
    isRTL,
};
