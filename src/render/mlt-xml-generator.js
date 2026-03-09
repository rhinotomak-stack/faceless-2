/**
 * MLT XML Generator
 * Port of Kdenlive's RenderRequest — converts video-plan.json into MLT XML.
 *
 * The generated .mlt file is the CONTRACT between our AI pipeline and the
 * MLT renderer (melt). Same XML drives both preview and final render,
 * guaranteeing WYSIWYG.
 *
 * MLT architecture (same as Kdenlive):
 *   - Producers: media sources (video clips, audio, images, color)
 *   - Playlists: sequential arrangements of producers on a track
 *   - Tractors: multi-track containers that composite playlists together
 *   - Transitions: composite/luma/mix between tracks
 *   - Filters: effects applied to producers or tracks
 *   - Consumer: output sink (avformat for render, sdl2 for preview)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { RenderPresetRepository } = require('./render-presets');

/**
 * Generate MLT XML from a video-plan.json
 * @param {object} plan - Parsed video-plan.json
 * @param {object} opts - { outputPath, presetName, presetOverrides, publicDir }
 * @returns {string} MLT XML string
 */
function generateMLTXml(plan, opts = {}) {
    const fps = plan.fps || 30;
    const width = plan.width || 1920;
    const height = plan.height || 1080;
    const totalFrames = Math.ceil(plan.totalDuration * fps);

    const xml = [];
    const indent = (n) => '  '.repeat(n);

    xml.push('<?xml version="1.0" encoding="utf-8"?>');
    xml.push('<mlt LC_NUMERIC="C" version="7.0" producer="main_bin" root=".">');

    // --- Profile ---
    xml.push(`${indent(1)}<profile description="AI Director Profile" width="${width}" height="${height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${width}" display_aspect_den="${height}" frame_rate_num="${fps}" frame_rate_den="1" colorspace="709"/>`);

    // --- Consumer (only for rendering, not preview) ---
    if (opts.outputPath) {
        const consumerAttrs = buildConsumerAttrs(plan, opts);
        xml.push(`${indent(1)}<consumer${consumerAttrs}/>`);
    }

    // --- Producers ---
    const producers = [];

    // Audio producer
    const audioFile = resolveMediaPath(plan.audio, opts.publicDir, plan);
    if (audioFile) {
        xml.push(`${indent(1)}<producer id="audio_main" in="0" out="${totalFrames - 1}">`);
        xml.push(`${indent(2)}<property name="resource">${escXml(audioFile)}</property>`);
        xml.push(`${indent(2)}<property name="mlt_service">avformat</property>`);
        xml.push(`${indent(2)}<property name="video_index">-1</property>`);
        xml.push(`${indent(1)}</producer>`);
    }

    // Black background producer
    xml.push(`${indent(1)}<producer id="black_bg" in="0" out="${totalFrames - 1}">`);
    xml.push(`${indent(2)}<property name="mlt_service">color</property>`);
    xml.push(`${indent(2)}<property name="resource">#000000</property>`);
    xml.push(`${indent(1)}</producer>`);

    // Scene producers (video-track-1, video-track-2, video-track-3)
    const allScenes = [...(plan.scenes || []), ...(plan.mgScenes || [])];
    for (let i = 0; i < allScenes.length; i++) {
        const scene = allScenes[i];
        const pid = scene.isMGScene ? `mg_${i}` : `scene_${scene.index != null ? scene.index : i}`;
        const inFrame = 0;
        const durationSec = (scene.endTime || 0) - (scene.startTime || 0);
        const outFrame = Math.max(0, Math.ceil(durationSec * fps) - 1);

        if (scene.mediaFile && fs.existsSync(scene.mediaFile)) {
            xml.push(`${indent(1)}<producer id="${pid}" in="${inFrame}" out="${outFrame}">`);
            xml.push(`${indent(2)}<property name="resource">${escXml(scene.mediaFile)}</property>`);
            xml.push(`${indent(2)}<property name="mlt_service">avformat</property>`);
            if (scene.mediaType === 'image' || scene.mediaExtension === '.png' || scene.mediaExtension === '.jpg') {
                xml.push(`${indent(2)}<property name="ttl">1</property>`);
                xml.push(`${indent(2)}<property name="length">${outFrame + 1}</property>`);
                xml.push(`${indent(2)}<property name="loop">1</property>`);
            }
            // Fit mode — scale to fill frame
            if (scene.fitMode === 'cover') {
                xml.push(`${indent(2)}<filter id="${pid}_resize" mlt_service="avfilter.scale">`);
                xml.push(`${indent(3)}<property name="av.w">${width}</property>`);
                xml.push(`${indent(3)}<property name="av.h">${height}</property>`);
                xml.push(`${indent(2)}</filter>`);
            }

            // Visual effects as MLT filters
            const sceneEffects = (plan.visualEffects || []).find(ve => ve.sceneIndex === scene.index);
            if (sceneEffects && !scene.isMGScene) {
                for (const effect of (sceneEffects.effects || [])) {
                    const filterXml = effectToMltFilter(effect, pid, width, height);
                    if (filterXml) xml.push(filterXml);
                }
            }

            xml.push(`${indent(1)}</producer>`);
        } else if (scene.isMGScene) {
            // Motion graphic — use color producer as placeholder
            // MG rendering will be handled by canvas pre-render + overlay
            xml.push(`${indent(1)}<producer id="${pid}" in="${inFrame}" out="${outFrame}">`);
            xml.push(`${indent(2)}<property name="mlt_service">color</property>`);
            xml.push(`${indent(2)}<property name="resource">#00000000</property>`);
            xml.push(`${indent(1)}</producer>`);
        }

        producers.push({ id: pid, scene, inFrame, outFrame });
    }

    // Overlay producers
    for (let i = 0; i < (plan.overlayScenes || []).length; i++) {
        const overlay = plan.overlayScenes[i];
        const pid = `overlay_${i}`;
        const durationSec = (overlay.endTime || plan.totalDuration) - (overlay.startTime || 0);
        const outFrame = Math.max(0, Math.ceil(durationSec * fps) - 1);

        if (overlay.mediaFile && fs.existsSync(overlay.mediaFile)) {
            xml.push(`${indent(1)}<producer id="${pid}" in="0" out="${outFrame}">`);
            xml.push(`${indent(2)}<property name="resource">${escXml(overlay.mediaFile)}</property>`);
            xml.push(`${indent(2)}<property name="mlt_service">avformat</property>`);
            if (overlay.mediaType === 'image') {
                xml.push(`${indent(2)}<property name="length">${outFrame + 1}</property>`);
                xml.push(`${indent(2)}<property name="loop">1</property>`);
            }
            // Blend mode via opacity filter
            if (overlay.overlayIntensity != null) {
                xml.push(`${indent(2)}<filter mlt_service="brightness">`);
                xml.push(`${indent(3)}<property name="alpha">${overlay.overlayIntensity}</property>`);
                xml.push(`${indent(2)}</filter>`);
            }
            xml.push(`${indent(1)}</producer>`);
        }
    }

    // --- Playlists (tracks) ---
    // Kdenlive model: each track is a playlist, tractor combines them

    // Track 1: background (black)
    xml.push(`${indent(1)}<playlist id="playlist_bg">`);
    xml.push(`${indent(2)}<entry producer="black_bg" in="0" out="${totalFrames - 1}"/>`);
    xml.push(`${indent(1)}</playlist>`);

    // Track 2: video-track-1 (main video scenes)
    const track1Scenes = (plan.scenes || []).filter(s => (s.trackId || 'video-track-1') === 'video-track-1');
    xml.push(`${indent(1)}<playlist id="playlist_video1">`);
    buildTrackPlaylist(xml, track1Scenes, fps, totalFrames, 'scene', indent);
    xml.push(`${indent(1)}</playlist>`);

    // Track 3: video-track-2 (secondary video scenes)
    const track2Scenes = (plan.scenes || []).filter(s => s.trackId === 'video-track-2');
    xml.push(`${indent(1)}<playlist id="playlist_video2">`);
    if (track2Scenes.length > 0) {
        buildTrackPlaylist(xml, track2Scenes, fps, totalFrames, 'scene', indent);
    } else {
        xml.push(`${indent(2)}<blank length="${totalFrames}"/>`);
    }
    xml.push(`${indent(1)}</playlist>`);

    // Track 4: video-track-3 (MG scenes)
    const track3Scenes = (plan.mgScenes || []).filter(s => (s.trackId || 'video-track-3') === 'video-track-3');
    xml.push(`${indent(1)}<playlist id="playlist_video3">`);
    if (track3Scenes.length > 0) {
        buildTrackPlaylist(xml, track3Scenes, fps, totalFrames, 'mg', indent);
    } else {
        xml.push(`${indent(2)}<blank length="${totalFrames}"/>`);
    }
    xml.push(`${indent(1)}</playlist>`);

    // Track 5: overlays
    xml.push(`${indent(1)}<playlist id="playlist_overlay">`);
    if ((plan.overlayScenes || []).length > 0) {
        buildTrackPlaylist(xml, plan.overlayScenes, fps, totalFrames, 'overlay', indent);
    } else {
        xml.push(`${indent(2)}<blank length="${totalFrames}"/>`);
    }
    xml.push(`${indent(1)}</playlist>`);

    // Track 6: audio
    xml.push(`${indent(1)}<playlist id="playlist_audio">`);
    if (audioFile) {
        xml.push(`${indent(2)}<entry producer="audio_main" in="0" out="${totalFrames - 1}"/>`);
    } else {
        xml.push(`${indent(2)}<blank length="${totalFrames}"/>`);
    }
    xml.push(`${indent(1)}</playlist>`);

    // --- Tractor (multi-track compositor) ---
    xml.push(`${indent(1)}<tractor id="main_tractor" in="0" out="${totalFrames - 1}">`);

    // Multitrack
    xml.push(`${indent(2)}<multitrack>`);
    xml.push(`${indent(3)}<track producer="playlist_bg"/>`);
    xml.push(`${indent(3)}<track producer="playlist_video1"/>`);
    xml.push(`${indent(3)}<track producer="playlist_video2" hide="video"/>`);  // initially hidden if empty
    xml.push(`${indent(3)}<track producer="playlist_video3" hide="video"/>`);
    xml.push(`${indent(3)}<track producer="playlist_overlay" hide="video"/>`);
    xml.push(`${indent(3)}<track producer="playlist_audio" hide="video"/>`);
    xml.push(`${indent(2)}</multitrack>`);

    // Unhide tracks that have content
    if (track2Scenes.length > 0) {
        xml[xml.length - 4] = `${indent(3)}<track producer="playlist_video2"/>`;
    }
    if (track3Scenes.length > 0) {
        xml[xml.length - 3] = `${indent(3)}<track producer="playlist_video3"/>`;
    }
    if ((plan.overlayScenes || []).length > 0) {
        xml[xml.length - 2] = `${indent(3)}<track producer="playlist_overlay"/>`;
    }

    // Transitions — composite tracks together
    // Track 1 (video1) over track 0 (bg)
    xml.push(`${indent(2)}<transition id="composite_v1" mlt_service="frei0r.cairoblend">`);
    xml.push(`${indent(3)}<property name="a_track">0</property>`);
    xml.push(`${indent(3)}<property name="b_track">1</property>`);
    xml.push(`${indent(2)}</transition>`);

    // Track 2 (video2) over track 1
    if (track2Scenes.length > 0) {
        xml.push(`${indent(2)}<transition id="composite_v2" mlt_service="frei0r.cairoblend">`);
        xml.push(`${indent(3)}<property name="a_track">1</property>`);
        xml.push(`${indent(3)}<property name="b_track">2</property>`);
        xml.push(`${indent(2)}</transition>`);
    }

    // Track 3 (video3/MGs) over track 2
    if (track3Scenes.length > 0) {
        xml.push(`${indent(2)}<transition id="composite_v3" mlt_service="frei0r.cairoblend">`);
        xml.push(`${indent(3)}<property name="a_track">${track2Scenes.length > 0 ? 2 : 1}</property>`);
        xml.push(`${indent(3)}<property name="b_track">3</property>`);
        xml.push(`${indent(2)}</transition>`);
    }

    // Track 4 (overlay) over everything
    if ((plan.overlayScenes || []).length > 0) {
        xml.push(`${indent(2)}<transition id="composite_overlay" mlt_service="frei0r.cairoblend">`);
        xml.push(`${indent(3)}<property name="a_track">1</property>`);
        xml.push(`${indent(3)}<property name="b_track">4</property>`);
        xml.push(`${indent(2)}</transition>`);
    }

    // Audio mix — mix audio track with video track audio
    xml.push(`${indent(2)}<transition id="audio_mix" mlt_service="mix">`);
    xml.push(`${indent(3)}<property name="a_track">0</property>`);
    xml.push(`${indent(3)}<property name="b_track">5</property>`);
    xml.push(`${indent(3)}<property name="combine">1</property>`);
    xml.push(`${indent(2)}</transition>`);

    // Scene-to-scene transitions (luma, dissolve, etc.)
    buildSceneTransitions(xml, plan, fps, indent);

    xml.push(`${indent(1)}</tractor>`);

    xml.push('</mlt>');

    return xml.join('\n');
}

/**
 * Build playlist entries for a track, inserting blanks between scenes.
 */
function buildTrackPlaylist(xml, scenes, fps, totalFrames, prefix, indent) {
    let cursor = 0; // current frame position

    // Sort by startTime
    const sorted = [...scenes].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));

    for (let i = 0; i < sorted.length; i++) {
        const scene = sorted[i];
        const startFrame = Math.round((scene.startTime || 0) * fps);
        const endFrame = Math.round((scene.endTime || scene.startTime || 0) * fps);
        const durationFrames = endFrame - startFrame;

        if (durationFrames <= 0) continue;

        // Insert blank before this scene if needed
        if (startFrame > cursor) {
            xml.push(`${indent(2)}<blank length="${startFrame - cursor}"/>`);
        }

        const idx = scene.index != null ? scene.index : i;
        const pid = prefix === 'mg' ? `mg_${i}` : prefix === 'overlay' ? `overlay_${idx}` : `scene_${idx}`;

        xml.push(`${indent(2)}<entry producer="${pid}" in="0" out="${durationFrames - 1}"/>`);
        cursor = endFrame;
    }

    // Trailing blank
    if (cursor < totalFrames) {
        xml.push(`${indent(2)}<blank length="${totalFrames - cursor}"/>`);
    }
}

/**
 * Build scene-to-scene transitions in the tractor.
 * Maps our transition types to MLT transitions.
 */
function buildSceneTransitions(xml, plan, fps, indent) {
    const transitions = plan.transitions || [];

    for (const trans of transitions) {
        if (trans.type === 'cut' || trans.duration <= 0) continue;

        const durationFrames = Math.round((trans.duration || 0) / 1000 * fps);
        if (durationFrames <= 0) continue;

        // Find the scenes to get frame positions
        const fromScene = (plan.scenes || [])[trans.fromSceneIndex];
        const toScene = (plan.scenes || [])[trans.toSceneIndex];
        if (!fromScene || !toScene) continue;

        const transFrame = Math.round((toScene.startTime || 0) * fps);
        const inFrame = Math.max(0, transFrame - Math.floor(durationFrames / 2));
        const outFrame = transFrame + Math.ceil(durationFrames / 2);

        let mltService = 'luma';
        let extraProps = '';

        switch (trans.type) {
            case 'dissolve':
            case 'crossfade':
                mltService = 'luma';
                // Pure dissolve = luma with no resource (no wipe pattern)
                break;
            case 'push':
                mltService = 'luma';
                extraProps = `${indent(3)}<property name="resource">%luma01.pgm</property>\n`;
                break;
            case 'wipe':
            case 'wipe_left':
                mltService = 'luma';
                extraProps = `${indent(3)}<property name="resource">%luma04.pgm</property>\n`;
                break;
            case 'blur':
                // Use luma with softness
                mltService = 'luma';
                extraProps = `${indent(3)}<property name="softness">0.5</property>\n`;
                break;
            default:
                mltService = 'luma';
        }

        xml.push(`${indent(2)}<transition mlt_service="${mltService}" in="${inFrame}" out="${outFrame}">`);
        xml.push(`${indent(3)}<property name="a_track">0</property>`);
        xml.push(`${indent(3)}<property name="b_track">1</property>`);
        if (extraProps) xml.push(extraProps);
        xml.push(`${indent(2)}</transition>`);
    }
}

/**
 * Build consumer attributes string from preset params.
 * Mirrors Kdenlive's RenderRequest::setDocGeneralParams().
 */
function buildConsumerAttrs(plan, opts) {
    const fps = plan.fps || 30;
    const totalFrames = Math.ceil(plan.totalDuration * fps);

    let attrs = '';
    attrs += ` mlt_service="avformat"`;
    attrs += ` target="${escXml(opts.outputPath)}"`;
    attrs += ` in="0" out="${totalFrames - 1}"`;
    attrs += ` rescale="bilinear"`;
    attrs += ` deinterlacer="onefield"`;

    // Add preset params
    if (opts.presetName) {
        const repo = RenderPresetRepository.get();
        const params = repo.resolvePresetParams(opts.presetName, opts.presetOverrides || {});
        if (params) {
            for (const [k, v] of params) {
                attrs += ` ${escXml(k)}="${escXml(v)}"`;
            }
        }
    } else if (opts.consumerParams) {
        // Direct params map
        for (const [k, v] of Object.entries(opts.consumerParams)) {
            attrs += ` ${escXml(k)}="${escXml(v)}"`;
        }
    }

    // Two-pass support
    if (opts.pass === 1) {
        attrs += ` pass="1" fastfirstpass="1" an="1"`;
    } else if (opts.pass === 2) {
        attrs += ` pass="2"`;
        if (opts.passLogFile) {
            attrs += ` passlogfile="${escXml(opts.passLogFile)}"`;
        }
    }

    return attrs;
}

/**
 * Map our visual effect types to MLT filter XML.
 */
function effectToMltFilter(effect, producerId, width, height) {
    const indent = (n) => '  '.repeat(n);
    const intensity = effect.intensity || 0.3;

    switch (effect.type) {
        case 'vignette':
            return [
                `${indent(2)}<filter mlt_service="vignette">`,
                `${indent(3)}<property name="smooth">${Math.round(intensity * 80)}</property>`,
                `${indent(2)}</filter>`
            ].join('\n');

        case 'grain':
            return [
                `${indent(2)}<filter mlt_service="frei0r.grain_merge">`,
                `${indent(2)}</filter>`
            ].join('\n');

        case 'colorTint':
            if (effect.tint === 'cool') {
                return [
                    `${indent(2)}<filter mlt_service="avfilter.colorbalance">`,
                    `${indent(3)}<property name="av.bs">${intensity * 0.5}</property>`,
                    `${indent(3)}<property name="av.ms">${intensity * 0.3}</property>`,
                    `${indent(2)}</filter>`
                ].join('\n');
            } else if (effect.tint === 'warm') {
                return [
                    `${indent(2)}<filter mlt_service="avfilter.colorbalance">`,
                    `${indent(3)}<property name="av.rs">${intensity * 0.4}</property>`,
                    `${indent(3)}<property name="av.gs">${intensity * 0.2}</property>`,
                    `${indent(2)}</filter>`
                ].join('\n');
            }
            return null;

        case 'chromatic':
            // No direct MLT equivalent — skip or use blur approximation
            return null;

        case 'letterbox':
            return [
                `${indent(2)}<filter mlt_service="avfilter.drawbox">`,
                `${indent(3)}<property name="av.x">0</property>`,
                `${indent(3)}<property name="av.y">0</property>`,
                `${indent(3)}<property name="av.w">${width}</property>`,
                `${indent(3)}<property name="av.h">${Math.round(height * 0.12)}</property>`,
                `${indent(3)}<property name="av.color">black</property>`,
                `${indent(3)}<property name="av.t">fill</property>`,
                `${indent(2)}</filter>`
            ].join('\n');

        default:
            return null;
    }
}

/**
 * Resolve a media path relative to publicDir or as absolute.
 */
function resolveMediaPath(filename, publicDir, plan) {
    if (!filename) return null;
    // Already absolute
    if (path.isAbsolute(filename) && fs.existsSync(filename)) return filename;
    // Try publicDir
    if (publicDir) {
        const p = path.join(publicDir, filename);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Escape XML special characters.
 */
function escXml(str) {
    if (typeof str !== 'string') str = String(str);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Write MLT XML to a file.
 * @returns {string} Path to the generated .mlt file
 */
function generateMLTFile(plan, opts = {}) {
    const xml = generateMLTXml(plan, opts);
    const mltPath = opts.mltPath || path.join(opts.tempDir || require('os').tmpdir(), `render-${Date.now()}.mlt`);

    const dir = path.dirname(mltPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(mltPath, xml, 'utf8');
    return mltPath;
}

module.exports = {
    generateMLTXml,
    generateMLTFile,
    buildConsumerAttrs,
    escXml
};
