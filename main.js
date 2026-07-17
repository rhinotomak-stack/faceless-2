/**
 * YTA Empire WEBGL - Electron Main Process
 * This file creates the desktop app window and bridges the UI to Node.js
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, protocol, net, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { execSync, spawn, exec } = require('child_process');

// Remote-debugging port for the verify workflow: lets tooling attach to the
// LIVE app via DevTools protocol (seek the preview, screenshot the renderer,
// read console) instead of only window-surface captures. Localhost-only.
// Disable with YTA_REMOTE_DEBUG=0.
if (!/^(0|false|off)$/i.test(String(process.env.YTA_REMOTE_DEBUG || '').trim())) {
    app.commandLine.appendSwitch('remote-debugging-port', '9223');
}

// ========================================
// Project Directory Resolution
// ========================================
// Parse --project=<path> or .fvp file path from command line args
const APP_ROOT = __dirname;  // The app's install directory (code, node_modules, assets)
let PROJECT_DIR = APP_ROOT;  // Default: use app root (backward compat)
let hasExplicitProject = false;

for (const arg of process.argv) {
    if (arg.startsWith('--project=')) {
        PROJECT_DIR = arg.substring('--project='.length);
        hasExplicitProject = true;
        break;
    }
    // Handle double-click on .fvp file: extract project dir from file path
    if (arg.endsWith('.fvp') && fs.existsSync(arg)) {
        PROJECT_DIR = path.dirname(arg);
        hasExplicitProject = true;
        break;
    }
}

// Resolve to absolute path
PROJECT_DIR = path.resolve(PROJECT_DIR);
// Publish to the process env so any module running in the main process
// (e.g. style-studio-agent) can locate the active project without being passed it.
process.env.PROJECT_DIR = PROJECT_DIR;

// ========================================
// Single-Instance Lock (per project directory)
// ========================================
// Each unique PROJECT_DIR gets its own lock so multiple projects can run simultaneously,
// but two instances can't accidentally share the same project folder.
// We use a lock file instead of Electron's requestSingleInstanceLock because that's app-global.
function acquireProjectLock() {
    const lockFile = path.join(PROJECT_DIR, '.lock');
    try {
        // Ensure directory exists before creating lock
        if (!fs.existsSync(PROJECT_DIR)) {
            fs.mkdirSync(PROJECT_DIR, { recursive: true });
        }
        // Try to create lock file exclusively (fails if already exists)
        fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
        return true;
    } catch (e) {
        if (e.code === 'EEXIST') {
            // Lock file exists — check if the PID is still alive
            try {
                const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
                if (pid && !isNaN(pid)) {
                    // Check if process is still running
                    try {
                        process.kill(pid, 0); // signal 0 = just check if alive
                        return false; // Process is alive — lock is held
                    } catch (_) {
                        // Process is dead — stale lock, overwrite it
                        fs.writeFileSync(lockFile, String(process.pid));
                        return true;
                    }
                }
            } catch (_) { }
            // Can't read lock file or invalid PID — overwrite
            fs.writeFileSync(lockFile, String(process.pid));
            return true;
        }
        // Some other error (e.g. dir doesn't exist yet) — proceed anyway
        return true;
    }
}

function releaseProjectLock() {
    try {
        const lockFile = path.join(PROJECT_DIR, '.lock');
        if (fs.existsSync(lockFile)) {
            const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
            if (pid === process.pid) {
                fs.unlinkSync(lockFile);
            }
        }
    } catch (_) { }
}

// Project-specific paths (isolated per instance)
const PROJECT_ROOT = APP_ROOT; // Keep for code/node_modules references
let INPUT_PATH = path.join(PROJECT_DIR, 'input');
let OUTPUT_PATH = path.join(PROJECT_DIR, 'output');
let TEMP_PATH = path.join(PROJECT_DIR, 'temp');
let PUBLIC_PATH = path.join(PROJECT_DIR, 'public');

// Ensure project subdirectories exist
function ensureProjectDirs() {
    for (const dir of [INPUT_PATH, OUTPUT_PATH, TEMP_PATH, PUBLIC_PATH]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}
ensureProjectDirs();

// Copy .env from app root to project dir if it doesn't exist there yet
const appEnvPath = path.join(APP_ROOT, '.env');
const projectEnvPath = path.join(PROJECT_DIR, '.env');
if (PROJECT_DIR !== APP_ROOT && fs.existsSync(appEnvPath) && !fs.existsSync(projectEnvPath)) {
    fs.copyFileSync(appEnvPath, projectEnvPath);
}

// Derive a human-readable project name from the directory
let PROJECT_NAME = PROJECT_DIR === APP_ROOT ? '' : path.basename(PROJECT_DIR);
let CURRENT_LOG_FILE = null;

const _baseConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
};

function getLogsDir(projectDir = PROJECT_DIR) {
    return path.join(projectDir, 'logs');
}

function ensureLogsDir(projectDir = PROJECT_DIR) {
    const logsDir = getLogsDir(projectDir);
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
    }
    return logsDir;
}

function nowStamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function stringifyLogArgs(args) {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }).join(' ');
}

function appendProjectLog(level, message) {
    if (!CURRENT_LOG_FILE) return;
    try {
        const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
        fs.appendFileSync(CURRENT_LOG_FILE, line, 'utf8');
    } catch (e) {
        _baseConsole.error('Failed to write project log:', e.message);
    }
}

function initProjectLogger(projectDir = PROJECT_DIR) {
    try {
        const logsDir = ensureLogsDir(projectDir);
        CURRENT_LOG_FILE = path.join(logsDir, `app-${nowStamp()}-${process.pid}.log`);
        appendProjectLog('INFO', `Logger initialized. projectDir=${projectDir}`);
    } catch (e) {
        _baseConsole.error('Failed to initialize project logger:', e.message);
        CURRENT_LOG_FILE = null;
    }
}

function getLatestProjectLogFile(projectDir = PROJECT_DIR) {
    const logsDir = ensureLogsDir(projectDir);
    try {
        const files = fs.readdirSync(logsDir)
            .filter((f) => f.toLowerCase().endsWith('.log'))
            .map((name) => {
                const file = path.join(logsDir, name);
                const stat = fs.statSync(file);
                return { file, mtimeMs: stat.mtimeMs };
            })
            .sort((a, b) => b.mtimeMs - a.mtimeMs);

        if (files.length > 0) {
            return files[0].file;
        }
    } catch (_) {
        // Fall back to current log file below
    }
    return (CURRENT_LOG_FILE && fs.existsSync(CURRENT_LOG_FILE)) ? CURRENT_LOG_FILE : null;
}

// Kill log tail PowerShell windows by matching their window title
function killLogTailWindows() {
    try {
        execSync('taskkill /FI "WINDOWTITLE eq Project Logs - Live" /F', { stdio: 'ignore' });
    } catch (_) { /* no matching window — ignore */ }
}

function tailProjectLogsLive(projectDir = PROJECT_DIR) {
    const logFile = getLatestProjectLogFile(projectDir);
    if (!logFile || !fs.existsSync(logFile)) {
        return { success: false, error: `No log file found in ${getLogsDir(projectDir)}` };
    }

    if (process.platform === 'win32') {
        try {
            // Write a small .ps1 script to temp so we can pass complex commands cleanly.
            // The script writes its own PID to a file so we can track it for cleanup.
            const escaped = logFile.replace(/'/g, "''");
            const scriptFile = path.join(projectDir, 'temp', '_logtail.ps1');

            const psScript = [
                `$Host.UI.RawUI.WindowTitle = 'Project Logs - Live'`,
                `$p = '${escaped}'`,
                `if (-not (Test-Path -LiteralPath $p)) { Write-Host 'Log file not found:' $p -ForegroundColor Red; Read-Host 'Press Enter to close'; exit 1 }`,
                `Write-Host 'Tailing log:' $p -ForegroundColor Cyan; Write-Host ''`,
                `Get-Content -LiteralPath $p -Tail 50 -Wait`,
            ].join('\n');

            // Ensure temp dir exists
            const tempDir = path.join(projectDir, 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            // Write with UTF-8 BOM so PowerShell correctly reads unicode characters (em dash, etc.)
            const BOM = '\uFEFF';
            fs.writeFileSync(scriptFile, BOM + psScript, 'utf8');

            // Use cmd /c start to create a visible console window
            const child = spawn('cmd.exe', [
                '/c', 'start', 'Project Logs',
                'powershell.exe',
                '-NoLogo', '-NoProfile', '-NoExit',
                '-ExecutionPolicy', 'Bypass',
                '-File', scriptFile
            ], {
                detached: true,
                stdio: 'ignore',
                shell: false,
            });
            child.unref();

            return { success: true, logFile };
        } catch (e) {
            return { success: false, error: `Failed to launch log tail: ${e.message}` };
        }
    }

    return { success: false, error: 'Live log tail is currently implemented for Windows only.' };
}

function setupConsoleTee() {
    if (console.__ytaTeePatched) return;
    console.__ytaTeePatched = true;

    console.log = (...args) => {
        _baseConsole.log(...args);
        appendProjectLog('INFO', stringifyLogArgs(args));
    };
    console.warn = (...args) => {
        _baseConsole.warn(...args);
        appendProjectLog('WARN', stringifyLogArgs(args));
    };
    console.error = (...args) => {
        _baseConsole.error(...args);
        appendProjectLog('ERROR', stringifyLogArgs(args));
    };
}

setupConsoleTee();
initProjectLogger(PROJECT_DIR);

function applyProjectDir(projectDir) {
    PROJECT_DIR = path.resolve(projectDir);
    process.env.PROJECT_DIR = PROJECT_DIR;
    INPUT_PATH = path.join(PROJECT_DIR, 'input');
    OUTPUT_PATH = path.join(PROJECT_DIR, 'output');
    TEMP_PATH = path.join(PROJECT_DIR, 'temp');
    PUBLIC_PATH = path.join(PROJECT_DIR, 'public');
    PROJECT_NAME = PROJECT_DIR === APP_ROOT ? '' : path.basename(PROJECT_DIR);
    ensureProjectDirs();

    // Copy .env from app root to selected project dir if needed
    const newEnvPath = path.join(PROJECT_DIR, '.env');
    if (fs.existsSync(appEnvPath) && !fs.existsSync(newEnvPath)) {
        fs.copyFileSync(appEnvPath, newEnvPath);
    }
    initProjectLogger(PROJECT_DIR);
    console.log(`📁 Active project set to: ${PROJECT_DIR}`);

    // Wipe accumulated Style Studio chat history on project switch so long
    // Detach in-memory Style Studio sessions so the old project's Gemini context
    // doesn't leak into the new one. The on-disk session stays intact — when the
    // user switches back, Style Studio restores from disk (like ChatGPT projects).
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.clearChatHistory(path.join(PROJECT_DIR, 'styles'));
    } catch (e) {
        console.warn(`[project-switch] Failed to detach studio session: ${e.message}`);
    }
}

let startupWindow = null;
let startupChoiceResolver = null;

function resolveStartupChoice(projectPath) {
    if (startupChoiceResolver) {
        const resolve = startupChoiceResolver;
        startupChoiceResolver = null;
        resolve(projectPath || null);
    }
    if (startupWindow && !startupWindow.isDestroyed()) {
        startupWindow.close();
    }
}

function createStartupWindow() {
    return new Promise((resolve) => {
        startupChoiceResolver = resolve;

        startupWindow = new BrowserWindow({
            width: 860,
            height: 560,
            minWidth: 860,
            minHeight: 560,
            resizable: false,
            maximizable: false,
            minimizable: true,
            fullscreenable: false,
            autoHideMenuBar: true,
            backgroundColor: '#0a0a0a',
            title: 'YTA Empire WEBGL — Start',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false,
                sandbox: false,
                preload: path.join(__dirname, 'preload.js')
            },
            icon: getWindowIconPath() || undefined
        });

        startupWindow.loadFile(path.join(__dirname, 'ui', 'startup.html'));

        startupWindow.on('closed', () => {
            startupWindow = null;
            if (startupChoiceResolver) {
                const pending = startupChoiceResolver;
                startupChoiceResolver = null;
                pending(null);
            }
        });
    });
}

async function promptForExistingProjectPath(parentWindow) {
    const mode = await dialog.showMessageBox(parentWindow || null, {
        type: 'question',
        title: 'Open Project',
        message: 'How do you want to open the project?',
        detail: 'You can open by selecting the project folder, or pick a .fvp project file directly.',
        buttons: ['Project Folder', '.fvp File', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
    });

    if (mode.response === 2) {
        return null;
    }

    if (mode.response === 1) {
        const fileResult = await dialog.showOpenDialog(parentWindow || null, {
            title: 'Open .fvp project file',
            properties: ['openFile'],
            filters: [{ name: 'Project Files', extensions: ['fvp'] }],
        });
        if (fileResult.canceled || !fileResult.filePaths.length) return null;
        return path.dirname(fileResult.filePaths[0]);
    }

    const folderResult = await dialog.showOpenDialog(parentWindow || null, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (folderResult.canceled || !folderResult.filePaths.length) return null;
    return folderResult.filePaths[0];
}

async function promptStartupProjectPath() {
    return createStartupWindow();
}

const APP_ICON_ICO = path.join(APP_ROOT, 'assets', 'icon.ico');
const APP_ICON_TASKBAR_PNG = path.join(APP_ROOT, 'assets', 'icon-taskbar.png');
const APP_ICON_PNG = path.join(APP_ROOT, 'assets', 'icon.png');

function getIconSourcePng() {
    if (fs.existsSync(APP_ICON_TASKBAR_PNG)) return APP_ICON_TASKBAR_PNG;
    return fs.existsSync(APP_ICON_PNG) ? APP_ICON_PNG : null;
}

function getIcoIconPath() {
    return fs.existsSync(APP_ICON_ICO) ? APP_ICON_ICO : null;
}

function getWindowIconPath() {
    const ico = getIcoIconPath();
    if (ico) return ico;
    return getIconSourcePng();
}

function getShortcutIconPath() {
    return getIcoIconPath() || process.execPath;
}

function ensureIcoFromPng() {
    const sourcePngPath = getIconSourcePng();
    if (!sourcePngPath) {
        return;
    }
    if (fs.existsSync(APP_ICON_ICO)) {
        const icoMtime = fs.statSync(APP_ICON_ICO).mtimeMs;
        const srcMtime = fs.statSync(sourcePngPath).mtimeMs;
        if (icoMtime >= srcMtime) {
            return;
        }
    }
    try {
        const png = fs.readFileSync(sourcePngPath);
        // PNG signature + IHDR sanity check
        const pngSig = '89504e470d0a1a0a';
        if (png.length < 24 || png.slice(0, 8).toString('hex') !== pngSig || png.toString('ascii', 12, 16) !== 'IHDR') {
            throw new Error(`${path.basename(sourcePngPath)} is not a valid PNG`);
        }

        const width = png.readUInt32BE(16);
        const height = png.readUInt32BE(20);
        const widthByte = width >= 256 ? 0 : width;
        const heightByte = height >= 256 ? 0 : height;

        // ICO header + single PNG image entry
        const icoHeader = Buffer.alloc(22);
        icoHeader.writeUInt16LE(0, 0);   // reserved
        icoHeader.writeUInt16LE(1, 2);   // type = icon
        icoHeader.writeUInt16LE(1, 4);   // image count
        icoHeader.writeUInt8(widthByte, 6);
        icoHeader.writeUInt8(heightByte, 7);
        icoHeader.writeUInt8(0, 8);      // color count
        icoHeader.writeUInt8(0, 9);      // reserved
        icoHeader.writeUInt16LE(1, 10);  // planes
        icoHeader.writeUInt16LE(32, 12); // bit count
        icoHeader.writeUInt32LE(png.length, 14);
        icoHeader.writeUInt32LE(22, 18); // offset to image data

        fs.writeFileSync(APP_ICON_ICO, Buffer.concat([icoHeader, png]));
        console.log(`✅ Generated ${APP_ICON_ICO} from ${path.basename(sourcePngPath)}`);
    } catch (e) {
        console.warn(`⚠️ Could not generate icon.ico: ${e.message}`);
    }
}

ensureIcoFromPng();

let mainWindow;
let footageResourcesWindow = null;
let footageResourceState = {
    clipAnalyzer: true,
    footageSources: {
        storyblocks: false,
        pexels: true,
        pixabay: true,
        youtube: true,
        reddit: true,
        bing: true,
        brave: true,
    },
};

function normalizeFootageResourceState(input = {}) {
    const sources = input.footageSources || input.sources || {};
    return {
        clipAnalyzer: input.clipAnalyzer !== false,
        footageSources: {
            storyblocks: sources.storyblocks === true,
            pexels: sources.pexels !== false,
            pixabay: sources.pixabay !== false,
            youtube: sources.youtube !== false,
            reddit: sources.reddit !== false,
            bing: sources.bing !== false,
            brave: sources.brave !== false,
        },
    };
}

function broadcastFootageResourceState() {
    const payload = { ...footageResourceState, updatedAt: new Date().toISOString() };
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('footage-resources-updated', payload);
    }
    if (footageResourcesWindow && !footageResourcesWindow.isDestroyed()) {
        footageResourcesWindow.webContents.send('footage-resources-updated', payload);
    }
}

function createFootageResourcesWindow() {
    const htmlFile = path.join(__dirname, 'ui', 'footage-resources.html');
    if (footageResourcesWindow && !footageResourcesWindow.isDestroyed()) {
        footageResourcesWindow.focus();
        return footageResourcesWindow;
    }
    footageResourcesWindow = new BrowserWindow({
        width: 980,
        height: 820,
        minWidth: 760,
        minHeight: 620,
        backgroundColor: '#0a0a0a',
        title: 'Resource Control Center',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    footageResourcesWindow.loadFile(htmlFile);
    footageResourcesWindow.on('closed', () => { footageResourcesWindow = null; });
    footageResourcesWindow.webContents.once('did-finish-load', () => {
        if (footageResourcesWindow && !footageResourcesWindow.isDestroyed()) {
            footageResourcesWindow.webContents.send('footage-resources-updated', footageResourceState);
        }
    });
    return footageResourcesWindow;
}

// ========================================
// Create Window
// ========================================
async function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        backgroundColor: '#0a0a0a',
        titleBarStyle: 'default',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: getWindowIconPath() || undefined
    });

    // Disable caching so CSS/JS changes are picked up immediately
    await mainWindow.webContents.session.clearCache().catch(() => {});
    await mainWindow.webContents.session.clearCodeCaches({}).catch(() => {});

    // Set window title with project name
    if (PROJECT_NAME) {
        mainWindow.setTitle(`YTA Empire WEBGL — ${PROJECT_NAME}`);
    }

    // Load the UI
    mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

    // Custom menu - let Ctrl+Z/C/V/S pass through to the renderer
    const sendToRenderer = (channel) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel);
        }
    };
    const menu = Menu.buildFromTemplate([
        {
            label: 'File',
            submenu: [
                { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: () => sendToRenderer('menu-save') },
                { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => sendToRenderer('menu-new') },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendToRenderer('menu-undo') },
                { type: 'separator' },
                { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => sendToRenderer('menu-copy') },
                { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => sendToRenderer('menu-paste') },
                { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => sendToRenderer('menu-select-all') },
                { label: 'Delete', accelerator: 'Delete', click: () => sendToRenderer('menu-delete') }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { role: 'resetZoom' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Create Desktop Shortcut', click: async () => {
                        const result = await ipcMain.emit('create-desktop-shortcut') || {};
                        // Call directly instead of through IPC
                        try {
                            const desktopDir = path.join(require('os').homedir(), 'Desktop');
                            const shortcutPath = path.join(desktopDir, 'YTA Empire WEBGL.lnk');
                            const electronExe = process.execPath;
                            const icon = getShortcutIconPath();
                            const ps = `$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $sc.TargetPath = '${electronExe.replace(/'/g, "''")}'; $sc.Arguments = '""${APP_ROOT.replace(/'/g, "''")}""'; $sc.WorkingDirectory = '${APP_ROOT.replace(/'/g, "''")}'; $sc.IconLocation = '${icon.replace(/'/g, "''")}'; $sc.Description = 'YTA Empire WEBGL'; $sc.Save();`;
                            execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
                            dialog.showMessageBox(mainWindow, { title: 'Shortcut Created', message: 'Desktop shortcut created successfully!', type: 'info' });
                        } catch (e) {
                            dialog.showMessageBox(mainWindow, { title: 'Error', message: `Failed to create shortcut: ${e.message}`, type: 'error' });
                        }
                    }
                },
                {
                    label: 'Open Project Logs', click: async () => {
                        const logsDir = ensureLogsDir(PROJECT_DIR);
                        await shell.openPath(logsDir);
                    }
                },
                {
                    label: 'Tail Project Logs (Live)', click: async () => {
                        const result = tailProjectLogsLive(PROJECT_DIR);
                        if (!result.success) {
                            dialog.showMessageBox(mainWindow, {
                                title: 'Log Tail Failed',
                                message: result.error || 'Could not tail project logs.',
                                type: 'error'
                            });
                        }
                    }
                },
                { type: 'separator' },
                { label: 'About', click: () => dialog.showMessageBox(mainWindow, { title: 'YTA Empire WEBGL', message: 'AI-powered video generator', type: 'info' }) }
            ]
        }
    ]);
    Menu.setApplicationMenu(menu);

    // Open DevTools in development
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Forward renderer console messages to main process log (critical for diagnostics)
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
        // level: 0=verbose, 1=info, 2=warning, 3=error
        if (level >= 2 || message.includes('✅') || message.includes('❌') || message.includes('Restored project') || message.includes('No saved project') || message.includes('[PreCache]') || message.includes('[MGRenderer]')) {
            const prefix = level >= 3 ? '[RENDERER ERROR]' : level >= 2 ? '[RENDERER WARN]' : '[RENDERER]';
            console.log(`${prefix} ${message}`);
        }
    });

    console.log('🎬 YTA Empire WEBGL started');
}

// ========================================
// V2 GPU-Native Export: colocate GPU thread with main process
// Required for EGL/ANGLE D3D11 device access from native addon.
// Enable with EXPORT_V2=1 environment variable.
// ========================================
// --in-process-gpu moves GPU thread into main process so native addon can
// access ANGLE's EGL display for D3D11 shared texture interop.
// --disable-gpu-compositing prevents blank window by using software UI compositing
// while keeping GPU available for WebGL rendering.
// Disable with EXPORT_V2=0 if it causes problems.
if (process.env.EXPORT_V2 !== '0') {
    app.commandLine.appendSwitch('in-process-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
    app.commandLine.appendSwitch('no-sandbox');
    console.log('[V2] --in-process-gpu + --disable-gpu-compositing ENABLED');
} else {
    console.log('[V2] --in-process-gpu DISABLED (EXPORT_V2=0)');
}

// ========================================
// App Lifecycle
// ========================================
app.setAppUserModelId('YTA Empire WEBGL');

// Register asset:// as a privileged scheme (must be before app.whenReady)
protocol.registerSchemesAsPrivileged([
    { scheme: 'asset', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } }
]);

app.whenReady().then(async () => {
    // Register asset:// protocol handler for serving local files securely
    // Raw string manipulation to avoid URL parser mangling Windows drive letters
    protocol.handle('asset', (request) => {
        // Strip scheme prefix: "asset:///C:/path" or "asset://C:/path" → "C:/path"
        let filePath = request.url.replace(/^asset:\/{2,3}/, '');
        // Strip any cache-bust query/hash (?cb=… added after a scene Retry so the browser
        // re-fetches the swapped file) before resolving the real path on disk.
        filePath = filePath.replace(/[?#].*$/, '');
        filePath = decodeURIComponent(filePath);
        // Restore drive colon if URL parser stripped it (C/path → C:/path)
        if (/^[A-Za-z]\//.test(filePath)) {
            filePath = filePath[0] + ':' + filePath.slice(1);
        }
        return net.fetch('file:///' + filePath);
    });
    // If app launched without an explicit project argument, ask user at startup.
    if (!hasExplicitProject) {
        const selectedProjectPath = await promptStartupProjectPath();
        if (!selectedProjectPath) {
            app.quit();
            return;
        }
        applyProjectDir(selectedProjectPath);
    }

    const lockAcquired = acquireProjectLock();

    if (!lockAcquired) {
        // Another instance is already using this project directory
        const response = await dialog.showMessageBox(null, {
            type: 'warning',
            title: 'Project Already Open',
            message: `This project folder is already open in another window:\n\n${PROJECT_DIR}`,
            detail: 'Choose a different folder to work in, or cancel to quit.',
            buttons: ['Choose Folder', 'Cancel'],
            defaultId: 0
        });

        if (response.response === 0) {
            // Let user pick a new folder
            const folderResult = await dialog.showOpenDialog(null, {
                title: 'Choose a project folder',
                properties: ['openDirectory', 'createDirectory']
            });
            if (folderResult.canceled || !folderResult.filePaths.length) {
                app.quit();
                return;
            }
            // Re-set all project paths to the new folder
            applyProjectDir(folderResult.filePaths[0]);
            // Acquire lock on new dir
            acquireProjectLock();
        } else {
            app.quit();
            return;
        }
    }

    createWindow();

    // Auto-probe V2 on startup to log GPU capabilities
    if (typeof _gpuExportAddon !== 'undefined' && _gpuExportAddon && process.env.EXPORT_V2 !== '0') {
        try {
            const probe = _gpuExportAddon.probeAngleD3D11();
            if (probe.ok) {
                console.log('[V2] GPU Probe SUCCESS:');
                console.log('  Renderer:', probe.details?.renderer);
                console.log('  Adapter:', probe.details?.adapterDescription);
                console.log('  LUID:', probe.details?.adapterLuid);
                console.log('  EGL Extensions:', probe.details?.eglExtensions?.length, 'found');
            } else {
                console.log(`[V2] GPU Probe: ${probe.reason} — ${probe.error || ''}`);
            }
        } catch (e) {
            console.log('[V2] GPU Probe error:', e.message);
        }
    }
});

app.on('window-all-closed', () => {
    killLogTailWindows();
    releaseProjectLock();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    killLogTailWindows();
    releaseProjectLock();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// ========================================
// IPC Handlers (Bridge between UI and Node.js)
// ========================================

// Copy audio file to input folder
ipcMain.handle('copy-file', async (event, sourcePath, destFolder) => {
    try {
        if (!sourcePath || typeof sourcePath !== 'string') {
            return { success: false, error: 'Source path is missing or invalid' };
        }
        const destPath = destFolder === 'input' ? INPUT_PATH : destFolder;
        const fileName = path.basename(sourcePath);
        const destination = path.join(destPath, fileName);

        // Ensure folder exists
        if (!fs.existsSync(destPath)) {
            fs.mkdirSync(destPath, { recursive: true });
        }

        // Skip copy if source is already in the destination folder
        if (path.resolve(sourcePath) === path.resolve(destination)) {
            console.log(`✅ Audio already in ${destFolder}, skipping copy`);
            return { success: true, path: destination };
        }

        // Validate the source BEFORE touching the destination. A stale source path (e.g.
        // a public/ copy wiped by a prior build) must never cause us to delete the good
        // copy already sitting in the destination. If the destination already holds this
        // file, treat it as already-present and reuse it instead of failing.
        if (!fs.existsSync(sourcePath)) {
            if (fs.existsSync(destination)) {
                console.log(`⚠️ Source missing (${sourcePath}) but ${fileName} already in ${destFolder} — reusing existing copy`);
                return { success: true, path: destination };
            }
            return { success: false, error: `Source audio not found: ${sourcePath}` };
        }

        // Clear existing audio files in input (source is confirmed to exist)
        const existingFiles = fs.readdirSync(destPath);
        existingFiles.forEach(file => {
            if (file.endsWith('.mp3') || file.endsWith('.wav')) {
                fs.unlinkSync(path.join(destPath, file));
            }
        });

        // Copy file
        fs.copyFileSync(sourcePath, destination);
        console.log(`✅ Copied ${fileName} to ${destFolder}`);

        return { success: true, path: destination };
    } catch (error) {
        console.error('❌ Copy failed:', error);
        return { success: false, error: error.message };
    }
});

// Copy a chosen presenter image into the ACTIVE project's assets/ folder (talking-head
// mode). Unlike copy-file('input'), this never clears audio and always targets the
// project dir, so the image is project-local and Step 8 can find it. Returns absolute path.
ipcMain.handle('copy-presenter-image', async (event, sourcePath) => {
    try {
        if (!sourcePath || typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
            return { success: false, error: 'Presenter image not found' };
        }
        const assetsDir = path.join(PROJECT_DIR, 'assets');
        if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
        const ext = (path.extname(sourcePath) || '.png').toLowerCase();
        const destination = path.join(assetsDir, `presenter-source${ext}`);
        fs.copyFileSync(sourcePath, destination);
        console.log(`✅ Copied presenter image to ${destination}`);
        return { success: true, path: destination };
    } catch (error) {
        console.error('❌ Presenter image copy failed:', error);
        return { success: false, error: error.message };
    }
});

// Active child process tracking for cancellation
let activeProcess = null;
let activeProcessType = null; // 'build' or 'render'
let processCancelled = false;
let activeRenderCancelled = false;

ipcMain.handle('cancel-process', async () => {

    if (activeProcess) {
        const type = activeProcessType || 'process';
        const pid = activeProcess.pid;
        console.log(`⛔ Cancelling ${type} (PID: ${pid})...`);
        processCancelled = true;
        if (type === 'render') activeRenderCancelled = true;
        try {
            // Kill entire process tree on Windows
            if (process.platform === 'win32') {
                exec(`taskkill /pid ${pid} /f /t`, (err) => {
                    if (err) console.error('taskkill error:', err.message);
                    else console.log(`taskkill success for PID ${pid}`);
                });
            } else {
                activeProcess.kill('SIGTERM');
            }
        } catch (e) {
            console.error('Error killing process:', e);
            try { activeProcess.kill('SIGKILL'); } catch (_) { }
        }
        return { success: true, message: `${type} cancelled` };
    }

    // Legacy: WebGL export via main-process FFmpeg (kept for backward compat)
    if (_webglExport && _webglExport.proc) {
        try {
            _webglExport.proc.stdin.end();
            _webglExport.proc.kill('SIGTERM');
        } catch (_) { }
        return { success: true, message: 'render cancelled' };
    }

    // Direct-spawn mode: FFmpeg runs in renderer, cancelled via ExportPipeline.cancel()
    return { success: true, message: 'No active main-process export (direct-spawn mode)' };
});

// Apply the chosen vision backend before the build spawns, so the build child inherits it.
// The GPU MACHINE itself is no longer booted here — it is started JUST-IN-TIME inside the
// build pipeline (src/build-video.js, right before media scoring) and stopped once vision is
// done (src/vision-gpu.js). That keeps the rented GPU off during transcribe/Director/Planner
// (before scoring) and rendering (after) — the model the user asked for, for ALL GPU backends.
async function _prepareVisionForBuild(options) {
    if (options && options.visionBackend) {
        const vb = String(options.visionBackend).toLowerCase();
        if (String(process.env.VISION_BACKEND || 'aws').toLowerCase() !== vb) {
            process.env.VISION_BACKEND = vb;
            try { updateEnvFile('VISION_BACKEND', vb); } catch (_) {}
            try { require('./src/settings/config').resolveVisionBackend(); } catch (_) {}
        }
    }
}

// Run the build pipeline
ipcMain.handle('run-build', async (event, options) => {
    try {
        console.log('🚀 Starting build with options:', options);

        // Update .env with AI provider and Ollama model settings
        if (options.aiProvider) {
            applyBrainProvider(options.aiProvider);
        }
        if (options.ollamaModel) {
            updateEnvFile('OLLAMA_MODEL', options.ollamaModel);
        }
        if (options.ollamaVisionModel) {
            updateEnvFile('OLLAMA_VISION_MODEL', options.ollamaVisionModel);
        }

        // Send progress updates to renderer
        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('build-progress', { percent, message });
            }
        };

        sendProgress(5, '🔑 Preparing build...');

        // Apply the chosen vision backend so the build child inherits it. The GPU machine is
        // started just-in-time inside the pipeline (right before scoring), not here.
        try { await _prepareVisionForBuild(options); } catch (e) { console.warn('vision prep failed:', e.message); }

        sendProgress(8, '⚙️ Starting build pipeline...');

        // Run the build script
        return new Promise((resolve, reject) => {
            // options -> child-process env now lives in the schema-driven single
            // source of truth (src/settings/build-env.js), proven byte-identical to
            // the old inline logic by scripts/verify-settings.js.
            const { applyOptionsToEnv } = require('./src/settings/build-env');
            const { env: buildEnv, isSmartAI } = applyOptionsToEnv(options, { projectDir: PROJECT_DIR });
            console.log(`   🧠 Smart AI: smartAI=${options.smartAI} (${typeof options.smartAI}) → SMART_AI=${buildEnv.SMART_AI}`);
            console.log(`   🎬 Clip Analyzer: ${buildEnv.CLIP_ANALYZER_ENABLED === 'true' ? 'ON' : 'OFF'}`);
            if (buildEnv.BUILD_REPEAT_FROM) console.log(`   🔁 Repeat From Step: ${buildEnv.BUILD_REPEAT_FROM}`);
            if (buildEnv.BUILD_FORCE_FRESH_FOOTAGE === 'true') console.log(`   🆕 Force fresh footage: ON (re-downloading clips, keeping VP plan)`);
            console.log(`   ♻️  Resume Build: ${buildEnv.BUILD_RESUME === 'true' ? `ON (skip completed steps${buildEnv.BUILD_REPEAT_FROM ? ` — repeat from ${buildEnv.BUILD_REPEAT_FROM}` : ''})` : 'OFF (fresh build)'}`);
            if (buildEnv.AI_THINKING && buildEnv.AI_THINKING !== 'off') console.log(`   🧠 AI Thinking: ${buildEnv.AI_THINKING}`);
            // Pass --smart-ai flag as CLI arg for reliability (env vars can be lost on Windows)
            const buildArgs = ['src/pipeline/build-video.js'];
            if (!isSmartAI) buildArgs.push('--dumb');
            const buildProcess = spawn(process.execPath, buildArgs, {
                cwd: APP_ROOT,
                shell: false,
                env: buildEnv
            });
            activeProcess = buildProcess;
            activeProcessType = 'build';
            processCancelled = false;

            let output = '';
            let errorOutput = '';

            // ── Clean build-summary log ──
            // Mirrors the in-app Build Log panel to disk: a readable,
            // phase-grouped, per-scene file written ALONGSIDE the verbose
            // app-*.log. Same logs/ folder; built from the structured events.
            let cleanLogFile = null;
            try {
                const logsDir = ensureLogsDir(PROJECT_DIR);
                cleanLogFile = path.join(logsDir, `build-summary-${nowStamp()}.log`);
                fs.writeFileSync(cleanLogFile, `Build summary — ${new Date().toLocaleString()}\n${'='.repeat(56)}\n`, 'utf8');
                console.log(`📋 Clean build summary → ${cleanLogFile}`);
            } catch (_) { cleanLogFile = null; }
            const _hms = () => new Date().toTimeString().slice(0, 8);
            const _evtIcon = { ok: '✅', fail: '❌', warn: '⚠️', timeout: '⏱️', start: '·', info: '·', done: '✅' };
            // Authoritative phase → progress% map (phase slugs from src/logger.js
            // _phaseId). The on-screen status is driven by these real phase events
            // so it ALWAYS reflects the current step (never stuck on a stale label).
            const PHASE_PROGRESS = {
                clean: 6, audio: 9, preflight: 12, transcribe: 15,
                director: 24, mapassign: 30, visualplanner: 36, orchestrator: 44,
                scout: 46, pool: 48, download: 58,
                framing: 66, mg: 72, 'explainer-images': 74, 'map-images': 75,
                templates: 78, transitions: 80, overlays: 76, sfx: 82,
                plan: 85, 'composition-author': 90, copy: 95,
            };
            let _lastPhasePct = 8;
            const appendCleanEvent = (evt) => {
                if (!cleanLogFile || !evt || typeof evt !== 'object') return;
                try {
                    let line = '';
                    if (evt.t === 'phase') {
                        line = `\n[${_hms()}] ═══ ${evt.label || evt.phase} ═══`;
                    } else if (evt.t === 'scene') {
                        if (evt.status === 'start') return; // keep file to terminal outcomes only
                        const icon = _evtIcon[evt.status] || '·';
                        line = `[${_hms()}]   S${evt.scene} ${icon} ${evt.msg || ''}${evt.detail ? `  (${evt.detail})` : ''}`;
                    } else if (evt.t === 'note') {
                        const icon = _evtIcon[evt.status] || '·';
                        line = `[${_hms()}]   ${icon} ${evt.msg || ''}${evt.scene != null ? ` [S${evt.scene}]` : ''}`;
                    }
                    if (line) fs.appendFileSync(cleanLogFile, line + '\n', 'utf8');
                } catch (_) { /* best-effort */ }
            };

            buildProcess.stdout.on('data', (data) => {
                let text = data.toString();

                // ── Structured Build Log events ──
                // The pipeline emits compact `@@EVT@@<json>` lines (see
                // src/logger.js). Pull them out, forward each to the renderer's
                // in-app Build Log panel, and STRIP them from the text before it
                // hits the terminal/.log echo so the file stays clean.
                if (text.includes('@@EVT@@')) {
                    const keptLines = [];
                    for (const line of text.split('\n')) {
                        const i = line.indexOf('@@EVT@@');
                        if (i === -1) { keptLines.push(line); continue; }
                        // Anything before the sentinel on the same line is real output.
                        const before = line.slice(0, i);
                        if (before.trim()) keptLines.push(before);
                        const jsonStr = line.slice(i + '@@EVT@@'.length).trim();
                        try {
                            const evt = JSON.parse(jsonStr);
                            appendCleanEvent(evt); // mirror to the clean build-summary file
                            // Drive the on-screen status from the REAL current phase so it
                            // never sticks on a stale label. Monotonic (never goes backward).
                            if (evt.t === 'phase' && evt.status === 'start' && evt.label) {
                                const mapped = PHASE_PROGRESS[evt.phase];
                                const pct = Math.max(_lastPhasePct, Number.isFinite(mapped) ? mapped : _lastPhasePct);
                                _lastPhasePct = pct;
                                sendProgress(pct, evt.label);
                            }
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send('build-event', evt);
                            }
                        } catch (_) { /* malformed event line — drop it */ }
                    }
                    text = keptLines.join('\n');
                }

                output += text;
                if (text.trim()) console.log(text);

                // Progress + status are now driven AUTHORITATIVELY by the @@EVT@@
                // phase events above (so the label always tracks the real step and
                // never sticks on "Transcribing"). Only the completion sentinel and
                // a couple of long-phase sub-status hints remain here.
                if (text.includes('BUILD COMPLETE')) sendProgress(100, '✅ Build complete!');
                else if (/Rendering frame\s+\d+\s*\/\s*\d+/.test(text)) { const m = text.match(/Rendering frame\s+(\d+)\s*\/\s*(\d+)/); if (m) sendProgress(Math.max(_lastPhasePct, 96), `🎬 Rendering frame ${m[1]}/${m[2]}...`); }

                // Qwen key fully vision-exhausted alert — sentinel emitted by
                // src/ai-provider.js when every model in QWEN_VL_POOL is
                // permanently dead on a specific key. Surface as OS notification
                // + in-app toast so the user knows to swap the key in .env.
                const qwenAlertRe = /QWEN_KEY_VISION_EXHAUSTED\|key=(\d+)(?:\|tail=([A-Za-z0-9_-]+))?\|pool=(\d+)/g;
                let qwenMatch;
                while ((qwenMatch = qwenAlertRe.exec(text)) !== null) {
                    const [, keyIdx, tail, pool] = qwenMatch;
                    const title = 'Qwen Vision Key Exhausted';
                    const tailText = tail ? ` (...${tail})` : '';
                    const body  = `Key ${keyIdx}${tailText} — all ${pool} vision models permanently exhausted. Swap with a fresh key in .env.`;
                    if (Notification.isSupported()) {
                        try { new Notification({ title, body, silent: false }).show(); } catch (_) {}
                    }
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('build-progress', {
                            percent: -1, // sticky alert, don't move progress bar
                            message: `⚠️ ${body}`
                        });
                    }
                }

                const qwenDegradedRe = /QWEN_KEY_VISION_DEGRADED\|key=(\d+)\|tail=([A-Za-z0-9_-]+)\|image=(\d+\/\d+)\|omni=(\d+\/\d+)/g;
                let qwenDegradedMatch;
                while ((qwenDegradedMatch = qwenDegradedRe.exec(text)) !== null) {
                    const [, keyIdx, tail, image, omni] = qwenDegradedMatch;
                    const title = 'Qwen Vision Key Degraded';
                    const body = `Key ${keyIdx} (...${tail}) image ${image}, omni ${omni}. Build can continue, but this key may slow scoring.`;
                    if (Notification.isSupported()) {
                        try { new Notification({ title, body, silent: true }).show(); } catch (_) {}
                    }
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('build-progress', {
                            percent: -1,
                            message: `⚠️ ${body}`
                        });
                    }
                }

                // QWEN_KEY_TEXT_EXHAUSTED handler removed — Qwen is now
                // vision-only, so the text-side sentinel is never emitted.

            });

            buildProcess.stderr.on('data', (data) => {
                const text = data.toString();
                errorOutput += text;
                // Suppress ffmpeg banner/config noise (always writes to stderr, not a real error)
                if (/^(ffmpeg version|built with gcc|configuration:|lib(av|sw|post)|Input #|Output #|Stream #|Stream mapping|Press \[q\]|size=|frame=|\[out#|Duration:|Metadata:|major_brand|minor_version|compatible_brands|creation_time|handler_name|vendor_id|encoder)/m.test(text.trim())) return;
                console.error(text);
            });

            buildProcess.on('close', (code) => {
                const wasCancelled = processCancelled;
                activeProcess = null;
                activeProcessType = null;
                processCancelled = false;
                if (wasCancelled) {
                    console.log('⛔ Build was cancelled by user');
                    resolve({ success: false, error: 'Cancelled' });
                    return;
                }
                if (code === 0) {
                    // Inject transitionStyle into video plan if provided
                    if (options.transitionStyle) {
                        try {
                            const planPaths = [
                                path.join(TEMP_PATH, 'video-plan.json'),
                                path.join(PUBLIC_PATH, 'video-plan.json')
                            ];
                            for (const p of planPaths) {
                                if (fs.existsSync(p)) {
                                    const plan = JSON.parse(fs.readFileSync(p, 'utf8'));
                                    plan.transitionStyle = options.transitionStyle;
                                    fs.writeFileSync(p, JSON.stringify(plan, null, 2));
                                }
                            }
                        } catch (e) {
                            console.error('Failed to inject transitionStyle:', e);
                        }
                    }
                    resolve({ success: true, output });
                } else {
                    resolve({ success: false, error: errorOutput || 'Build failed' });
                }
            });

            buildProcess.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });
        });

    } catch (error) {
        console.error('❌ Build error:', error);
        return { success: false, error: error.message };
    }
});

// Load video plan
ipcMain.handle('load-video-plan', async () => {
    try {
        // Try public folder first (where build-video.js copies files)
        const publicPlanPath = path.join(PUBLIC_PATH, 'video-plan.json');
        if (fs.existsSync(publicPlanPath)) {
            const data = fs.readFileSync(publicPlanPath, 'utf8');
            console.log('✅ Loaded video plan from public folder');
            return JSON.parse(data);
        }

        // Fall back to temp folder
        const tempPlanPath = path.join(TEMP_PATH, 'video-plan.json');
        if (fs.existsSync(tempPlanPath)) {
            const data = fs.readFileSync(tempPlanPath, 'utf8');
            console.log('✅ Loaded video plan from temp folder');
            return JSON.parse(data);
        }

        console.log('⚠️ No video plan found');
        return null;
    } catch (error) {
        console.error('❌ Failed to load video plan:', error);
        return null;
    }
});

// Save Video Plan
ipcMain.handle('save-video-plan', async (event, plan) => {
    try {
        // Save to both temp and public to be safe
        const paths = [
            path.join(TEMP_PATH, 'video-plan.json'),
            path.join(PUBLIC_PATH, 'video-plan.json')
        ];

        const data = JSON.stringify(plan, null, 2);

        paths.forEach(p => {
            // Ensure directory exists
            const dir = path.dirname(p);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(p, data);
        });

        console.log('✅ Video plan saved from UI');
        return { success: true };
    } catch (error) {
        console.error('❌ Failed to save plan:', error);
        return { success: false, error: error.message };
    }
});

// ── Per-scene timeline actions (Retry footage / CEO edit) ───────────────────
// Runs in the MAIN process (Node) — the SAME context as the real build — so the
// footage-download pipeline behaves identically (no renderer CSP / Accept-Encoding /
// AbortSignal mismatches). Streams progress to the renderer via 'scene-action-progress'.
function _resolveSceneMediaPathMain(scene) {
    const candidates = [];
    if (scene && scene.mediaFile) {
        if (path.isAbsolute(scene.mediaFile)) candidates.push(scene.mediaFile);
        candidates.push(path.join(PUBLIC_PATH, scene.mediaFile), path.join(TEMP_PATH, scene.mediaFile));
    }
    const exts = ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
    const idx = scene?.index;
    for (const ext of exts) {
        candidates.push(path.join(PUBLIC_PATH, `scene-${idx}-asset${ext}`));
        candidates.push(path.join(PUBLIC_PATH, `scene-${idx}${ext}`));
        candidates.push(path.join(TEMP_PATH, `scene-${idx}${ext}`));
    }
    for (const p of candidates) { try { if (p && fs.existsSync(p)) return p; } catch (_) {} }
    return null;
}

ipcMain.handle('scene-action', async (event, payload = {}) => {
    const { kind, sceneIndices = [], action = '', instruction = '' } = payload;
    const send = (sceneIndex, message) => { try { event.sender.send('scene-action-progress', { sceneIndex, message }); } catch (_) {} };
    const result = { success: false, ok: 0, fail: 0, scenes: [], errors: [] };
    let visionBox = null;
    let weStarted = false;
    // Retry vision routing (RETRY_VISION): 'auto' (default) = use the GPU box ONLY if it's
    // already running, else Bedrock — NEVER boots the box for a retry. 'box' = always wake
    // the box. 'bedrock' = always Bedrock. The box is otherwise for the real build only.
    const retryVisionMode = String(process.env.RETRY_VISION || 'auto').toLowerCase();
    const _savedVisionEnv = {};
    const _restoreVisionEnv = () => {
        for (const k of Object.keys(_savedVisionEnv)) {
            if (_savedVisionEnv[k] === undefined) delete process.env[k];
            else process.env[k] = _savedVisionEnv[k];
        }
    };
    try {
        const sceneActions = require('./src/agents/scene-actions');
        visionBox = null;
        try { visionBox = require('./src/vision/vision-box'); } catch (_) {}

        const planPath = [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].find(p => fs.existsSync(p));
        if (!planPath) return { success: false, error: 'no video-plan.json found' };
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        const scenes = plan.scenes || [];
        const scriptContext = plan.scriptContext || {};

        // Retry vision routing — see retryVisionMode above. Decide whether to use the box
        // (only if already running, unless forced) or route to Bedrock. Never boots the box
        // in 'auto' mode.
        weStarted = false;
        let useBoxForRetry = false;
        if (kind === 'retry') {
            if (retryVisionMode === 'box' && visionBox?.isConfigured?.()) {
                send(-1, 'Vision box: starting (RETRY_VISION=box)…');
                const r = await visionBox.ensureReady({ onProgress: (m) => send(-1, `Vision box: ${m}`) });
                if (r.ok) { useBoxForRetry = true; weStarted = !r.alreadyReady; }
                else send(-1, `Vision box not ready (${r.reason}) — using Bedrock`);
            } else if (retryVisionMode !== 'bedrock' && visionBox?.isVisionReady) {
                // 'auto': use the box ONLY if it's already up (free + fast). Never boot it.
                const ready = await visionBox.isVisionReady().catch(() => false);
                if (ready) { useBoxForRetry = true; send(-1, 'Vision: box already running — using it for retry'); }
            }
        }
        if (kind === 'retry' && !useBoxForRetry) {
            // Route the vision chain straight to Bedrock (skip the box) for this retry only.
            for (const k of ['VISION_PROVIDER', 'VISION_FALLBACK_ORDER', 'VISION_EXCLUDE_QWEN']) _savedVisionEnv[k] = process.env[k];
            process.env.VISION_PROVIDER = process.env.RETRY_VISION_PROVIDER || 'bedrock-claude';
            process.env.VISION_FALLBACK_ORDER = 'bedrock-nova,bedrock-qwen-vl';
            process.env.VISION_EXCLUDE_QWEN = '1';
            send(-1, `Vision: using Bedrock (${process.env.VISION_PROVIDER}) for retry — no GPU-box boot needed`);
        }

        for (const si of sceneIndices) {
            const scene = scenes.find((s) => Number(s.index) === Number(si)) || scenes[si];
            if (!scene) { result.fail++; result.errors.push({ si, error: 'scene not found' }); continue; }
            const onProgress = (m) => send(si, m);
            try {
                if (kind === 'retry') {
                    const mediaFilePath = _resolveSceneMediaPathMain(scene);
                    const r = await sceneActions.retrySceneMedia(scene, scriptContext, { mediaFilePath, onProgress });
                    if (r.success) { result.ok++; result.scenes.push({ si, reload: true, keyword: r.keyword, sourceHint: r.sourceHint }); }
                    else { result.fail++; result.errors.push({ si, error: r.error }); send(si, `❌ ${r.error}`); }
                } else if (kind === 'ceo') {
                    const arrIdx = scenes.indexOf(scene);
                    const r = await sceneActions.ceoEditScene(action, scene, scriptContext, arrIdx, scenes, { instruction, onProgress });
                    if (r.success) { result.ok++; result.scenes.push({ si, scene: r.scene, change: r.change }); }
                    else { result.fail++; result.errors.push({ si, error: r.error }); send(si, `❌ ${r.error}`); }
                }
            } catch (e) { result.fail++; result.errors.push({ si, error: e.message }); send(si, `❌ ${e.message}`); }
        }

        // Persist scene changes (framing etc.) back to the plan.
        plan.scenes = scenes;
        [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].forEach((p) => {
            try { if (fs.existsSync(path.dirname(p))) fs.writeFileSync(p, JSON.stringify(plan, null, 2)); } catch (_) {}
        });

        if (kind === 'retry' && weStarted && visionBox?.stop) {
            send(-1, 'Vision box: stopping (mission done)…');
            await visionBox.stop({ onProgress: (m) => send(-1, `Vision box: ${m}`) }).catch(() => {});
        }
        _restoreVisionEnv();

        result.success = result.ok > 0 || result.fail === 0;
        return result;
    } catch (err) {
        if (kind === 'retry' && weStarted && visionBox?.stop) {
            send(-1, 'Vision box: stopping after error…');
            await visionBox.stop({ onProgress: (m) => send(-1, `Vision box: ${m}`) }).catch(() => {});
            weStarted = false;
        }
        _restoreVisionEnv();
        return { success: false, error: err.message, ...result };
    }
});

// ── Agentic ACTING agent: apply a free-text ORDER to the already-built plan ──
// Compiles the order (directive-compiler) → applies per-scene writes + the
// compliance fixers to the loaded plan (directive-actuator, the same enforcement
// path the build uses) → routes footage changes through the REAL media system →
// persists to both plan copies → refreshes the preview via 'qa-plan-updated'.
ipcMain.handle('qa-preview-order', async (event, payload = {}) => {
    try {
        const { previewOrder } = require('./src/directives/directive-actuator');
        const planPath = [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].find(p => fs.existsSync(p));
        const sc = planPath ? (JSON.parse(fs.readFileSync(planPath, 'utf8')).scriptContext || {}) : {};
        const prev = await previewOrder(payload.text || '', { themeId: sc.themeId, nicheId: sc.nicheId, productionMode: sc.productionMode });
        return { ok: true, summary: prev.summary, hasActions: prev.hasActions };
    } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('qa-apply-order', async (event, payload = {}) => {
    const send = (message) => { try { event.sender.send('scene-action-progress', { sceneIndex: -1, message }); } catch (_) {} };
    try {
        const { previewOrder, applyOrderToPlan } = require('./src/directives/directive-actuator');
        const sceneActions = require('./src/agents/scene-actions');
        const planPath = [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].find(p => fs.existsSync(p));
        if (!planPath) return { success: false, error: 'no video-plan.json found' };
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

        // Undo snapshot before any mutation.
        try { fs.writeFileSync(path.join(PUBLIC_PATH, '.qa-undo.json'), JSON.stringify(plan)); } catch (_) {}

        send('Interpreting your order…');
        const sc = plan.scriptContext || {};
        const prev = await previewOrder(payload.text || '', { themeId: sc.themeId, nicheId: sc.nicheId, productionMode: sc.productionMode }, { log: send });
        if (!prev.directives || !prev.hasActions) {
            return { success: false, error: 'no actionable order detected', summary: prev.summary };
        }
        send(`Applying: ${prev.summary}`);
        const res = await applyOrderToPlan(plan, prev.directives, { log: send });

        // Route footage changes through the REAL media system (re-download in place).
        let footageRedownloaded = 0;
        for (const nf of (res.needsFootage || [])) {
            const scene = (plan.scenes || []).find(s => Number(s.index) === Number(nf.index));
            if (!scene) continue;
            const mediaFilePath = _resolveSceneMediaPathMain(scene);
            if (nf.keyword) { scene.keyword = nf.keyword; scene.searchKeyword = nf.keyword; }
            if (nf.sourceHint) scene.sourceHint = nf.sourceHint;
            if (nf.mediaType) scene.mediaType = nf.mediaType;
            send(`Re-downloading footage for scene ${nf.index}…`);
            try {
                const r = await sceneActions.retrySceneMedia(scene, sc, { mediaFilePath, onProgress: send });
                if (r && r.success) footageRedownloaded++;
            } catch (e) { send(`Scene ${nf.index} footage retry failed: ${e.message}`); }
        }

        // Persist to both plan copies + refresh preview.
        [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].forEach((p) => {
            try { if (fs.existsSync(path.dirname(p))) fs.writeFileSync(p, JSON.stringify(plan, null, 2)); } catch (_) {}
        });
        try { if (mainWindow) mainWindow.webContents.send('qa-plan-updated', plan); } catch (_) {}

        const rep = res.report || {};
        return {
            success: true,
            summary: prev.summary,
            perSceneChanged: res.changed,
            fixed: (rep.fixed || []).length,
            flagged: (rep.unfixable || []).length,
            footageRedownloaded,
            report: rep,
        };
    } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('qa-undo', async () => {
    try {
        const snap = path.join(PUBLIC_PATH, '.qa-undo.json');
        if (!fs.existsSync(snap)) return { success: false, error: 'nothing to undo' };
        const plan = JSON.parse(fs.readFileSync(snap, 'utf8'));
        [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].forEach((p) => {
            try { if (fs.existsSync(path.dirname(p))) fs.writeFileSync(p, JSON.stringify(plan, null, 2)); } catch (_) {}
        });
        try { if (mainWindow) mainWindow.webContents.send('qa-plan-updated', plan); } catch (_) {}
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('vision-box-status', async () => {
    try { return await require('./src/vision/vision-box').status(); }
    catch (e) { return { configured: false, ready: false, reason: e.message }; }
});

// Vision backend selector (dropdown): which backend scores B-roll images.
//   aws — self-hosted GPU box (auto-starts during a build)
//   lightning — Lightning.ai vLLM (you start the Studio + tunnel manually)
//   bedrock — AWS Bedrock vision (always on, no box)
ipcMain.handle('get-vision-backend', async () => {
    return String(process.env.VISION_BACKEND || 'aws').toLowerCase();
});
ipcMain.handle('set-vision-backend', async (event, backend) => {
    const b = String(backend || 'aws').toLowerCase();
    const allowed = ['aws', 'lightning', 'bedrock', 'dashscope'];
    if (!allowed.includes(b)) return { ok: false, error: `unknown vision backend: ${b}` };
    try {
        updateEnvFile('VISION_BACKEND', b);          // persist so it survives restart
        process.env.VISION_BACKEND = b;
        // Re-resolve QWEN_* live so the main process (retries) uses the new backend now.
        try { require('./src/settings/config').resolveVisionBackend(); } catch (_) {}
        let note = '';
        if (b === 'aws') note = '🟦 AWS GPU box — it will auto-start when a build needs vision.';
        else if (b === 'lightning') note = process.env.LIGHTNING_API_KEY
            ? '🟨 Lightning — auto-starts the Studio when a build needs vision.'
            : '🟨 Lightning — manual: start the Studio + tunnel, paste the URL into .env (add LIGHTNING_API_KEY to auto-start).';
        else if (b === 'bedrock') note = '☁️ Bedrock — always on, no box to manage.';
        console.log(`👁️  Vision backend switched to: ${b}`);
        return { ok: true, backend: b, note };
    } catch (e) {
        return { ok: false, error: e.message };
    }
});

// ── Lightning account pool (multi-account rotation) — no-code management ──
ipcMain.handle('lightning-pool-list', async () => {
    try { return { ok: true, accounts: require('./src/vision/lightning-rotation').poolDetails() }; }
    catch (e) { return { ok: false, error: e.message, accounts: [] }; }
});
ipcMain.handle('lightning-pool-add', async (event, account) => {
    try { return require('./src/vision/lightning-rotation').addAccount(account || {}); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-remove', async (event, id) => {
    try { return require('./src/vision/lightning-rotation').removeAccount(String(id || '')); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-reset', async (event, id) => {
    try { return require('./src/vision/lightning-rotation').resetCycle(String(id || '')); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-update', async (event, payload) => {
    try { return require('./src/vision/lightning-rotation').updateAccount(String(payload?.id || ''), payload?.patch || {}); }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-get-active', async () => {
    try { return { ok: true, id: require('./src/vision/lightning-rotation').getForcedAccount() }; }
    catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('lightning-pool-set-active', async (event, id) => {
    try {
        const v = (!id || id === 'auto') ? null : String(id);
        return require('./src/vision/lightning-rotation').setForcedAccount(v);
    } catch (e) { return { ok: false, error: e.message }; }
});
// Provision a Studio from the UI (install vLLM+ninja+serve script + warm model) by running
// tools/provision-lightning-studio.py in the MAIN process and streaming its output to the UI.
ipcMain.handle('lightning-provision', async (event, id) => {
    return new Promise((resolve) => {
        const acctId = String(id || '');
        if (!acctId) return resolve({ ok: false, error: 'no account id' });
        const send = (line) => { try { event.sender.send('lightning-provision-progress', { id: acctId, line }); } catch (_) {} };
        let proc;
        try {
            proc = spawn(process.env.LIGHTNING_PYTHON || 'python', ['tools/provision-lightning-studio.py', acctId], { cwd: APP_ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }
        const emit = (buf) => buf.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) send(l.trim()); });
        proc.stdout.on('data', emit);
        proc.stderr.on('data', emit);
        proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        proc.on('close', (code) => { send(code === 0 ? '✅ Provisioning finished.' : `⚠️ Exited with code ${code}.`); resolve({ ok: code === 0, code }); });
    });
});
// Health-check a Studio: boot on L4 → vision test → stop → report. Streams progress on the
// same channel as provisioning; returns the parsed JSON verdict.
ipcMain.handle('lightning-check', async (event, id) => {
    return new Promise((resolve) => {
        const acctId = String(id || '');
        if (!acctId) return resolve({ ok: false, error: 'no account id' });
        const send = (line) => { try { event.sender.send('lightning-provision-progress', { id: acctId, line }); } catch (_) {} };
        let proc, stdout = '';
        try {
            proc = spawn(process.env.LIGHTNING_PYTHON || 'python', ['tools/check-lightning-studio.py', acctId], { cwd: APP_ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => d.toString().split(/\r?\n/).forEach((l) => { if (l.trim()) send(l.trim()); }));
        proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        proc.on('close', () => {
            const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            let res;
            try { res = JSON.parse(last); } catch (_) { res = { ok: false, error: 'bad output: ' + last.slice(0, 200) }; }
            send(res.ok ? '✅ Check PASSED — vision works' : `⚠️ Check failed: ${res.error || (res.steps && res.steps.visionReply) || 'unknown'}`);
            resolve(res);
        });
    });
});
// Validate candidate account creds BEFORE adding (catches teamspace/username/key typos): runs
// lightning-control.py `status`, which resolves the Studio via the SDK without booting anything.
ipcMain.handle('lightning-validate', async (event, account) => {
    return new Promise((resolve) => {
        const a = account || {};
        if (!a.userId || !a.apiKey || !a.studioName) return resolve({ ok: false, error: 'User ID, API Key and Studio name are required' });
        const env = {
            ...process.env, PYTHONIOENCODING: 'utf-8',
            LIGHTNING_USER_ID: String(a.userId), LIGHTNING_API_KEY: String(a.apiKey),
            LIGHTNING_STUDIO_NAME: String(a.studioName), LIGHTNING_TEAMSPACE: String(a.teamspace || ''),
            LIGHTNING_USER: String(a.user || ''), LIGHTNING_ORG: String(a.org || ''),
        };
        let proc, stdout = '';
        try {
            proc = spawn(process.env.LIGHTNING_PYTHON || 'python', ['src/lightning-control.py', 'status'], { cwd: APP_ROOT, env });
        } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message }); }
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('error', (e) => resolve({ ok: false, error: e.message }));
        proc.on('close', () => {
            const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            try {
                const r = JSON.parse(last);
                resolve(r.ok ? { ok: true, state: r.state } : { ok: false, error: r.error || 'Studio not found' });
            } catch (_) { resolve({ ok: false, error: 'No response from Lightning — check your User ID / API Key. ' + last.slice(0, 120) }); }
        });
    });
});

// Open a web URL in the user's default browser (Media Log panel link clicks).
ipcMain.handle('open-external', async (event, url) => {
    try {
        if (/^https?:\/\//i.test(String(url || ''))) { await shell.openExternal(url); return { ok: true }; }
        return { ok: false, error: 'not an http(s) url' };
    } catch (e) { return { ok: false, error: e.message }; }
});

// ── QA Results persistence ──────────────────────────────────────────────────
// Saves analysis results so closing QA Studio doesn't lose work
ipcMain.handle('save-qa-results', async (event, data) => {
    try {
        const filePath = path.join(TEMP_PATH, 'qa-results.json');
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return { success: true };
    } catch (error) {
        console.error('❌ Failed to save QA results:', error.message);
        return { success: false, error: error.message };
    }
});

ipcMain.handle('load-qa-results', async () => {
    try {
        const filePath = path.join(TEMP_PATH, 'qa-results.json');
        if (!fs.existsSync(filePath)) return { success: true, data: null };
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { success: true, data: JSON.parse(raw) };
    } catch (error) {
        console.error('❌ Failed to load QA results:', error.message);
        return { success: true, data: null };
    }
});

// Push QA-fixed plan into the main window's memory so auto-save picks it up
ipcMain.handle('push-plan-to-main', async (event, plan) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('qa-plan-updated', plan);
    }
    return { success: true };
});

// ========================================
// Project File (.fvp) Save/Load
// ========================================

// Project file path computed dynamically (PROJECT_DIR may change on lock conflict redirect)
// Named after the project folder (e.g., "My Video Project.fvp")
function getProjectFilePath() {
    const name = path.basename(PROJECT_DIR) || 'project';
    return path.join(PROJECT_DIR, name + '.fvp');
}
const RECENT_PROJECTS_FILE = path.join(APP_ROOT, 'recent-projects.json');

// Save .fvp project file (video plan + editor settings unified)
ipcMain.handle('save-project-file', async (event, data) => {
    try {
        const fvpData = {
            version: 1,
            savedAt: new Date().toISOString(),
            settings: data.settings || {},
            videoPlan: data.videoPlan || {}
        };

        // Write .fvp file to project root
        fs.writeFileSync(getProjectFilePath(), JSON.stringify(fvpData, null, 2));

        // Also write video-plan.json to public/ and temp/ (renderer needs it)
        if (data.videoPlan) {
            const planData = JSON.stringify(data.videoPlan, null, 2);
            [path.join(PUBLIC_PATH, 'video-plan.json'), path.join(TEMP_PATH, 'video-plan.json')].forEach(p => {
                const dir = path.dirname(p);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(p, planData);
            });
        }

        // Add to recent projects list
        _addRecentProject(PROJECT_DIR);

        console.log('✅ Project file saved:', getProjectFilePath());
        return { success: true, path: getProjectFilePath() };
    } catch (error) {
        console.error('❌ Failed to save project file:', error);
        return { success: false, error: error.message };
    }
});

// Load .fvp project file
ipcMain.handle('load-project-file', async () => {
    console.log('[IPC] load-project-file called, PROJECT_DIR:', PROJECT_DIR);
    try {
        // Try expected .fvp name first, then scan for any .fvp in project dir
        let fvpPath = getProjectFilePath();
        console.log('[IPC] Expected .fvp path:', fvpPath, 'exists:', fs.existsSync(fvpPath));
        if (!fs.existsSync(fvpPath)) {
            // Scan for any .fvp file (handles renamed projects or legacy "project.fvp")
            const files = fs.readdirSync(PROJECT_DIR).filter(f => f.endsWith('.fvp'));
            if (files.length > 0) fvpPath = path.join(PROJECT_DIR, files[0]);
            else fvpPath = null;
            console.log('[IPC] Scanned .fvp files:', files, 'resolved:', fvpPath);
        }
        if (fvpPath) {
            const data = JSON.parse(fs.readFileSync(fvpPath, 'utf8'));
            console.log('✅ Loaded project from .fvp file:', fvpPath, '| scenes:', data?.videoPlan?.scenes?.length || 0);
            return data;
        }

        // Fallback: migrate from video-plan.json (old format, no settings)
        const publicPlan = path.join(PUBLIC_PATH, 'video-plan.json');
        const tempPlan = path.join(TEMP_PATH, 'video-plan.json');
        const planPath = fs.existsSync(publicPlan) ? publicPlan : (fs.existsSync(tempPlan) ? tempPlan : null);

        if (planPath) {
            const videoPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
            console.log('✅ Loaded video plan from legacy JSON (no .fvp found, will migrate on save)');
            return { version: 1, savedAt: null, settings: null, videoPlan };
        }

        console.log('⚠️ No .fvp or video-plan.json found in:', PROJECT_DIR);
        return null;
    } catch (error) {
        console.error('❌ Failed to load project file:', error);
        return null;
    }
});

// Get recent projects list
ipcMain.handle('get-recent-projects', async () => {
    try {
        if (fs.existsSync(RECENT_PROJECTS_FILE)) {
            return JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, 'utf8'));
        }
        return [];
    } catch (e) {
        return [];
    }
});

// Add to recent projects list
ipcMain.handle('add-recent-project', async () => {
    _addRecentProject(PROJECT_DIR);
    return { success: true };
});

function _addRecentProject(projectDir) {
    try {
        let recent = [];
        if (fs.existsSync(RECENT_PROJECTS_FILE)) {
            recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_FILE, 'utf8'));
        }
        // Remove duplicate, add to front, keep max 20
        recent = recent.filter(r => r.path !== projectDir);
        const projectName = path.basename(projectDir) || projectDir;
        recent.unshift({ path: projectDir, name: projectName, lastOpened: new Date().toISOString() });
        if (recent.length > 20) recent = recent.slice(0, 20);
        fs.writeFileSync(RECENT_PROJECTS_FILE, JSON.stringify(recent, null, 2));
    } catch (e) {
        console.warn('Could not update recent projects:', e.message);
    }
}

// Get scene media path (video or image) for preview
ipcMain.handle('get-scene-media-path', async (event, sceneIndex, extension, prefix) => {
    try {
        const filePrefix = prefix || 'scene';
        // Try with provided extension first, then try common extensions
        const extensions = extension ? [extension] : ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        for (const ext of extensions) {
            // Try both naming conventions: scene-{i}-asset{ext} (new) and scene-{i}{ext} (legacy)
            const publicAssetPath = path.join(PUBLIC_PATH, `${filePrefix}-${sceneIndex}-asset${ext}`);
            if (fs.existsSync(publicAssetPath)) return publicAssetPath;
            const publicPath = path.join(PUBLIC_PATH, `${filePrefix}-${sceneIndex}${ext}`);
            if (fs.existsSync(publicPath)) return publicPath;
            const tempPath = path.join(TEMP_PATH, `${filePrefix}-${sceneIndex}${ext}`);
            if (fs.existsSync(tempPath)) return tempPath;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get scene media path:', error);
        return null;
    }
});

// Backward compatibility: get scene video path
ipcMain.handle('get-scene-video-path', async (event, sceneIndex) => {
    try {
        const extensions = ['.mp4', '.jpg', '.jpeg', '.png', '.webp'];
        for (const ext of extensions) {
            const publicAssetPath = path.join(PUBLIC_PATH, `scene-${sceneIndex}-asset${ext}`);
            if (fs.existsSync(publicAssetPath)) return publicAssetPath;
            const publicPath = path.join(PUBLIC_PATH, `scene-${sceneIndex}${ext}`);
            if (fs.existsSync(publicPath)) return publicPath;
            const tempPath = path.join(TEMP_PATH, `scene-${sceneIndex}${ext}`);
            if (fs.existsSync(tempPath)) return tempPath;
        }
        return null;
    } catch (error) {
        console.error('❌ Failed to get scene video path:', error);
        return null;
    }
});

// Get audio path for preview
ipcMain.handle('get-audio-path', async (event, filename) => {
    try {
        if (!filename) return null;

        // Prefer input/ — it is the STABLE source copy of the audio (written once per
        // build and never cleaned). public/ and temp/ are build outputs that Step 0 wipes,
        // so resolving the canonical audio path to them leaves a dangling reference that
        // breaks the next "Copy audio" on Generate/Repeat (ENOENT). Order: input → public → temp.
        const inputPath = path.join(INPUT_PATH, filename);
        if (fs.existsSync(inputPath)) {
            return inputPath;
        }

        // Check public folder (serving copy)
        const publicPath = path.join(PUBLIC_PATH, filename);
        if (fs.existsSync(publicPath)) {
            return publicPath;
        }

        // Check temp folder
        const tempPath = path.join(TEMP_PATH, filename);
        if (fs.existsSync(tempPath)) {
            return tempPath;
        }

        return null;
    } catch (error) {
        console.error('❌ Failed to get audio path:', error);
        return null;
    }
});



// ========================================
// WebGL2 Compositor Engine - Export IPC
// ========================================

const WEBGL_FFMPEG_PATH = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');

// NVENC availability cache (shared with ffmpeg-renderer if loaded)
let _webglNvencAvailable = null;

async function probeNvencForWebGL() {
    if (_webglNvencAvailable !== null) return _webglNvencAvailable;
    try {
        await new Promise((resolve, reject) => {
            const { execFile } = require('child_process');
            execFile(WEBGL_FFMPEG_PATH, [
                '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
                '-c:v', 'h264_nvenc', '-preset', 'p4',
                '-f', 'null', '-'
            ], { timeout: 10000 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        _webglNvencAvailable = true;
        console.log('[WebGL Export] NVENC GPU encoder available');
    } catch {
        _webglNvencAvailable = false;
        console.log('[WebGL Export] NVENC not available, will use CPU (libx264)');
    }
    return _webglNvencAvailable;
}

// State for the active WebGL export
let _webglExport = null;

ipcMain.handle('start-webgl-export', async (event, options) => {
    try {
        const { width, height, fps, totalFrames } = options;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const videoFile = path.join(TEMP_PATH, `webgl-video-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        // Ensure output dirs exist
        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        // Probe NVENC
        const useGpu = await probeNvencForWebGL();
        const encArgs = useGpu
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M', '-maxrate:v', '24M', '-bufsize:v', '48M']
            : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22'];

        console.log(`[WebGL Export] Starting: ${width}x${height} @ ${fps}fps, ${totalFrames} frames, encoder: ${useGpu ? 'NVENC' : 'libx264'}`);

        const ffmpegProc = spawn(WEBGL_FFMPEG_PATH, [
            '-y',
            '-f', 'rawvideo',
            '-pixel_format', 'rgba',
            '-video_size', `${width}x${height}`,
            '-framerate', String(fps),
            '-i', 'pipe:0',
            ...encArgs,
            '-pix_fmt', 'yuv420p',
            '-an',  // No audio (muxed later)
            videoFile
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        let ffmpegStderr = '';
        ffmpegProc.stderr.on('data', (data) => {
            ffmpegStderr += data.toString();
        });

        _webglExport = {
            proc: ffmpegProc,
            videoFile,
            outputFile,
            totalFrames,
            width, height, fps,
            stderr: ffmpegStderr,
            framesWritten: 0,
            bytesWritten: 0,
            lastLogTime: Date.now(),
            lastLogFrames: 0,
            expectedFrameSize: width * height * 4,
        };

        return { success: true, videoFile, outputFile };
    } catch (err) {
        console.error('[WebGL Export] start error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('export-frame', async (event, frameBuffer) => {
    const exp = _webglExport;
    if (!exp || !exp.proc || exp.proc.killed) {
        return { success: false, error: 'No active export process' };
    }

    try {
        const buf = Buffer.from(frameBuffer);
        const canWrite = exp.proc.stdin.write(buf);
        exp.framesWritten++;
        if (!canWrite) {
            // Wait for drain before accepting more frames (backpressure)
            await new Promise(resolve => exp.proc.stdin.once('drain', resolve));
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('export-frames-batch', async (event, batchPayload) => {
    const exp = _webglExport;
    if (!exp || !exp.proc || exp.proc.killed) {
        return { success: false, error: 'No active export process' };
    }

    try {
        const { frames } = batchPayload; // Array of { frameIndex, buffer }
        if (!frames || !frames.length) {
            return { success: true, written: 0 };
        }

        // Detect out-of-order (renderer guarantees order, but log if violated)
        for (let i = 1; i < frames.length; i++) {
            if (frames[i].frameIndex <= frames[i - 1].frameIndex) {
                console.warn(`[WebGL Export] Out-of-order batch: frame ${frames[i].frameIndex} after ${frames[i - 1].frameIndex}`);
            }
        }

        // Concatenate all frame buffers into a single Buffer for one stdin.write()
        const totalSize = frames.length * exp.expectedFrameSize;
        const combined = Buffer.allocUnsafe(totalSize);
        let offset = 0;
        for (const entry of frames) {
            const src = Buffer.from(entry.buffer);
            if (src.length !== exp.expectedFrameSize) {
                console.warn(`[WebGL Export] Frame ${entry.frameIndex} size mismatch: ${src.length} vs expected ${exp.expectedFrameSize}`);
            }
            src.copy(combined, offset);
            offset += src.length;
        }

        // Single write for the whole batch
        const canWrite = exp.proc.stdin.write(combined);
        exp.framesWritten += frames.length;
        exp.bytesWritten += offset;

        // Backpressure: wait for FFmpeg to drain before returning
        if (!canWrite) {
            await new Promise(resolve => exp.proc.stdin.once('drain', resolve));
        }

        // Periodic logging (~every second)
        const now = Date.now();
        if (now - exp.lastLogTime >= 1000) {
            const elapsed = (now - exp.lastLogTime) / 1000;
            const recentFrames = exp.framesWritten - exp.lastLogFrames;
            const fps = (recentFrames / elapsed).toFixed(1);
            const totalMB = (exp.bytesWritten / (1024 * 1024)).toFixed(0);
            console.log(`[WebGL Export] ${exp.framesWritten}/${exp.totalFrames} frames | ${fps} fps recent | ${totalMB} MB written`);
            exp.lastLogTime = now;
            exp.lastLogFrames = exp.framesWritten;
        }

        return { success: true, written: frames.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('finish-webgl-export', async () => {
    const exp = _webglExport;
    if (!exp || !exp.proc) {
        return { success: false, error: 'No active export process' };
    }

    try {
        // Close FFmpeg stdin to signal end of input
        exp.proc.stdin.end();

        // Wait for FFmpeg to finish encoding
        const exitCode = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                try { exp.proc.kill('SIGTERM'); } catch (_) { }
                reject(new Error('FFmpeg timeout'));
            }, 120000); // 2 minute timeout

            exp.proc.on('close', (code) => {
                clearTimeout(timeout);
                resolve(code);
            });
            exp.proc.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        if (exitCode !== 0) {
            throw new Error(`FFmpeg exited with code ${exitCode}`);
        }

        console.log(`[WebGL Export] Video encoded: ${exp.videoFile} (${exp.framesWritten} frames)`);

        // Mux audio if available
        const finalOutput = await _webglMuxAudio(exp);

        _webglExport = null;
        return { success: true, outputPath: finalOutput };

    } catch (err) {
        console.error('[WebGL Export] finish error:', err.message);
        _webglExport = null;
        return { success: false, error: err.message };
    }
});

ipcMain.handle('cancel-webgl-export', async () => {
    if (_webglExport && _webglExport.proc) {
        try {
            if (process.platform === 'win32' && _webglExport.proc.pid) {
                exec(`taskkill /pid ${_webglExport.proc.pid} /f /t`, () => { });
            } else {
                _webglExport.proc.kill('SIGTERM');
            }
        } catch (_) { }
        _webglExport = null;
    }
    return { success: true };
});

// ========================================
// Direct-spawn export support (renderer-side FFmpeg)
// ========================================

ipcMain.handle('get-export-config', async (event, options) => {
    try {
        const { width, height, fps, totalFrames } = options;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const videoFile = path.join(TEMP_PATH, `webgl-video-${timestamp}.mp4`);
        const outputFile = path.join(OUTPUT_PATH, `video-${timestamp}.mp4`);

        // Ensure output dirs exist
        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        if (!fs.existsSync(TEMP_PATH)) fs.mkdirSync(TEMP_PATH, { recursive: true });

        // Probe NVENC
        const useGpu = await probeNvencForWebGL();
        const encArgs = useGpu
            ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '18M', '-maxrate:v', '24M', '-bufsize:v', '48M']
            : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22'];

        console.log(`[WebGL Export] Config: ${width}x${height} @ ${fps}fps, ${totalFrames} frames, encoder: ${useGpu ? 'NVENC' : 'libx264'}, direct-spawn mode`);

        return {
            success: true,
            ffmpegPath: WEBGL_FFMPEG_PATH,
            encArgs,
            videoFile,
            outputFile,
            useGpu,
        };
    } catch (err) {
        console.error('[WebGL Export] get-export-config error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mux-audio', async (event, videoFile, outputFile, audioTrimStartSec, audioTrimEndSec) => {
    try {
        const exp = { videoFile, outputFile, audioTrimStartSec, audioTrimEndSec };
        const finalOutput = await _webglMuxAudio(exp);
        return { success: true, outputPath: finalOutput };
    } catch (err) {
        console.error('[WebGL Export] mux-audio error:', err.message);
        return { success: false, error: err.message };
    }
});

function sendRenderProgress(percent, message) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('render-progress', { percent, message });
    }
}

function checkHyperframesNodeRuntime() {
    try {
        const version = execSync('node -v', {
            cwd: PROJECT_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const major = parseInt(version.replace(/^v/, '').split('.')[0], 10);
        return {
            ok: Number.isFinite(major) && major >= 22,
            version,
            major,
        };
    } catch (err) {
        return {
            ok: false,
            version: 'not found',
            error: err.message,
        };
    }
}

// HyperFrames' optimized render/capture path REQUIRES Google's chrome-headless-shell.
// A full chrome.exe / brave.exe makes the streaming capture hang on the (15 min)
// protocol timeout instead of rendering. So always prefer the headless-shell that
// HyperFrames downloads into its own browser cache (~/.cache/hyperframes/chrome).
function findHyperframesHeadlessShell() {
    let homeDir = '';
    try { homeDir = require('os').homedir(); } catch (_) { homeDir = process.env.USERPROFILE || ''; }
    if (!homeDir) return null;
    const base = path.join(homeDir, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell');
    try {
        if (!fs.existsSync(base)) return null;
        // Version-agnostic: pick whatever win64-<version> build is present.
        for (const entry of fs.readdirSync(base)) {
            for (const sub of ['chrome-headless-shell-win64', 'chrome-headless-shell-linux64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-mac-arm64']) {
                const exe = path.join(base, entry, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
                if (fs.existsSync(exe)) return exe;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

// An interrupted browser download leaves the headless-shell folder present but
// WITHOUT the executable. That makes HyperFrames fail ("Browser was not found at
// executablePath") AND blocks @puppeteer/browsers from re-downloading ("folder
// exists but executable is missing"). Purge confirmed-broken partials so the next
// render can cleanly re-fetch. Only runs when NO valid install exists.
function purgePartialHyperframesBrowser() {
    let homeDir = '';
    try { homeDir = require('os').homedir(); } catch (_) { homeDir = process.env.USERPROFILE || ''; }
    if (!homeDir) return;
    const base = path.join(homeDir, '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell');
    try {
        if (!fs.existsSync(base)) return;
        if (findHyperframesHeadlessShell()) return; // a valid install exists — leave it alone
        for (const entry of fs.readdirSync(base)) {
            const full = path.join(base, entry);
            try {
                fs.rmSync(full, { recursive: true, force: true });
                console.warn(`[HyperFrames] Removed partial/corrupt browser cache: ${full}`);
            } catch (_) { /* ignore */ }
        }
    } catch (_) { /* ignore */ }
}

function findHyperframesBrowserPath() {
    // Prefer the proper headless-shell; a full system browser is only a last resort.
    const headlessShell = findHyperframesHeadlessShell();
    if (headlessShell) return headlessShell;
    const programFiles = process.env.PROGRAMFILES || process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || process.env.LocalAppData;
    const candidates = [
        process.env.HYPERFRAMES_BROWSER_PATH,
        process.env.PRODUCER_HEADLESS_SHELL_PATH,
        process.env.CHROME_PATH,
        path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localAppData ? path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
        path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        localAppData ? path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') : null,
        path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean);

    return candidates.find((candidate) => {
        try {
            return fs.existsSync(candidate);
        } catch (_) {
            return false;
        }
    }) || null;
}

// Pre-render lint gate (OPENMONTAGE-BORROW-PLAN #12). Runs the hyperframes CLI's
// own `lint` validator on the generated project and logs findings BEFORE the
// expensive render. Advisory only — never blocks the render. HF_PRERENDER_LINT=0
// disables. Returns a summary object (or null when skipped/unavailable).
function runHyperframesLint(projectDir) {
    if (/^(0|false|off|no)$/i.test(String(process.env.HF_PRERENDER_LINT || '').trim())) return null;
    const { spawnSync } = require('child_process');
    const localCliJs = path.join(PROJECT_ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');
    if (!fs.existsSync(localCliJs)) return null;
    let r;
    try {
        r = spawnSync('node', [localCliJs, 'lint', projectDir, '--json'], {
            cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
            env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: true,
        });
    } catch (e) { console.warn(`[HF-Lint] skipped (${e.message})`); return null; }
    let data = null;
    try { data = JSON.parse(String(r.stdout || '').trim()); } catch (_) { /* non-JSON */ }
    if (!data || !Array.isArray(data.findings)) { return null; }
    const errs = Number(data.errorCount || 0);
    const warns = Number(data.warningCount || 0);
    if (errs === 0 && warns === 0) {
        console.log('[HF-Lint] ✅ composition clean (0 errors, 0 warnings)');
        return { ok: true, errorCount: 0, warningCount: 0 };
    }
    console.warn(`[HF-Lint] ${errs} error(s), ${warns} warning(s) in the generated composition:`);
    for (const f of data.findings.filter((x) => x.severity === 'error' || x.severity === 'warning').slice(0, 20)) {
        console.warn(`[HF-Lint]   ${f.severity === 'error' ? '❌' : '⚠️'} ${f.code}: ${f.message}${f.elementId ? ` (#${f.elementId})` : ''}`);
    }
    return { ok: data.ok !== false, errorCount: errs, warningCount: warns, findings: data.findings };
}

function runHyperframesCli(projectDir, outputFile, options = {}) {
    return new Promise((resolve) => {
        const localCliJs = path.join(PROJECT_ROOT, 'node_modules', 'hyperframes', 'dist', 'cli.js');
        const hasLocalCli = fs.existsSync(localCliJs);
        const cliCmd = hasLocalCli ? 'node' : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
        const workerCountRaw = Number(options.workers);
        const workerCount = Number.isFinite(workerCountRaw) && workerCountRaw > 0
            ? Math.max(1, Math.min(8, Math.floor(workerCountRaw)))
            : 1;
        const browserGpu = options.browserGpu === true;
        const args = hasLocalCli ? [
            localCliJs,
            'render',
            projectDir,
            '--output',
            outputFile,
            '--fps',
            String(options.fps || 30),
            '--quality',
            options.quality || 'standard',
            '--workers',
            String(workerCount),
        ] : [
            '--no-install',
            'hyperframes',
            'render',
            projectDir,
            '--output',
            outputFile,
            '--fps',
            String(options.fps || 30),
            '--quality',
            options.quality || 'standard',
            '--workers',
            String(workerCount),
        ];
        const browserPath = findHyperframesBrowserPath();
        if (options.gpu !== false) args.push('--gpu');
        args.push(browserGpu ? '--browser-gpu' : '--no-browser-gpu');
        if (options.strict) args.push('--strict');

        console.log(`[HyperFrames] Running: ${cliCmd} ${args.join(' ')}`);
        console.log(`[HyperFrames] Browser: ${browserPath || 'HyperFrames default browser resolution'}`);
        const workerLabel = workerCount === 1 ? '1 worker' : `${workerCount} workers`;
        sendRenderProgress(18, `[HyperFrames] Rendering ${options.gpu === false ? 'CPU' : 'GPU'} HTML/MG composition (${workerLabel}, browser ${browserGpu ? 'GPU' : 'software'})...`);

        const proc = spawn(cliCmd, args, {
            cwd: PROJECT_ROOT,
            env: {
                ...process.env,
                FORCE_COLOR: '0',
                PRODUCER_MAX_WORKERS: String(workerCount),
                PRODUCER_BROWSER_GPU_MODE: browserGpu ? 'hardware' : 'software',
                PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: String(options.protocolTimeoutMs || 900000),
                PRODUCER_PLAYER_READY_TIMEOUT_MS: String(options.playerReadyTimeoutMs || 180000),
                PRODUCER_RENDER_READY_TIMEOUT_MS: String(options.renderReadyTimeoutMs || 180000),
                ...(browserPath ? {
                    HYPERFRAMES_BROWSER_PATH: browserPath,
                    PRODUCER_HEADLESS_SHELL_PATH: browserPath,
                } : {}),
            },
            windowsHide: true,
        });
        activeProcess = proc;
        activeProcessType = 'render';

        let stdout = '';
        let stderr = '';
        const started = Date.now();
        let lastFrameLogAt = 0;
        let lastFrameLogged = 0;
        let lastFrameProgressAt = 0;
        let sawFrameProgress = false;
        const progressTimer = setInterval(() => {
            const sec = ((Date.now() - started) / 1000).toFixed(0);
            if (!sawFrameProgress) {
                sendRenderProgress(45, `[HyperFrames] Rendering... ${sec}s elapsed`);
            }
        }, 5000);

        const stripAnsi = (value) => String(value || '')
            .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
            .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');

        const appendTail = (current, text) => (current + text).slice(-50000);
        const isCancellationError = () => activeRenderCancelled === true;

        const handleCliOutput = (raw, streamName) => {
            const text = raw.toString();
            if (streamName === 'stdout') stdout = appendTail(stdout, text);
            else stderr = appendTail(stderr, text);

            const clean = stripAnsi(text).replace(/\r/g, '\n');
            const frameMatches = [...clean.matchAll(/Streaming frame\s+(\d+)\s*\/\s*(\d+)/g)];
            if (frameMatches.length) {
                const lastMatch = frameMatches[frameMatches.length - 1];
                const frame = Number(lastMatch[1]);
                const total = Number(lastMatch[2]);
                const now = Date.now();
                if (Number.isFinite(frame) && Number.isFinite(total) && total > 0) {
                    sawFrameProgress = true;
                    if (now - lastFrameProgressAt >= 1000 || frame === total) {
                        const percent = Math.min(98, Math.max(20, Math.round(20 + (frame / total) * 76)));
                        sendRenderProgress(percent, `[HyperFrames] Rendering frame ${frame}/${total} (${workerLabel}, browser ${browserGpu ? 'GPU' : 'software'})`);
                        lastFrameProgressAt = now;
                    }
                    if (now - lastFrameLogAt >= 5000 || frame - lastFrameLogged >= 250 || frame === total) {
                        console.log(`[HyperFrames] Streaming frame ${frame}/${total}`);
                        lastFrameLogAt = now;
                        lastFrameLogged = frame;
                    }
                }
            }

            const nonFrameLines = clean
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !/Streaming frame\s+\d+\s*\/\s*\d+/.test(line));
            for (const line of nonFrameLines) {
                console.log(`[HyperFrames] ${line}`);
            }
        };

        proc.stdout.on('data', (data) => {
            handleCliOutput(data, 'stdout');
        });
        proc.stderr.on('data', (data) => {
            handleCliOutput(data, 'stderr');
        });
        proc.on('error', (err) => {
            clearInterval(progressTimer);
            activeProcess = null;
            activeProcessType = null;
            if (isCancellationError()) {
                resolve({ success: false, cancelled: true, error: 'Cancelled', stdout, stderr });
                return;
            }
            resolve({ success: false, error: err.message, stdout, stderr });
        });
        proc.on('close', (code) => {
            clearInterval(progressTimer);
            activeProcess = null;
            activeProcessType = null;
            if (isCancellationError()) {
                resolve({ success: false, cancelled: true, error: 'Cancelled', stdout, stderr });
                return;
            }
            if (code === 0 && fs.existsSync(outputFile)) {
                resolve({ success: true, outputPath: outputFile, stdout, stderr });
            } else {
                const tail = `${stdout}\n${stderr}`.trim().slice(-2000);
                resolve({
                    success: false,
                    error: `HyperFrames exited with code ${code}${tail ? `\n${tail}` : ''}`,
                    stdout,
                    stderr,
                });
            }
        });
    });
}

function loadHyperframesBridgeFresh() {
    const bridgePath = require.resolve('./src/hyperframes-bridge');
    delete require.cache[bridgePath];
    return require(bridgePath);
}

// Agent-authored compositions (templates + fullscreen MGs). Runs on the final
// plan right before the bridge so `_authoredComposition` lands on the exact
// objects the bridge renders. Failures degrade silently to fixed renderers.
async function runCompositionAuthorPass(plan) {
    try {
        if (!plan) return;
        const { authorPlanCompositions } = require('./src/agents/workers/composition-author');
        // openMode: project open / refresh / render-prep must NEVER author —
        // fresh authoring belongs to builds (Step 7.6). HF_AUTHOR_REFRESH=1
        // overrides for an explicit re-author.
        const openMode = !/^(1|true|on|yes)$/i.test(String(process.env.HF_AUTHOR_REFRESH || '').trim());
        await authorPlanCompositions(plan, { projectDir: PROJECT_DIR, openMode, log: (m) => console.log(`[HyperFrames]${m}`) });
    } catch (err) {
        console.warn(`[HyperFrames] composition author pass skipped: ${err.message}`);
    }
}

function readJsonSafe(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function loadHyperframesLabRegistry() {
    const mg = require('./src/render/mg-registry');
    let templateRegistry = {};
    try {
        templateRegistry = require('./src/agents/ai-templates').TEMPLATE_REGISTRY || {};
    } catch (err) {
        console.warn(`[HyperFrames Lab] Template registry unavailable: ${err.message}`);
    }
    let themeIds = ['standard', 'minimal', 'modern', 'history', 'crime'];
    let styles = ['clean', 'minimal', 'bold', 'neon', 'cinematic', 'elegant'];
    try {
        const themes = require('./src/data/themes');
        if (typeof themes.getThemeIds === 'function') themeIds = themes.getThemeIds();
        if (typeof themes.getMGStylePresetNames === 'function') styles = themes.getMGStylePresetNames();
    } catch (err) {
        console.warn(`[HyperFrames Lab] Theme registry unavailable: ${err.message}`);
    }

    const mgCategories = Object.entries(mg.MG_REGISTRY || {}).map(([key, reg]) => ({
        key,
        label: reg.label || key,
        group: reg.group || 'overlay',
        defaultVariant: reg.defaultType || Object.keys(reg.types || {})[0] || 'standard',
        variants: Object.entries(reg.types || {}).map(([variantKey, variant]) => ({
            key: variantKey,
            label: variant.label || variantKey,
            animation: variant.animation || reg.animations?.[0] || 'fadeSlide',
        })),
        animations: Array.isArray(reg.animations) ? reg.animations : [],
        fields: Array.isArray(reg.fields) ? reg.fields : [],
    }));

    const templates = Object.entries(templateRegistry).map(([key, reg]) => ({
        key,
        label: reg.label || key,
        defaultVariant: reg.defaultVariant || reg.variants?.[0] || 'standard',
        variants: Array.isArray(reg.variants) ? reg.variants : ['standard'],
        animations: Array.isArray(reg.animations) ? reg.animations : [reg.defaultAnimation || 'fadeSlide'],
        defaultAnimation: reg.defaultAnimation || reg.animations?.[0] || 'fadeSlide',
        requiresItems: !!reg.requiresItems,
        needsBackground: !!reg.needsBackground,
        needsItemImages: !!reg.needsItemImages,
        contentFields: Array.isArray(reg.contentFields) ? reg.contentFields : [],
    }));

    return {
        success: true,
        updatedAt: new Date().toISOString(),
        projectDir: PROJECT_DIR,
        mgCategories,
        templates,
        styles,
        themeIds,
        transitions: ['crossfade', 'swipe', 'wipe', 'slide', 'push', 'zoom', 'flash', 'glitch'],
    };
}

function hyperframesLabBackgroundFiles() {
    const candidates = [
        path.join(APP_ROOT, 'assets', 'backgrounds'),
        path.join(APP_ROOT, 'assets', 'overlays'),
        path.join(PROJECT_DIR, 'temp'),
        path.join(PROJECT_DIR, 'public'),
        path.join(PROJECT_DIR, 'media'),
    ];
    const allowed = new Set(['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']);
    const files = [];
    for (const dir of candidates) {
        try {
            if (!fs.existsSync(dir)) continue;
            for (const entry of fs.readdirSync(dir)) {
                const full = path.join(dir, entry);
                if (!fs.statSync(full).isFile()) continue;
                if (allowed.has(path.extname(full).toLowerCase())) files.push(full);
            }
        } catch (_) {
            // Ignore missing/locked media folders.
        }
    }
    return files;
}

function pickHyperframesLabBackground(index = 0) {
    const files = hyperframesLabBackgroundFiles();
    if (!files.length) return null;
    const videos = files.filter(file => ['.mp4', '.mov', '.webm'].includes(path.extname(file).toLowerCase()));
    const pool = videos.length ? videos : files;
    return pool[Math.abs(index) % pool.length];
}

function sampleItemsForVisual(type, variant, index = 0) {
    const label = String(type || 'visual').replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ').trim();
    if (/comparison/i.test(type)) {
        return [
            { label: 'Before', value: 'Slow', text: 'Old workflow' },
            { label: 'After', value: 'Fast', text: 'HyperFrames pipeline' },
        ];
    }
    if (/timeline/i.test(type)) {
        return [
            { label: 'Step 1', value: 'Plan', text: 'Scene intent' },
            { label: 'Step 2', value: 'Animate', text: 'Motion pass' },
            { label: 'Step 3', value: 'Render', text: 'Final output' },
        ];
    }
    if (/listicle|infographic|imageShowcase|personIntro|splitScreen/i.test(type)) {
        return [
            { label: '01', value: 'Variant', text: variant || 'standard' },
            { label: '02', value: 'Motion', text: 'GSAP timing' },
            { label: '03', value: 'Style', text: 'Theme tokens' },
            { label: '04', value: 'Render', text: 'Bridge output' },
        ];
    }
    if (/stat|counter|progress/i.test(type)) {
        return [
            { label: 'Coverage', value: `${index + 1}`, text: `${label} test` },
            { label: 'Status', value: 'Live', text: 'Real bridge' },
        ];
    }
    return [
        { label: 'Style', value: variant || 'standard', text: `${label} variant` },
        { label: 'Motion', value: 'OK', text: 'Animation wired' },
    ];
}

function buildHyperframesLabPlan(payload = {}, registry = loadHyperframesLabRegistry()) {
    const mode = payload.mode || 'single';
    const kind = payload.kind || 'mg';
    const themeId = payload.themeId || registry.themeIds?.[0] || 'standard';
    const styles = Array.isArray(payload.styles) && payload.styles.length ? payload.styles : (registry.styles || ['clean']);
    const sceneDuration = Math.max(1.6, Math.min(8, Number(payload.duration || 2.6) || 2.6));
    const gap = Math.max(0.15, Math.min(1.5, Number(payload.gap || 0.35) || 0.35));
    const speed = Math.max(0.25, Math.min(2.5, Number(payload.speed || 1) || 1));
    const shadowStrength = Math.max(0, Math.min(1, Number(payload.shadowStrength || 0.55) || 0.55));
    const items = [];

    const pushMg = (entry, variant, animation, styleName) => {
        const i = items.length;
        const start = i * (sceneDuration + gap);
        const label = entry.label || entry.key;
        items.push({
            kind: 'mg',
            type: entry.key,
            subType: variant,
            variant,
            animation,
            styleName,
            themeId,
            startTime: start,
            duration: sceneDuration,
            sceneIndex: i,
            position: i % 3 === 0 ? 'lower' : i % 3 === 1 ? 'center' : 'upper',
            text: `${label}`,
            subtext: `${variant} / ${animation} / ${styleName}`,
            value: String(i + 1),
            progress: Math.min(100, 20 + (i * 7) % 80),
            items: sampleItemsForVisual(entry.key, variant, i),
        });
    };

    const pushTemplate = (entry, variant, animation, styleName) => {
        const i = items.length;
        const start = i * (sceneDuration + gap);
        const background = pickHyperframesLabBackground(i);
        const label = entry.label || entry.key;
        items.push({
            kind: 'template',
            type: entry.key,
            templateType: entry.key,
            templateVariant: variant,
            variant,
            templateAnimation: animation,
            animation,
            styleName,
            themeId,
            startTime: start,
            duration: Math.max(sceneDuration, 3.2),
            sceneIndex: i,
            text: `${label}`,
            templateText: `${label}`,
            subText: `${variant} / ${animation} / ${styleName}`,
            templateSubtext: `Real HyperFrames template bridge test`,
            templateHint: `${label} ${variant}`,
            items: sampleItemsForVisual(entry.key, variant, i),
            mediaPath: background,
            templateMediaFile: background,
            backgroundMediaFile: background,
        });
    };

    if (mode === 'all' || mode === 'mg-all') {
        for (const entry of registry.mgCategories || []) {
            for (const v of entry.variants || [{ key: entry.defaultVariant || 'standard' }]) {
                const styleName = styles[items.length % styles.length] || 'clean';
                const animation = v.animation || entry.animations?.[items.length % Math.max(1, entry.animations.length)] || 'fadeSlide';
                pushMg(entry, v.key || v, animation, styleName);
            }
        }
    }

    if (mode === 'all' || mode === 'template-all') {
        for (const entry of registry.templates || []) {
            for (const variant of entry.variants || [entry.defaultVariant || 'standard']) {
                const styleName = styles[items.length % styles.length] || 'clean';
                const animation = entry.animations?.[items.length % Math.max(1, entry.animations.length)] || entry.defaultAnimation || 'fadeSlide';
                pushTemplate(entry, variant, animation, styleName);
            }
        }
    }

    if (mode === 'single') {
        if (kind === 'template') {
            const entry = (registry.templates || []).find(t => t.key === payload.type) || registry.templates?.[0];
            if (entry) {
                pushTemplate(
                    entry,
                    payload.variant || entry.defaultVariant || entry.variants?.[0] || 'standard',
                    payload.animation || entry.defaultAnimation || entry.animations?.[0] || 'fadeSlide',
                    payload.styleName || styles[0] || 'clean'
                );
            }
        } else {
            const entry = (registry.mgCategories || []).find(t => t.key === payload.type) || registry.mgCategories?.[0];
            if (entry) {
                const variantObj = (entry.variants || []).find(v => v.key === payload.variant) || entry.variants?.[0] || {};
                pushMg(
                    entry,
                    payload.variant || variantObj.key || entry.defaultVariant || 'standard',
                    payload.animation || variantObj.animation || entry.animations?.[0] || 'fadeSlide',
                    payload.styleName || styles[0] || 'clean'
                );
            }
        }
    }

    const totalDuration = Math.max(3, ...items.map(item => Number(item.startTime || 0) + Number(item.duration || sceneDuration))) + 0.5;
    const background = pickHyperframesLabBackground(0);
    const scenes = [
        {
            index: 0,
            startTime: 0,
            endTime: totalDuration,
            duration: totalDuration,
            text: 'HyperFrames Motion Lab background scene',
            keyword: 'motion graphics lab background',
            mediaPath: background,
            assetPath: background,
            fit: 'cover',
        },
    ];

    return {
        title: 'HyperFrames Motion Lab',
        fps: 30,
        width: 1920,
        height: 1080,
        duration: totalDuration,
        totalDuration,
        themeId,
        mgStyle: styles[0] || 'clean',
        scriptContext: {
            themeId,
            mgStyle: styles[0] || 'clean',
            hyperframesLab: true,
            mgAnimationSpeed: speed,
            mgShadowStrength: shadowStrength,
        },
        scenes,
        transitions: [
            { fromSceneIndex: 0, toSceneIndex: 1, type: payload.transition || 'crossfade', duration: 0.35 },
        ],
        motionGraphics: items.filter(item => item.kind === 'mg').map(({ kind: _kind, ...item }) => item),
        templateScenes: items.filter(item => item.kind === 'template').map(({ kind: _kind, ...item }) => item),
        _labStats: {
            mode,
            totalItems: items.length,
            mgItems: items.filter(item => item.kind === 'mg').length,
            templateItems: items.filter(item => item.kind === 'template').length,
            background,
        },
    };
}

function readHyperframesLabReports(projectDir) {
    return {
        visual: readJsonSafe(path.join(projectDir, 'hyperframes-visual-report.json')),
        style: readJsonSafe(path.join(projectDir, 'hyperframes-style-report.json')),
        snapshot: readJsonSafe(path.join(projectDir, 'video-plan.snapshot.json')),
    };
}

let hyperframesLabWindow = null;

function openHyperframesLabWindow() {
    const htmlFile = path.join(__dirname, 'ui', 'hyperframes-lab.html');
    if (hyperframesLabWindow && !hyperframesLabWindow.isDestroyed()) {
        hyperframesLabWindow.focus();
        return hyperframesLabWindow;
    }
    hyperframesLabWindow = new BrowserWindow({
        width: 1540,
        height: 920,
        minWidth: 1100,
        minHeight: 700,
        backgroundColor: '#070a10',
        title: 'HyperFrames Motion Lab',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    hyperframesLabWindow.loadFile(htmlFile);
    hyperframesLabWindow.on('closed', () => { hyperframesLabWindow = null; });
    return hyperframesLabWindow;
}

ipcMain.handle('open-hyperframes-lab', async () => {
    openHyperframesLabWindow();
    return { success: true };
});

ipcMain.handle('hyperframes-lab-registry', async () => {
    try {
        return loadHyperframesLabRegistry();
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('hyperframes-lab-generate', async (_event, payload = {}) => {
    try {
        const registry = loadHyperframesLabRegistry();
        const plan = buildHyperframesLabPlan(payload, registry);
        if (payload.motionDirector !== false) {
            const { applyHyperframesMotionDirector } = require('./src/render/hyperframes-motion-director');
            await applyHyperframesMotionDirector({
                motionGraphics: plan.motionGraphics || [],
                mgScenes: plan.mgScenes || [],
                templateScenes: plan.templateScenes || [],
                scenes: plan.scenes || [],
                scriptContext: plan.scriptContext || {},
                style: {
                    mgStyle: plan.mgStyle,
                    themeId: plan.themeId,
                    labMode: plan._labStats?.mode,
                },
                log: {
                    info: (m) => console.log(`[HyperFrames Lab] ${m}`),
                    ok: (m) => console.log(`[HyperFrames Lab] ${m}`),
                    warn: (m) => console.warn(`[HyperFrames Lab] ${m}`),
                    dim: (m) => console.log(`[HyperFrames Lab] ${m}`),
                },
            });
            plan._labStats.motionDirector = true;
        } else {
            plan._labStats.motionDirector = false;
        }
        await runCompositionAuthorPass(plan);
        const { generateHyperframesProject } = loadHyperframesBridgeFresh();
        const result = generateHyperframesProject({
            plan,
            projectDir: PROJECT_DIR,
            appRoot: APP_ROOT,
            tempDir: TEMP_PATH,
            publicDir: PUBLIC_PATH,
            inputDir: INPUT_PATH,
            outputRoot: path.join(PROJECT_DIR, 'hyperframes-lab'),
            options: payload.options || {},
        });
        const reports = readHyperframesLabReports(result.projectDir);
        return {
            success: true,
            ...result,
            fileUrl: result.indexPath ? pathToFileURL(result.indexPath).href : null,
            reports,
            labStats: plan._labStats,
        };
    } catch (err) {
        console.error('[HyperFrames Lab] Generate failed:', err);
        return { success: false, error: err.message || String(err) };
    }
});

ipcMain.handle('hyperframes-lab-open-folder', async (_event, folder) => {
    const fallback = path.join(PROJECT_DIR, 'hyperframes-lab');
    const target = folder && fs.existsSync(folder) ? folder : fallback;
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    await shell.openPath(target);
    return { success: true, path: target };
});

ipcMain.handle('hyperframes-generate-project', async (_event, payload = {}) => {
    try {
        await runCompositionAuthorPass(payload.plan);
        const { generateHyperframesProject } = loadHyperframesBridgeFresh();
        const result = generateHyperframesProject({
            plan: payload.plan,
            projectDir: PROJECT_DIR,
            appRoot: APP_ROOT,
            tempDir: TEMP_PATH,
            publicDir: PUBLIC_PATH,
            inputDir: INPUT_PATH,
            outputRoot: path.join(PROJECT_DIR, 'hyperframes'),
            options: payload.options || {},
        });
        console.log(`[HyperFrames] Project generated: ${result.projectDir}`);
        return result;
    } catch (err) {
        console.error('[HyperFrames] Project generation failed:', err.message);
        return { success: false, error: err.message };
    }
});

// Clip a plan down to [startSec, endSec] for a FAST partial HyperFrames render (In/Out
// points). Shifts all timings to start at 0, drops out-of-range items, keeps a transition
// only if both its scenes survive, and trims the narration audio so the section stays in
// sync. Returns a NEW plan object; never mutates the original. Used only when In/Out is set.
async function _clipPlanForRange(plan, startSec, endSec) {
    const dur = Math.max(0.1, endSec - startSec);
    const overlaps = (s, e) => Number(e) > startSec + 0.001 && Number(s) < endSec - 0.001;
    const shift = (item) => {
        const s = Number(item.startTime ?? item.start ?? 0);
        const eRaw = item.endTime ?? item.end ?? (item.duration != null ? s + Number(item.duration) : s);
        const e = Number(eRaw);
        const ns = Math.max(0, Math.min(dur, s - startSec));
        const ne = Math.max(ns, Math.min(dur, e - startSec));
        const out = { ...item, startTime: ns, endTime: ne };
        if (item.duration != null) out.duration = Number((ne - ns).toFixed(3)); // bridge derives from start/end anyway
        delete out._hfTiming; // force the bridge to recompute timing
        return out;
    };
    const clipped = { ...plan };
    const keptIdx = new Set();
    if (Array.isArray(plan.scenes)) {
        clipped.scenes = plan.scenes
            .filter(sc => {
                const keep = overlaps(Number(sc.startTime ?? 0), Number(sc.endTime ?? sc.startTime ?? 0));
                if (keep && sc.index != null) keptIdx.add(Number(sc.index));
                return keep;
            })
            .map(shift);
    }
    if (Array.isArray(plan.mgScenes)) {
        clipped.mgScenes = plan.mgScenes
            .filter(sc => overlaps(Number(sc.startTime ?? 0), Number(sc.endTime ?? sc.startTime ?? 0)))
            .map(shift);
    }
    if (Array.isArray(plan.motionGraphics)) {
        clipped.motionGraphics = plan.motionGraphics
            .filter(mg => overlaps(Number(mg.startTime ?? 0), Number(mg.startTime ?? 0) + Number(mg.duration ?? 0)))
            .map(shift);
    }
    // templateScenes (stat cards, key-takeaways, listicle grids, etc.) are a SEPARATE timed
    // array the renderer places by startTime. Without clipping+re-basing them here, a section
    // render leaves them at their ABSOLUTE time → they appear shifted late (out of audio sync)
    // while the full preview is correct. Mirror the mgScenes handling.
    if (Array.isArray(plan.templateScenes)) {
        clipped.templateScenes = plan.templateScenes
            .filter(sc => overlaps(Number(sc.startTime ?? 0), Number(sc.endTime ?? sc.startTime ?? 0)))
            .map(shift);
    }
    if (Array.isArray(plan.sfxClips)) {
        clipped.sfxClips = plan.sfxClips
            .filter(sx => overlaps(Number(sx.startTime ?? 0), Number(sx.startTime ?? 0) + Number(sx.duration ?? 0.5)))
            .map(shift);
    }
    if (Array.isArray(plan.transitions)) {
        clipped.transitions = plan.transitions.filter(t => keptIdx.has(Number(t.fromSceneIndex)) && keptIdx.has(Number(t.toSceneIndex)));
    }
    clipped.totalDuration = dur;

    // Trim the narration audio to the range so it matches the shifted visuals.
    if (plan.audio) {
        const resolved = [PUBLIC_PATH, TEMP_PATH, INPUT_PATH].map(d => path.join(d, plan.audio)).find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
        if (resolved) {
            const outName = `hf-clip-voiceover-${Date.now()}.mp3`;
            const outPath = path.join(TEMP_PATH, outName);
            try {
                await new Promise((resolve, reject) => {
                    const { execFile } = require('child_process');
                    execFile(WEBGL_FFMPEG_PATH, ['-y', '-ss', String(startSec), '-to', String(endSec), '-i', resolved, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', outPath], (err) => err ? reject(err) : resolve());
                });
                clipped.audio = outName; // bridge resolves it from TEMP_PATH
            } catch (e) {
                console.warn(`[HyperFrames] audio trim failed (${e.message}); section may be out of sync`);
            }
        }
    }
    return clipped;
}

ipcMain.handle('hyperframes-render', async (_event, payload = {}) => {
    try {
        activeRenderCancelled = false;
        purgePartialHyperframesBrowser();
        const { generateHyperframesProject } = loadHyperframesBridgeFresh();
        const nodeRuntime = checkHyperframesNodeRuntime();
        if (!nodeRuntime.ok) {
            const versionLabel = nodeRuntime.version || 'unknown';
            const message = `HyperFrames requires Node 22+ for the CLI renderer. Current node is ${versionLabel}. Install/switch to Node 22+, then retry the HyperFrames render.`;
            console.warn(`[HyperFrames] ${message}`);
            sendRenderProgress(0, `[HyperFrames] ${message}`);
            return { success: false, error: message, nodeRuntime };
        }
        if (!fs.existsSync(OUTPUT_PATH)) fs.mkdirSync(OUTPUT_PATH, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outputFile = path.join(OUTPUT_PATH, `hyperframes-${stamp}.mp4`);

        // Partial render (In/Out points): clip the plan to the range so HyperFrames renders
        // ONLY that section (fast check) instead of the whole timeline.
        let renderPlan = payload.plan;
        const _opt = payload.options || {};
        const _start = Number(_opt.startSec || 0);
        const _end = Number.isFinite(Number(_opt.endSec)) ? Number(_opt.endSec) : null;
        const _fullDur = Number(payload.plan?.totalDuration || 0);
        const _isPartial = _end != null && _end > _start + 0.05 && ((_start > 0.05) || (_fullDur && _end < _fullDur - 0.05));
        if (_isPartial) {
            sendRenderProgress(6, `[HyperFrames] Partial render ${_start.toFixed(1)}s → ${_end.toFixed(1)}s (clipping to section)...`);
            try { renderPlan = await _clipPlanForRange(payload.plan, _start, _end); }
            catch (e) { console.warn(`[HyperFrames] plan clip failed (${e.message}); rendering full timeline`); renderPlan = payload.plan; }
        }

        sendRenderProgress(8, '[HyperFrames] Generating HTML composition...');
        await runCompositionAuthorPass(renderPlan);
        const project = generateHyperframesProject({
            plan: renderPlan,
            projectDir: PROJECT_DIR,
            appRoot: APP_ROOT,
            tempDir: TEMP_PATH,
            publicDir: PUBLIC_PATH,
            inputDir: INPUT_PATH,
            outputRoot: path.join(PROJECT_DIR, 'hyperframes'),
            options: {
                ...(payload.options || {}),
                onProgress: sendRenderProgress,
            },
        });

        console.log(`[HyperFrames] Project generated: ${project.projectDir}`);
        sendRenderProgress(14, '[HyperFrames] Project generated, starting renderer...');

        // Pre-render slideshow/monotony advisory (OPENMONTAGE-BORROW-PLAN #10).
        // Log-only — surfaces monotony before we spend a full render; never blocks.
        try {
            const { scoreSlideshowRisk } = require('./src/agents/scene-risk');
            const sr = scoreSlideshowRisk(renderPlan);
            if (sr.level !== 'ok') {
                console.warn(`[SlideshowRisk] ${sr.level.toUpperCase()} (score ${sr.score}) — ${sr.findings.length} finding(s):`);
                for (const f of sr.findings) console.warn(`[SlideshowRisk]   ${f.severity === 'fail' ? '❌' : '⚠️'} ${f.message}`);
            }
        } catch (_) { /* advisory only */ }

        // Pre-render HyperFrames lint (OPENMONTAGE-BORROW-PLAN #12).
        try { runHyperframesLint(project.projectDir); } catch (_) { /* advisory only */ }

        const renderOptions = {
            fps: payload.fps || payload.plan?.fps || 30,
            quality: payload.quality || 'standard',
            gpu: payload.gpu !== false,
            workers: payload.workers || 4,
            browserGpu: payload.browserGpu !== false,
            strict: payload.strict === true,
        };
        let rendered = await runHyperframesCli(project.projectDir, outputFile, renderOptions);

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        if (!rendered.success && (renderOptions.browserGpu || Number(renderOptions.workers) > 1)) {
            console.warn('[HyperFrames] Fast browser render failed. Retrying stable mode (1 worker, browser software).');
            sendRenderProgress(22, '[HyperFrames] Fast render failed, retrying stable mode...');
            rendered = await runHyperframesCli(project.projectDir, outputFile, {
                ...renderOptions,
                workers: 1,
                browserGpu: false,
            });
        }

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        if (!rendered.success && renderOptions.gpu) {
            console.warn('[HyperFrames] GPU render failed. Retrying without GPU encoding.');
            sendRenderProgress(22, '[HyperFrames] GPU render failed, retrying CPU encode...');
            rendered = await runHyperframesCli(project.projectDir, outputFile, {
                ...renderOptions,
                gpu: false,
                workers: 1,
                browserGpu: false,
            });
        }

        if (rendered.cancelled) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        if (!rendered.success) {
            activeRenderCancelled = false;
            return { ...rendered, projectDir: project.projectDir };
        }

        // ── Audio finishing (OPENMONTAGE-BORROW-PLAN #1) ──
        // The CLI muxed voice+sfx crudely (no ducking, no loudnorm, no bed).
        // Post-process the finished mp4: normalize to −16 LUFS and, if a music
        // bed is present, duck it under the narration. Non-destructive: video
        // stream is copied and the original is only replaced on success.
        // Skipped for partial (In/Out) renders — those are quick section checks.
        if (!_isPartial) {
            try {
                sendRenderProgress(99, '[HyperFrames] Finishing audio (loudness + mix)...');
                const { finishAudio } = require('./src/render/audio-mixer');
                let bedPath = null;
                const bedCandidate = renderPlan?.musicBed || process.env.MUSIC_BED_PATH || '';
                if (bedCandidate) {
                    bedPath = [PUBLIC_PATH, TEMP_PATH, INPUT_PATH, '']
                        .map((d) => (d ? path.join(d, bedCandidate) : bedCandidate))
                        .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
                }
                finishAudio({ videoPath: rendered.outputPath, bedPath, log: (m) => console.log(m) });
            } catch (e) {
                console.warn(`[HyperFrames] audio finishing skipped (${e.message}) — original render kept`);
            }
        }

        // ── Post-render final review (OPENMONTAGE-BORROW-PLAN #7 + #8 + #9) ──
        // Probe the ACTUAL output (duration/black/audio) + plan (motion-ratio,
        // pacing). Advisory: we never fail a render that produced a file, but we
        // surface the verdict to the UI and logs. FINAL_REVIEW=0 disables.
        let review = null;
        if (!_isPartial) {
            try {
                sendRenderProgress(99, '[HyperFrames] Reviewing final render...');
                const { finalReview } = require('./src/pipeline/final-review');
                review = await finalReview({
                    videoPath: rendered.outputPath,
                    plan: renderPlan,
                    publicDir: PUBLIC_PATH,
                    log: (m) => console.log(m),
                });
            } catch (e) {
                console.warn(`[HyperFrames] final review skipped (${e.message})`);
            }
        }

        sendRenderProgress(100, '[HyperFrames] Render complete');
        activeRenderCancelled = false;
        return {
            success: true,
            outputPath: rendered.outputPath,
            projectDir: project.projectDir,
            indexPath: project.indexPath,
            review,
        };
    } catch (err) {
        activeProcess = null;
        activeProcessType = null;
        activeRenderCancelled = false;
        console.error('[HyperFrames] Render failed:', err.message);
        return { success: false, error: err.message };
    }
});

/**
 * Mux the WebGL-rendered video with the project's audio track + SFX clips.
 * Returns the final output file path.
 */
async function _webglMuxAudio(exp) {
    const planPath = path.join(PUBLIC_PATH, 'video-plan.json');
    let audioFile = null;
    let sfxClips = [];
    let sfxEnabled = true;

    if (fs.existsSync(planPath)) {
        try {
            const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
            if (plan.audio) {
                for (const dir of [PUBLIC_PATH, TEMP_PATH, INPUT_PATH]) {
                    const candidate = path.join(dir, plan.audio);
                    if (fs.existsSync(candidate)) {
                        audioFile = candidate;
                        break;
                    }
                }
            }
            // Read SFX clips from plan
            if (plan.sfxEnabled !== false && plan.sfxClips && plan.sfxClips.length > 0) {
                const sfxDir = path.join(__dirname, 'assets', 'sfx');
                for (const clip of plan.sfxClips) {
                    const sfxPath = path.join(sfxDir, clip.file);
                    if (fs.existsSync(sfxPath)) {
                        sfxClips.push({
                            path: sfxPath,
                            startTime: clip.startTime || 0,
                            duration: clip.duration || 0.5,
                            volume: clip.volume !== undefined ? clip.volume : 0.35,
                        });
                    }
                }
            }
        } catch (_) { }
    }

    // If rendering a sub-range (in/out points), filter SFX to that range and adjust timing
    const trimStart = exp.audioTrimStartSec || 0;
    const trimEnd = exp.audioTrimEndSec || Infinity;
    if (trimStart > 0 || trimEnd < Infinity) {
        const before = sfxClips.length;
        sfxClips = sfxClips.filter(sfx => {
            const sfxEnd = sfx.startTime + sfx.duration;
            return sfxEnd > trimStart && sfx.startTime < trimEnd;
        });
        // Adjust startTime relative to the trim start
        for (const sfx of sfxClips) {
            sfx.startTime = Math.max(0, sfx.startTime - trimStart);
        }
        if (before !== sfxClips.length) {
            console.log(`[WebGL Export] SFX trimmed: ${before} → ${sfxClips.length} clips (range ${trimStart.toFixed(1)}s-${trimEnd === Infinity ? 'end' : trimEnd.toFixed(1) + 's'})`);
        }
    }

    const hasSfx = sfxClips.length > 0;

    if (!audioFile && !hasSfx) {
        // No audio at all — just copy video
        fs.copyFileSync(exp.videoFile, exp.outputFile);
        console.log('[WebGL Export] No audio to mux, video only:', exp.outputFile);
        return exp.outputFile;
    }

    console.log(`[WebGL Export] Muxing audio: VO=${audioFile ? 'yes' : 'no'}, SFX=${sfxClips.length} clips`);

    // Build FFmpeg args with filter_complex for mixing VO + SFX
    const inputArgs = ['-y', '-i', exp.videoFile]; // input 0 = video
    let audioInputIndex = 1;

    // Add VO audio input
    let voIndex = -1;
    if (audioFile) {
        if (exp.audioTrimStartSec != null && exp.audioTrimStartSec > 0) {
            inputArgs.push('-ss', String(exp.audioTrimStartSec));
        }
        if (exp.audioTrimEndSec != null) {
            inputArgs.push('-to', String(exp.audioTrimEndSec));
        }
        inputArgs.push('-i', audioFile);
        voIndex = audioInputIndex++;
    }

    // Add each SFX clip as a separate input with offset
    const sfxIndices = [];
    for (const sfx of sfxClips) {
        inputArgs.push('-i', sfx.path);
        sfxIndices.push(audioInputIndex++);
    }

    let outputArgs;

    if (!hasSfx) {
        // Simple case: just VO, no filter needed
        outputArgs = [
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            exp.outputFile
        ];
    } else {
        // Build filter_complex to mix all audio streams
        const filterParts = [];
        const mixInputs = [];
        let streamIdx = 0;

        // VO stream (or silent placeholder if no VO)
        if (voIndex >= 0) {
            filterParts.push(`[${voIndex}:a]aformat=fltp:44100:stereo,volume=1.0[vo]`);
            mixInputs.push('[vo]');
            streamIdx++;
        }

        // SFX streams — each delayed to its startTime and volume-adjusted
        for (let i = 0; i < sfxClips.length; i++) {
            const sfx = sfxClips[i];
            const idx = sfxIndices[i];
            const label = `sfx${i}`;
            const delayMs = Math.round(sfx.startTime * 1000);
            const vol = sfx.volume.toFixed(2);
            filterParts.push(
                `[${idx}:a]aformat=fltp:44100:stereo,volume=${vol},adelay=${delayMs}|${delayMs}[${label}]`
            );
            mixInputs.push(`[${label}]`);
            streamIdx++;
        }

        // Mix all streams together
        // normalize=0 prevents amix from dividing volume by input count
        // (with 200+ SFX clips, the default normalize=1 makes everything silent)
        const mixCount = mixInputs.length;
        filterParts.push(
            `${mixInputs.join('')}amix=inputs=${mixCount}:duration=longest:dropout_transition=0:normalize=0[aout]`
        );

        const filterComplex = filterParts.join(';');

        outputArgs = [
            '-filter_complex', filterComplex,
            '-map', '0:v',
            '-map', '[aout]',
            '-c:v', 'copy',
            '-c:a', 'aac', '-b:a', '192k',
            '-shortest',
            '-movflags', '+faststart',
            exp.outputFile
        ];
    }

    return new Promise((resolve, reject) => {
        const muxProc = spawn(WEBGL_FFMPEG_PATH, [
            ...inputArgs,
            ...outputArgs
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderr = '';
        muxProc.stderr.on('data', (d) => { stderr += d.toString(); });

        muxProc.on('close', (code) => {
            if (code === 0) {
                console.log('[WebGL Export] Final output:', exp.outputFile);
                // Clean up temp video after successful mux
                try { fs.unlinkSync(exp.videoFile); } catch (_) { }
                resolve(exp.outputFile);
            } else {
                console.error('[WebGL Export] Mux failed:', stderr.slice(-500));
                // Fallback: use video-only file (rename, don't delete first)
                try { fs.renameSync(exp.videoFile, exp.outputFile); } catch (_) {
                    try { fs.copyFileSync(exp.videoFile, exp.outputFile); } catch (_2) { }
                }
                resolve(exp.outputFile);
            }
        });

        muxProc.on('error', (err) => {
            console.error('[WebGL Export] Mux process error:', err.message);
            try { fs.renameSync(exp.videoFile, exp.outputFile); } catch (_) {
                try { fs.copyFileSync(exp.videoFile, exp.outputFile); } catch (_2) { }
            }
            resolve(exp.outputFile);
        });
    });
}


// Open output folder
ipcMain.handle('open-output-folder', async () => {
    shell.openPath(OUTPUT_PATH);
});

// Open current project's logs folder
ipcMain.handle('open-project-logs', async () => {
    const logsDir = ensureLogsDir(PROJECT_DIR);
    await shell.openPath(logsDir);
    return { success: true, logsDir };
});

// Tail latest project log in a live PowerShell window
ipcMain.handle('tail-project-logs', async () => {
    return tailProjectLogsLive(PROJECT_DIR);
});

// Get current log file path (for troubleshooting UI)
ipcMain.handle('get-current-log-file', async () => {
    return {
        projectDir: PROJECT_DIR,
        logsDir: getLogsDir(PROJECT_DIR),
        logFile: CURRENT_LOG_FILE,
    };
});

// Open file in default app
ipcMain.handle('open-file', async (event, filePath) => {
    shell.openPath(filePath);
});

// Select folder dialog
ipcMain.handle('select-folder', async (event, title) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        title: title || 'Select folder',
        properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Startup chooser actions (custom in-app startup window)
ipcMain.handle('startup-create-project', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Choose folder for new project',
        properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const projectPath = result.filePaths[0];
    resolveStartupChoice(projectPath);
    return { success: true, projectDir: projectPath };
});

ipcMain.handle('startup-open-project-folder', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const projectPath = result.filePaths[0];
    resolveStartupChoice(projectPath);
    return { success: true, projectDir: projectPath };
});

ipcMain.handle('startup-open-project-file', async () => {
    const result = await dialog.showOpenDialog(startupWindow || null, {
        title: 'Open .fvp project file',
        properties: ['openFile'],
        filters: [{ name: 'Project Files', extensions: ['fvp'] }]
    });
    if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
    const fvpPath = result.filePaths[0];
    const projectPath = path.dirname(fvpPath);
    resolveStartupChoice(projectPath);
    return { success: true, projectDir: projectPath, projectFile: fvpPath };
});

ipcMain.handle('startup-cancel', async () => {
    resolveStartupChoice(null);
    return { success: true, cancelled: true };
});

// Select file dialog
ipcMain.handle('select-file', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Audio Files', extensions: ['mp3', 'wav'] }
        ],
        ...options
    });

    if (!result.canceled && result.filePaths.length > 0) {
        return result.filePaths[0];
    }
    return null;
});

// Get file URL for video playback
ipcMain.handle('get-file-url', async (event, filePath) => {
    // Convert file path to file:// URL
    if (fs.existsSync(filePath)) {
        // Use URL constructor to handle encoding of spaces and special chars
        const fileUrl = new URL(`file://${filePath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// Show OS notification
ipcMain.handle('show-notification', async (event, title, body) => {
    if (Notification.isSupported()) {
        const n = new Notification({ title, body, silent: false });
        n.show();
    }
});

// Get SFX file path for preview playback
ipcMain.handle('get-sfx-path', async (event, filename) => {
    const sfxPath = path.join(__dirname, 'assets', 'sfx', filename);
    if (fs.existsSync(sfxPath)) {
        const fileUrl = new URL(`file://${sfxPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    // Fallback: check project's public folder
    const pubPath = path.join(PUBLIC_PATH, filename);
    if (fs.existsSync(pubPath)) {
        const fileUrl = new URL(`file://${pubPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// Download real SFX from Freesound API (replaces synthetic placeholders)
ipcMain.handle('download-real-sfx', async () => {
    try {
        const { downloadAllSfx } = require('./src/media/sfx-provider');
        const simpleLog = {
            step: (msg) => console.log(msg),
            ok: (msg) => console.log(`   ✅ ${msg}`),
            warn: (msg) => console.log(`   ⚠️ ${msg}`),
            dim: (msg) => console.log(msg),
            br: () => console.log(''),
        };
        const result = await downloadAllSfx({ log: simpleLog });
        return { success: true, ...result };
    } catch (err) {
        console.error('[SFX Download] Error:', err.message);
        return { success: false, error: err.message };
    }
});

// Scan assets/overlays/ folder for available overlay files
ipcMain.handle('scan-overlays', async () => {
    const overlaysDir = path.join(__dirname, 'assets', 'overlays');
    if (!fs.existsSync(overlaysDir)) return [];

    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);
    const files = fs.readdirSync(overlaysDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.has(ext) && !f.startsWith('.');
    });

    return files.map(f => {
        const ext = path.extname(f).toLowerCase();
        const name = path.basename(f, path.extname(f));
        const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
        const fullPath = path.join(overlaysDir, f);
        const stat = fs.statSync(fullPath);
        return {
            filename: f,
            name: name,
            ext: ext,
            mediaType: isVideo ? 'video' : 'image',
            size: stat.size,
            path: fullPath,
        };
    });
});

// Get overlay file URL for preview playback
ipcMain.handle('get-overlay-url', async (event, filename) => {
    const overlayPath = path.join(__dirname, 'assets', 'overlays', filename);
    if (fs.existsSync(overlayPath)) {
        const fileUrl = new URL(`file://${overlayPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// Scan assets/backgrounds/ folder for available background pattern files
ipcMain.handle('scan-backgrounds', async () => {
    const bgDir = path.join(__dirname, 'assets', 'backgrounds');
    if (!fs.existsSync(bgDir)) {
        fs.mkdirSync(bgDir, { recursive: true });
        return [];
    }

    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);
    const files = fs.readdirSync(bgDir).filter(f => {
        const ext = path.extname(f).toLowerCase();
        return supportedExts.has(ext) && !f.startsWith('.');
    });

    // Theme tagging convention: "{theme}--{name}.ext"
    // e.g. "history--vintage-paper.jpg" → theme: 'history', name: 'vintage-paper'
    // Files without a theme prefix are available for all themes
    const VALID_THEMES = new Set(['crime', 'history', 'modern', 'minimal', 'standard']);

    return files.map(f => {
        const ext = path.extname(f).toLowerCase();
        let name = path.basename(f, path.extname(f));
        const isVideo = ['.mp4', '.webm', '.mov'].includes(ext);
        const fullPath = path.join(bgDir, f);
        const stat = fs.statSync(fullPath);

        // Parse theme prefix: "history--vintage-paper" → theme='history', name='vintage-paper'
        let theme = null;
        const dashIdx = name.indexOf('--');
        if (dashIdx > 0) {
            const prefix = name.substring(0, dashIdx).toLowerCase();
            if (VALID_THEMES.has(prefix)) {
                theme = prefix;
                name = name.substring(dashIdx + 2);
            }
        }

        return {
            filename: f,
            name: name,
            theme: theme,   // null = all themes, or specific theme ID
            ext: ext,
            mediaType: isVideo ? 'video' : 'image',
            size: stat.size,
            path: fullPath,
        };
    });
});

// Get background file URL for preview
ipcMain.handle('get-background-url', async (event, filename) => {
    const bgPath = path.join(__dirname, 'assets', 'backgrounds', filename);
    if (fs.existsSync(bgPath)) {
        const fileUrl = new URL(`file://${bgPath.replace(/\\/g, '/')}`);
        return fileUrl.href;
    }
    return null;
});

// ========================================
// Multi-Instance / Project Management
// ========================================

// Get info about the current project
ipcMain.handle('get-project-info', async () => {
    return {
        projectDir: PROJECT_DIR,
        projectName: PROJECT_NAME,
        projectFile: getProjectFilePath(),
        appRoot: APP_ROOT,
        isDefaultProject: PROJECT_DIR === APP_ROOT
    };
});

// Qwen model pool status + reset (used by UI)
const _qwenExhaustedPath = path.join(APP_ROOT, '.qwen-exhausted-models.json');
function _parseEnvListForUi(raw) {
    return String(raw || '')
        .split(/[,\n;]/)
        .map(v => v.trim())
        .filter(Boolean);
}

function _readEnvValueForUi(envPath, key) {
    try {
        if (!fs.existsSync(envPath)) return '';
        const content = fs.readFileSync(envPath, 'utf8');
        const re = new RegExp(`^${key}=([\\s\\S]*?)$`, 'm');
        const match = content.match(re);
        if (!match) return '';
        let value = String(match[1] || '').trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        return value;
    } catch (_) {
        return '';
    }
}

function _envHasKeyForUi(envPath, key) {
    try {
        if (!fs.existsSync(envPath)) return false;
        const content = fs.readFileSync(envPath, 'utf8');
        return new RegExp(`^${key}=`, 'm').test(content);
    } catch (_) {
        return false;
    }
}

function _maskSecretForUi(secret) {
    const value = String(secret || '').trim();
    if (!value) return '';
    if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
    return `${value.slice(0, 4)}...${value.slice(-6)}`;
}

function _qwenVisionKeysForUi() {
    const envPath = path.join(APP_ROOT, '.env');
    const sharedKeys = _parseEnvListForUi(_readEnvValueForUi(envPath, 'QWEN_VISION_API_KEY'));
    const hasImagePrimary = _envHasKeyForUi(envPath, 'QWEN_IMAGE_API_KEY');
    const hasImageLane = hasImagePrimary || _envHasKeyForUi(envPath, 'QWEN_VL_API_KEY');
    const hasOmniLane = _envHasKeyForUi(envPath, 'QWEN_OMNI_API_KEY');
    const imageRaw = _parseEnvListForUi(hasImageLane ? (hasImagePrimary ? _readEnvValueForUi(envPath, 'QWEN_IMAGE_API_KEY') : _readEnvValueForUi(envPath, 'QWEN_VL_API_KEY')) : '');
    const omniRaw = _parseEnvListForUi(hasOmniLane ? _readEnvValueForUi(envPath, 'QWEN_OMNI_API_KEY') : '');
    const mapKeys = (keys) => keys.map((key, index) => ({
        index,
        tail: key.slice(-6),
        masked: _maskSecretForUi(key),
        length: key.length,
    }));
    return {
        envPath,
        shared: { envKey: 'QWEN_VISION_API_KEY', explicit: sharedKeys.length > 0, keys: mapKeys(sharedKeys) },
        image: { envKey: 'QWEN_IMAGE_API_KEY', explicit: hasImageLane, fallback: hasImageLane ? '' : 'QWEN_VISION_API_KEY', keys: mapKeys(hasImageLane ? imageRaw : sharedKeys) },
        omni: { envKey: 'QWEN_OMNI_API_KEY', explicit: hasOmniLane, fallback: hasOmniLane ? '' : 'QWEN_VISION_API_KEY', keys: mapKeys(hasOmniLane ? omniRaw : sharedKeys) },
        keys: mapKeys(sharedKeys),
    };
}

function _resolveQwenLaneKeysForSave(envPath, lane) {
    const sharedKeys = _parseEnvListForUi(_readEnvValueForUi(envPath, 'QWEN_VISION_API_KEY'));
    if (lane === 'image') {
        const hasImagePrimary = _envHasKeyForUi(envPath, 'QWEN_IMAGE_API_KEY');
        const hasImageLane = hasImagePrimary || _envHasKeyForUi(envPath, 'QWEN_VL_API_KEY');
        const imageKeys = _parseEnvListForUi(hasImagePrimary ? _readEnvValueForUi(envPath, 'QWEN_IMAGE_API_KEY') : _readEnvValueForUi(envPath, 'QWEN_VL_API_KEY'));
        return hasImageLane ? imageKeys : sharedKeys;
    }
    if (lane === 'omni') {
        const hasOmniLane = _envHasKeyForUi(envPath, 'QWEN_OMNI_API_KEY');
        const omniKeys = _parseEnvListForUi(_readEnvValueForUi(envPath, 'QWEN_OMNI_API_KEY'));
        return hasOmniLane ? omniKeys : sharedKeys;
    }
    return sharedKeys;
}

function _applyQwenKeyEdit(baseKeys, edit = {}) {
    const rows = Array.isArray(edit.rows) ? edit.rows : [];
    const additions = _parseEnvListForUi(Array.isArray(edit.additions) ? edit.additions.join(',') : edit.additions);
    const next = [];
    for (let i = 0; i < baseKeys.length; i++) {
        const row = rows.find(r => Number(r.index) === i) || {};
        if (row.remove === true) continue;
        const replacement = String(row.replacement || '').trim();
        next.push(replacement || baseKeys[i]);
    }
    for (const key of additions) next.push(key);
    const deduped = [];
    const seen = new Set();
    for (const key of next.map(k => String(k || '').trim()).filter(Boolean)) {
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(key);
    }
    return deduped;
}

const RESOURCE_ENV_GROUPS = [
    {
        id: 'qwen',
        title: 'Alibaba Qwen Vision',
        description: 'Primary vision lanes: image/VL frame scoring and Omni multimodal clip analysis.',
        fields: [
            { key: 'QWEN_BASE_URL', label: 'DashScope base URL', kind: 'text', importance: 'recommended' },
            { key: 'QWEN_VISION_MODEL', label: 'Image/VL model pool', kind: 'text', importance: 'recommended' },
            { key: 'QWEN_VISION_API_KEY', label: 'Shared fallback key pool', kind: 'secret-list', importance: 'recommended', note: 'Used only when lane-specific keys are not configured.' },
            { key: 'QWEN_IMAGE_API_KEY', label: 'Image/VL key pool', kind: 'secret-list', importance: 'optional', note: 'Leave absent to use the shared fallback pool.' },
            { key: 'QWEN_OMNI_API_KEY', label: 'Omni key pool', kind: 'secret-list', importance: 'optional', note: 'Separate this lane when Omni burns quota faster than image/VL.' },
            { key: 'QWEN_OMNI_MODEL', label: 'Omni HTTP model pool', kind: 'text', importance: 'optional' },
            { key: 'QWEN_OMNI_REALTIME_MODEL', label: 'Omni realtime model pool', kind: 'text', importance: 'optional' },
            { key: 'QWEN_OMNI_HTTP_ENABLED', label: 'Omni HTTP enabled', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_OMNI_REALTIME_ENABLED', label: 'Omni realtime enabled', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_MODEL_SYNC', label: 'Auto-sync model registry', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_MODEL_SYNC_PROBE', label: 'Probe discovered models', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_MODEL_SYNC_INTERVAL_HOURS', label: 'Model sync interval hours', kind: 'number', importance: 'optional' },
            { key: 'QWEN_DYNAMIC_MODEL_POOLS', label: 'Use generated model pools', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_PREFLIGHT', label: 'Preflight keys on build', kind: 'toggle', importance: 'optional' },
            { key: 'QWEN_HEALTH_FRESH_MS', label: 'Health cache freshness', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'bedrock',
        title: 'AWS Bedrock',
        description: 'Text AI route plus Bedrock vision fallback. Replace these when you move to a fresh AWS credit account.',
        fields: [
            { key: 'AI_PROVIDER', label: 'Text provider', kind: 'text', importance: 'required' },
            { key: 'BEDROCK_REGION', label: 'Region', kind: 'text', importance: 'required' },
            { key: 'BEDROCK_ACCESS_KEY_ID', label: 'Access key ID', kind: 'secret', importance: 'required' },
            { key: 'BEDROCK_SECRET_ACCESS_KEY', label: 'Secret access key', kind: 'secret', importance: 'required' },
            { key: 'BEDROCK_DIRECTOR_MODEL', label: 'Director model', kind: 'text', importance: 'recommended' },
            { key: 'BEDROCK_PLANNER_MODEL', label: 'Planner model', kind: 'text', importance: 'recommended' },
            { key: 'BEDROCK_UTILITY_MODEL', label: 'Utility model', kind: 'text', importance: 'recommended' },
            { key: 'BEDROCK_FALLBACK_MODEL', label: 'Text fallback model', kind: 'text', importance: 'optional' },
            { key: 'BEDROCK_TASK_TYPES', label: 'Task type allowlist', kind: 'text', importance: 'optional', note: 'Empty means all Bedrock text task types are allowed.' },
            { key: 'BEDROCK_VISION_NOVA_MODEL', label: 'Vision fallback: Nova', kind: 'text', importance: 'optional' },
            { key: 'BEDROCK_VISION_QWEN_MODEL', label: 'Vision fallback: Qwen VL', kind: 'text', importance: 'optional' },
            { key: 'BEDROCK_VISION_CLAUDE_MODEL', label: 'Vision fallback: Claude', kind: 'text', importance: 'optional' },
        ],
    },
    {
        id: 'azure',
        title: 'Azure AI',
        description: 'Azure AI Foundry text brains. Azure Claude and Azure OpenAI-compatible deployments like Grok can replace the Bedrock Sonnet tier; Bedrock remains fallback.',
        fields: [
            { key: 'AZURE_API_KEY', label: 'API key', kind: 'secret', importance: 'required' },
            { key: 'AZURE_ANTHROPIC_BASE_URL', label: 'Claude base URL', kind: 'text', importance: 'optional' },
            { key: 'AZURE_CLAUDE_MODEL', label: 'Claude deployment/model', kind: 'text', importance: 'optional' },
            { key: 'AZURE_TASK_TYPES', label: 'Claude task allowlist', kind: 'text', importance: 'optional', note: 'Claude dropdown fills this with the Sonnet tier.' },
            { key: 'AZURE_OPENAI_ENDPOINT', label: 'OpenAI-compatible endpoint', kind: 'text', importance: 'optional' },
            { key: 'AZURE_OPENAI_MODEL', label: 'OpenAI-compatible deployment/model', kind: 'text', importance: 'optional' },
            { key: 'AZURE_OPENAI_TASK_TYPES', label: 'OpenAI-compatible task allowlist', kind: 'text', importance: 'optional', note: 'Grok dropdown fills this with the Sonnet tier.' },
            { key: 'AZURE_TIMEOUT_MS', label: 'Timeout ms', kind: 'text', importance: 'optional' },
            { key: 'AZURE_OPENAI_TIMEOUT_MS', label: 'OpenAI-compatible timeout ms', kind: 'text', importance: 'optional' },
        ],
    },
    {
        id: 'stock',
        title: 'Stock Footage',
        description: 'Free stock API providers. Storyblocks is suspended unless manually re-enabled later.',
        fields: [
            { key: 'PEXELS_API_KEY', label: 'Pexels API key', kind: 'secret', importance: 'recommended' },
            { key: 'PIXABAY_API_KEY', label: 'Pixabay API key', kind: 'secret', importance: 'recommended' },
            { key: 'STORYBLOCKS_SUBSCRIBED', label: 'Storyblocks subscribed mode', kind: 'toggle', importance: 'optional', note: 'Suspended in source policy until re-enabled.' },
            { key: 'STORYBLOCKS_EMAIL', label: 'Storyblocks email', kind: 'secret', importance: 'optional', note: 'Suspended in source policy until re-enabled.' },
            { key: 'STORYBLOCKS_PASSWORD', label: 'Storyblocks password', kind: 'secret', importance: 'optional', note: 'Suspended in source policy until re-enabled.' },
            { key: 'STORYBLOCKS_COOKIE_FILE', label: 'Cookie file', kind: 'path', importance: 'optional', defaultValue: '.storyblocks-cookies.json' },
            { key: 'STORYBLOCKS_PARALLEL_DOWNLOADS', label: 'Parallel downloads', kind: 'number', importance: 'optional' },
            { key: 'STORYBLOCKS_SEARCH_RESULTS', label: 'Search result limit', kind: 'number', importance: 'optional' },
            { key: 'STORYBLOCKS_RACE_CANDIDATE_TIMEOUT_MS', label: 'Race candidate timeout', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'youtube',
        title: 'YouTube and Reddit Video',
        description: 'yt-dlp, cookies, and social/video search inputs.',
        fields: [
            { key: 'YTDLP_PATH', label: 'yt-dlp executable', kind: 'path', importance: 'recommended' },
            { key: 'YTDLP_COOKIES_FILE', label: 'yt-dlp cookies file', kind: 'path', importance: 'recommended' },
            { key: 'YTDLP_COOKIES_FROM_BROWSER', label: 'Cookie browser fallback', kind: 'text', importance: 'optional' },
            { key: 'YTDLP_CHECK_TIMEOUT_MS', label: 'yt-dlp check timeout', kind: 'number', importance: 'optional' },
            { key: 'YTDLP_TIMEOUT_SCALE', label: 'yt-dlp timeout scale', kind: 'number', importance: 'optional' },
            { key: 'YOUTUBE_API_KEY', label: 'YouTube API key', kind: 'secret', importance: 'optional' },
            { key: 'REDDIT_SEARCH_VARIANTS', label: 'Reddit search variants', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'web-images',
        title: 'Web Images',
        description: 'Reference image search for exact brands, diagrams, product shots, screenshots, maps, and news visuals.',
        fields: [
            { key: 'BRAVE_API_KEY', label: 'Brave Search API key', kind: 'secret', importance: 'recommended' },
            { key: 'BRAVE_COUNTRY', label: 'Brave country', kind: 'text', importance: 'optional' },
            { key: 'BRAVE_SEARCH_LANG', label: 'Brave language', kind: 'text', importance: 'optional' },
            { key: 'BRAVE_SAFESEARCH', label: 'Brave safe search', kind: 'text', importance: 'optional' },
            { key: 'BRAVE_IMAGES_DISABLED', label: 'Disable Brave Images', kind: 'toggle', importance: 'optional' },
            { key: 'BING_IMAGES_DISABLED', label: 'Disable Bing Images', kind: 'toggle', importance: 'optional' },
            { key: 'BING_API_KEY', label: 'Bing API key (legacy)', kind: 'secret', importance: 'optional', note: 'Empty is OK if the current Bing image path is browser/free mode.' },
        ],
    },
    {
        id: 'research-maps-assets',
        title: 'Research, Maps, and Assets',
        description: 'External resources used by director research, map media, icons, and sound effects.',
        fields: [
            { key: 'TAVILY_API_KEY', label: 'Tavily web research', kind: 'secret', importance: 'recommended' },
            { key: 'RAPIDAPI_KEY', label: 'RapidAPI search backend', kind: 'secret', importance: 'optional' },
            { key: 'FREEPIK_API_KEY', label: 'Freepik icons/assets', kind: 'secret', importance: 'optional' },
            { key: 'FREESOUND_API_KEY', label: 'Freesound SFX', kind: 'secret', importance: 'optional' },
            { key: 'GEOAPIFY_API_KEY', label: 'Geoapify maps', kind: 'secret', importance: 'optional' },
            { key: 'MAPTILER_API_KEY', label: 'MapTiler maps', kind: 'secret', importance: 'optional' },
        ],
    },
    {
        id: 'media-performance',
        title: 'Media Agent and Performance',
        description: 'Quality/speed controls for media search, candidate armies, scene concurrency, and referee decisions.',
        fields: [
            { key: 'MEDIA_AGENT_ENABLED', label: 'Media agent enabled', kind: 'toggle', importance: 'optional' },
            { key: 'MEDIA_AGENT_AI', label: 'Media agent AI planning', kind: 'toggle', importance: 'optional' },
            { key: 'FOOTAGE_PARALLEL_RACE', label: 'Parallel race enabled', kind: 'toggle', importance: 'optional' },
            { key: 'FOOTAGE_RACE_CONCURRENCY', label: 'Footage soldiers per batch', kind: 'number', importance: 'optional' },
            { key: 'FOOTAGE_RACE_MAX_BATCHES', label: 'Default footage batches', kind: 'number', importance: 'optional' },
            { key: 'IMAGE_RACE_HARD_LOCK_MAX_BATCHES', label: 'Image batches for locked scenes', kind: 'number', importance: 'optional' },
            { key: 'MEDIA_SCENE_CONCURRENCY', label: 'Scenes in parallel', kind: 'number', importance: 'optional' },
            { key: 'FOOTAGE_AI_REFEREE', label: 'AI referee', kind: 'toggle', importance: 'optional' },
            { key: 'FOOTAGE_AI_REFEREE_TIMEOUT_MS', label: 'AI referee timeout', kind: 'number', importance: 'optional' },
            { key: 'CLIP_ANALYZER_ENABLED', label: 'Clip analyzer env default', kind: 'toggle', importance: 'optional' },
            { key: 'VISION_CACHE', label: 'Vision cache', kind: 'toggle', importance: 'optional' },
        ],
    },
    {
        id: 'build-pipeline',
        title: 'Build Pipeline',
        description: 'Global build switches that affect scene splitting, orchestration, rendering, and editor agent workers.',
        fields: [
            { key: 'USE_SMART_SPLITTER', label: 'Smart splitter', kind: 'toggle', importance: 'recommended' },
            { key: 'USE_SCENE_CLASSES', label: 'Scene classifier', kind: 'toggle', importance: 'optional' },
            { key: 'USE_CAMERA_PLAN_STOPS', label: 'Camera plan stops', kind: 'toggle', importance: 'optional' },
            { key: 'RENDER_GPU_MAX_CONCURRENCY', label: 'Renderer GPU concurrency', kind: 'number', importance: 'optional' },
            { key: 'EDITOR_AGENT', label: 'Editor agent', kind: 'toggle', importance: 'optional' },
            { key: 'EDITOR_AGENT_CONCURRENCY', label: 'Editor agent workers', kind: 'number', importance: 'optional' },
            { key: 'SCOUT_LAB_BATCH_SCENE_TIMEOUT_MS', label: 'Scout lab scene timeout', kind: 'number', importance: 'optional' },
        ],
    },
    {
        id: 'legacy-watch',
        title: 'Legacy Watchlist',
        description: 'Old providers. If these appear in .env they are visible here so they do not hide in the system.',
        fields: [
            { key: 'NVIDIA_API_KEY', label: 'NVIDIA key', kind: 'secret', importance: 'optional', legacy: true },
            { key: 'NVIDIA_API_KEYS', label: 'NVIDIA key pool', kind: 'secret-list', importance: 'optional', legacy: true },
            { key: 'GEMINI_MODEL', label: 'Gemini model', kind: 'text', importance: 'optional', legacy: true },
            { key: 'GEMINI_THINKING', label: 'Gemini thinking', kind: 'toggle', importance: 'optional', legacy: true },
            { key: 'GOOGLE_APPLICATION_CREDENTIALS', label: 'Google credentials', kind: 'path', importance: 'optional', legacy: true },
        ],
    },
];

const CLOUD_ACCOUNT_DEFS = {
    bedrock: {
        id: 'bedrock',
        title: 'AWS Bedrock Accounts',
        envPrefix: 'BEDROCK',
        activeKey: 'BEDROCK_ACTIVE_ACCOUNT',
        note: 'The active slot is copied into the normal BEDROCK_* variables used by the real build.',
        fields: [
            { suffix: 'REGION', canonical: 'BEDROCK_REGION', label: 'Region', kind: 'text', required: true, defaultValue: 'us-east-1' },
            { suffix: 'ACCESS_KEY_ID', canonical: 'BEDROCK_ACCESS_KEY_ID', label: 'Access key ID', kind: 'secret', required: true },
            { suffix: 'SECRET_ACCESS_KEY', canonical: 'BEDROCK_SECRET_ACCESS_KEY', label: 'Secret access key', kind: 'secret', required: true },
            { suffix: 'DIRECTOR_MODEL', canonical: 'BEDROCK_DIRECTOR_MODEL', label: 'Director model', kind: 'text' },
            { suffix: 'PLANNER_MODEL', canonical: 'BEDROCK_PLANNER_MODEL', label: 'Planner / VP model', kind: 'text' },
            { suffix: 'UTILITY_MODEL', canonical: 'BEDROCK_UTILITY_MODEL', label: 'Utility model', kind: 'text' },
            { suffix: 'FALLBACK_MODEL', canonical: 'BEDROCK_FALLBACK_MODEL', label: 'Text fallback model', kind: 'text' },
            { suffix: 'TASK_TYPES', canonical: 'BEDROCK_TASK_TYPES', label: 'Allowed task types', kind: 'text' },
            { suffix: 'VISION_NOVA_MODEL', canonical: 'BEDROCK_VISION_NOVA_MODEL', label: 'Vision fallback: Nova', kind: 'text' },
            { suffix: 'VISION_QWEN_MODEL', canonical: 'BEDROCK_VISION_QWEN_MODEL', label: 'Vision fallback: Qwen VL', kind: 'text' },
            { suffix: 'VISION_CLAUDE_MODEL', canonical: 'BEDROCK_VISION_CLAUDE_MODEL', label: 'Vision fallback: Claude', kind: 'text' },
        ],
    },
    azure: {
        id: 'azure',
        title: 'Azure AI Accounts',
        envPrefix: 'AZURE',
        activeKey: 'AZURE_ACTIVE_ACCOUNT',
        note: 'The active slot is copied into Azure Claude and Azure OpenAI variables used by the Sonnet-tier router.',
        fields: [
            { suffix: 'ANTHROPIC_BASE_URL', canonical: 'AZURE_ANTHROPIC_BASE_URL', label: 'Claude base URL', kind: 'text' },
            { suffix: 'API_KEY', canonical: 'AZURE_API_KEY', label: 'API key', kind: 'secret', required: true },
            { suffix: 'CLAUDE_MODEL', canonical: 'AZURE_CLAUDE_MODEL', label: 'Claude deployment/model', kind: 'text', defaultValue: 'claude-sonnet-4-6' },
            { suffix: 'TASK_TYPES', canonical: 'AZURE_TASK_TYPES', label: 'Allowed task types', kind: 'text' },
            { suffix: 'OPENAI_ENDPOINT', canonical: 'AZURE_OPENAI_ENDPOINT', label: 'OpenAI-compatible endpoint', kind: 'text' },
            { suffix: 'OPENAI_MODEL', canonical: 'AZURE_OPENAI_MODEL', label: 'OpenAI-compatible deployment/model', kind: 'text', defaultValue: 'grok-4.3' },
            { suffix: 'OPENAI_TASK_TYPES', canonical: 'AZURE_OPENAI_TASK_TYPES', label: 'OpenAI-compatible task types', kind: 'text' },
            { suffix: 'TIMEOUT_MS', canonical: 'AZURE_TIMEOUT_MS', label: 'Timeout ms', kind: 'text' },
            { suffix: 'OPENAI_TIMEOUT_MS', canonical: 'AZURE_OPENAI_TIMEOUT_MS', label: 'OpenAI-compatible timeout ms', kind: 'text' },
        ],
    },
};

function _resourceEnvPath() {
    return path.join(APP_ROOT, '.env');
}

function _backupEnvFile(envPath, reason = 'resource-edit') {
    if (!fs.existsSync(envPath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(path.dirname(envPath), `.env.backup-${reason}-${stamp}`);
    fs.copyFileSync(envPath, backupPath);
    return backupPath;
}

function _parseEnvContent(content) {
    const lines = String(content || '').split(/\r?\n/);
    const entries = [];
    const byKey = new Map();
    const duplicates = [];
    const keyCounts = new Map();
    lines.forEach((raw, index) => {
        const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!match) return;
        const key = match[1].trim();
        const value = String(match[2] || '').trim();
        const entry = { key, value, line: index + 1, raw };
        entries.push(entry);
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
        if (byKey.has(key)) {
            duplicates.push({ key, firstLine: byKey.get(key).line, line: index + 1 });
            return;
        }
        byKey.set(key, entry);
    });
    return { lines, entries, byKey, duplicates, keyCounts };
}

function _readParsedEnvForResources() {
    const envPath = _resourceEnvPath();
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    return { envPath, content, ..._parseEnvContent(content) };
}

function _unquoteEnvValue(value) {
    let next = String(value || '').trim();
    if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
        next = next.slice(1, -1);
    }
    return next;
}

function _isTruthyEnvValue(value) {
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function _resourcePathExists(rawValue) {
    const value = _unquoteEnvValue(rawValue);
    if (!value) return false;
    const candidates = [
        value,
        path.resolve(APP_ROOT, value),
        path.resolve(PROJECT_DIR, value),
    ];
    return candidates.some(candidate => {
        try { return fs.existsSync(candidate); } catch (_) { return false; }
    });
}

function _fieldIsSecret(field) {
    return field.kind === 'secret' || field.kind === 'secret-list' || /(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(field.key);
}

function _maskListForResource(raw) {
    const keys = _parseEnvListForUi(_unquoteEnvValue(raw));
    return {
        count: keys.length,
        masked: keys.map(key => _maskSecretForUi(key)),
        tails: keys.map(key => key.slice(-6)),
    };
}

function _resourceFieldStatus(field, parsed) {
    const entry = parsed.byKey.get(field.key);
    const exists = !!entry;
    const raw = exists ? _unquoteEnvValue(entry.value) : '';
    const isEmpty = !String(raw).trim();
    const isSecret = _fieldIsSecret(field);
    const list = field.kind === 'secret-list' ? _maskListForResource(raw) : null;
    const pathExists = field.kind === 'path' && !isEmpty ? _resourcePathExists(raw) : null;
    let status = 'missing';
    if (exists && isEmpty) status = field.importance === 'required' ? 'bad' : 'empty';
    else if (exists && field.kind === 'toggle') status = _isTruthyEnvValue(raw) ? 'on' : 'off';
    else if (exists && pathExists === false) status = field.importance === 'required' || field.importance === 'recommended' ? 'warn' : 'missing-path';
    else if (exists) status = field.legacy ? 'legacy' : 'ok';
    else if (field.defaultValue) status = 'default';
    else if (field.future) status = 'future';

    let displayValue = raw;
    if (field.kind === 'secret-list') {
        displayValue = list.count ? `${list.count} key${list.count === 1 ? '' : 's'} (${list.tails.join(', ')})` : '';
    } else if (isSecret) {
        displayValue = _maskSecretForUi(raw);
    }

    return {
        ...field,
        exists,
        line: entry?.line || null,
        empty: isEmpty,
        secret: isSecret,
        status,
        displayValue,
        editableValue: isSecret ? '' : raw,
        placeholder: isSecret && raw ? `${displayValue} - paste replacement to change` : '',
        list,
        pathExists,
        duplicateCount: parsed.keyCounts.get(field.key) || 0,
    };
}

function _resourceGroupStatus(fields) {
    const bad = fields.some(field => field.status === 'bad');
    const warn = fields.some(field => ['warn', 'legacy'].includes(field.status));
    const hasAny = fields.some(field => field.exists && !field.empty);
    if (bad) return 'bad';
    if (warn) return 'warn';
    if (hasAny) return 'ok';
    return 'empty';
}

function _getResourceEnvStatus() {
    const parsed = _readParsedEnvForResources();
    const knownKeys = new Set();
    const groups = RESOURCE_ENV_GROUPS.map(group => {
        const fields = group.fields.map(field => {
            knownKeys.add(field.key);
            return _resourceFieldStatus(field, parsed);
        });
        return {
            id: group.id,
            title: group.title,
            description: group.description,
            status: _resourceGroupStatus(fields),
            fields,
        };
    });
    for (const entry of parsed.entries) {
        if (/^(BEDROCK|AZURE)_ACTIVE_ACCOUNT$/.test(entry.key) || /^(BEDROCK|AZURE)_ACCOUNT_\d+_/.test(entry.key)) {
            knownKeys.add(entry.key);
        }
    }

    const unmatched = parsed.entries
        .filter(entry => !knownKeys.has(entry.key))
        .map(entry => ({
            key: entry.key,
            line: entry.line,
            empty: !_unquoteEnvValue(entry.value),
            secret: /(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(entry.key),
            displayValue: /(?:KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL)/.test(entry.key)
                ? _maskSecretForUi(_unquoteEnvValue(entry.value))
                : _unquoteEnvValue(entry.value),
        }));

    const cleanupSuggestions = [];
    if (parsed.duplicates.length) {
        cleanupSuggestions.push(`${parsed.duplicates.length} duplicate env line(s) can be removed safely.`);
    }
    const legacyPresent = groups.find(g => g.id === 'legacy-watch')?.fields.filter(f => f.exists && !f.empty) || [];
    if (legacyPresent.length) {
        cleanupSuggestions.push(`${legacyPresent.length} legacy provider setting(s) are still present.`);
    }
    const intentionalEmpty = groups.flatMap(g => g.fields).filter(f => f.exists && f.empty && f.importance !== 'required');
    if (intentionalEmpty.length) {
        cleanupSuggestions.push(`${intentionalEmpty.length} empty optional/default setting(s) are present. These are kept unless you clear/remove them manually.`);
    }

    return {
        success: true,
        envPath: parsed.envPath,
        projectEnvPath: path.join(PROJECT_DIR, '.env'),
        appRoot: APP_ROOT,
        projectDir: PROJECT_DIR,
        updatedAt: new Date().toISOString(),
        groups,
        unmatched,
        duplicates: parsed.duplicates,
        cleanupSuggestions,
    };
}

function _escapeRegexLiteral(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _setEnvValueInContent(content, key, value) {
    const cleanKey = String(key || '').trim();
    const cleanValue = String(value ?? '');
    const regex = new RegExp(`^\\s*${_escapeRegexLiteral(cleanKey)}\\s*=.*$`, 'm');
    const line = `${cleanKey}=${cleanValue}`;
    if (regex.test(content)) return content.replace(regex, line);
    return `${String(content || '').replace(/\s*$/, '')}\n${line}\n`;
}

function _removeEnvKeyFromContent(content, key) {
    const regex = new RegExp(`^\\s*${_escapeRegexLiteral(key)}\\s*=.*(?:\\r?\\n)?`, 'gm');
    return String(content || '').replace(regex, '');
}

function _cloudProviderDef(provider) {
    const id = String(provider || '').trim().toLowerCase();
    if (!CLOUD_ACCOUNT_DEFS[id]) throw new Error(`Unknown cloud account provider: ${provider}`);
    return CLOUD_ACCOUNT_DEFS[id];
}

function _cloudSlotEnvKey(def, slotId, suffix) {
    return `${def.envPrefix}_ACCOUNT_${Number(slotId)}_${suffix}`;
}

function _cloudActiveSlotId(def, parsed) {
    const raw = _unquoteEnvValue(parsed.byKey.get(def.activeKey)?.value || '');
    const n = parseInt(raw || '1', 10);
    return Number.isFinite(n) && n > 0 ? String(n) : '1';
}

function _cloudSlotIds(def, parsed) {
    const ids = new Set();
    const re = new RegExp(`^${def.envPrefix}_ACCOUNT_(\\d+)_`);
    for (const entry of parsed.entries || []) {
        const match = entry.key.match(re);
        if (match) ids.add(match[1]);
    }
    return [...ids].sort((a, b) => Number(a) - Number(b));
}

function _cloudCanonicalValue(parsed, field) {
    const value = parsed.byKey.get(field.canonical)?.value;
    if (value == null || value === '') return field.defaultValue || '';
    return _unquoteEnvValue(value);
}

function _cloudSlotStoredValue(parsed, def, slotId, suffix) {
    const value = parsed.byKey.get(_cloudSlotEnvKey(def, slotId, suffix))?.value;
    return value == null ? null : _unquoteEnvValue(value);
}

function _cloudFieldForUi(parsed, def, slotId, field, useCanonicalFallback) {
    let raw = _cloudSlotStoredValue(parsed, def, slotId, field.suffix);
    if (raw == null && useCanonicalFallback) raw = _cloudCanonicalValue(parsed, field);
    if (raw == null) raw = field.defaultValue || '';
    const empty = !String(raw || '').trim();
    const secret = field.kind === 'secret';
    return {
        suffix: field.suffix,
        canonical: field.canonical,
        label: field.label,
        kind: field.kind || 'text',
        required: field.required === true,
        secret,
        secretSet: secret && !empty,
        status: field.required && empty ? 'bad' : empty ? 'empty' : 'ok',
        displayValue: secret ? _maskSecretForUi(raw) : raw,
        editableValue: secret ? '' : raw,
        placeholder: secret && raw ? `${_maskSecretForUi(raw)} - paste replacement` : '',
    };
}

function _cloudSlotStatus(fields) {
    if (fields.some(field => field.status === 'bad')) return 'bad';
    if (fields.some(field => field.status === 'ok')) return 'ok';
    return 'empty';
}

function _getCloudAccountStatus() {
    const parsed = _readParsedEnvForResources();
    const providers = Object.values(CLOUD_ACCOUNT_DEFS).map(def => {
        const activeSlotId = _cloudActiveSlotId(def, parsed);
        let ids = _cloudSlotIds(def, parsed);
        const hasStoredSlots = ids.length > 0;
        if (!ids.includes(activeSlotId)) ids.push(activeSlotId);
        if (!ids.length) ids = ['1'];
        ids = [...new Set(ids)].sort((a, b) => Number(a) - Number(b));

        const slots = ids.map(id => {
            const label = _cloudSlotStoredValue(parsed, def, id, 'LABEL') || (hasStoredSlots ? `${def.title.replace(/ Accounts$/, '')} ${id}` : 'Current .env account');
            const useCanonicalFallback = id === activeSlotId || (!hasStoredSlots && id === '1');
            const fields = {};
            for (const field of def.fields) {
                fields[field.suffix] = _cloudFieldForUi(parsed, def, id, field, useCanonicalFallback);
            }
            const fieldList = Object.values(fields);
            const canonicalApplied = id === activeSlotId && def.fields.every(field => {
                const slotVal = fields[field.suffix]?.displayValue || '';
                const canonicalRaw = _cloudCanonicalValue(parsed, field);
                const canonicalDisplay = field.kind === 'secret' ? _maskSecretForUi(canonicalRaw) : canonicalRaw;
                return String(slotVal || '') === String(canonicalDisplay || '');
            });
            return {
                id,
                label,
                active: id === activeSlotId,
                virtual: !hasStoredSlots && id === '1',
                canonicalApplied,
                status: _cloudSlotStatus(fieldList),
                fields,
            };
        });

        return {
            id: def.id,
            title: def.title,
            note: def.note,
            activeSlotId,
            activeKey: def.activeKey,
            fields: def.fields,
            slots,
        };
    });
    return { success: true, envPath: parsed.envPath, updatedAt: new Date().toISOString(), providers };
}

function _cloudPayloadFieldValue(parsed, def, slotId, field, payloadField = {}) {
    if (payloadField.clear === true) return '';
    if (payloadField.keep === true) {
        const stored = _cloudSlotStoredValue(parsed, def, slotId, field.suffix);
        if (stored != null) return stored;
        return _cloudCanonicalValue(parsed, field);
    }
    const value = String(payloadField.value ?? '').trim();
    return value || '';
}

function _normalizeCloudSlotsPayload(providerPayload = {}) {
    const slots = Array.isArray(providerPayload.slots) ? providerPayload.slots : [];
    const normalized = [];
    const seen = new Set();
    for (const slot of slots) {
        const idNum = parseInt(slot?.id, 10);
        if (!Number.isFinite(idNum) || idNum <= 0 || idNum > 99 || seen.has(idNum)) continue;
        seen.add(idNum);
        normalized.push({ ...slot, id: String(idNum) });
    }
    normalized.sort((a, b) => Number(a.id) - Number(b.id));
    return normalized;
}

function _resolvedCloudSlotFromPayload(parsed, def, slotPayload) {
    const slotId = String(slotPayload.id || '1');
    const fields = {};
    for (const field of def.fields) {
        fields[field.suffix] = _cloudPayloadFieldValue(parsed, def, slotId, field, slotPayload.fields?.[field.suffix] || {});
    }
    return {
        id: slotId,
        label: String(slotPayload.label || '').trim() || `${def.title.replace(/ Accounts$/, '')} ${slotId}`,
        fields,
    };
}

function _applyCloudAccountSlots(payload = {}) {
    const envPath = _resourceEnvPath();
    const parsed = _readParsedEnvForResources();
    let content = parsed.content || '';
    const changedKeys = [];
    const providerPayloads = payload.providers && typeof payload.providers === 'object' ? payload.providers : {};

    for (const [providerId, providerPayload] of Object.entries(providerPayloads)) {
        const def = _cloudProviderDef(providerId);
        const slots = _normalizeCloudSlotsPayload(providerPayload);
        if (!slots.length) continue;
        const activeRequested = String(providerPayload.activeSlotId || slots[0].id);
        const activeSlotId = slots.some(slot => slot.id === activeRequested) ? activeRequested : slots[0].id;
        const resolvedSlots = slots.map(slot => _resolvedCloudSlotFromPayload(parsed, def, slot));

        const slotLineRe = new RegExp(`^\\s*${_escapeRegexLiteral(def.envPrefix)}_ACCOUNT_\\d+_[A-Za-z0-9_]+\\s*=.*(?:\\r?\\n)?`, 'gm');
        content = String(content || '').replace(slotLineRe, '');
        content = _removeEnvKeyFromContent(content, def.activeKey);

        content = _setEnvValueInContent(content, def.activeKey, activeSlotId);
        changedKeys.push(def.activeKey);
        for (const slot of resolvedSlots) {
            const labelKey = _cloudSlotEnvKey(def, slot.id, 'LABEL');
            content = _setEnvValueInContent(content, labelKey, slot.label);
            changedKeys.push(labelKey);
            for (const field of def.fields) {
                const envKey = _cloudSlotEnvKey(def, slot.id, field.suffix);
                content = _setEnvValueInContent(content, envKey, slot.fields[field.suffix] || '');
                changedKeys.push(envKey);
            }
        }

        const active = resolvedSlots.find(slot => slot.id === activeSlotId) || resolvedSlots[0];
        for (const field of def.fields) {
            content = _setEnvValueInContent(content, field.canonical, active.fields[field.suffix] || '');
            process.env[field.canonical] = active.fields[field.suffix] || '';
            changedKeys.push(field.canonical);
        }
        process.env[def.activeKey] = activeSlotId;
    }

    fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
    for (const key of changedKeys) {
        const parsedAgain = _parseEnvContent(content);
        const value = parsedAgain.byKey.get(key)?.value;
        if (value != null) process.env[key] = _unquoteEnvValue(value);
    }
    for (const mod of ['./src/config', './src/ai-provider']) {
        try { delete require.cache[require.resolve(mod)]; } catch (_) {}
    }
    return {
        changedKeys: [...new Set(changedKeys)],
        runtimeConfigRefreshed: true,
        ..._getCloudAccountStatus(),
    };
}

function _applyResourceEnvEdits(envPath, updates = {}, removals = []) {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const changedKeys = [];
    for (const key of removals || []) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ''))) continue;
        content = _removeEnvKeyFromContent(content, key);
        delete process.env[key];
        changedKeys.push(key);
    }
    for (const [key, value] of Object.entries(updates || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key || ''))) continue;
        content = _setEnvValueInContent(content, key, value);
        process.env[key] = String(value ?? '');
        changedKeys.push(key);
    }
    fs.writeFileSync(envPath, content.trim() + '\n', 'utf8');
    const qwenChanged = changedKeys.some(key => String(key).startsWith('QWEN_'));
    const runtimeConfigChanged = changedKeys.some(key => /^(AI_PROVIDER|BEDROCK_|AZURE_|QWEN_|BRAVE_|TAVILY_|YTDLP_|STORYBLOCKS_|MEDIA_|FOOTAGE_|IMAGE_|CLIP_ANALYZER_|VISION_)/.test(String(key)));
    if (runtimeConfigChanged) {
        for (const mod of ['./src/config', './src/ai-provider']) {
            try { delete require.cache[require.resolve(mod)]; } catch (_) {}
        }
    }
    if (qwenChanged && fs.existsSync(_qwenExhaustedPath)) {
        fs.unlinkSync(_qwenExhaustedPath);
    }
    return { changedKeys: [...new Set(changedKeys)], qwenTrackingReset: qwenChanged, runtimeConfigRefreshed: runtimeConfigChanged };
}

function _cleanResourceEnvFile(envPath) {
    const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const lines = content.split(/\r?\n/);
    const seen = new Set();
    const removed = [];
    const next = [];
    for (const raw of lines) {
        const trimmedLine = raw.replace(/[ \t]+$/g, '');
        const match = trimmedLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (!match) {
            next.push(trimmedLine);
            continue;
        }
        const key = match[1].trim();
        if (seen.has(key)) {
            removed.push(key);
            continue;
        }
        seen.add(key);
        next.push(trimmedLine);
    }
    const normalized = next.join('\n').replace(/\n{4,}/g, '\n\n\n').trim() + '\n';
    fs.writeFileSync(envPath, normalized, 'utf8');
    return { removedDuplicates: removed };
}

function _withTimeout(promise, timeoutMs, label) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label || 'check'} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function _checkResult(id, title, status, detail = '') {
    return { id, title, status, detail };
}

async function _checkBedrockAccountValues(values = {}, timeoutMs = 9000, title = 'AWS Bedrock') {
    const region = values.REGION || process.env.BEDROCK_REGION || 'us-east-1';
    const accessKeyId = values.ACCESS_KEY_ID || process.env.BEDROCK_ACCESS_KEY_ID || '';
    const secretAccessKey = values.SECRET_ACCESS_KEY || process.env.BEDROCK_SECRET_ACCESS_KEY || '';
    const modelId = values.UTILITY_MODEL || values.DIRECTOR_MODEL || process.env.BEDROCK_UTILITY_MODEL || process.env.BEDROCK_DIRECTOR_MODEL || '';
    if (!accessKeyId || !secretAccessKey || !modelId) {
        return _checkResult('bedrock', title, 'warn', 'Missing access key, secret key, or model ID.');
    }
    try {
        const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
        const client = new BedrockRuntimeClient({ region, credentials: { accessKeyId, secretAccessKey } });
        const t0 = Date.now();
        const res = await _withTimeout(client.send(new ConverseCommand({
            modelId,
            messages: [{ role: 'user', content: [{ text: 'Reply with exactly OK.' }] }],
            inferenceConfig: { maxTokens: 12 },
        })), timeoutMs, title);
        const elapsed = Date.now() - t0;
        const usage = res?.usage ? ` input=${res.usage.inputTokens || 0} output=${res.usage.outputTokens || 0}` : '';
        return _checkResult('bedrock', title, 'ok', `${modelId} responded in ${(elapsed / 1000).toFixed(1)}s.${usage}`);
    } catch (e) {
        return _checkResult('bedrock', title, 'bad', e.message || String(e));
    }
}

async function _checkBedrockResource(timeoutMs) {
    return _checkBedrockAccountValues({}, timeoutMs, 'AWS Bedrock');
}

async function _checkBraveResource(timeoutMs) {
    const apiKey = process.env.BRAVE_API_KEY || '';
    if (!apiKey) return _checkResult('brave', 'Brave Images', 'warn', 'BRAVE_API_KEY is empty.');
    try {
        const url = new URL('https://api.search.brave.com/res/v1/images/search');
        url.searchParams.set('q', 'test image');
        url.searchParams.set('count', '1');
        url.searchParams.set('safesearch', 'strict');
        const fetchFn = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
        const res = await _withTimeout(fetchFn(url, {
            headers: {
                Accept: 'application/json',
                'X-Subscription-Token': apiKey,
            },
        }), timeoutMs, 'Brave Images');
        if (!res.ok) {
            return _checkResult('brave', 'Brave Images', res.status === 429 ? 'warn' : 'bad', `HTTP ${res.status}`);
        }
        const json = await res.json().catch(() => ({}));
        const count = Array.isArray(json?.results) ? json.results.length : 0;
        return _checkResult('brave', 'Brave Images', 'ok', `API reachable; ${count} sample result(s).`);
    } catch (e) {
        return _checkResult('brave', 'Brave Images', 'bad', e.message || String(e));
    }
}

function _azureAnthropicBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/anthropic$/i.test(raw)) return raw;
    if (/\/anthropic\/v1\/messages$/i.test(raw)) return raw.replace(/\/v1\/messages$/i, '');
    if (/\/openai\/v1$/i.test(raw)) return raw.replace(/\/openai\/v1$/i, '/anthropic');
    if (/\.services\.ai\.azure\.com\/api\/projects\//i.test(raw)) return raw.replace(/\/api\/projects\/.*$/i, '/anthropic');
    if (/\.services\.ai\.azure\.com$/i.test(raw)) return `${raw}/anthropic`;
    if (/\.openai\.azure\.com$/i.test(raw)) return raw.replace(/\.openai\.azure\.com$/i, '.services.ai.azure.com/anthropic');
    return raw;
}

function _azureOpenAIBaseUrl(value = '') {
    const raw = String(value || '').trim().replace(/\/+$/, '');
    if (!raw) return '';
    if (/\/chat\/completions$/i.test(raw)) return raw.replace(/\/chat\/completions$/i, '');
    if (/\/openai\/v1$/i.test(raw)) return raw;
    if (/\.openai\.azure\.com$/i.test(raw)) return `${raw}/openai/v1`;
    if (/\.services\.ai\.azure\.com\/api\/projects\//i.test(raw)) return raw.replace(/\/api\/projects\/.*$/i, '/openai/v1');
    if (/\.services\.ai\.azure\.com$/i.test(raw)) return `${raw}/openai/v1`;
    return raw;
}

function _checkAzureResource() {
    const apiKey = process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || '';
    if (!apiKey) return _checkResult('azure', 'Azure AI', 'warn', 'Incomplete: missing API key.');
    const routes = [];
    if (process.env.AZURE_ANTHROPIC_BASE_URL && process.env.AZURE_CLAUDE_MODEL) routes.push(`Claude:${process.env.AZURE_CLAUDE_MODEL}`);
    if (process.env.AZURE_OPENAI_ENDPOINT && (process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT)) {
        routes.push(`OpenAI:${process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT}`);
    }
    if (!routes.length) {
        return _checkResult('azure', 'Azure AI', 'warn', 'Incomplete: set either Claude base+model or OpenAI endpoint+model.');
    }
    return _checkResult('azure', 'Azure AI', 'ok', `Configured routes: ${routes.join(', ')}.`);
}

async function _checkAzureAccountValues(values = {}, timeoutMs = 9000, title = 'Azure AI') {
    const apiKey = values.API_KEY || process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || '';
    const openAIEndpoint = String(values.OPENAI_ENDPOINT || values.ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT || '').replace(/\/+$/, '');
    const openAIModel = values.OPENAI_MODEL || values.OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || '';
    const claudeEndpoint = String(values.ANTHROPIC_BASE_URL || values.CLAUDE_BASE_URL || process.env.AZURE_ANTHROPIC_BASE_URL || '').replace(/\/+$/, '');
    const claudeDeployment = values.CLAUDE_MODEL || values.DEPLOYMENT || process.env.AZURE_CLAUDE_MODEL || 'claude-sonnet-4-6';
    const apiVersion = values.ANTHROPIC_VERSION || process.env.AZURE_ANTHROPIC_VERSION || '2023-06-01';
    if (!apiKey) {
        return _checkResult('azure', title, 'warn', 'Incomplete slot: missing API key.');
    }
    if (openAIEndpoint && openAIModel) {
        try {
            const fetchFn = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
            const url = `${_azureOpenAIBaseUrl(openAIEndpoint)}/chat/completions`;
            const t0 = Date.now();
            const res = await _withTimeout(fetchFn(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': apiKey,
                },
                body: JSON.stringify({
                    model: openAIModel,
                    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
                    max_tokens: 8,
                }),
            }), timeoutMs, title);
            const elapsed = Date.now() - t0;
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                return _checkResult('azure', title, 'bad', `OpenAI HTTP ${res.status}${body ? ` - ${body.slice(0, 180)}` : ''}`);
            }
            return _checkResult('azure', title, 'ok', `${openAIModel} responded in ${(elapsed / 1000).toFixed(1)}s.`);
        } catch (e) {
            return _checkResult('azure', title, 'bad', e.message || String(e));
        }
    }
    if (!claudeEndpoint || !claudeDeployment) {
        return _checkResult('azure', title, 'warn', 'Incomplete slot: set either OpenAI endpoint+model or Claude base+model.');
    }
    try {
        const fetchFn = typeof fetch === 'function' ? fetch : net.fetch.bind(net);
        const url = `${_azureAnthropicBaseUrl(claudeEndpoint)}/v1/messages`;
        const t0 = Date.now();
        const res = await _withTimeout(fetchFn(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': apiVersion,
            },
            body: JSON.stringify({
                model: claudeDeployment,
                messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
                max_tokens: 8,
                stream: false,
            }),
        }), timeoutMs, title);
        const elapsed = Date.now() - t0;
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return _checkResult('azure', title, 'bad', `HTTP ${res.status}${body ? ` - ${body.slice(0, 180)}` : ''}`);
        }
        return _checkResult('azure', title, 'ok', `${claudeDeployment} responded in ${(elapsed / 1000).toFixed(1)}s.`);
    } catch (e) {
        return _checkResult('azure', title, 'bad', e.message || String(e));
    }
}

function _cloudSlotPayloadValues(provider, slotPayload = {}) {
    const def = _cloudProviderDef(provider);
    const parsed = _readParsedEnvForResources();
    const slotId = String(slotPayload.id || slotPayload.slotId || _cloudActiveSlotId(def, parsed));
    const resolved = _resolvedCloudSlotFromPayload(parsed, def, {
        id: slotId,
        label: slotPayload.label || '',
        fields: slotPayload.fields || {},
    });
    return { def, slotId, values: resolved.fields, label: resolved.label };
}

async function _checkCloudAccountSlot(provider, slotPayload = {}, timeoutMs = 9000) {
    const { def, slotId, values, label } = _cloudSlotPayloadValues(provider, slotPayload);
    const title = `${def.title.replace(/ Accounts$/, '')} ${slotId}${label ? ` - ${label}` : ''}`;
    if (def.id === 'bedrock') return _checkBedrockAccountValues(values, timeoutMs, title);
    if (def.id === 'azure') return _checkAzureAccountValues(values, timeoutMs, title);
    return _checkResult(def.id, title, 'warn', 'No checker is wired for this provider.');
}

function _checkLocalResourcePaths() {
    const checks = [];
    const ytdlpPath = process.env.YTDLP_PATH || '';
    checks.push(_checkResult(
        'ytdlp',
        'yt-dlp',
        ytdlpPath && _resourcePathExists(ytdlpPath) ? 'ok' : 'warn',
        ytdlpPath ? (_resourcePathExists(ytdlpPath) ? 'Executable found.' : 'Configured path was not found.') : 'YTDLP_PATH is empty.'
    ));

    const cookies = process.env.YTDLP_COOKIES_FILE || '';
    checks.push(_checkResult(
        'youtube-cookies',
        'YouTube cookies',
        cookies && _resourcePathExists(cookies) ? 'ok' : 'warn',
        cookies ? (_resourcePathExists(cookies) ? 'Cookie file found.' : 'Configured cookie file was not found.') : 'YTDLP_COOKIES_FILE is empty.'
    ));

    const storyblocksCookie = process.env.STORYBLOCKS_COOKIE_FILE || '.storyblocks-cookies.json';
    checks.push(_checkResult(
        'storyblocks',
        'Storyblocks',
        (process.env.STORYBLOCKS_SUBSCRIBED === '1' || process.env.STORYBLOCKS_SUBSCRIBED === 'true') ? 'ok' : 'warn',
        `${_resourcePathExists(storyblocksCookie) ? 'Cookie file found' : 'Cookie file not found'}; subscribed=${process.env.STORYBLOCKS_SUBSCRIBED || 'unset'}.`
    ));
    return checks;
}

async function _runResourceLiveChecks(options = {}) {
    const changedKeys = Array.isArray(options.changedKeys) ? options.changedKeys : [];
    const force = options.force === true;
    const timeoutMs = Math.max(4000, Math.min(20000, Number(options.timeoutMs || 9000) || 9000));
    const checks = [];
    checks.push(..._checkLocalResourcePaths());
    const changed = (prefixes) => force || changedKeys.some(key => prefixes.some(prefix => String(key).startsWith(prefix)));
    const changedOnly = (prefixes) => changedKeys.some(key => prefixes.some(prefix => String(key).startsWith(prefix)));
    if (changed(['BEDROCK_', 'AI_PROVIDER'])) checks.push(await _checkBedrockResource(timeoutMs));
    if (changed(['BRAVE_'])) checks.push(await _checkBraveResource(timeoutMs));
    const azureConfigured = !!(process.env.AZURE_API_KEY || process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_ANTHROPIC_BASE_URL || process.env.AZURE_CLAUDE_MODEL);
    if (changedOnly(['AZURE_']) || (force && azureConfigured)) checks.push(_checkAzureResource());
    if (changed(['QWEN_'])) {
        try {
            const aiProvider = require('./src/brain/ai-provider');
            const status = aiProvider.getQwenVisionStatus();
            checks.push(_checkResult(
                'qwen',
                'Alibaba Qwen Vision',
                Number(status?.image?.available || 0) > 0 || Number(status?.omniHttp?.available || 0) > 0 ? 'ok' : 'warn',
                `Image ${status?.image?.available || 0}/${status?.image?.total || 0}; Omni ${status?.omniHttp?.available || 0}/${status?.omniHttp?.total || 0}. Use Live Probe for real model calls.`
            ));
        } catch (e) {
            checks.push(_checkResult('qwen', 'Alibaba Qwen Vision', 'bad', e.message || String(e)));
        }
    }
    return {
        success: true,
        checkedAt: new Date().toISOString(),
        checks,
        summary: {
            ok: checks.filter(c => c.status === 'ok').length,
            warn: checks.filter(c => c.status === 'warn').length,
            bad: checks.filter(c => c.status === 'bad').length,
        },
    };
}

ipcMain.handle('qwen-pool-status', async () => {
    try {
        if (fs.existsSync(_qwenExhaustedPath)) {
            const data = JSON.parse(fs.readFileSync(_qwenExhaustedPath, 'utf8'));
            // Support role/lane-scoped format ({ text, image, omni }), older
            // role-scoped format ({ text, vision }), multi-key legacy, and old flat format.
            if (data.text || data.image || data.omni || data.vision) {
                let totalExhausted = 0, totalModels = 0;
                for (const roleMap of [data.text || {}, data.image || {}, data.omni || {}, data.vision || {}]) {
                    for (const map of Object.values(roleMap)) {
                        totalExhausted += Object.values(map).filter(v => v === true).length;
                        totalModels += Object.keys(map).length;
                    }
                }
                return { exhausted: totalExhausted, total: totalModels, multiKey: true, roleScoped: true, laneScoped: !!(data.image || data.omni) };
            }
            // Support both old format (flat) and legacy multi-key format (keys: { hash: { ... } })
            if (data.keys) {
                let totalExhausted = 0, totalModels = 0;
                for (const [hash, map] of Object.entries(data.keys)) {
                    totalExhausted += Object.values(map).filter(v => v === true).length;
                    totalModels += Object.keys(map).length;
                }
                return { exhausted: totalExhausted, total: totalModels, multiKey: true };
            }
            const exhausted = Object.values(data).filter(v => v === true).length;
            return { exhausted, total: Object.keys(data).length };
        }
        return { exhausted: 0, total: 0 };
    } catch (e) {
        return { exhausted: 0, total: 0 };
    }
});
ipcMain.handle('qwen-pool-reset', async () => {
    try {
        if (fs.existsSync(_qwenExhaustedPath)) {
            fs.unlinkSync(_qwenExhaustedPath);
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('qwen-vision-keys-status', async () => {
    try {
        return { success: true, ..._qwenVisionKeysForUi() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('qwen-vision-keys-save', async (_event, payload = {}) => {
    try {
        const envPath = path.join(APP_ROOT, '.env');
        let saved;
        if (payload?.lanes && typeof payload.lanes === 'object') {
            const imageKeys = _applyQwenKeyEdit(_resolveQwenLaneKeysForSave(envPath, 'image'), payload.lanes.image || {});
            const omniKeys = _applyQwenKeyEdit(_resolveQwenLaneKeysForSave(envPath, 'omni'), payload.lanes.omni || {});
            updateEnvFileAt(envPath, 'QWEN_IMAGE_API_KEY', imageKeys.join(','));
            updateEnvFileAt(envPath, 'QWEN_VL_API_KEY', '');
            updateEnvFileAt(envPath, 'QWEN_OMNI_API_KEY', omniKeys.join(','));
            process.env.QWEN_IMAGE_API_KEY = imageKeys.join(',');
            process.env.QWEN_VL_API_KEY = '';
            process.env.QWEN_OMNI_API_KEY = omniKeys.join(',');
            saved = { image: imageKeys.length, omni: omniKeys.length };
        } else {
            // Legacy UI payload: edit the shared fallback pool only.
            const sharedKeys = _applyQwenKeyEdit(_resolveQwenLaneKeysForSave(envPath, 'shared'), payload);
            updateEnvFileAt(envPath, 'QWEN_VISION_API_KEY', sharedKeys.join(','));
            process.env.QWEN_VISION_API_KEY = sharedKeys.join(',');
            saved = sharedKeys.length;
        }
        if (fs.existsSync(_qwenExhaustedPath)) {
            fs.unlinkSync(_qwenExhaustedPath);
        }

        const aiProvider = require('./src/brain/ai-provider');
        const status = aiProvider.getQwenVisionStatus();
        return { success: true, saved, clearedTracking: true, status, ..._qwenVisionKeysForUi() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('vision-health-status', async () => {
    try {
        const aiProvider = require('./src/brain/ai-provider');
        return { success: true, status: aiProvider.getQwenVisionStatus() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('vision-health-live-check', async (_event, options = {}) => {
    try {
        const aiProvider = require('./src/brain/ai-provider');
        const imageLimit = Math.max(0, Math.min(4, Number(options.imageLimit || 1) || 1));
        const omniLimit = Math.max(0, Math.min(4, Number(options.omniLimit || 1) || 1));
        const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 3) || 3));
        const timeoutMs = Math.max(5000, Math.min(30000, Number(options.timeoutMs || 12000) || 12000));
        const lanes = Array.isArray(options.lanes) && options.lanes.length
            ? options.lanes.filter(lane => ['image', 'omniHttp', 'omniRealtime'].includes(lane))
            : ['image', 'omniHttp'];
        const probe = await aiProvider.refreshQwenVisionHealth({
            lanes,
            imageLimit,
            omniLimit,
            concurrency,
            timeoutMs
        });
        return { success: true, probe, status: aiProvider.getQwenVisionStatus() };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-status', async () => {
    try {
        return _getResourceEnvStatus();
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-save', async (_event, payload = {}) => {
    try {
        const envPath = _resourceEnvPath();
        const updates = payload?.updates && typeof payload.updates === 'object' ? payload.updates : {};
        const removals = Array.isArray(payload?.removals) ? payload.removals : [];
        const updateCount = Object.keys(updates).length;
        if (!updateCount && !removals.length) {
            return { success: true, changedKeys: [], skipped: true, ..._getResourceEnvStatus() };
        }
        const backupPath = _backupEnvFile(envPath, 'resource-save');
        const editResult = _applyResourceEnvEdits(envPath, updates, removals);
        return {
            success: true,
            backupPath,
            ...editResult,
            ..._getResourceEnvStatus(),
        };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-clean', async () => {
    try {
        const envPath = _resourceEnvPath();
        const backupPath = _backupEnvFile(envPath, 'resource-clean');
        const cleaned = _cleanResourceEnvFile(envPath);
        return {
            success: true,
            backupPath,
            ...cleaned,
            ..._getResourceEnvStatus(),
        };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('resource-env-live-check', async (_event, options = {}) => {
    try {
        return await _runResourceLiveChecks(options || {});
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('cloud-account-slots-status', async () => {
    try {
        return _getCloudAccountStatus();
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('cloud-account-slots-save', async (_event, payload = {}) => {
    try {
        const envPath = _resourceEnvPath();
        const backupPath = _backupEnvFile(envPath, 'cloud-accounts');
        const result = _applyCloudAccountSlots(payload || {});
        return { success: true, backupPath, ...result };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('cloud-account-slot-check', async (_event, payload = {}) => {
    try {
        const provider = payload?.provider || '';
        const slot = payload?.slot || {};
        const timeoutMs = Math.max(4000, Math.min(30000, Number(payload?.timeoutMs || 9000) || 9000));
        const check = await _checkCloudAccountSlot(provider, slot, timeoutMs);
        return { success: true, check };
    } catch (e) {
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('open-footage-resources', async () => {
    createFootageResourcesWindow();
    return { success: true };
});

ipcMain.handle('footage-resources-get', async () => {
    return { success: true, ...footageResourceState };
});

ipcMain.handle('footage-resources-set', async (_event, payload = {}) => {
    footageResourceState = normalizeFootageResourceState(payload || {});
    broadcastFootageResourceState();
    return { success: true, ...footageResourceState };
});

// ============ STYLE LEARNER IPC ============
// Reference video → Gemini multimodal analysis → structured style profile JSON.
// Profiles live under PROJECT_DIR/styles/ and are picked from a dropdown in build settings.

function _styleProfilesDir() {
    const dir = path.join(PROJECT_DIR, 'styles');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

ipcMain.handle('learn-style', async (event, input) => {
    try {
        if (!input || typeof input !== 'string') {
            return { success: false, error: 'No input provided' };
        }
        const styleLearner = require('./src/studio/style-learner');
        const saveDir = _styleProfilesDir();

        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('learn-style-progress', { percent, message });
            }
        };

        const profile = await styleLearner.analyzeStyle(input, {
            saveDir,
            onProgress: sendProgress
        });

        // analyzeStyle attaches savedPath to the returned profile.
        return { success: true, profile, path: profile.savedPath };
    } catch (e) {
        console.error('[learn-style] Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('learn-style-multi', async (event, urls, profileName) => {
    try {
        if (!urls || !Array.isArray(urls) || urls.length === 0) {
            return { success: false, error: 'No URLs provided' };
        }
        const styleLearner = require('./src/studio/style-learner');
        const saveDir = _styleProfilesDir();

        const sendProgress = (percent, message) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('learn-style-progress', { percent, message });
            }
        };

        const profile = await styleLearner.analyzeMultiple(urls, {
            name: profileName || undefined,
            saveDir,
            onProgress: sendProgress,
        });

        return { success: true, profile, path: profile.savedPath };
    } catch (e) {
        console.error('[learn-style-multi] Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

ipcMain.handle('compare-style', async (event, profilePath, videoPlan) => {
    try {
        const styleLearner = require('./src/studio/style-learner');
        const profile = styleLearner.loadStyleProfile(profilePath);
        if (!profile) return { success: false, error: 'Could not load style profile' };
        const report = styleLearner.compareWithBuild(profile, videoPlan);
        const formatted = styleLearner.formatComparison(report);
        return { success: true, report: formatted, data: report };
    } catch (e) {
        console.error('[compare-style] Failed:', e);
        return { success: false, error: e.message || String(e) };
    }
});

// ========================================
// Style Studio Agent — Conversational style analyst
// ========================================
function _sendStudioProgress(window, percent, message) {
    if (window && !window.isDestroyed()) {
        window.webContents.send('style-studio-progress', { percent, message });
    }
}

ipcMain.handle('style-studio-start', async (event, input, options) => {
    try {
        if (!input || typeof input !== 'string') {
            return { error: 'No input provided' };
        }
        const studio = require('./src/studio/style-studio-agent');
        const saveDir = _styleProfilesDir();
        const win = BrowserWindow.fromWebContents(event.sender);

        const result = await studio.startSession(input, {
            saveDir,
            thinkingMode: options?.thinkingMode || 'off',
            codeAccess: options?.codeAccess !== false,
            onProgress: (pct, msg) => _sendStudioProgress(win, pct, msg),
        });
        return result;
    } catch (e) {
        console.error('[style-studio-start] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-add-video', async (event, sessionId, input) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await studio.addVideo(sessionId, input, (pct, msg) =>
            _sendStudioProgress(win, pct, msg));
        return result;
    } catch (e) {
        console.error('[style-studio-add-video] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-chat', async (event, sessionId, message) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const result = await studio.chat(sessionId, message);
        return result;
    } catch (e) {
        console.error('[style-studio-chat] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-analyze-script', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const result = await studio.analyzeScript(sessionId);
        return result;
    } catch (e) {
        console.error('[style-studio-analyze-script] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-extract-profile', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const profile = await studio.extractProfile(sessionId);
        return { profile };
    } catch (e) {
        console.error('[style-studio-extract-profile] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-save-profile', async (event, sessionId, name) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const profile = studio.saveProfile(sessionId, name);
        return { savedPath: profile.savedPath, profile };
    } catch (e) {
        console.error('[style-studio-save-profile] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-end-session', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return await studio.endSession(sessionId);
    } catch (e) {
        console.error('[style-studio-end-session] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-session-info', async (event, sessionId) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return studio.getSessionInfo(sessionId);
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-set-code-access', async (event, sessionId, enabled) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return studio.setCodeAccess(sessionId, enabled);
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// Receive live project settings from the renderer so the agent knows the
// user's video title / niche / AI instructions even before the .fvp is saved.
ipcMain.handle('style-studio-set-project-context', async (event, ctx) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.setLiveProjectContext(ctx || {});
        return { ok: true };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// --- Session Persistence ---

ipcMain.handle('style-studio-check-saved', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const saveDir = _styleProfilesDir();
        const saved = studio.loadSavedSession(saveDir);
        return saved; // null if no saved session
    } catch (e) {
        return null;
    }
});

ipcMain.handle('style-studio-restore', async (event) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const saveDir = _styleProfilesDir();
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await studio.restoreSession(saveDir, (pct, msg) =>
            _sendStudioProgress(win, pct, msg));
        return result;
    } catch (e) {
        console.error('[style-studio-restore] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-discard-saved', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.deleteSavedSession(_styleProfilesDir());
        return { ok: true };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// --- Style Studio Memory ---

ipcMain.handle('style-studio-load-memory', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        return { memories: studio.loadMemory(_styleProfilesDir()) };
    } catch (e) {
        return { memories: [] };
    }
});

ipcMain.handle('style-studio-save-memory', async (event, text, category) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const memories = studio.saveMemoryEntry(_styleProfilesDir(), text, category || 'user-note');
        return { memories };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-delete-memory', async (event, index) => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        const memories = studio.deleteMemoryEntry(_styleProfilesDir(), index);
        return { memories };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-clear-memory', async () => {
    try {
        const studio = require('./src/studio/style-studio-agent');
        studio.clearMemory(_styleProfilesDir());
        return { memories: [] };
    } catch (e) {
        return { error: e.message || String(e) };
    }
});

// --- In-Studio Audio Transcription (Whisper) ---
// Writes to <project>/temp/transcription.json so the Style Studio agent's
// _buildTimestampedTranscriptContext() can pick it up on "plan scenes".

ipcMain.handle('style-studio-pick-audio', async (event) => {
    try {
        const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
        const result = await dialog.showOpenDialog(win, {
            title: 'Choose audio file',
            properties: ['openFile'],
            filters: [
                { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'webm', 'mp4'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return null;
        const audioPath = result.filePaths[0];
        let size = null;
        try { size = fs.statSync(audioPath).size; } catch (_) {}
        return { path: audioPath, name: path.basename(audioPath), size };
    } catch (e) {
        console.error('[style-studio-pick-audio] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-transcribe-audio', async (event, audioPath, options) => {
    try {
        if (!audioPath || typeof audioPath !== 'string') {
            return { error: 'No audio path provided' };
        }
        if (!fs.existsSync(audioPath)) {
            return { error: `Audio file not found: ${audioPath}` };
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        const send = (pct, msg) => {
            if (win && !win.isDestroyed()) {
                win.webContents.send('style-studio-transcribe-progress', { percent: pct, message: msg });
            }
        };

        send(5, 'Loading Whisper…');
        const { transcribeAudio } = require('./src/pipeline/transcribe');
        const result = await transcribeAudio(audioPath, {
            languageHint: options?.languageHint || null
        });
        send(100, 'Transcription complete');

        // transcribeAudio wrote the JSON to <project>/temp/transcription.json
        const config = require('./src/settings/config');
        const outPath = path.join(config.paths.temp, 'transcription.json');
        return {
            ok: true,
            path: outPath,
            duration: result.duration || 0,
            language: result.language || 'unknown',
            segments: (result.segments || []).length,
            text: (result.text || '').slice(0, 2000)
        };
    } catch (e) {
        console.error('[style-studio-transcribe-audio] Failed:', e);
        return { error: e.message || String(e) };
    }
});

ipcMain.handle('style-studio-get-transcript-info', async () => {
    try {
        const config = require('./src/settings/config');
        const p = path.join(config.paths.temp, 'transcription.json');
        if (!fs.existsSync(p)) return { exists: false };
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const st = fs.statSync(p);
        return {
            exists: true,
            path: p,
            duration: j.duration || 0,
            language: j.language || 'unknown',
            segments: (j.segments || []).length,
            mtime: st.mtimeMs
        };
    } catch (e) {
        return { exists: false, error: e.message };
    }
});

// pick-video-file handler is registered later (legacy from style-learner)

ipcMain.handle('scan-style-profiles', async () => {
    try {
        const dir = _styleProfilesDir();
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.style.json'));
        const profiles = [];
        for (const f of files) {
            try {
                const full = path.join(dir, f);
                const json = JSON.parse(fs.readFileSync(full, 'utf8'));
                profiles.push({
                    path: full,
                    name: json.name || f.replace('.style.json', ''),
                    videoDuration: json.videoDuration || null,
                    createdAt: json.createdAt || null
                });
            } catch (e) { /* skip malformed */ }
        }
        // Newest first
        profiles.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        return profiles;
    } catch (e) {
        console.error('[scan-style-profiles] Failed:', e);
        return [];
    }
});

ipcMain.handle('pick-video-file', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose reference video',
            properties: ['openFile'],
            filters: [
                { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v'] },
                { name: 'All files', extensions: ['*'] }
            ]
        });
        if (result.canceled || !result.filePaths.length) return null;
        return result.filePaths[0];
    } catch (e) {
        console.error('[pick-video-file] Failed:', e);
        return null;
    }
});

// Launch a new instance with a new project folder
// options: { projectName, location } — if provided, creates named subfolder
ipcMain.handle('launch-new-instance', async (event, options) => {
    let projectPath;

    if (options && options.projectName && options.location) {
        // Create named subfolder at chosen location
        projectPath = path.join(options.location, options.projectName);
        if (!fs.existsSync(projectPath)) {
            fs.mkdirSync(projectPath, { recursive: true });
        }
    } else {
        // Legacy: just pick a folder
        const result = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose location for new project',
            properties: ['openDirectory', 'createDirectory']
        });
        if (result.canceled || !result.filePaths.length) return { success: false, cancelled: true };
        projectPath = result.filePaths[0];
    }

    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath };
});

// Open an existing project folder in a new instance
ipcMain.handle('open-existing-project', async () => {
    const projectPath = await promptForExistingProjectPath(mainWindow);
    if (!projectPath) return { success: false, cancelled: true };

    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath };
});

// Open existing project by selecting a folder (no mode prompt)
ipcMain.handle('open-existing-project-folder', async () => {
    const folderResult = await dialog.showOpenDialog(mainWindow, {
        title: 'Open existing project folder',
        properties: ['openDirectory']
    });
    if (folderResult.canceled || !folderResult.filePaths.length) return { success: false, cancelled: true };

    const projectPath = folderResult.filePaths[0];
    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath };
});

// Open existing project by selecting a .fvp file (no mode prompt)
ipcMain.handle('open-existing-project-file', async () => {
    const fileResult = await dialog.showOpenDialog(mainWindow, {
        title: 'Open .fvp project file',
        properties: ['openFile'],
        filters: [{ name: 'Project Files', extensions: ['fvp'] }]
    });
    if (fileResult.canceled || !fileResult.filePaths.length) return { success: false, cancelled: true };

    const projectFile = fileResult.filePaths[0];
    const projectPath = path.dirname(projectFile);
    _spawnNewInstance(projectPath);
    return { success: true, projectDir: projectPath, projectFile };
});

function _spawnNewInstance(projectPath) {
    // Spawn a new Electron process with --project= pointing to the chosen folder
    const electronPath = process.argv[0]; // path to electron executable
    const appPath = APP_ROOT;
    const args = [appPath, `--project=${projectPath}`];
    // Also forward --dev flag if active
    if (process.argv.includes('--dev')) args.push('--dev');

    const child = spawn(electronPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: APP_ROOT
    });
    child.unref();
    console.log(`🚀 Launched new instance for project: ${projectPath}`);
}

// ========================================
// Desktop Shortcut & Start Menu
// ========================================
ipcMain.handle('create-desktop-shortcut', async () => {
    if (process.platform !== 'win32') return { success: false, error: 'Windows only' };
    try {
        const desktopDir = path.join(require('os').homedir(), 'Desktop');
        const shortcutPath = path.join(desktopDir, 'YTA Empire WEBGL.lnk');
        const electronExe = process.execPath;
        const icon = getShortcutIconPath();

        // Use PowerShell to create a .lnk shortcut
        const ps = `
$ws = New-Object -ComObject WScript.Shell;
$sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}');
$sc.TargetPath = '${electronExe.replace(/'/g, "''")}';
$sc.Arguments = '"${APP_ROOT.replace(/'/g, "''")}"';
$sc.WorkingDirectory = '${APP_ROOT.replace(/'/g, "''")}';
$sc.IconLocation = '${icon.replace(/'/g, "''")}';
$sc.Description = 'YTA Empire WEBGL - AI Video Generator';
$sc.Save();
        `.trim();

        execSync(`powershell -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { stdio: 'ignore' });
        console.log('✅ Desktop shortcut created:', shortcutPath);
        return { success: true, path: shortcutPath };
    } catch (e) {
        console.error('❌ Failed to create shortcut:', e.message);
        return { success: false, error: e.message };
    }
});

// ========================================
// .fvp File Association (Windows)
// ========================================
// Registers .fvp files to open with this app (HKCU — no admin needed)
function registerFvpFileAssociation() {
    if (process.platform !== 'win32') return { success: false, error: 'Only supported on Windows' };

    try {
        const electronExe = process.execPath; // Full path to electron.exe
        const appDir = APP_ROOT;
        // Icon: use custom .ico if available, otherwise electron.exe
        const iconValue = getShortcutIconPath();

        // Write a .reg file and import it (most reliable way to handle Windows registry quoting)
        // In .reg files: backslash = \\, inner quotes = \"
        const regEsc = (p) => p.replace(/\\/g, '\\\\');
        const regQ = (p) => `\\\"${regEsc(p)}\\\"`;  // Quoted path for .reg value
        const openCmd = `${regQ(electronExe)} ${regQ(appDir)} \\\"%1\\\"`;
        const regContent = [
            'Windows Registry Editor Version 5.00',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\.fvp]',
            '@="FacelessVideoProject"',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject]',
            '@="YTA Empire WEBGL Project"',
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject\\DefaultIcon]',
            `@="${regEsc(iconValue)}"`,
            '',
            '[HKEY_CURRENT_USER\\Software\\Classes\\FacelessVideoProject\\shell\\open\\command]',
            `@="${openCmd}"`,
            ''
        ].join('\r\n');

        const regFile = path.join(APP_ROOT, 'temp', 'fvp-association.reg');
        if (!fs.existsSync(path.dirname(regFile))) fs.mkdirSync(path.dirname(regFile), { recursive: true });
        // .reg files need UTF-16LE BOM to import correctly
        const bom = Buffer.from([0xFF, 0xFE]);
        const content = Buffer.from(regContent, 'utf16le');
        fs.writeFileSync(regFile, Buffer.concat([bom, content]));
        execSync(`reg import "${regFile}"`, { stdio: 'ignore' });
        try { fs.unlinkSync(regFile); } catch (_) { } // Clean up

        console.log('✅ .fvp file association registered');
        return { success: true };
    } catch (e) {
        console.error('❌ Failed to register .fvp file association:', e.message);
        return { success: false, error: e.message };
    }
}

ipcMain.handle('register-fvp-association', async () => {
    return registerFvpFileAssociation();
});

// Auto-register file association + create desktop shortcut on first launch
const fvpRegisteredFlag = path.join(APP_ROOT, '.fvp-registered');
if (process.platform === 'win32' && !fs.existsSync(fvpRegisteredFlag)) {
    try {
        registerFvpFileAssociation();
        // Auto-create desktop shortcut
        const desktopDir = path.join(require('os').homedir(), 'Desktop');
        const shortcutPath = path.join(desktopDir, 'YTA Empire WEBGL.lnk');
        if (!fs.existsSync(shortcutPath)) {
            const electronExe = process.execPath;
            const icon = getShortcutIconPath();
            const ps = `$ws = New-Object -ComObject WScript.Shell; $sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}'); $sc.TargetPath = '${electronExe.replace(/'/g, "''")}'; $sc.Arguments = '""${APP_ROOT.replace(/'/g, "''")}""'; $sc.WorkingDirectory = '${APP_ROOT.replace(/'/g, "''")}'; $sc.IconLocation = '${icon.replace(/'/g, "''")}'; $sc.Description = 'YTA Empire WEBGL'; $sc.Save();`;
            execSync(`powershell -Command "${ps.replace(/"/g, '\\"')}"`, { stdio: 'ignore' });
            console.log('✅ Desktop shortcut created');
        }
        fs.writeFileSync(fvpRegisteredFlag, new Date().toISOString());
    } catch (e) { /* silent fail on first try */ }
}

// ========================================
// Helper Functions
// ========================================

// Brain switch: the AI Provider dropdown value maps onto AI_PROVIDER +
// AILINK_TASK_TYPES. process.env is updated LIVE (render-prep authoring in
// this process + child builds inherit it); .env persists across restarts.
function applyBrainProvider(value) {
    const ailinkBrain = value === 'bedrock-ailink';
    const aplinkBrain = value === 'bedrock-aplink';
    const azureBrain = value === 'bedrock-azure';
    const azureOpenAIBrain = value === 'bedrock-azure-grok' || value === 'bedrock-azure-openai';
    const base = (ailinkBrain || aplinkBrain || azureBrain || azureOpenAIBrain) ? 'bedrock' : String(value || 'bedrock');

    // An alt brain (AiLink GPT-5.5 / APlink Claude-Opus-4-6 / Azure Claude Sonnet / Azure Grok)
    // takes over EXACTLY the
    // Bedrock "Sonnet tier" — the high-reasoning editorial tasks (Visual Planner,
    // Director scene-split, effects/icon/transition directors). The DeepSeek default
    // tier and Haiku utility tier ALWAYS stay on Bedrock, and Bedrock stays the
    // automatic fallback for the alt-routed tasks. Only ONE alt brain runs at a time.
    let sonnetTier = 'brain,planner-outline,planner-large,planner-small';
    let defaultTier = 'bedrock default';
    let plannerTier = 'bedrock planner';
    let utilityTier = 'bedrock utility';
    let fallbackTier = 'bedrock fallback';
    let ailinkModel = 'gpt-5.5';
    let aplinkModel = 'claude-opus-4-6';
    let azureModel = 'claude-sonnet-4-6';
    let azureOpenAIModel = 'grok-4.3';
    let hasAplinkKey = false;
    try {
        const cfg = require('./src/settings/config');
        const tier = cfg?.bedrock?.plannerTaskTypes;
        if (Array.isArray(tier) && tier.length) sonnetTier = tier.join(',');
        if (cfg?.bedrock?.model) defaultTier = `bedrock:${cfg.bedrock.model}`;
        if (cfg?.bedrock?.plannerModel) plannerTier = `bedrock:${cfg.bedrock.plannerModel}`;
        if (cfg?.bedrock?.utilityModel) utilityTier = `bedrock:${cfg.bedrock.utilityModel}`;
        if (cfg?.bedrock?.fallbackModel) fallbackTier = `bedrock:${cfg.bedrock.fallbackModel}`;
        if (cfg?.ailink?.model) ailinkModel = cfg.ailink.model;
        if (cfg?.aplink?.model) aplinkModel = cfg.aplink.model;
        hasAplinkKey = !!cfg?.aplink?.apiKey;
        if (cfg?.azure?.model) azureModel = cfg.azure.model;
        if (cfg?.azureOpenAI?.model) azureOpenAIModel = cfg.azureOpenAI.model;
    } catch (_) {}

    updateEnvFile('AI_PROVIDER', base);
    // Set the chosen alt brain's task gate; clear the other so only one is active.
    updateEnvFile('AILINK_TASK_TYPES', ailinkBrain ? sonnetTier : '');
    updateEnvFile('APLINK_TASK_TYPES', aplinkBrain ? sonnetTier : '');
    updateEnvFile('AZURE_TASK_TYPES', azureBrain ? sonnetTier : '');
    updateEnvFile('AZURE_OPENAI_TASK_TYPES', azureOpenAIBrain ? sonnetTier : '');
    process.env.AI_PROVIDER = base;
    process.env.AILINK_TASK_TYPES = ailinkBrain ? sonnetTier : '';
    process.env.APLINK_TASK_TYPES = aplinkBrain ? sonnetTier : '';
    process.env.AZURE_TASK_TYPES = azureBrain ? sonnetTier : '';
    process.env.AZURE_OPENAI_TASK_TYPES = azureOpenAIBrain ? sonnetTier : '';

    const sonnetOwner = ailinkBrain ? `ailink:${ailinkModel}`
        : aplinkBrain ? `aplink:${aplinkModel}`
        : azureBrain ? `azure-claude:${azureModel}`
        : azureOpenAIBrain ? `azure-openai:${azureOpenAIModel}`
        : plannerTier;
    console.log(`[Brain Router] dropdown=${value || 'bedrock'} base=${base} sonnetTier=${sonnetOwner} tasks=[${sonnetTier}]`);
    console.log(`[Brain Router] default=${defaultTier}; utility=${utilityTier}; fallback=${fallbackTier}; AILINK=${ailinkBrain ? sonnetTier : '(off)'}; APLINK=${aplinkBrain ? sonnetTier : '(off)'}; AZURE_CLAUDE=${azureBrain ? sonnetTier : '(off)'}; AZURE_OPENAI=${azureOpenAIBrain ? sonnetTier : '(off)'}`);
    if ((azureBrain || azureOpenAIBrain) && hasAplinkKey && !/^(0|false|off|no)$/i.test(String(process.env.AZURE_LARGE_PROMPT_APLINK || 'on').trim())) {
        console.log(`[Brain Router] azure-large-detour=aplink:${aplinkModel} tasks=[${process.env.AZURE_LARGE_PROMPT_APLINK_TASKS || 'planner-large'}] fallback=${plannerTier}`);
    }
}

ipcMain.handle('set-ai-provider', (event, value) => {
    try { applyBrainProvider(value); return { success: true }; }
    catch (e) { return { success: false, error: e.message }; }
});

function updateEnvFile(key, value) {
    updateEnvFileAt(path.join(PROJECT_DIR, '.env'), key, value);
}

function updateEnvFileAt(envPath, key, value) {
    try {
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }

        const regex = new RegExp(`^${key}=.*$`, 'm');

        if (regex.test(envContent)) {
            envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
            envContent += `\n${key}=${value}`;
        }

        fs.writeFileSync(envPath, envContent.trim() + '\n');
        console.log(`✅ Updated ${key} in ${path.basename(path.dirname(envPath))}/.env`);
    } catch (error) {
        console.error('Failed to update .env:', error);
    }
}



// ========================================
// QA Studio — Separate Window
// ========================================
let qaStudioWindow = null;

ipcMain.handle('open-qa-studio', async (event, options) => {
    const openChat = options?.openChat || false;
    const htmlFile = path.join(__dirname, 'ui', 'qa-studio.html');
    const query = openChat ? '?chat=1' : '';

    // Re-open: reload the page so it re-reads the latest video-plan.json from disk
    if (qaStudioWindow && !qaStudioWindow.isDestroyed()) {
        qaStudioWindow.loadFile(htmlFile, { query: openChat ? 'chat=1' : '' });
        qaStudioWindow.focus();
        return;
    }
    qaStudioWindow = new BrowserWindow({
        width: 1300,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0a0a0a',
        title: 'QA Studio',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    qaStudioWindow.loadFile(htmlFile, { query: openChat ? 'chat=1' : '' });
    qaStudioWindow.on('closed', () => { qaStudioWindow = null; });
});

// Agent Chat button → opens QA Studio with chat panel expanded (no separate window)
ipcMain.handle('open-qa-chat', async () => {
    // Redirect to QA Studio with chat auto-opened
    if (qaStudioWindow && !qaStudioWindow.isDestroyed()) {
        // QA Studio already open — just tell it to open chat
        qaStudioWindow.webContents.executeJavaScript(
            `document.getElementById('chat-panel')?.classList.add('open'); document.getElementById('btn-chat-toggle')?.click?.();`
        ).catch(() => {});
        qaStudioWindow.focus();
        return;
    }
    // QA Studio not open — open it with chat=1
    ipcMain.emit('handle-open-qa-studio');
    // Use the handler directly
    const htmlFile = path.join(__dirname, 'ui', 'qa-studio.html');
    qaStudioWindow = new BrowserWindow({
        width: 1300,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        backgroundColor: '#0a0a0a',
        title: 'QA Studio',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    qaStudioWindow.loadFile(htmlFile, { query: 'chat=1' });
    qaStudioWindow.on('closed', () => { qaStudioWindow = null; });
});

// ========================================
// Scout Lab — Separate Window
// ========================================
let scoutLabWindow = null;

ipcMain.handle('open-scout-lab', async () => {
    const htmlFile = path.join(__dirname, 'ui', 'scout-lab.html');
    if (scoutLabWindow && !scoutLabWindow.isDestroyed()) {
        scoutLabWindow.focus();
        return;
    }
    scoutLabWindow = new BrowserWindow({
        width: 1400,
        height: 880,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#0a0a0a',
        title: 'Scout Lab',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    scoutLabWindow.loadFile(htmlFile);
    scoutLabWindow.on('closed', () => { scoutLabWindow = null; });
});

ipcMain.handle('scout-lab-load-build', async (_event, buildDir) => {
    const scoutLab = require('./src/media/scout-lab');
    return await scoutLab.loadBuild(buildDir);
});

ipcMain.handle('scout-lab-test-scene', async (event, buildDir, sceneId, options) => {
    const scoutLab = require('./src/media/scout-lab');
    const win = BrowserWindow.fromWebContents(event.sender);
    const emit = (evt) => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('scout-lab-event', evt && evt.sceneId == null ? { ...evt, sceneId } : evt);
        }
    };
    try {
        return await scoutLab.testScene(buildDir, sceneId, emit, options || {});
    } catch (err) {
        emit({ stage: 'log', message: `[err] ${err.message}` });
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('scout-lab-test-batch', async (event, buildDir, sceneId, options) => {
    const scoutLab = require('./src/media/scout-lab');
    const win = BrowserWindow.fromWebContents(event.sender);
    const emit = (evt) => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('scout-lab-event', evt && evt.sceneId == null ? { ...evt, sceneId } : evt);
        }
    };
    try {
        return await scoutLab.testSceneBatch(buildDir, sceneId, emit, options || {});
    } catch (err) {
        emit({ stage: 'log', message: `[err] ${err.message}` });
        return { ok: false, error: err.message };
    }
});

ipcMain.handle('scout-lab-export-scene-log', async (_event, payload = {}) => {
    try {
        const buildDir = String(payload.buildDir || '').trim();
        const sceneId = String(payload.sceneId ?? 'unknown').replace(/[^\w.-]+/g, '_');
        const content = String(payload.content || '').trim();
        if (!buildDir) throw new Error('Missing buildDir');
        if (!content) throw new Error('No scene log content to export');

        const outDir = path.join(ensureLogsDir(buildDir), 'scout-lab');
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `scene-S${sceneId}-${nowStamp()}.md`);
        fs.writeFileSync(outPath, `${content}\n`, 'utf8');
        try { clipboard.writeText(outPath); } catch (_) {}
        return { ok: true, path: outPath, copiedToClipboard: true };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
});

// ========================================
// Style Studio — Separate Window
// ========================================
let styleStudioWindow = null;

ipcMain.handle('open-style-studio', async () => {
    const htmlFile = path.join(__dirname, 'ui', 'style-studio.html');

    if (styleStudioWindow && !styleStudioWindow.isDestroyed()) {
        styleStudioWindow.focus();
        return;
    }
    styleStudioWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#0a0a0a',
        title: 'Learner',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: false,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        icon: getWindowIconPath() || undefined,
        parent: mainWindow || undefined,
    });
    styleStudioWindow.loadFile(htmlFile);
    styleStudioWindow.on('closed', () => { styleStudioWindow = null; });
});

// ========================================
// Error Handling
// ========================================
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    // Log more detail — plain objects serialize as {} with console.error
    if (reason instanceof Error) {
        console.error('Unhandled Rejection:', reason.message, reason.stack);
    } else if (reason && typeof reason === 'object') {
        console.error('Unhandled Rejection (object):', JSON.stringify(reason, null, 2));
    } else {
        console.error('Unhandled Rejection:', reason);
    }
});
