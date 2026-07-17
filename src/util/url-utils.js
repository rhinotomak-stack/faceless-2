/**
 * URL helpers shared across the footage pipeline.
 *
 * normalizeUrlForDedup(url)
 *   Produces a stable dedup key from a media URL.
 *   - YouTube watch URLs (youtube.com/watch?v=ID): keeps the v=ID param, so two
 *     different videos do NOT collapse to the same `https://www.youtube.com/watch`.
 *   - youtu.be/ID short links: video ID is in the path; query is dropped.
 *   - Anything else (HLS manifests, tracking-tagged URLs, stock CDN): query is
 *     dropped because the path is the stable identifier and query carries
 *     volatile auth tokens.
 */
function normalizeUrlForDedup(url) {
    if (!url) return '';
    const trimmed = String(url).trim();
    if (!trimmed) return '';

    const ytWatch = trimmed.match(/^(https?:\/\/(?:www\.|m\.)?youtube\.com\/watch)\?(?:.*&)?v=([^&#]+)/i);
    if (ytWatch) return `${ytWatch[1].toLowerCase()}?v=${ytWatch[2]}`;

    const ytShort = trimmed.match(/^(https?:\/\/youtu\.be\/[^?#]+)/i);
    if (ytShort) return ytShort[1];

    return trimmed.split('?')[0];
}

module.exports = {
    normalizeUrlForDedup,
};
