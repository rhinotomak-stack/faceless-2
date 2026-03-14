/**
 * Logger — Colorful terminal output for the build pipeline
 *
 * Usage:
 *   const log = require('./logger');
 *   log.step('Step 4: Visual Planner');
 *   log.ok('Downloaded 3 overlays');
 *   log.warn('Vision AI skipped');
 *   log.info('Scene 3: "tesla" [pexels]');
 *   log.fail('Download failed: timeout');
 *   log.dim('   ... and 5 more scenes');
 *   log.banner('BUILD COMPLETE!');
 *   log.divider();
 *   log.kv('Theme', 'tech');
 *   log.scene(0, 'video', 'city aerial at night', 'pexels');
 */

const pc = require('picocolors');

const log = {
    /** Pipeline step header — bold cyan with ═ divider */
    step(text) {
        console.log(pc.cyan('═'.repeat(60)));
        console.log(pc.bold(pc.cyan(text)));
        console.log(pc.cyan('═'.repeat(60)));
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
