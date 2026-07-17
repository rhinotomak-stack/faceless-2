/**
 * Logger — Colorful terminal output for the build pipeline
 *
 * Usage:
 *   const log = require('./logger');
 *   log.step('Step 4: Visual Planner');
 *   log.ok('Downloaded 3 overlays');
 *   log.warn('Vision AI skipped');
 *   log.info('Scene 3: "tesla" [storyblocks]');
 *   log.fail('Download failed: timeout');
 *   log.dim('   ... and 5 more scenes');
 *   log.banner('BUILD COMPLETE!');
 *   log.divider();
 *   log.kv('Theme', 'tech');
 *   log.scene(0, 'video', 'city aerial at night', 'storyblocks');
 *
 * Structured UI events:
 *   log.sceneEvt('download', 6, 'ok', 'Bing 7/10');   // per-scene status row
 *   log.note('download', 'warn', 'Bing 403 - retrying');
 */

const pc = require('picocolors');

// -- Structured UI events ----------------------------------------------
// Alongside the pretty terminal lines, the pipeline emits compact
// machine-readable events on stdout prefixed with `@@EVT@@`. main.js parses
// these out of the build child's stdout, strips them from the file/terminal
// echo, and forwards them to the renderer's in-app Build Log panel. This gives
// a clean, phase-grouped, per-scene view WITHOUT touching the verbose debug
// lines (which stay in the .log file for deep debugging).
const EVT_PREFIX = '@@EVT@@';

// Derive a stable phase id from a step header like "Step 5: Downloading Media".
function _phaseId(text) {
    const s = String(text || '').toLowerCase();
    if (/vision check|preflight/.test(s)) return 'preflight';
    if (/transcrib/.test(s)) return 'transcribe';
    if (/director|scene creation/.test(s)) return 'director';
    if (/visual planner/.test(s)) return 'visualplanner';
    if (/topic footage scout/.test(s)) return 'scout';
    if (/fallback pool/.test(s)) return 'pool';
    if (/download|downloading media/.test(s)) return 'download';
    if (/motion graphic/.test(s)) return 'mg';
    if (/transition/.test(s)) return 'transitions';
    if (/overlay/.test(s)) return 'overlays';
    if (/template/.test(s)) return 'templates';
    if (/video plan|build .*plan|finaliz/.test(s)) return 'plan';
    if (/clean/.test(s)) return 'clean';
    if (/audio/.test(s)) return 'audio';
    // Fallback: kebab slug of the first words after any "Step N:".
    return s.replace(/^[^a-z]*step\s*[\d.]+:\s*/i, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'phase';
}

const log = {
    /** Emit a structured UI event (best-effort; never throws). */
    evt(obj) {
        try { console.log(EVT_PREFIX + JSON.stringify(obj)); } catch (_) { /* noop */ }
    },

    /** Phase marker for the UI (auto-emitted by step(); also callable directly). */
    phase(phaseId, label, status = 'start', extra = {}) {
        this.evt({ t: 'phase', phase: phaseId, label: String(label || phaseId), status, ...extra });
    },

    /**
     * Per-scene status row for the UI Build Log.
     * @param {string} phaseId  e.g. 'download'
     * @param {number} scene    scene index
     * @param {'start'|'ok'|'fail'|'warn'|'timeout'|'info'} status
     * @param {string} msg      short headline (e.g. "Bing 7/10")
     * @param {string} [detail] longer text shown when the row is expanded
     */
    sceneEvt(phaseId, scene, status, msg, detail) {
        this.evt({ t: 'scene', phase: phaseId, scene, status, msg: String(msg || ''), ...(detail ? { detail: String(detail) } : {}) });
    },

    /** Free-form note attached to a phase (and optionally a scene) for the UI. */
    note(phaseId, status, msg, opts = {}) {
        this.evt({ t: 'note', phase: phaseId, status, msg: String(msg || ''), ...(opts.scene != null ? { scene: opts.scene } : {}), ...(opts.detail ? { detail: String(opts.detail) } : {}) });
    },

    /** Pipeline step header — bold cyan with divider (also emits a UI phase). */
    step(text) {
        console.log(pc.cyan('═'.repeat(60)));
        console.log(pc.bold(pc.cyan(text)));
        console.log(pc.cyan('═'.repeat(60)));
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        this.phase(_phaseId(text), clean || 'Step', 'start');
    },

    /** Sub-step header — bold white */
    substep(text) {
        console.log(pc.bold(pc.white(`\n${text}`)));
    },

    /** Success — green */
    ok(text) {
        console.log(pc.green(`   ✅ ${text}`));
    },

    /** Warning — yellow */
    warn(text) {
        console.log(pc.yellow(`   ⚠️  ${text}`));
    },

    /** Error — red bold */
    fail(text) {
        console.log(pc.bold(pc.red(`   ❌ ${text}`)));
    },

    /** Info — default color, indented */
    info(text) {
        console.log(`   ${text}`);
    },

    /** Dim detail — gray, for secondary info */
    dim(text) {
        console.log(pc.dim(`   ${text}`));
    },

    /** Key-value pair — key in bold, value in cyan */
    kv(key, value) {
        console.log(`   ${pc.bold(key)}: ${pc.cyan(String(value))}`);
    },

    /** Big banner — bold white on magenta background */
    banner(text) {
        const pad = '  ';
        console.log('');
        console.log(pc.bold(pc.magenta(`🎬 ${'='.repeat(42)}`)));
        console.log(pc.bold(pc.magenta(`${pad}${text}`)));
        console.log(pc.bold(pc.magenta(`🎬 ${'='.repeat(42)}`)));
        console.log('');
    },

    /** Thin divider line */
    divider() {
        console.log(pc.dim('─'.repeat(60)));
    },

    /** Scene log line — color-coded by type */
    scene(index, kind, keyword, source) {
        const idx = pc.dim(`Scene ${String(index).padStart(2)}:`);
        if (kind === 'mg') {
            console.log(`   ${idx} ${pc.magenta('🎨')} ${pc.magenta(keyword)}`);
        } else if (kind === 'v2') {
            console.log(`   ${idx} ${pc.blue('📸')} ${pc.blue(keyword)} ${pc.dim('(V2 overlay)')}`);
        } else if (kind === 'image') {
            console.log(`   ${idx} 🖼️  ${pc.white(keyword)} ${pc.dim(`[${source}]`)}`);
        } else {
            console.log(`   ${idx} 🎥 ${pc.white(keyword)} ${pc.dim(`[${source}]`)}`);
        }
    },

    /** Provider result — colored by outcome */
    provider(name, status, detail) {
        const tag = pc.dim(`[${name}]`);
        if (status === 'ok') {
            console.log(`      ${pc.green('✓')} ${tag} ${detail || ''}`);
        } else if (status === 'skip') {
            console.log(`      ${pc.yellow('–')} ${tag} ${pc.dim(detail || 'skipped')}`);
        } else {
            console.log(`      ${pc.red('✗')} ${tag} ${pc.dim(detail || 'failed')}`);
        }
    },

    /** Progress counter — e.g. "3/10" */
    progress(current, total, label) {
        const pct = Math.round((current / total) * 100);
        const bar = pc.cyan(`[${current}/${total}]`);
        console.log(`   ${bar} ${label || ''} ${pc.dim(`${pct}%`)}`);
    },

    /** Timing — elapsed seconds */
    timing(label, seconds) {
        console.log(`   ${pc.dim('⏱')}  ${label}: ${pc.bold(pc.yellow(`${seconds}s`))}`);
    },

    /** Blank line */
    br() {
        console.log('');
    },

    /** Raw console.log passthrough (for anything custom) */
    raw(...args) {
        console.log(...args);
    },

    /** Access to picocolors for inline coloring */
    pc,
};

module.exports = log;
