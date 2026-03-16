const fs = require('fs');
const path = require('path');

const RECIPES_DIR = path.join(__dirname, '..', 'assets', 'recipes');

/**
 * Load all available recipe files from assets/recipes/
 * @returns {Object[]} Array of parsed recipe objects
 */
function loadAllRecipes() {
    if (!fs.existsSync(RECIPES_DIR)) return [];
    return fs.readdirSync(RECIPES_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
            try {
                return JSON.parse(fs.readFileSync(path.join(RECIPES_DIR, f), 'utf-8'));
            } catch (e) {
                console.warn(`   ⚠️ Failed to parse recipe ${f}: ${e.message}`);
                return null;
            }
        })
        .filter(Boolean);
}

/**
 * Auto-detect which recipe matches the video content.
 * Checks: explicit BUILD_RECIPE env > user instructions keywords > scriptContext keywords.
 * @param {Object} scriptContext - From AI Director (has theme, summary, entities, etc.)
 * @param {string} userInstructions - The user's free-text AI instructions
 * @returns {Object|null} Matching recipe or null
 */
function detectRecipe(scriptContext, userInstructions) {
    const recipes = loadAllRecipes();
    if (recipes.length === 0) return null;

    // 1. Explicit override via env var
    const explicit = (process.env.BUILD_RECIPE || '').trim().toLowerCase();
    if (explicit) {
        const match = recipes.find(r => r.niche === explicit);
        if (match) return match;
        console.log(`   ⚠️ Recipe "${explicit}" not found in assets/recipes/`);
    }

    // 2. Keyword matching against user instructions + scriptContext
    const searchText = [
        userInstructions || '',
        scriptContext?.summary || '',
        scriptContext?.theme || '',
        ...(scriptContext?.entities || []),
        ...(scriptContext?.mainPoints || []),
    ].join(' ').toLowerCase();

    let bestMatch = null;
    let bestScore = 0;

    const contentFormat = (scriptContext?.format || '').toLowerCase();
    const contentNiche = (scriptContext?.nicheId || '').toLowerCase();

    for (const recipe of recipes) {
        let score = 0;

        // Keyword matching
        if (recipe.detectKeywords?.length) {
            score += recipe.detectKeywords.reduce((acc, kw) => {
                return acc + (searchText.includes(kw.toLowerCase()) ? 1 : 0);
            }, 0);
        }

        // Format + niche matching (strong signals)
        if (recipe.formatMatch && contentFormat === recipe.formatMatch.toLowerCase()) score += 5;
        if (recipe.nicheMatch && contentNiche === recipe.nicheMatch.toLowerCase()) score += 5;

        if (score > bestScore) {
            bestScore = score;
            bestMatch = recipe;
        }
    }

    // Require at least 3 keyword hits OR format+niche match to auto-detect
    return bestScore >= 3 ? bestMatch : null;
}

/**
 * Convert a recipe into structured AI prompt text.
 * This gets appended to aiInstructions and flows to all AI modules.
 * @param {Object} recipe - Parsed recipe object
 * @returns {string} Formatted prompt text
 */
function formatRecipePrompt(recipe) {
    const lines = [];
    lines.push(`GENRE RECIPE (${recipe.niche}):`);
    lines.push(`Follow these niche-specific patterns for ${recipe.description || recipe.niche} content.\n`);

    // MG preferences
    if (recipe.mgPreferences?.length) {
        const highPri = recipe.mgPreferences.filter(m => m.priority === 'high');
        const medPri = recipe.mgPreferences.filter(m => m.priority === 'medium');
        lines.push('MOTION GRAPHICS PREFERENCES:');
        if (highPri.length) {
            lines.push(`  Strongly prefer: ${highPri.map(m => `${m.type} (${m.when})`).join(', ')}`);
        }
        if (medPri.length) {
            lines.push(`  Also good: ${medPri.map(m => `${m.type} (${m.when})`).join(', ')}`);
        }
        lines.push('');
    }

    // Footage rules (content-driven, no fixed percentages)
    if (recipe.footageRules?.length) {
        lines.push('FOOTAGE SOURCE RULES:');
        for (const rule of recipe.footageRules) {
            lines.push(`  - ${rule}`);
        }
        lines.push('');
    }

    // Legacy footage strategy (percentage-based, for older recipes)
    if (recipe.footageStrategy) {
        lines.push('FOOTAGE STRATEGY:');
        for (const [source, cfg] of Object.entries(recipe.footageStrategy)) {
            lines.push(`  ${source}: ~${cfg.percentage}% — ${cfg.use}`);
        }
        lines.push('');
    }

    // Pacing
    if (recipe.pacing) {
        lines.push(`PACING: ${recipe.pacing.sceneDuration}. Transitions: ${recipe.pacing.transitionStyle}.`);
        lines.push('');
    }

    // Scene structure
    if (recipe.sceneStructure?.length) {
        lines.push('SCENE STRUCTURE (follow this flow):');
        for (const section of recipe.sceneStructure) {
            const mgs = section.mgTypes?.join(', ') || 'none';
            lines.push(`  ${section.section.toUpperCase()} (${section.durationHint}): MGs=[${mgs}], footage=${section.footage}. ${section.notes || ''}`);
        }
        lines.push('');
    }

    // Keyword rules
    if (recipe.keywordRules) {
        lines.push('KEYWORD RULES:');
        for (const [key, rule] of Object.entries(recipe.keywordRules)) {
            lines.push(`  - ${rule}`);
        }
        lines.push('');
    }

    // MG placement rules
    if (recipe.mgRules) {
        lines.push('MG PLACEMENT RULES:');
        for (const [key, rule] of Object.entries(recipe.mgRules)) {
            lines.push(`  - ${rule}`);
        }
        lines.push('');
    }

    // Style
    if (recipe.stylePreferences) {
        const sp = recipe.stylePreferences;
        const parts = [];
        if (sp.mgStyle) parts.push(`MG style: ${sp.mgStyle}`);
        if (sp.mapStyle) parts.push(`map style: ${sp.mapStyle}`);
        if (sp.colorScheme) parts.push(`colors: ${sp.colorScheme}`);
        if (parts.length) lines.push(`STYLE: ${parts.join(', ')}`);
    }

    return lines.join('\n');
}

/**
 * Main entry: detect and load a genre recipe, return formatted prompt text.
 * @param {Object} scriptContext - From AI Director
 * @param {string} userInstructions - User's free-text instructions
 * @returns {{ recipe: Object|null, promptText: string }}
 */
function loadRecipe(scriptContext, userInstructions) {
    const recipe = detectRecipe(scriptContext, userInstructions);
    if (!recipe) return { recipe: null, promptText: '' };
    return { recipe, promptText: formatRecipePrompt(recipe) };
}

module.exports = { loadRecipe, loadAllRecipes, formatRecipePrompt };
