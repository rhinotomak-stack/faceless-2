import { Composition, registerRoot, staticFile } from 'remotion';
import { VideoComposition } from './Composition';
import { MGPreRenderComposition, MGBatchComposition } from './MGPreRender';


const fps = 30;

export const RemotionRoot = () => {
    return (
        <>
            <Composition
                id="FacelessVideo"
                component={VideoComposition}
                durationInFrames={fps * 10}
                fps={fps}
                width={1920}
                height={1080}
                calculateMetadata={async () => {
                    const planUrl = staticFile('video-plan.json');
                    const response = await fetch(planUrl);
                    if (!response.ok) {
                        throw new Error(`Failed to load video plan (${response.status}) from ${planUrl}`);
                    }
                    const plan = await response.json();
                    const totalDuration = Number(plan?.totalDuration);
                    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
                        throw new Error(`video-plan.json is missing a valid totalDuration (got: ${plan?.totalDuration})`);
                    }
                    return {
                        durationInFrames: Math.max(1, Math.ceil(totalDuration * fps)),
                    };
                }}
            />
            <Composition
                id="MGPreRender"
                component={MGPreRenderComposition}
                durationInFrames={fps * 5}
                fps={fps}
                width={1920}
                height={1080}
                calculateMetadata={async ({ props }) => {
                    const dur = Number(props?.duration) || 5;
                    return {
                        durationInFrames: Math.max(1, Math.ceil(dur * fps)),
                    };
                }}
            />
            <Composition
                id="MGBatch"
                component={MGBatchComposition}
                durationInFrames={fps * 10}
                fps={fps}
                width={1920}
                height={1080}
                calculateMetadata={async ({ props }) => {
                    const dur = Number(props?.totalDuration) || 10;
                    return {
                        durationInFrames: Math.max(1, Math.ceil(dur * fps)),
                    };
                }}
            />
        </>
    );
};

// Register the root component
registerRoot(RemotionRoot);
