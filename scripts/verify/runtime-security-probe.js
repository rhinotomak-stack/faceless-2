#!/usr/bin/env node
'use strict';

const puppeteer = require('puppeteer-core');

const browserWSEndpoint = process.argv[2];
if (!browserWSEndpoint) {
    console.error('usage: node scripts/verify/runtime-security-probe.js <browserWsEndpoint>');
    process.exit(2);
}

(async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
    const pages = await browser.pages();
    const page = pages.find((candidate) => /ui\/index\.html/i.test(candidate.url()));
    if (!page) throw new Error('main renderer page not found');

    const startupErrors = [];
    page.on('pageerror', (error) => startupErrors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        const expectedInlineCspBlock = /(?:Refused to execute inline script|Executing inline script violates)/i.test(message.text());
        if (message.type() === 'error' && !expectedInlineCspBlock) {
            startupErrors.push(`console: ${message.text()}`);
        }
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const result = await page.evaluate(async () => {
        const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || '';
        const iframe = document.getElementById('hyperframes-preview-frame');
        if (iframe && !iframe.src.startsWith('hf-preview://project/')) {
            const generated = await window.electronAPI.hyperframesGenerateProject({
                plan: {
                    totalDuration: 2,
                    fps: 30,
                    width: 640,
                    height: 360,
                    scriptContext: { title: 'Security Probe', themeId: 'standard' },
                    scenes: [{
                        index: 0,
                        clipId: 'security-probe-scene',
                        sourceSceneIndex: 0,
                        trackId: 'video-track-1',
                        startTime: 0,
                        endTime: 2,
                        duration: 2,
                        text: 'Security probe',
                        keyword: 'security probe',
                    }],
                    mgScenes: [],
                    transitions: [],
                },
                fps: 30,
                options: { preview: true },
            });
            if (generated?.previewUrl) iframe.src = generated.previewUrl;
        }

        delete window.__ytaInlineSecurityProbe;
        const inline = document.createElement('script');
        inline.textContent = 'window.__ytaInlineSecurityProbe = true;';
        document.body.appendChild(inline);
        await new Promise((resolve) => setTimeout(resolve, 50));
        inline.remove();

        const payload = '<img id="yta-xss-probe" src=x onerror="window.__ytaXssProbe=true">';
        const oldScenes = state.scenes;
        const oldSceneList = elements.sceneList;
        const sceneProbe = document.createElement('div');
        window.__ytaXssProbe = false;
        try {
            elements.sceneList = sceneProbe;
            state.scenes = [{
                index: 0,
                trackId: 'video-track-1',
                startTime: 0,
                endTime: 2,
                text: payload,
                keyword: payload,
                mediaType: 'image',
            }];
            renderScenes();
        } finally {
            state.scenes = oldScenes;
            elements.sceneList = oldSceneList;
        }

        const liveNotifList = document.getElementById('notif-list');
        const notifProbe = document.createElement('div');
        const oldNotifications = localStorage.getItem(NOTIF_STORAGE_KEY);
        let notificationInjected = null;
        try {
            if (liveNotifList) liveNotifList.id = 'notif-list-live';
            notifProbe.id = 'notif-list';
            document.body.appendChild(notifProbe);
            saveNotifications([{ title: payload, body: payload, type: 'success', timestamp: Date.now(), read: false }]);
            renderNotifList();
            notificationInjected = !!notifProbe.querySelector('img');
        } finally {
            notifProbe.remove();
            if (liveNotifList) liveNotifList.id = 'notif-list';
            if (oldNotifications === null) localStorage.removeItem(NOTIF_STORAGE_KEY);
            else localStorage.setItem(NOTIF_STORAGE_KEY, oldNotifications);
        }

        const invalidExportResult = await window.electronAPI.startWebGLExport({
            width: 15,
            height: 16,
            fps: 30,
            totalFrames: 1,
        });
        const invalidCropResult = await window.electronAPI.qaPreCropMedia({
            mediaFile: '../package.json',
            crop: { cropTop: 10 },
        });
        const projectInfo = await window.electronAPI.getProjectInfo();
        const projectPlanFileUrl = `file:///${projectInfo.projectDir.replace(/\\/g, '/')}/public/video-plan.json`;
        const confinedProjectAsset = await window.electronAPI.getFileUrl(projectPlanFileUrl);
        const rangeResponse = await fetch(confinedProjectAsset, {
            headers: { Range: 'bytes=0-15' },
        });
        const rangeBytes = new Uint8Array(await rangeResponse.arrayBuffer());
        const outsideAppFileUrl = new URL('../package.json', window.location.href).href;
        const rejectedOutsideAsset = await window.electronAPI.getFileUrl(outsideAppFileUrl);

        return {
            cspHasNoUnsafeScript: /script-src\s+'self'\s*;/.test(csp)
                && !/script-src[^;]*(?:unsafe-inline|unsafe-eval)/.test(csp),
            iframeSandbox: iframe?.getAttribute('sandbox') || '',
            iframeSource: iframe?.src || '',
            inlineScriptBlocked: window.__ytaInlineSecurityProbe !== true,
            sceneInjectedElement: !!sceneProbe.querySelector('img'),
            sceneRenderedLiteralText: sceneProbe.textContent.includes('<img id="yta-xss-probe"'),
            notificationInjectedElement: notificationInjected,
            payloadHandlerRan: window.__ytaXssProbe === true,
            escapedPayload: escapeHTML(payload),
            rawNodeGlobalsAbsent: typeof window._nodeSpawn === 'undefined'
                && typeof window._nodeFs === 'undefined'
                && typeof window._nodePath === 'undefined'
                && typeof window.require === 'undefined'
                && typeof window.process === 'undefined'
                && typeof window._qaStudioAgent === 'undefined'
                && typeof window._qaChatAgent === 'undefined'
                && typeof window._qaReplacer === 'undefined',
            retiredExportApisAbsent: typeof window.electronAPI.getExportConfig === 'undefined'
                && typeof window.electronAPI.muxAudio === 'undefined'
                && typeof window.electronAPI.sendExportFrame === 'undefined',
            secureExportApisPresent: ['startWebGLExport', 'sendExportFramesBatch', 'finishWebGLExport', 'cancelWebGLExport']
                .every((name) => typeof window.electronAPI[name] === 'function'),
            invalidExportRejected: invalidExportResult?.success === false
                && /invalid export dimensions/i.test(invalidExportResult?.error || ''),
            invalidCropRejected: invalidCropResult?.success === false
                && /inside project public\/temp\/assets/i.test(invalidCropResult?.error || ''),
            legacyProjectFileUrlConfined: /^asset:\/\//i.test(confinedProjectAsset || ''),
            projectAssetRangeSupported: rangeResponse.status === 206
                && /^bytes 0-15\/\d+$/i.test(rangeResponse.headers.get('content-range') || '')
                && rangeResponse.headers.get('accept-ranges') === 'bytes'
                && rangeBytes.byteLength === 16,
            outsideFileUrlRejected: rejectedOutsideAsset === null,
        };
    });

    let previewFrame = page.frames().find((frame) => frame.url().startsWith('hf-preview://project/'));
    for (let attempt = 0; !previewFrame && attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        previewFrame = page.frames().find((frame) => frame.url().startsWith('hf-preview://project/'));
    }
    const previewState = previewFrame
        ? await previewFrame.evaluate(() => ({
            gsapLoaded: typeof window.gsap === 'object' && typeof window.gsap.timeline === 'function',
            timelineLoaded: !!window.__timelines?.['yta-hyperframes'],
            localGsap: !!document.querySelector('script[src="vendor/gsap.min.js"]'),
            protocol: location.protocol,
        }))
        : null;

    await page.evaluate(async () => {
        await window.electronAPI.openQAStudio();
        await window.electronAPI.openStyleStudio();
        await window.electronAPI.openFootageResources();
    });
    let rolePages = [];
    for (let attempt = 0; attempt < 30; attempt++) {
        rolePages = await browser.pages();
        if (rolePages.some((candidate) => /qa-studio\.html/i.test(candidate.url()))
            && rolePages.some((candidate) => /style-studio\.html/i.test(candidate.url()))
            && rolePages.some((candidate) => /footage-resources\.html/i.test(candidate.url()))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const getApiKeys = async (pattern) => {
        const rolePage = rolePages.find((candidate) => pattern.test(candidate.url()));
        return rolePage ? rolePage.evaluate(() => Object.keys(window.electronAPI || {}).sort()) : [];
    };
    const qaApiKeys = await getApiKeys(/qa-studio\.html/i);
    const styleApiKeys = await getApiKeys(/style-studio\.html/i);
    const resourceApiKeys = await getApiKeys(/footage-resources\.html/i);
    const roleSurfaces = {
        qaScoped: qaApiKeys.includes('qaAgentAnalyzeScene')
            && qaApiKeys.includes('saveVideoPlan')
            && !qaApiKeys.includes('runBuild')
            && !qaApiKeys.includes('resourceEnvSave'),
        styleScoped: styleApiKeys.includes('styleStudioChat')
            && styleApiKeys.includes('styleStudioTranscribeAudio')
            && !styleApiKeys.includes('runBuild')
            && !styleApiKeys.includes('saveProjectFile'),
        resourcesScoped: resourceApiKeys.includes('resourceEnvStatus')
            && resourceApiKeys.includes('qwenPoolStatus')
            && !resourceApiKeys.includes('loadVideoPlan')
            && !resourceApiKeys.includes('runBuild'),
    };

    const checks = [
        ['strict script CSP active', result.cspHasNoUnsafeScript],
        ['HyperFrames iframe sandboxed without same-origin privilege', result.iframeSandbox === 'allow-scripts'],
        ['HyperFrames iframe uses isolated preview protocol', result.iframeSource.startsWith('hf-preview://project/')],
        ['HyperFrames preview frame loaded', !!previewState],
        ['HyperFrames preview uses local GSAP', previewState?.localGsap === true && previewState?.gsapLoaded === true],
        ['HyperFrames preview timeline initialized', previewState?.timelineLoaded === true],
        ['inline script execution blocked', result.inlineScriptBlocked],
        ['scene payload did not create an element', result.sceneInjectedElement === false],
        ['scene payload rendered as literal text', result.sceneRenderedLiteralText === true],
        ['notification payload did not create an element', result.notificationInjectedElement === false],
        ['payload event handler never ran', result.payloadHandlerRan === false],
        ['escapeHTML encodes tag delimiters and quotes', /&lt;img/.test(result.escapedPayload) && /&quot;/.test(result.escapedPayload)],
        ['raw Node process/filesystem globals are absent', result.rawNodeGlobalsAbsent === true],
        ['QA Studio receives only its role-scoped bridge', roleSurfaces.qaScoped],
        ['Style Studio receives only its role-scoped bridge', roleSurfaces.styleScoped],
        ['Footage Resources receives only its role-scoped bridge', roleSurfaces.resourcesScoped],
        ['retired renderer export powers are absent', result.retiredExportApisAbsent === true],
        ['secure export IPC methods are present', result.secureExportApisPresent === true],
        ['main process rejects invalid export dimensions', result.invalidExportRejected === true],
        ['QA pre-crop rejects paths outside mutable project media', result.invalidCropRejected === true],
        ['legacy project file URL is converted to confined asset URL', result.legacyProjectFileUrlConfined === true],
        ['project asset protocol supports byte-range media seeks', result.projectAssetRangeSupported === true],
        ['file URL outside project roots is rejected', result.outsideFileUrlRejected === true],
        ['renderer reload produced no unexpected errors', startupErrors.length === 0],
    ];

    console.log('\n=== RUNTIME SECURITY PROBE ===');
    let passed = 0;
    for (const [name, ok] of checks) {
        if (ok) passed++;
        console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
    }
    if (startupErrors.length) {
        for (const error of startupErrors.slice(0, 10)) console.log(`  ${error}`);
    }
    console.log(`\n${passed === checks.length ? 'ALL PASS' : 'SOME FAILED'} (${passed}/${checks.length})`);

    await browser.disconnect();
    process.exit(passed === checks.length ? 0 : 1);
})().catch((error) => {
    console.error(`RUNTIME SECURITY PROBE ERROR: ${error.message}`);
    process.exit(3);
});
