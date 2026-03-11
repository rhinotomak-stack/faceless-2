/**
 * Generate SFX audio files for transitions using ffmpeg.
 * Run: node assets/sfx/generate-sfx.js
 *
 * These are synthesized placeholder sounds. Replace with real SFX files for better quality.
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const outDir = __dirname;

const sfx = [
    {
        name: 'sfx-fade.mp3',
        desc: 'Soft low whoosh (fade)',
        // Pink noise with low-pass filter, gentle fade in/out
        cmd: `-f lavfi -i "anoisesrc=d=0.5:c=pink:a=0.08" -af "lowpass=f=800,afade=t=in:ss=0:d=0.15,afade=t=out:st=0.3:d=0.2" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-slide.mp3',
        desc: 'Fast swoosh (slide)',
        // White noise with bandpass sweep, quick fade
        cmd: `-f lavfi -i "anoisesrc=d=0.4:c=white:a=0.12" -af "bandpass=f=2000:w=1000,afade=t=in:ss=0:d=0.05,afade=t=out:st=0.15:d=0.25,atempo=1.2" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-zoom.mp3',
        desc: 'Rising sweep (zoom)',
        // Sine sweep from low to high frequency
        cmd: `-f lavfi -i "sine=f=200:d=0.5" -f lavfi -i "sine=f=800:d=0.5" -filter_complex "[0][1]amix=inputs=2:duration=first,afade=t=in:ss=0:d=0.1,afade=t=out:st=0.3:d=0.2,volume=0.15" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-blur.mp3',
        desc: 'Airy soft whoosh (blur)',
        // Pink noise with high-pass, very soft
        cmd: `-f lavfi -i "anoisesrc=d=0.5:c=pink:a=0.06" -af "highpass=f=400,lowpass=f=3000,afade=t=in:ss=0:d=0.2,afade=t=out:st=0.25:d=0.25" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-wipe.mp3',
        desc: 'Fast lateral swipe (wipe)',
        // Short sharp noise burst
        cmd: `-f lavfi -i "anoisesrc=d=0.3:c=white:a=0.15" -af "bandpass=f=3000:w=2000,afade=t=in:ss=0:d=0.03,afade=t=out:st=0.08:d=0.22" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-dissolve.mp3',
        desc: 'Gentle shimmer (dissolve)',
        // Layered soft tones
        cmd: `-f lavfi -i "sine=f=1200:d=0.5" -f lavfi -i "sine=f=1800:d=0.5" -f lavfi -i "anoisesrc=d=0.5:c=pink:a=0.03" -filter_complex "[0][1][2]amix=inputs=3:duration=first,afade=t=in:ss=0:d=0.15,afade=t=out:st=0.25:d=0.25,volume=0.08" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-flash.mp3',
        desc: 'Bright snap (flash)',
        // Very short impact burst
        cmd: `-f lavfi -i "anoisesrc=d=0.3:c=white:a=0.25" -af "highpass=f=1000,afade=t=in:ss=0:d=0.01,afade=t=out:st=0.04:d=0.26,volume=0.6" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-filmburn.mp3',
        desc: 'Crackling burn (filmBurn)',
        // Noise with tremolo effect to simulate crackling
        cmd: `-f lavfi -i "anoisesrc=d=0.6:c=brown:a=0.12" -af "tremolo=f=30:d=0.7,lowpass=f=2000,afade=t=in:ss=0:d=0.1,afade=t=out:st=0.35:d=0.25" -ar 44100 -b:a 128k`
    },
    // ===== NEW: Additional SFX for expanded transitions =====
    {
        name: 'sfx-glitch.mp3',
        desc: 'Digital glitch stutter (glitch/dataMosh/rgbSplit)',
        // Choppy noise with rapid tremolo to simulate digital corruption
        cmd: `-f lavfi -i "anoisesrc=d=0.4:c=white:a=0.2" -af "tremolo=f=60:d=0.9,bandpass=f=4000:w=3000,afade=t=in:ss=0:d=0.02,afade=t=out:st=0.15:d=0.25,volume=0.5" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-camera-flash.mp3',
        desc: 'Camera shutter + flash pop (cameraFlash)',
        // Sharp bright snap with high-frequency click
        cmd: `-f lavfi -i "anoisesrc=d=0.3:c=white:a=0.3" -af "highpass=f=2000,afade=t=in:ss=0:d=0.005,afade=t=out:st=0.03:d=0.27,volume=0.5" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-whip.mp3',
        desc: 'Fast whip pan swoosh (whip)',
        // Very fast directional noise sweep
        cmd: `-f lavfi -i "anoisesrc=d=0.3:c=white:a=0.18" -af "bandpass=f=2500:w=2000,afade=t=in:ss=0:d=0.02,afade=t=out:st=0.06:d=0.24,atempo=1.5" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-bounce.mp3',
        desc: 'Elastic bounce pop (bounce)',
        // Short tone with descending pitch + pop
        cmd: `-f lavfi -i "sine=f=600:d=0.4" -f lavfi -i "sine=f=300:d=0.4" -filter_complex "[0][1]amix=inputs=2:duration=first,afade=t=in:ss=0:d=0.01,afade=t=out:st=0.15:d=0.25,volume=0.2" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-ripple.mp3',
        desc: 'Water ripple shimmer (ripple)',
        // Soft resonant shimmer with slight tremolo
        cmd: `-f lavfi -i "sine=f=800:d=0.7" -f lavfi -i "anoisesrc=d=0.7:c=pink:a=0.04" -filter_complex "[0][1]amix=inputs=2:duration=first,tremolo=f=8:d=0.4,afade=t=in:ss=0:d=0.1,afade=t=out:st=0.4:d=0.3,volume=0.1" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-spin.mp3',
        desc: 'Spinning whoosh (spin)',
        // Rising-falling frequency sweep with doppler effect
        cmd: `-f lavfi -i "sine=f=400:d=0.6" -f lavfi -i "sine=f=1200:d=0.6" -filter_complex "[0][1]amix=inputs=2:duration=first,tremolo=f=12:d=0.5,afade=t=in:ss=0:d=0.05,afade=t=out:st=0.3:d=0.3,volume=0.15" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-shutter.mp3',
        desc: 'Mechanical shutter click (shutterSlice)',
        // Sharp mechanical click
        cmd: `-f lavfi -i "anoisesrc=d=0.25:c=white:a=0.25" -af "bandpass=f=5000:w=3000,afade=t=in:ss=0:d=0.003,afade=t=out:st=0.02:d=0.23,volume=0.4" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-flare.mp3',
        desc: 'Bright lens flare shimmer (flare/lightLeak)',
        // Bright ascending tones with noise
        cmd: `-f lavfi -i "sine=f=1000:d=0.6" -f lavfi -i "sine=f=2000:d=0.6" -f lavfi -i "anoisesrc=d=0.6:c=pink:a=0.03" -filter_complex "[0][1][2]amix=inputs=3:duration=first,afade=t=in:ss=0:d=0.08,afade=t=out:st=0.3:d=0.3,volume=0.1" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-static.mp3',
        desc: 'TV static noise burst (static/scanline)',
        // White noise with heavy band-pass to simulate TV static
        cmd: `-f lavfi -i "anoisesrc=d=0.5:c=white:a=0.15" -af "bandpass=f=6000:w=4000,tremolo=f=50:d=0.8,afade=t=in:ss=0:d=0.02,afade=t=out:st=0.2:d=0.3,volume=0.4" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-ink.mp3',
        desc: 'Soft ink spread (ink/reveal)',
        // Low soft spreading sound
        cmd: `-f lavfi -i "anoisesrc=d=0.6:c=brown:a=0.1" -af "lowpass=f=1200,afade=t=in:ss=0:d=0.15,afade=t=out:st=0.3:d=0.3" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-prism.mp3',
        desc: 'Crystal prism shimmer (prismShift)',
        // High-frequency shimmering tones
        cmd: `-f lavfi -i "sine=f=2400:d=0.5" -f lavfi -i "sine=f=3200:d=0.5" -filter_complex "[0][1]amix=inputs=2:duration=first,tremolo=f=6:d=0.3,afade=t=in:ss=0:d=0.1,afade=t=out:st=0.25:d=0.25,volume=0.08" -ar 44100 -b:a 128k`
    },
    // ===== MG (Motion Graphics) SFX =====
    {
        name: 'sfx-mg-pop.mp3',
        desc: 'Quick pop-in for text/headline appear',
        // Short bright pop with slight reverb feel
        cmd: `-f lavfi -i "sine=f=1000:d=0.25" -f lavfi -i "anoisesrc=d=0.25:c=pink:a=0.08" -filter_complex "[0][1]amix=inputs=2:duration=first,afade=t=in:ss=0:d=0.01,afade=t=out:st=0.06:d=0.19,volume=0.25" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-mg-tick.mp3',
        desc: 'Counter tick for statCounter/progressBar',
        // Soft mechanical tick
        cmd: `-f lavfi -i "sine=f=3000:d=0.15" -af "afade=t=in:ss=0:d=0.002,afade=t=out:st=0.01:d=0.14,volume=0.2" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-mg-swoosh.mp3',
        desc: 'Smooth swoosh for lowerThird/callout slide-in',
        // Soft directional swoosh
        cmd: `-f lavfi -i "anoisesrc=d=0.35:c=pink:a=0.1" -af "bandpass=f=1500:w=1000,afade=t=in:ss=0:d=0.03,afade=t=out:st=0.1:d=0.25,volume=0.3" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-mg-ding.mp3',
        desc: 'Bright ding for chart/data reveal',
        // Clean bell-like tone
        cmd: `-f lavfi -i "sine=f=1400:d=0.4" -f lavfi -i "sine=f=2100:d=0.4" -filter_complex "[0][1]amix=inputs=2:duration=first,afade=t=in:ss=0:d=0.005,afade=t=out:st=0.1:d=0.3,volume=0.12" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-mg-type.mp3',
        desc: 'Typewriter click for kineticText',
        // Quick mechanical keystroke
        cmd: `-f lavfi -i "anoisesrc=d=0.2:c=white:a=0.2" -af "bandpass=f=4000:w=2000,afade=t=in:ss=0:d=0.002,afade=t=out:st=0.015:d=0.185,volume=0.35" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-mg-rise.mp3',
        desc: 'Rising tone for timeline/rankingList progression',
        // Ascending tone sweep
        cmd: `-f lavfi -i "sine=f=400:d=0.5" -f lavfi -i "sine=f=1200:d=0.5" -filter_complex "[0][1]amix=inputs=2:duration=first,afade=t=in:ss=0:d=0.05,afade=t=out:st=0.25:d=0.25,volume=0.12" -ar 44100 -b:a 128k`
    },
    {
        name: 'sfx-mg-chime.mp3',
        desc: 'Notification chime for subscribeCTA',
        // Two-tone notification bell
        cmd: `-f lavfi -i "sine=f=1200:d=0.5" -f lavfi -i "sine=f=1600:d=0.5" -filter_complex "[0]adelay=0|0[a];[1]adelay=150|150[b];[a][b]amix=inputs=2:duration=first,afade=t=in:ss=0:d=0.01,afade=t=out:st=0.2:d=0.3,volume=0.15" -ar 44100 -b:a 128k`
    }
];

console.log('Generating SFX audio files...\n');

for (const s of sfx) {
    const outPath = path.join(outDir, s.name);
    // Remove existing
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

    const fullCmd = `ffmpeg -y ${s.cmd} "${outPath}" 2>&1`;
    try {
        execSync(fullCmd, { stdio: 'pipe' });
        const size = fs.statSync(outPath).size;
        console.log(`  OK  ${s.name} (${(size/1024).toFixed(1)}KB) - ${s.desc}`);
    } catch (e) {
        console.error(`  FAIL  ${s.name} - ${e.message}`);
    }
}

console.log('\nDone! SFX files generated in:', outDir);
console.log('Replace with real SFX files for better quality.');
