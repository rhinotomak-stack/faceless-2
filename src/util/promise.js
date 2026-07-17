/**
 * promise.js — delivery-promise checks (OPENMONTAGE-BORROW-PLAN #9).
 *
 * The load-bearing insight: an animated card / still image is a SLIDE, not
 * motion. A footage-led niche that quietly shipped mostly text cards + stills
 * has broken its implicit promise ("this is a video, not a slideshow").
 *
 * Pure, plan-level, deterministic — no ffmpeg, no AI. Consumed by final-review.
 */
'use strict';

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

function _ext(s) {
    const e = String(s.mediaExtension || '').toLowerCase();
    if (e) return e.startsWith('.') ? e : '.' + e;
    const f = String(s.mediaFile || s.videoFile || s.imageFile || '');
    const m = f.match(/\.[a-z0-9]+$/i);
    return m ? m[0].toLowerCase() : '';
}

/** Classify a base-layer scene: 'video' (real motion) | 'slide' (still/graphic) | 'skip'. */
function classifyScene(s) {
    if (!s) return 'skip';
    // Fullscreen graphics / template cards are slides regardless of any media behind them.
    if (s.templateType || s.fullscreenMG || s.isTemplate) return 'slide';
    const ext = _ext(s);
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (IMAGE_EXTS.has(ext)) return 'slide';
    if (s.mediaType === 'video') return 'video';
    if (s.mediaType === 'image') return 'slide';
    return 'skip'; // no resolvable media (e.g. pure overlay-host) — don't count
}

/**
 * @param {object} plan  — video-plan.json
 * @param {object} [opts] — { niche } resolved niche object (footagePriority/preferredMediaType)
 * @returns {{ratio:number, videoScenes:number, slideScenes:number, total:number, footageLed:boolean, floor:number, finding:object|null, metrics:object}}
 */
function computeMotionRatio(plan, opts = {}) {
    const niche = opts.niche || null;
    const scenes = (plan && Array.isArray(plan.scenes)) ? plan.scenes : [];
    // Only count base-layer content scenes (overlay/upper tracks aren't the "backbone").
    const base = scenes.filter((s) => !s.trackId || s.trackId === 'video-track-1');
    let video = 0, slide = 0;
    for (const s of base) {
        const c = classifyScene(s);
        if (c === 'video') video++;
        else if (c === 'slide') slide++;
    }
    const total = video + slide;
    const ratio = total > 0 ? video / total : 0;

    // Footage-led = the niche prefers motion footage (has a video priority list and
    // doesn't explicitly prefer stills). Unknown niche → assume footage-led.
    let footageLed = true;
    if (niche) {
        const hasVideoPriority = !!(niche.footagePriority && Array.isArray(niche.footagePriority.video) && niche.footagePriority.video.length);
        const prefersImage = String(niche.preferredMediaType || '').toLowerCase() === 'image';
        footageLed = hasVideoPriority && !prefersImage;
    }
    const floor = 0.30;

    let finding = null;
    if (total >= 6) { // only judge once there's enough content to be meaningful
        if (footageLed && ratio < floor) {
            finding = {
                severity: ratio < 0.15 ? 'fail' : 'warn',
                code: 'motion_ratio_low',
                message: `Motion ratio ${(ratio * 100).toFixed(0)}% (${video} video / ${slide} still-or-card of ${total}) is below the ${(floor * 100).toFixed(0)}% floor for a footage-led niche — this reads as a slideshow, not a video.`,
            };
        }
    }
    return {
        ratio: Math.round(ratio * 1000) / 1000,
        videoScenes: video, slideScenes: slide, total,
        footageLed, floor, finding,
        metrics: { motion_ratio: Math.round(ratio * 1000) / 1000, videoScenes: video, slideScenes: slide },
    };
}

module.exports = { computeMotionRatio, classifyScene };
