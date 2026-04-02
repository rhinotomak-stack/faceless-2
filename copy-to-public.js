/**
 * One-time script: copies temp build files to public folder.
 * Use when Step 8 failed (e.g., disk full) but Steps 1-7 completed.
 *
 * Usage: node copy-to-public.js "C:\Users\user\Downloads\Miltary real test"
 */
const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.argv[2];
if (!PROJECT_DIR) {
    console.log('Usage: node copy-to-public.js <project-dir>');
    process.exit(1);
}

const tempDir = path.join(PROJECT_DIR, 'temp');
const publicDir = path.join(PROJECT_DIR, 'public');
const inputDir = path.join(PROJECT_DIR, 'input');

// Check temp exists
if (!fs.existsSync(path.join(tempDir, 'video-plan.json'))) {
    console.log('❌ No video-plan.json in temp folder');
    process.exit(1);
}

// Ensure public folder exists
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

// Load video plan to know what to copy
const plan = JSON.parse(fs.readFileSync(path.join(tempDir, 'video-plan.json'), 'utf-8'));

// Copy video plan
fs.copyFileSync(path.join(tempDir, 'video-plan.json'), path.join(publicDir, 'video-plan.json'));
console.log('✅ Copied video-plan.json');

// Copy audio
const audioFiles = fs.readdirSync(inputDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
for (const af of audioFiles) {
    fs.copyFileSync(path.join(inputDir, af), path.join(publicDir, af));
    console.log(`✅ Copied audio: ${af}`);
}

// Copy scene media files
let copied = 0, skipped = 0;
const scenes = plan.scenes || [];
for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const ext = scene.mediaExtension || '.mp4';
    const srcIdx = scene._fileIndex !== undefined ? scene._fileIndex : i;
    const srcMedia = path.join(tempDir, `scene-${srcIdx}${ext}`);
    const destName = `scene-${i}-asset${ext}`;
    const destMedia = path.join(publicDir, destName);
    if (fs.existsSync(srcMedia)) {
        fs.copyFileSync(srcMedia, destMedia);
        copied++;
    } else {
        console.log(`⚠️ Missing: scene-${srcIdx}${ext}`);
        skipped++;
    }
}
console.log(`✅ Copied ${copied} scene files${skipped ? `, ⚠️ ${skipped} missing` : ''}`);

// Copy MG-related files (article images, map images)
const mgScenes = plan.mgScenes || [];
const allMGs = [...mgScenes, ...(plan.motionGraphics || [])];
let mgCopied = 0;
for (const mg of allMGs) {
    for (const field of ['articleImageFile', 'mapImageFile']) {
        if (mg[field]) {
            const src = path.join(tempDir, mg[field]);
            const dest = path.join(publicDir, mg[field]);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, dest);
                mgCopied++;
            }
        }
    }
}
if (mgCopied) console.log(`✅ Copied ${mgCopied} MG asset files`);

// Copy SFX
const sfxDir = path.join(__dirname, 'assets', 'sfx');
if (fs.existsSync(sfxDir)) {
    const sfxFiles = fs.readdirSync(sfxDir).filter(f => f.endsWith('.mp3') || f.endsWith('.wav'));
    for (const sf of sfxFiles) {
        fs.copyFileSync(path.join(sfxDir, sf), path.join(publicDir, sf));
    }
    if (sfxFiles.length) console.log(`✅ Copied ${sfxFiles.length} SFX files`);
}

// Copy background files
const bgDir = path.join(__dirname, 'assets', 'backgrounds');
if (fs.existsSync(bgDir)) {
    const bgFiles = fs.readdirSync(bgDir).filter(f => /\.(jpg|png|webp)$/i.test(f));
    for (const bg of bgFiles) {
        fs.copyFileSync(path.join(bgDir, bg), path.join(publicDir, bg));
    }
    if (bgFiles.length) console.log(`✅ Copied ${bgFiles.length} background files`);
}

console.log('\n🎬 Done! Open the project in the app and hit Refresh.');
