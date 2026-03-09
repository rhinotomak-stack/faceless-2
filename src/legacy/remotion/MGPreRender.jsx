import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion';
import { MotionGraphic } from './MotionGraphics';

// Full-screen MG background gradients per style (same as Composition.jsx)
const MG_BACKGROUNDS = {
    clean:    'radial-gradient(ellipse at center, #0a0a2e, #000000)',
    bold:     'radial-gradient(ellipse at center, #1a0000, #0a0a0a)',
    minimal:  'radial-gradient(ellipse at center, #1a1a2e, #0f0f0f)',
    neon:     'radial-gradient(ellipse at center, #000020, #000008)',
    cinematic:'radial-gradient(ellipse at center, #1a1500, #000000)',
    elegant:  'radial-gradient(ellipse at center, #0a0020, #050010)',
};

// Google Fonts map (same as Composition.jsx — load theme fonts during pre-render)
const GOOGLE_FONTS_MAP = {
    'Orbitron': 'Orbitron:wght@400;700;900',
    'Roboto': 'Roboto:wght@400;500;600;700;900',
    'Merriweather': 'Merriweather:wght@400;700;900',
    'Open Sans': 'Open+Sans:wght@400;500;600;700',
    'Oswald': 'Oswald:wght@400;500;600;700',
    'Lato': 'Lato:wght@400;700;900',
    'Montserrat': 'Montserrat:wght@400;500;600;700;800;900',
    'Inter': 'Inter:wght@400;500;600;700',
    'Playfair Display': 'Playfair+Display:wght@400;700;900',
    'Cormorant': 'Cormorant:wght@400;500;600;700',
    'Bebas Neue': 'Bebas+Neue',
    'Roboto Condensed': 'Roboto+Condensed:wght@400;500;700',
};

function getGoogleFontsUrl(themeId) {
    if (!themeId) return null;
    try {
        const theme = require('../themes.js').getTheme(themeId);
        const fonts = new Set();
        for (const fontStack of [theme.fonts.heading, theme.fonts.body]) {
            const primary = fontStack.split(',')[0].trim().replace(/["']/g, '');
            if (GOOGLE_FONTS_MAP[primary]) fonts.add(GOOGLE_FONTS_MAP[primary]);
        }
        if (fonts.size === 0) return null;
        return `https://fonts.googleapis.com/css2?${[...fonts].map(f => `family=${f}`).join('&')}&display=swap`;
    } catch { return null; }
}

/**
 * Pre-render a single MG as a transparent or styled clip.
 *
 * inputProps shape:
 *   { mg: { type, text, subtext, style, position, duration, ... },
 *     scriptContext: { themeId, ... },
 *     duration: number (seconds),
 *     isFullScreen: boolean }
 */
export const MGPreRenderComposition = (props) => {
    const { mg, scriptContext, isFullScreen } = props;
    const fontsUrl = getGoogleFontsUrl(scriptContext?.themeId);

    if (!mg) {
        return <AbsoluteFill style={{ backgroundColor: 'transparent' }} />;
    }

    // Full-screen MG scenes get an opaque background
    if (isFullScreen) {
        const bgStyle = MG_BACKGROUNDS[mg.style] || MG_BACKGROUNDS.clean;

        // mapChart renders its own full-frame background
        if (mg.type === 'mapChart') {
            return (
                <AbsoluteFill>
                    {fontsUrl && <style dangerouslySetInnerHTML={{ __html: `@import url('${fontsUrl}');` }} />}
                    <MotionGraphic mg={mg} scriptContext={scriptContext || {}} />
                </AbsoluteFill>
            );
        }

        // articleHighlight has 3D transforms — moderate scale(1.3) to fill more of the frame
        if (mg.type === 'articleHighlight') {
            return (
                <AbsoluteFill style={{ background: bgStyle }}>
                    {fontsUrl && <style dangerouslySetInnerHTML={{ __html: `@import url('${fontsUrl}');` }} />}
                    <AbsoluteFill style={{ transform: 'scale(1.3)', transformOrigin: 'center center' }}>
                        <MotionGraphic mg={mg} scriptContext={scriptContext || {}} />
                    </AbsoluteFill>
                </AbsoluteFill>
            );
        }

        // Default full-screen MG: background + scale(1.5)
        return (
            <AbsoluteFill style={{ background: bgStyle }}>
                {fontsUrl && <style dangerouslySetInnerHTML={{ __html: `@import url('${fontsUrl}');` }} />}
                <AbsoluteFill style={{ transform: 'scale(1.5)', transformOrigin: 'center center' }}>
                    <MotionGraphic mg={mg} scriptContext={scriptContext || {}} />
                </AbsoluteFill>
            </AbsoluteFill>
        );
    }

    // Overlay MG: transparent background — rendered over video in FFmpeg
    return (
        <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
            {fontsUrl && <style dangerouslySetInnerHTML={{ __html: `@import url('${fontsUrl}');` }} />}
            <MotionGraphic mg={mg} scriptContext={scriptContext || {}} />
        </AbsoluteFill>
    );
};

/**
 * Batch render ALL MGs in a single video, back-to-back.
 * Each MG gets its own Sequence with local frame numbering so animations work.
 *
 * inputProps shape:
 *   { items: [{ mg, isFullScreen, offsetFrames, durationFrames }],
 *     scriptContext: { themeId, ... },
 *     totalDuration: number (seconds) }
 */
export const MGBatchComposition = (props) => {
    const { items, scriptContext } = props;
    const fontsUrl = getGoogleFontsUrl(scriptContext?.themeId);

    if (!items || items.length === 0) {
        return <AbsoluteFill style={{ backgroundColor: 'transparent' }} />;
    }

    return (
        <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
            {fontsUrl && <style dangerouslySetInnerHTML={{ __html: `@import url('${fontsUrl}');` }} />}
            {items.map((item, i) => (
                <Sequence
                    key={i}
                    from={item.offsetFrames}
                    durationInFrames={item.durationFrames}
                    layout="none"
                >
                    <RenderSingleMG
                        mg={item.mg}
                        scriptContext={scriptContext || {}}
                        isFullScreen={item.isFullScreen}
                    />
                </Sequence>
            ))}
        </AbsoluteFill>
    );
};

// Internal: render a single MG (used by both single and batch compositions)
const RenderSingleMG = ({ mg, scriptContext, isFullScreen }) => {
    if (!mg) return null;

    if (isFullScreen) {
        const bgStyle = MG_BACKGROUNDS[mg.style] || MG_BACKGROUNDS.clean;

        if (mg.type === 'mapChart') {
            return (
                <AbsoluteFill>
                    <MotionGraphic mg={mg} scriptContext={scriptContext} />
                </AbsoluteFill>
            );
        }
        if (mg.type === 'articleHighlight') {
            return (
                <AbsoluteFill style={{ background: bgStyle }}>
                    <AbsoluteFill style={{ transform: 'scale(1.3)', transformOrigin: 'center center' }}>
                        <MotionGraphic mg={mg} scriptContext={scriptContext} />
                    </AbsoluteFill>
                </AbsoluteFill>
            );
        }
        return (
            <AbsoluteFill style={{ background: bgStyle }}>
                <AbsoluteFill style={{ transform: 'scale(1.5)', transformOrigin: 'center center' }}>
                    <MotionGraphic mg={mg} scriptContext={scriptContext} />
                </AbsoluteFill>
            </AbsoluteFill>
        );
    }

    return (
        <AbsoluteFill style={{ backgroundColor: 'transparent' }}>
            <MotionGraphic mg={mg} scriptContext={scriptContext} />
        </AbsoluteFill>
    );
};
