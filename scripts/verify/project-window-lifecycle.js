#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'ui', 'js', 'app.js'), 'utf8');
const projectStoreSource = fs.readFileSync(path.join(root, 'src', 'project', 'project-store.js'), 'utf8');

assert.ok(
    mainSource.includes('app.requestSingleInstanceLock('),
    'normal launches must route through one primary workspace'
);
assert.ok(
    mainSource.includes("app.on('second-instance'"),
    'normal secondary launches must be routed by the primary workspace'
);
assert.ok(
    mainSource.includes("process.argv.includes('--yta-project-instance')"),
    'spawned project instances need an explicit primary-lock bypass'
);
assert.ok(
    mainSource.includes('async function _switchProjectInPlace('),
    'the empty workspace must support one atomic in-place project switch'
);
assert.ok(
    mainSource.includes('function _spawnProjectInstance('),
    'named projects must be able to open another isolated project instance'
);
assert.ok(
    mainSource.includes('async function _openProjectTarget('),
    'project routing must choose between workspace reuse and a new instance'
);
assert.ok(
    mainSource.includes('function _validateExistingProjectTarget(')
        && mainSource.includes('projectStore.inspectProjectDirectory({'),
    'all project-open routes must use authoritative project validation'
);
assert.ok(
    mainSource.includes('function _prepareNewProjectTarget(')
        && mainSource.includes('projectStore.createProjectAtLocation(options)'),
    'new projects must be initialized as real YTA projects before opening'
);
assert.ok(
    mainSource.includes('_pathsEqual(PROJECT_DIR, DEFAULT_WORKSPACE_DIR)'),
    'routing must consume only the empty default workspace'
);
assert.ok(
    mainSource.includes("'--yta-project-instance'"),
    'additional project processes must carry the instance bypass marker'
);

for (const channel of [
    'launch-new-instance',
    'open-existing-project',
    'open-existing-project-folder',
    'open-existing-project-file',
]) {
    const start = mainSource.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(start >= 0, `missing ${channel} handler`);
    const end = mainSource.indexOf('\n});', start);
    const handler = mainSource.slice(start, end + 4);
    assert.ok(
        handler.includes('_openProjectTarget('),
        `${channel} must use hybrid project routing`
    );
}

assert.ok(
    appSource.includes('async function _saveBeforeProjectSwitch()'),
    'renderer must save the current project before opening another'
);
assert.ok(
    appSource.includes('function _reloadWorkspaceForProject('),
    'renderer must reload the empty workspace after its in-place switch'
);
assert.ok(
    appSource.includes("result?.openedIn === 'new-instance'"),
    'renderer must leave the current named project open when another instance launches'
);
assert.ok(
    appSource.includes('window.location.reload();'),
    'the first project switch must reuse the current renderer window'
);
assert.ok(
    appSource.includes('opened in a new window'),
    'UI must confirm additional project windows'
);
assert.ok(
    appSource.includes('value="selected-folder"')
        && appSource.includes('value="create-subfolder"'),
    'New Project must explicitly support using the selected folder or creating inside it'
);
assert.ok(
    appSource.includes('locationMode,'),
    'renderer must send the chosen folder behavior to the main process'
);
assert.ok(
    projectStoreSource.includes('NESTED_DUPLICATE_PROJECT_NAME'),
    'main process must block accidental Project/Project nesting'
);
assert.ok(
    projectStoreSource.includes('A YTA Empire project already exists in this folder. Use Open Project instead.'),
    'New Project must refuse to overwrite an existing project'
);

console.log('✅ hybrid multi-project window lifecycle checks passed');
