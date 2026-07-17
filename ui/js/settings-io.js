// ui/js/settings-io.js
// ============================================================================
// Schema-driven read/write of element-backed settings — kills the 5-place field
// duplication (saveSettings / loadSettings / applyProjectSettings / saveProject /
// runBuild options). Reads the control by its DOM id from the schema, inferring
// checkbox vs value from the element itself (no per-setting type needed). Deprecated
// settings (e.g. ollama*) and state-backed ones (el:null) are skipped — those stay
// hand-coded in app.js. Dual-loadable: window.SettingsIO in the renderer,
// require() in Node (scripts/verify-settings-ui.js), with an injectable getEl for tests.
// ============================================================================
(function (root, factory) {
    const mod = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (typeof window !== 'undefined') window.SettingsIO = mod;
})(typeof self !== 'undefined' ? self : this, function () {
    function _schema() {
        if (typeof window !== 'undefined' && window.SETTINGS_SCHEMA) return window.SETTINGS_SCHEMA;
        if (typeof require !== 'undefined') return require('../../src/settings/schema');
        throw new Error('SettingsIO: schema not available');
    }
    function _get(getEl, id) {
        if (getEl) return getEl(id);
        return (typeof document !== 'undefined') ? document.getElementById(id) : null;
    }
    // Settings SettingsIO owns: has a DOM control, not deprecated, not special
    // (special ones — e.g. transitionStyle 'cut'-detection, buildStyleProfile async
    // option load — stay hand-coded in app.js).
    function _managed(scope, sc) {
        return sc.SETTINGS.filter(s => s.el && !s.deprecated && !s.special && (!scope || (s.persist || []).includes(scope)));
    }

    // Read managed element settings into a plain object. scope null = all element
    // settings (used for the runBuild options payload).
    function collect(scope, opts = {}) {
        const sc = _schema(); const out = {};
        for (const s of _managed(scope, sc)) {
            const el = _get(opts.getEl, s.el);
            if (!el) continue;
            out[s.key] = (el.type === 'checkbox') ? !!el.checked : el.value;
        }
        return out;
    }

    // Write managed element settings from an object (missing keys fall back to default).
    function apply(obj, scope, opts = {}) {
        const sc = _schema();
        for (const s of _managed(scope, sc)) {
            const el = _get(opts.getEl, s.el);
            if (!el) continue;
            const has = obj && Object.prototype.hasOwnProperty.call(obj, s.key);
            const v = has ? obj[s.key] : s.def;
            if (el.type === 'checkbox') el.checked = !!v;
            else if (v !== undefined && v !== null) el.value = v;
        }
    }

    return { collect, apply };
});
