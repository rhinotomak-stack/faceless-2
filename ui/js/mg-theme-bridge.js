/**
 * MG Theme Bridge — shared style resolution for MGRenderer.
 *
 * Loaded by BOTH index.html (main app) AND qa-studio.html so that MG rendering
 * looks identical in preview and QA export clips.
 *
 * Exposes the globals that MGRenderer._getStyle() depends on:
 *   MG_STYLES                — per-style visual presets
 *   THEME_FONTS, THEME_COLORS — per-theme font/color maps
 *   getStyledThemeColors()   — returns themed+styled colors
 *   getActiveThemeFonts()    — returns language-aware theme fonts
 *   _resolveActiveTheme()    — resolves current theme ID
 */

// ========================================
// MG_STYLES — visual presets with inline fallbacks
// ========================================
const MG_STYLES = {
    clean: { primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)', text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false },
    bold: { primary: '#ef4444', accent: '#fbbf24', bg: 'rgba(10,10,10,0.92)', text: '#ffffff', textSub: 'rgba(255,255,255,0.85)', glow: false },
    minimal: { primary: '#e5e7eb', accent: '#94a3b8', bg: 'rgba(0,0,0,0.35)', text: '#f8fafc', textSub: 'rgba(255,255,255,0.5)', glow: false },
    neon: { primary: '#00ff88', accent: '#ff00ff', bg: 'rgba(0,0,15,0.85)', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)', glow: true },
    cinematic: { primary: '#d4af37', accent: '#c0c0c0', bg: 'rgba(0,0,0,0.92)', text: '#f5f0e8', textSub: 'rgba(245,240,232,0.55)', glow: false },
    elegant: { primary: '#8b5cf6', accent: '#f472b6', bg: 'rgba(10,0,25,0.82)', text: '#ffffff', textSub: 'rgba(255,255,255,0.6)', glow: true },
};

// Hydrate MG_STYLES from theme tokens (adds chrome properties like borderRadius, shadowStyle, etc.)
if (window._themeTokens) {
    for (const styleName of window._themeTokens.stylePresetNames) {
        const preset = window._themeTokens.getStylePreset(styleName);
        if (MG_STYLES[styleName]) {
            MG_STYLES[styleName].bg = preset.bg;
            MG_STYLES[styleName].glow = preset.glow;
            MG_STYLES[styleName].borderRadius = preset.borderRadius;
            MG_STYLES[styleName].strokeWidth = preset.strokeWidth;
            MG_STYLES[styleName].shadowStyle = preset.shadowStyle;
            MG_STYLES[styleName].shadowBlur = preset.shadowBlur;
            MG_STYLES[styleName].shadowOffsetY = preset.shadowOffsetY;
            MG_STYLES[styleName].cardStyle = preset.cardStyle;
            MG_STYLES[styleName].lowerThirdStyle = preset.lowerThirdStyle;
            MG_STYLES[styleName].lowerThirdAnimation = preset.lowerThirdAnimation;
            MG_STYLES[styleName].chartBarRadius = preset.chartBarRadius;
        }
    }
}

// ========================================
// Theme Fonts & Colors — from design tokens
// ========================================
const THEME_FONTS = {};
const THEME_COLORS = {};

if (window._themeTokens) {
    for (const themeId of window._themeTokens.themeIds) {
        const tokens = window._themeTokens.getTokens(themeId);
        THEME_FONTS[themeId] = {
            heading: tokens.typography.headingFont,
            body: tokens.typography.bodyFont,
        };
        THEME_COLORS[themeId] = {
            primary: tokens.colors.primary,
            accent: tokens.colors.accent,
            text: tokens.colors.textPrimary,
            textSub: tokens.colors.textSecondary,
        };
    }
} else {
    console.warn('[mg-theme-bridge] Theme tokens not available — using hardcoded fallbacks');
    Object.assign(THEME_FONTS, {
        tech: { heading: 'Orbitron, Electrolize, "Courier New", monospace', body: '"Roboto Mono", "Source Code Pro", monospace' },
        nature: { heading: '"Libre Baskerville", Merriweather, Georgia, serif', body: 'Lora, "Open Sans", Georgia, sans-serif' },
        crime: { heading: 'Oswald, "Bebas Neue", Impact, sans-serif', body: '"Barlow Condensed", Lato, Arial, sans-serif' },
        corporate: { heading: 'Montserrat, "Work Sans", Arial, sans-serif', body: '"Source Sans Pro", "Open Sans", "Segoe UI", sans-serif' },
        luxury: { heading: '"Playfair Display", Cinzel, Georgia, serif', body: 'Lora, "Libre Baskerville", "Times New Roman", serif' },
        sport: { heading: '"Bebas Neue", "Fjalla One", Impact, sans-serif', body: '"Roboto Condensed", "Barlow Condensed", Arial, sans-serif' },
        neutral: { heading: 'Nunito, Raleway, Arial, sans-serif', body: '"Open Sans", Roboto, Arial, sans-serif' },
    });
    Object.assign(THEME_COLORS, {
        tech: { primary: '#00ffff', accent: '#00ff00', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
        nature: { primary: '#8B4513', accent: '#87CEEB', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
        crime: { primary: '#dc143c', accent: '#ffd700', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
        corporate: { primary: '#0066cc', accent: '#00cc66', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
        luxury: { primary: '#d4af37', accent: '#c0c0c0', text: '#ffffff', textSub: 'rgba(255,255,255,0.6)' },
        sport: { primary: '#ff4500', accent: '#00ff00', text: '#ffffff', textSub: 'rgba(255,255,255,0.8)' },
        neutral: { primary: '#4a90e2', accent: '#e74c3c', text: '#ffffff', textSub: 'rgba(255,255,255,0.7)' },
    });
}

// ========================================
// Theme resolution — works in BOTH windows
// ========================================

/**
 * Resolve the active theme ID.
 * Main app: reads from #build-theme dropdown → falls back to videoPlan.
 * QA Studio: no dropdown → reads directly from videoPlan.
 */
function _resolveActiveTheme() {
    // Main app has a theme dropdown
    const themeEl = document.getElementById('build-theme');
    if (themeEl) {
        let themeId = themeEl.value;
        if (themeId === 'auto' && window._mgBridgeVideoPlan?.scriptContext) {
            themeId = window._mgBridgeVideoPlan.scriptContext.themeId || null;
        }
        if (themeId && themeId !== 'auto') return themeId;
    }

    // QA Studio (or main app without dropdown): read from videoPlan
    if (window._mgBridgeVideoPlan?.scriptContext?.themeId) {
        return window._mgBridgeVideoPlan.scriptContext.themeId;
    }

    return null;
}

/**
 * Get themed+styled colors for MG rendering.
 */
function getStyledThemeColors(styleName) {
    const activeTheme = _resolveActiveTheme();
    if (!activeTheme) return null;

    if (window._themeTokens) {
        const tokens = window._themeTokens.getTokens(activeTheme);
        const stylePreset = window._themeTokens.getStylePreset(styleName || 'clean');
        const mod = stylePreset?.modifier;

        if (mod && window._themeTokens.applyModifier) {
            const rawPrimary = tokens.colors.primary;
            const rawAccent = tokens.colors.accent;
            return {
                primary: window._themeTokens.applyModifier(rawPrimary, mod),
                accent: window._themeTokens.applyModifier(rawAccent, mod),
                text: tokens.colors.textPrimary,
                textSub: tokens.colors.textSecondary,
                bg: stylePreset.bg,
            };
        }

        return {
            primary: tokens.colors.mgPrimary,
            accent: tokens.colors.mgAccent,
            text: tokens.colors.textPrimary,
            textSub: tokens.colors.textSecondary,
            bg: stylePreset?.bg || tokens.colors.surface,
        };
    }

    return THEME_COLORS[activeTheme] || null;
}

/**
 * Get active theme fonts with language-aware overrides.
 */
function getActiveThemeFonts() {
    const activeTheme = _resolveActiveTheme();
    const baseFonts = (activeTheme && THEME_FONTS[activeTheme])
        ? THEME_FONTS[activeTheme]
        : { heading: 'Arial, sans-serif', body: 'Arial, sans-serif' };

    // Language-specific font overrides
    const lang = window._mgBridgeVideoPlan?.scriptContext?.language;
    if (lang && window._languageHelper?.resolveLanguageFonts) {
        try {
            return window._languageHelper.resolveLanguageFonts(baseFonts, lang);
        } catch (e) {
            console.warn('[mg-theme-bridge] Language font resolution failed:', e.message);
        }
    }
    return baseFonts;
}
