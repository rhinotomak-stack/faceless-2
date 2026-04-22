/**
 * QA Features Context — Auto-captures current system capabilities + recent changes.
 *
 * Feeds the QA agent with up-to-date knowledge about the app's features so it
 * knows what to expect when reviewing scenes. Fully automatic — no human editing.
 *
 * Three layers:
 *   1. Live registry scan — MG types/variants, templates, themes (always current)
 *   2. Recently active files — git log → changed files → JSDoc headers (what's new)
 *   3. Scene data introspection — walks _-prefixed fields on each scene (what's in this scene)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// ── Cache (1 hour TTL for catalog + git data) ──
let _catalogCache = null;
let _catalogCacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000;

// ============ LAYER 1: Live Registry Scan ============

function _getMGCatalog() {
    try {
        const { MG_REGISTRY } = require('./mg-registry');
        const lines = [];
        for (const [cat, def] of Object.entries(MG_REGISTRY)) {
            const variants = Object.keys(def.types || {}).join(', ');
            lines.push(`  ${cat} (${def.group}): ${def.label} — variants: ${variants}`);
        }
        return lines.join('\n');
    } catch (e) {
        return '  (registry unavailable)';
    }
}

function _getTemplateCatalog() {
    try {
        const { TEMPLATE_REGISTRY } = require('./ai-templates');
        const lines = [];
        for (const [name, def] of Object.entries(TEMPLATE_REGISTRY)) {
            const variants = def.variants ? Object.keys(def.variants).join(', ') : 'default';
            const desc = def.description || def.label || name;
            lines.push(`  ${name}: ${desc} — variants: ${variants}`);
        }
        return lines.join('\n');
    } catch (e) {
        return '  (template registry unavailable)';
    }
}

function _getThemeList() {
    try {
        const themes = require('./themes');
        const list = themes.THEME_IDS || Object.keys(themes.THEMES || themes);
        return Array.isArray(list) ? list.join(', ') : '(unknown)';
    } catch (e) {
        return '(themes unavailable)';
    }
}

// ============ LAYER 2: Recently Active Files (git-based) ============

function _getRecentlyActiveFiles() {
    try {
        const raw = execSync(
            'git log --since="60 days ago" --name-only --pretty=format:"" -- src/ ui/js/',
            { cwd: ROOT, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const counts = {};
        for (const line of raw.split('\n')) {
            const f = line.trim();
            if (!f || !f.match(/\.(js|ts)$/)) continue;
            counts[f] = (counts[f] || 0) + 1;
        }
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
    } catch (e) {
        return [];
    }
}

function _extractFileHeader(filePath) {
    try {
        const abs = path.join(ROOT, filePath);
        if (!fs.existsSync(abs)) return null;
        const content = fs.readFileSync(abs, 'utf8').substring(0, 800);
        const m = content.match(/\/\*\*\s*\n([\s\S]*?)\*\//);
        if (!m) return null;
        const lines = m[1].split('\n')
            .map(l => l.replace(/^\s*\*\s?/, '').trim())
            .filter(Boolean)
            .slice(0, 3);
        return lines.join(' ').substring(0, 200);
    } catch (e) {
        return null;
    }
}

function _getRecentCommitMessages() {
    try {
        const raw = execSync(
            'git log --since="60 days ago" --pretty=format:"%h %s" -- src/ ui/js/',
            { cwd: ROOT, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        );
        return raw.split('\n').filter(Boolean).slice(0, 15);
    } catch (e) {
        return [];
    }
}

// ============ LAYER 3: Scene Data Introspection ============

function extractSceneEnhancements(sceneInfo) {
    if (!sceneInfo || typeof sceneInfo !== 'object') return '';

    const lines = [];

    if (sceneInfo._mapWaypoints && Array.isArray(sceneInfo._mapWaypoints)) {
        const wps = sceneInfo._mapWaypoints;
        const hasIcons = wps.some(wp => wp.icon);
        const hasOrbit = wps.some(wp => wp.orbit || wp.o);
        const hasTilt = wps.some(wp => wp.tilt || wp.t);
        lines.push(`MAP WAYPOINTS: ${wps.length} waypoint(s) with cinematic camera animation`);
        lines.push(`  Locations: ${wps.map(wp => wp.name).join(' → ')}`);
        if (hasIcons) lines.push(`  Icons: ${wps.filter(wp => wp.icon).map(wp => `${wp.name}→${wp.icon}`).join(', ')}`);
        if (hasTilt) lines.push('  Tilt: 3D perspective enabled on some waypoints');
        if (hasOrbit) lines.push('  Orbit: slow rotation enabled on some waypoints');
        lines.push('  EXPECT: camera panning/zooming between locations, pin markers, possible icon badges on pins');
    }

    if (sceneInfo._mapIcons && typeof sceneInfo._mapIcons === 'object') {
        const count = Object.keys(sceneInfo._mapIcons).length;
        lines.push(`MAP ICONS: ${count} contextual icon badge(s) on map pins — verify they are visible as small circular badges near pins`);
    }

    if (sceneInfo._bigMapSize) {
        lines.push('BIG MAP: single high-res map tile covering all waypoints (not per-location tiles)');
    }

    if (sceneInfo._osmBoundaries && Array.isArray(sceneInfo._osmBoundaries)) {
        lines.push(`BOUNDARIES: ${sceneInfo._osmBoundaries.length} region polygon(s) drawn on map`);
    }

    if (sceneInfo._mapPins && Array.isArray(sceneInfo._mapPins)) {
        lines.push(`MAP PINS: ${sceneInfo._mapPins.length} location pin(s) with labels`);
    }

    if (sceneInfo.mapVariant) {
        lines.push(`MAP VARIANT: ${sceneInfo.mapVariant} (locator=spotlight, route=path, regionHighlight=area, comparison=side-by-side)`);
    }

    // Auto-detect unknown _ fields (future-proofing)
    for (const key of Object.keys(sceneInfo)) {
        if (!key.startsWith('_')) continue;
        if (['_mapWaypoints', '_mapIcons', '_bigMapSize', '_osmBoundaries', '_mapPins',
             '_mapView', '_wpCoords', '_mapIconsPreloaded', '_iconFile'].includes(key)) continue;
        const val = sceneInfo[key];
        const type = Array.isArray(val) ? `array(${val.length})` : typeof val;
        lines.push(`${key}: ${type}${type === 'string' ? ` = "${String(val).substring(0, 60)}"` : ''}`);
    }

    return lines.length > 0 ? lines.join('\n') : '';
}

// ============ BUILD FULL CONTEXT BLOCK ============

function buildFeatureCatalog() {
    const now = Date.now();
    if (_catalogCache && (now - _catalogCacheTime) < CACHE_TTL) return _catalogCache;

    const sections = [];

    // Section 1: Current MG + Template catalog
    sections.push(`MOTION GRAPHIC TYPES (current):
${_getMGCatalog()}

TEMPLATE TYPES (current):
${_getTemplateCatalog()}

THEMES: ${_getThemeList()}`);

    // Section 2: Recently active files with descriptions
    const activeFiles = _getRecentlyActiveFiles();
    if (activeFiles.length > 0) {
        const fileLines = [];
        for (const [filePath, count] of activeFiles) {
            const header = _extractFileHeader(filePath);
            if (header) {
                fileLines.push(`  ${filePath} (${count} changes) — ${header}`);
            } else {
                fileLines.push(`  ${filePath} (${count} changes)`);
            }
        }
        sections.push(`RECENTLY ACTIVE MODULES (last 60 days — indicates new/changed features):
${fileLines.join('\n')}`);
    }

    // Section 3: Recent commits
    const commits = _getRecentCommitMessages();
    if (commits.length > 0) {
        sections.push(`RECENT COMMITS (last 60 days):
${commits.map(c => `  ${c}`).join('\n')}`);
    }

    _catalogCache = sections.join('\n\n');
    _catalogCacheTime = now;
    return _catalogCache;
}

function buildQAContextBlock(sceneInfo) {
    const parts = [];
    parts.push(buildFeatureCatalog());

    if (sceneInfo) {
        const enhancements = extractSceneEnhancements(sceneInfo);
        if (enhancements) {
            parts.push(`SCENE ENHANCEMENTS (auto-detected features active on THIS scene):
${enhancements}`);
        }
    }

    return parts.join('\n\n');
}

module.exports = {
    buildFeatureCatalog,
    buildQAContextBlock,
    extractSceneEnhancements,
};
