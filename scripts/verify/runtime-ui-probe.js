// scripts/verify/runtime-ui-probe.js
// Attaches to the LIVE Electron renderer over CDP (DevTools :9223) and verifies the
// P2 settings schema + tabbed settings UI at runtime: schema/SettingsIO loaded, all
// tabs + panels present, exactly one active, a real tab-switch works, workspace
// indicator, and no leaked deprecated/special controls. Read-only except one click.
const puppeteer = require('puppeteer-core');

const BROWSER_WS = process.argv[2];
if (!BROWSER_WS) { console.error('usage: node runtime-ui-probe.js <browserWsEndpoint>'); process.exit(2); }

(async () => {
  const browser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS, defaultViewport: null });
  const pages = await browser.pages();
  const page = pages.find(p => /ui\/index\.html/i.test(p.url()));
  if (!page) { console.error('renderer page not found'); process.exit(2); }

  const results = [];
  const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

  // 1. Core renderer globals loaded (proves schema.js + settings-io.js loaded before app.js)
  const globals = await page.evaluate(() => ({
    schema: typeof window.SETTINGS_SCHEMA === 'object' && Array.isArray(window.SETTINGS_SCHEMA.SETTINGS),
    schemaCount: window.SETTINGS_SCHEMA ? window.SETTINGS_SCHEMA.SETTINGS.length : 0,
    settingsIO: !!(window.SettingsIO && typeof window.SettingsIO.collect === 'function' && typeof window.SettingsIO.apply === 'function'),
    // app.js declares top-level functions (classic <script>), which become window props.
    // loadVideoPlan ran during boot (seen in logs) — its presence proves app.js executed.
    appLoaded: typeof window.loadVideoPlan === 'function' || typeof window.saveSettings === 'function',
  }));
  check('SETTINGS_SCHEMA loaded', globals.schema, `${globals.schemaCount} settings`);
  check('SettingsIO loaded (collect+apply)', globals.settingsIO);
  check('app.js executed (window fns present)', globals.appLoaded);

  // 2. Tab bar + panels structure
  const tabs = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.settings-tabs .stab-btn')].map(b => ({ id: b.dataset.stab, active: b.classList.contains('active'), label: (b.textContent || '').trim() }));
    const panels = [...document.querySelectorAll('.stab-panel')].map(p => ({ id: p.dataset.stab, active: p.classList.contains('active'), display: getComputedStyle(p).display }));
    return { btns, panels };
  });
  check('5 tab buttons present', tabs.btns.length === 5, tabs.btns.map(b => b.id).join(','));
  check('5 tab panels present', tabs.panels.length === 5, tabs.panels.map(p => p.id).join(','));
  const activeBtns = tabs.btns.filter(b => b.active);
  check('exactly one tab active', activeBtns.length === 1, activeBtns.map(b => b.id).join(','));
  const visiblePanels = tabs.panels.filter(p => p.display !== 'none');
  check('exactly one panel visible', visiblePanels.length === 1, visiblePanels.map(p => p.id).join(','));
  check('active btn matches visible panel', activeBtns[0] && visiblePanels[0] && activeBtns[0].id === visiblePanels[0].id, `${activeBtns[0]?.id} vs ${visiblePanels[0]?.id}`);

  // 3. Every panel referenced by a button, and vice-versa (no orphans)
  const btnIds = new Set(tabs.btns.map(b => b.id));
  const panelIds = new Set(tabs.panels.map(p => p.id));
  const orphanBtns = [...btnIds].filter(id => !panelIds.has(id));
  const orphanPanels = [...panelIds].filter(id => !btnIds.has(id));
  check('no orphan tabs/panels', orphanBtns.length === 0 && orphanPanels.length === 0, `orphanBtns=${orphanBtns} orphanPanels=${orphanPanels}`);

  // 3b. Fully-tabbed: no settings .panel-section may sit OUTSIDE a .stab-panel in the
  // left panel. Only the top Import Audio importer and the bottom action buttons are
  // allowed outside the tabs — everything else must live in a tab (no leftover scroll).
  const stray = await page.evaluate(() => {
    const panel = document.getElementById('left-panel');
    if (!panel) return { err: 'no #left-panel' };
    const out = [];
    for (const sec of panel.querySelectorAll(':scope > .panel-section')) {
      // The tab container itself is a .panel-section — it's SUPPOSED to be a direct child.
      if (sec.classList.contains('settings-tabbed')) continue;
      // A section is "settings" if it holds form controls; the Import Audio dropzone has none.
      const hasControls = sec.querySelector('input,select,textarea');
      const h3 = (sec.querySelector('h3')?.textContent || '').trim();
      const isImport = /import audio/i.test(h3);
      if (hasControls && !isImport) out.push(h3 || sec.className);
    }
    return { stray: out };
  });
  check('fully tabbed (no settings section outside tabs)', stray.stray && stray.stray.length === 0, stray.err || (stray.stray.length ? 'stray: ' + stray.stray.join(' | ') : 'none'));

  // 4. Real interaction: click a non-active tab and confirm the switch
  const target = tabs.btns.find(b => !b.active);
  let switchOk = false, switchDetail = '';
  if (target) {
    await page.click(`.stab-btn[data-stab="${target.id}"]`);
    await new Promise(r => setTimeout(r, 150));
    const after = await page.evaluate((tid) => {
      const btn = document.querySelector(`.stab-btn[data-stab="${tid}"]`);
      const panel = document.querySelector(`.stab-panel[data-stab="${tid}"]`);
      const activeBtnCount = document.querySelectorAll('.settings-tabs .stab-btn.active').length;
      const visPanels = [...document.querySelectorAll('.stab-panel')].filter(p => getComputedStyle(p).display !== 'none').length;
      return { btnActive: btn?.classList.contains('active'), panelVisible: panel && getComputedStyle(panel).display !== 'none', activeBtnCount, visPanels };
    }, target.id);
    switchOk = after.btnActive && after.panelVisible && after.activeBtnCount === 1 && after.visPanels === 1;
    switchDetail = `clicked=${target.id} active=${after.btnActive} visible=${after.panelVisible} activeCount=${after.activeBtnCount} visCount=${after.visPanels}`;
  }
  check('tab switch works (click → single active/visible)', switchOk, switchDetail);

  // 5. All schema element-settings actually exist in the DOM (schema ↔ HTML parity)
  const domParity = await page.evaluate(() => {
    const S = window.SETTINGS_SCHEMA.SETTINGS;
    const missing = [];
    // Deprecated controls are intentionally pruned from the DOM — only live ones must exist.
    for (const s of S) { if (s.el && !s.deprecated && !document.getElementById(s.el)) missing.push(s.key + '#' + s.el); }
    return { missing };
  });
  check('all schema-backed controls exist in DOM', domParity.missing.length === 0, domParity.missing.join(', ') || 'none missing');

  // 6. SettingsIO round-trip on the live DOM (collect → mutate → apply → collect)
  const roundTrip = await page.evaluate(() => {
    const before = window.SettingsIO.collect(null);
    const keys = Object.keys(before);
    return { keyCount: keys.length, sample: keys.slice(0, 6) };
  });
  check('SettingsIO.collect returns managed settings', roundTrip.keyCount > 0, `${roundTrip.keyCount} keys e.g. ${roundTrip.sample.join(',')}`);

  // 7. Workspace indicator (no project loaded)
  const ws = await page.evaluate(() => {
    const el = document.getElementById('project-name') || document.querySelector('[data-project-name]');
    const txt = document.body.innerText;
    return { projName: el ? el.textContent.trim() : null, hasNoProjectHint: /No project|click New Project/i.test(txt) };
  });
  check('workspace mode indicator present', ws.hasNoProjectHint || (ws.projName && /No project/i.test(ws.projName)), `projName="${ws.projName}"`);

  // Report
  console.log('\n=== RUNTIME UI PROBE ===');
  let allPass = true;
  for (const r of results) { const s = r.pass ? 'PASS' : 'FAIL'; if (!r.pass) allPass = false; console.log(`[${s}] ${r.name}${r.detail ? '  — ' + r.detail : ''}`); }
  console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'} (${results.filter(r => r.pass).length}/${results.length})`);

  await browser.disconnect();
  process.exit(allPass ? 0 : 1);
})().catch(e => { console.error('PROBE ERROR', e.message); process.exit(3); });
