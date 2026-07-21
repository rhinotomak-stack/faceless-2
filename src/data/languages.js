(() => {
/**
 * Language Registry — single source of truth for multi-language support.
 *
 * ADDING A NEW LANGUAGE:
 *   Add one entry below. No other code changes required.
 *   Example: japanese = add { ja: { name, whisperCode, fontOverrides, promptInstruction } }
 *
 * FIELDS:
 *   name              — human-readable name (used in UI dropdowns)
 *   nativeName        — name in the language itself
 *   whisperCode       — ISO 639-1 code Whisper uses (en, es, de, fr, it, ko, ja, zh, ...)
 *   direction         — 'ltr' | 'rtl'  (currently no RTL languages enabled)
 *   fontOverrides     — null = inherit theme fonts; or { heading: [...], body: [...] } to prepend
 *                       language-specific fonts before the theme's fallback chain
 *   googleFontsImport — array of Google Fonts `family=` query parts to load (only when fontOverrides is set)
 *                       null if no external font loading needed
 *   promptInstruction — string appended to AI prompts telling the model to write user-facing text
 *                       in this language. Search keywords MUST always stay English regardless.
 *
 * FLEXIBILITY RULE:
 *   Nothing in the rest of the codebase should branch on language. Language-aware code should
 *   only read from this registry via src/language-helper.js. If you find yourself writing
 *   `if (lang === 'ko')` anywhere outside this file or the helper, stop and refactor.
 */

const LANGUAGES = {
    en: {
        name: 'English',
        nativeName: 'English',
        whisperCode: 'en',
        direction: 'ltr',
        fontOverrides: null,
        googleFontsImport: null,
        promptInstruction:
            'All user-facing text (scene titles, MG text, MG titles, MG subtext, template content, labels, captions) MUST be written in English. Search keywords and footage queries stay in English.',
    },

    es: {
        name: 'Spanish',
        nativeName: 'Español',
        whisperCode: 'es',
        direction: 'ltr',
        fontOverrides: null,
        googleFontsImport: null,
        promptInstruction:
            'All user-facing text (scene titles, MG text, MG titles, MG subtext, template content, labels, captions) MUST be written in Spanish (Español). Use proper Spanish punctuation and accents (¿ ¡ á é í ó ú ñ). IMPORTANT: Search keywords and footage queries stay in English for stock providers.',
    },

    de: {
        name: 'German',
        nativeName: 'Deutsch',
        whisperCode: 'de',
        direction: 'ltr',
        fontOverrides: null,
        googleFontsImport: null,
        promptInstruction:
            'All user-facing text (scene titles, MG text, MG titles, MG subtext, template content, labels, captions) MUST be written in German (Deutsch). Use proper German capitalization for nouns and umlauts (ä ö ü ß). IMPORTANT: Search keywords and footage queries stay in English for stock providers.',
    },

    fr: {
        name: 'French',
        nativeName: 'Français',
        whisperCode: 'fr',
        direction: 'ltr',
        fontOverrides: null,
        googleFontsImport: null,
        promptInstruction:
            'All user-facing text (scene titles, MG text, MG titles, MG subtext, template content, labels, captions) MUST be written in French (Français). Use proper French accents and punctuation (à â ç é è ê ë î ï ô û ù ü « »). IMPORTANT: Search keywords and footage queries stay in English for stock providers.',
    },

    it: {
        name: 'Italian',
        nativeName: 'Italiano',
        whisperCode: 'it',
        direction: 'ltr',
        fontOverrides: null,
        googleFontsImport: null,
        promptInstruction:
            'All user-facing text (scene titles, MG text, MG titles, MG subtext, template content, labels, captions) MUST be written in Italian (Italiano). Use proper Italian accents (à è é ì ò ù). IMPORTANT: Search keywords and footage queries stay in English for stock providers.',
    },

    ko: {
        name: 'Korean',
        nativeName: '한국어',
        whisperCode: 'ko',
        direction: 'ltr',
        // Korean needs CJK fonts — Latin theme fonts can't render Hangul.
        // Strategy: heavy display font for headings (YouTube-thumbnail energy), Noto Sans for body.
        fontOverrides: {
            heading: ['"Black Han Sans"', '"Noto Sans KR"', '"Nanum Gothic"', 'sans-serif'],
            body:    ['"Noto Sans KR"', '"Nanum Gothic"', '"Malgun Gothic"', 'sans-serif'],
        },
        googleFontsImport: [
            'Black+Han+Sans',
            'Noto+Sans+KR:wght@400;500;700;900',
        ],
        promptInstruction:
            'All user-facing text (scene titles, MG text, MG titles, MG subtext, template content, labels, captions) MUST be written in Korean (한국어). Use natural Korean grammar and honorifics appropriate for a YouTube video audience. IMPORTANT: Search keywords and footage queries stay in English for stock providers.',
    },
};

const DEFAULT_LANGUAGE = 'en';

/**
 * Get a language definition. Falls back to English if the code is unknown.
 */
function getLanguage(code) {
    return LANGUAGES[code] || LANGUAGES[DEFAULT_LANGUAGE];
}

/**
 * Check if a language code is registered.
 */
function isValidLanguage(code) {
    return typeof code === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

/**
 * List all supported language codes.
 */
function getSupportedLanguages() {
    return Object.keys(LANGUAGES);
}

/**
 * Get the list of supported languages as display objects for UI dropdowns.
 * Returns: [{ code, name, nativeName }, ...]
 */
function getLanguageList() {
    return Object.entries(LANGUAGES).map(([code, def]) => ({
        code,
        name: def.name,
        nativeName: def.nativeName,
    }));
}

const LANGUAGE_API = {
    LANGUAGES,
    DEFAULT_LANGUAGE,
    getLanguage,
    isValidLanguage,
    getSupportedLanguages,
    getLanguageList,
};
if (typeof module !== 'undefined' && module.exports) {
    module.exports = LANGUAGE_API;
}
if (typeof window !== 'undefined') {
    window._languages = LANGUAGE_API;
}
})();
