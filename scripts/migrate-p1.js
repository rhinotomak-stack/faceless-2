#!/usr/bin/env node
// scripts/migrate-p1.js  —  P1 folder reorg (mechanical, behavior-preserving).
// Moves src/*.js into intent-named subfolders and rewrites EVERY relative require()
// across the repo to match. NO logic changes. Dry-run by default; --apply to execute.
//   node scripts/migrate-p1.js            # dry run: prints plan + coverage check
//   node scripts/migrate-p1.js --apply    # git mv + rewrite requires
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..');
const S = (p) => p.split(path.sep).join('/'); // to posix

// ── Target folder per top-level src file ────────────────────────────────────
const TOP = {
  render: ['agentic-composition', 'audio-mixer', 'effect-presets', 'hf-background-packs', 'hf-character-rig', 'hf-design-doc', 'hf-effects', 'hf-look-ruleset', 'hf-template-author', 'hf-visual-lint', 'hyperframes-bridge', 'hyperframes-motion-director', 'mg-registry'],
  agents: ['ai-compositor-planner', 'ai-director', 'ai-motion-graphics', 'ai-templates', 'ai-visual-planner', 'design-intelligence', 'directors-brief', 'planner-display-guards', 'presenter-assignment', 'scene-actions', 'scene-boundary-scorer', 'scene-classifier', 'scene-optimizer', 'scene-risk', 'smart-segment', 'speech-units'],
  brain: ['ai-provider', 'cost-tracker', 'strict-json', 'vertex-auth'],
  media: ['article-image', 'candidate-finalist-scout', 'candidate-race', 'candidate-referee', 'clip-analyzer', 'clip-bytes-cache', 'clip-embedder', 'clip-prescreen', 'explainer-image-provider', 'fast-stock-media', 'footage-manager', 'icon-provider', 'media-agent', 'media-hunter', 'media-intent-controller', 'media-memory-bank', 'media-scout', 'music-provider', 'presenter-provider', 'relevant-person-rules', 'retrievability-rescue', 'scout-lab', 'search-keywords', 'sfx-provider', 'source-policy', 'subject-image-fetcher', 'tavily-client', 'title-sanity', 'topic-footage-scout', 'transcript-scout', 'web-search-client'],
  vision: ['ai-vision', 'lightning-box', 'lightning-rotation', 'qwen-model-discovery', 'thumbnail-vision', 'vision-box', 'vision-cache', 'vision-gpu', 'vision-rewake', 'vision-score-sanity'],
  map: ['map-assignment', 'map-compiler', 'map-hf-builder', 'map-provider', 'map-render-engine', 'map-style-packs'],
  directives: ['compliance-loop', 'directive-actuator', 'directive-compiler', 'directive-util'],
  data: ['class-treatment-map', 'language-helper', 'languages', 'niches', 'themes'],
  studio: ['qa-chat-agent', 'qa-features-context', 'qa-replacer', 'qa-studio-agent', 'style-learner', 'style-studio-agent'],
  pipeline: ['build-orchestrator', 'build-video', 'final-review', 'pacing-verify', 'transcribe'],
  settings: ['config', 'recipe-loader'],
  util: ['logger', 'promise', 'url-utils'],
  formats: ['listicle-format'],
};

// ── Build the move map (oldRel → newRel, repo-relative posix) ────────────────
const moves = new Map(); // oldAbs → newAbs
function addMove(oldRel, newRel) {
  moves.set(path.resolve(ROOT, oldRel), path.resolve(ROOT, newRel));
}
const folderOf = {};
for (const [folder, files] of Object.entries(TOP)) for (const f of files) folderOf[f + '.js'] = folder;

// Coverage check: every current src/*.js must be classified.
const topFiles = fs.readdirSync(path.join(ROOT, 'src')).filter(f => f.endsWith('.js'));
const uncovered = topFiles.filter(f => !folderOf[f]);
if (uncovered.length) { console.error('❌ UNCLASSIFIED src files (add to map):\n  ' + uncovered.join('\n  ')); process.exit(1); }
const ghosts = Object.keys(folderOf).filter(f => !topFiles.includes(f));
if (ghosts.length) { console.error('❌ MAP references missing files:\n  ' + ghosts.join('\n  ')); process.exit(1); }

for (const f of topFiles) addMove(`src/${f}`, `src/${folderOf[f]}/${f}`);

// editor-agent/ → agents/ ; editor-agent/workers/ → agents/workers/
for (const f of fs.readdirSync(path.join(ROOT, 'src/editor-agent')).filter(f => f.endsWith('.js'))) addMove(`src/editor-agent/${f}`, `src/agents/${f}`);
for (const f of fs.readdirSync(path.join(ROOT, 'src/editor-agent/workers')).filter(f => f.endsWith('.js'))) addMove(`src/editor-agent/workers/${f}`, `src/agents/workers/${f}`);
// providers/ → media/providers/
for (const f of fs.readdirSync(path.join(ROOT, 'src/providers')).filter(f => f.endsWith('.js'))) addMove(`src/providers/${f}`, `src/media/providers/${f}`);

// ── Collect every .js that might contain requires to rewrite ────────────────
function walk(dir, acc) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return acc; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === '__pycache__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.name.endsWith('.js')) acc.push(full);
  }
  return acc;
}
const scan = [];
walk(path.join(ROOT, 'src'), scan);
walk(path.join(ROOT, 'ui', 'js'), scan);
walk(path.join(ROOT, 'scripts'), scan);
for (const f of ['main.js', 'preload.js', 'test-pipeline.js']) { const p = path.join(ROOT, f); if (fs.existsSync(p)) scan.push(p); }
const SELF = path.resolve(__dirname, 'migrate-p1.js');

// Resolve a relative specifier from a dir to an actual existing file (old layout).
function resolveTarget(fromDirAbs, spec) {
  const base = path.resolve(fromDirAbs, spec);
  for (const c of [base, base + '.js', base + '.json', path.join(base, 'index.js')]) {
    try { if (fs.statSync(c).isFile()) return c; } catch (_) {}
  }
  return null;
}

const REQ_RE = /(require\(\s*)(['"])(\.\.?\/[^'"]+)\2(\s*\))/g;
let filesChanged = 0, rewrites = 0, unresolved = 0;
const pendingWrites = [];

for (const fileAbs of scan) {
  if (fileAbs === SELF) continue;
  const oldDir = path.dirname(fileAbs);
  const newAbs = moves.get(fileAbs) || fileAbs;
  const newDir = path.dirname(newAbs);
  const src = fs.readFileSync(fileAbs, 'utf8');
  let changedHere = 0;
  const out = src.replace(REQ_RE, (m, pre, q, spec, post) => {
    const targetOld = resolveTarget(oldDir, spec);
    if (!targetOld) { return m; } // node module / unresolved — leave
    const targetNew = moves.get(targetOld) || targetOld;
    if (targetNew === targetOld && newAbs === fileAbs) return m; // nothing moved
    let rel = S(path.relative(newDir, targetNew));
    rel = rel.replace(/\.js$/, ''); // keep .json, drop .js
    if (!rel.startsWith('.')) rel = './' + rel;
    if (rel === spec) return m;
    changedHere++;
    return pre + q + rel + q + post;
  });
  if (changedHere > 0) { filesChanged++; rewrites += changedHere; pendingWrites.push([fileAbs, out]); }
}

// Report
console.log(`\n=== P1 migration ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===`);
console.log(`files to move:      ${moves.size}`);
console.log(`files w/ rewrites:  ${filesChanged}`);
console.log(`total require fixes: ${rewrites}`);
console.log('\nfolder distribution:');
for (const [folder, files] of Object.entries(TOP)) console.log(`  src/${folder}/  ${files.length}`);
console.log(`  src/agents/ (+editor-agent: ceo/frame-extractor/scene-context)`);
console.log(`  src/agents/workers/  15   src/media/providers/  14`);

if (!APPLY) {
  console.log('\n(dry run — no files touched. Re-run with --apply to execute.)');
  process.exit(0);
}

// Apply: 1) rewrite content in place  2) git mv
for (const [f, content] of pendingWrites) fs.writeFileSync(f, content);
console.log(`\n✍  rewrote requires in ${pendingWrites.length} files`);

let moved = 0;
for (const [oldAbs, newAbs] of moves) {
  const newDir = path.dirname(newAbs);
  if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
  try {
    execFileSync('git', ['mv', '-f', S(path.relative(ROOT, oldAbs)), S(path.relative(ROOT, newAbs))], { cwd: ROOT, stdio: 'pipe' });
    moved++;
  } catch (e) {
    // Fall back to a plain rename if git mv balks (e.g., file not tracked yet).
    try { fs.renameSync(oldAbs, newAbs); moved++; }
    catch (e2) { console.error(`  ❌ move failed: ${S(path.relative(ROOT, oldAbs))} → ${e2.message}`); }
  }
}
console.log(`📦 moved ${moved}/${moves.size} files`);
console.log('\n✅ apply complete. Now run: npm run verify:paths');
