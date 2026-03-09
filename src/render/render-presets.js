/**
 * RenderPresetRepository + RenderPresetModel
 * Port of Kdenlive's renderpresetrepository.cpp + renderpresetmodel.cpp
 *
 * Manages render profiles (codecs, formats, quality settings).
 * Loads built-in profiles from render-presets.json, supports custom user profiles.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BUILTIN_PROFILES_PATH = path.join(__dirname, 'render-presets.json');
const CUSTOM_PROFILES_FILENAME = 'custom-render-presets.json';

// Rate control modes (mirrors Kdenlive's RenderPresetParams::RateControl)
const RateControl = {
    Unknown: 0,
    Average: 1,    // bitrate only
    Constant: 2,   // bitrate + buffer
    Quality: 3,    // CRF / QScale
    Constrained: 4 // CRF + buffer
};

// --- RenderPresetParams ---

class RenderPresetParams extends Map {
    constructor(argsString) {
        super();
        if (argsString) {
            this.insertFromString(argsString);
        }
    }

    insertFromString(str, overwrite = true) {
        // Parse "key=value key2=value2" format
        // Regex: split on space before key= (same logic as Kdenlive)
        const pairs = str.match(/\S+=\S+/g) || [];
        for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx < 0) continue;
            const key = pair.substring(0, eqIdx);
            const val = pair.substring(eqIdx + 1);
            if (overwrite || !this.has(key)) {
                this.set(key, val);
            }
        }
    }

    toString() {
        const parts = [];
        for (const [k, v] of this) {
            parts.push(`${k}=${v}`);
        }
        return parts.join(' ');
    }

    replacePlaceholder(placeholder, value) {
        for (const [k, v] of this) {
            if (v.includes(placeholder)) {
                this.set(k, v.replace(placeholder, value));
            }
        }
    }

    refreshX265Params() {
        if (!this.isX265()) return;
        // Collect x265-specific params into x265-params string
        const x265Keys = ['crf', 'vb'];
        // x265 handles CRF internally via x265-params
    }

    videoRateControl() {
        const hasCrf = this.has('crf') || this.has('qscale');
        const hasBitrate = this.has('vb');
        const hasBuffer = this.has('vbufsize');
        if (hasCrf && hasBuffer) return RateControl.Constrained;
        if (hasCrf) return RateControl.Quality;
        if (hasBitrate && hasBuffer) return RateControl.Constant;
        if (hasBitrate) return RateControl.Average;
        return RateControl.Unknown;
    }

    hasAlpha() {
        const pf = this.get('pix_fmt') || '';
        return /argb|bgra|yuva|rgba/.test(pf);
    }

    isImageSequence() {
        return this.get('f') === 'image2';
    }

    isX265() {
        const vc = this.get('vcodec') || '';
        return vc === 'libx265' || vc === 'hevc_nvenc';
    }
}

// --- RenderPresetModel ---

class RenderPresetModel {
    constructor(profileData) {
        this.name = profileData.name || '';
        this.extension = profileData.extension || 'mp4';
        this.groupId = profileData.groupId || 'generic';
        this.renderer = profileData.renderer || 'avformat';
        this.editable = profileData.editable !== false;

        this._argsString = profileData.args || '';
        this._params = null; // lazy

        this.vQualities = profileData.vQualities || '';
        this.defaultVQuality = profileData.defaultVQuality || '';
        this.vBitrates = profileData.vBitrates || '';
        this.defaultVBitrate = profileData.defaultVBitrate || '';
        this.aQualities = profileData.aQualities || '';
        this.defaultAQuality = profileData.defaultAQuality || '';
        this.aBitrates = profileData.aBitrates || '';
        this.defaultABitrate = profileData.defaultABitrate || '';
        this.speeds = profileData.speeds || '';
        this.defaultSpeedIndex = profileData.defaultSpeedIndex || 0;
    }

    params(excludeKeys) {
        if (!this._params) {
            this._params = new RenderPresetParams(this._argsString);
        }
        if (excludeKeys && excludeKeys.length) {
            const clone = new RenderPresetParams();
            for (const [k, v] of this._params) {
                if (!excludeKeys.includes(k)) clone.set(k, v);
            }
            return clone;
        }
        return new RenderPresetParams(this._params.toString());
    }

    defaultValues() {
        const speedParts = this.speeds ? this.speeds.split(';') : [];
        const defaultSpeed = speedParts[this.defaultSpeedIndex] || '';
        return [
            defaultSpeed,
            this.defaultABitrate,
            this.defaultAQuality,
            this.defaultVBitrate,
            this.defaultVQuality
        ];
    }

    supportsTwoPass() {
        const vc = (this._argsString.match(/vcodec=(\S+)/) || [])[1] || '';
        return /libx264|libx265|libvpx|libvpx-vp9/.test(vc);
    }

    toJSON() {
        return {
            name: this.name,
            extension: this.extension,
            groupId: this.groupId,
            renderer: this.renderer,
            args: this._argsString,
            vQualities: this.vQualities,
            defaultVQuality: this.defaultVQuality,
            vBitrates: this.vBitrates,
            defaultVBitrate: this.defaultVBitrate,
            aQualities: this.aQualities,
            defaultAQuality: this.defaultAQuality,
            aBitrates: this.aBitrates,
            defaultABitrate: this.defaultABitrate,
            speeds: this.speeds,
            defaultSpeedIndex: this.defaultSpeedIndex
        };
    }
}

// --- RenderPresetRepository (singleton) ---

let _instance = null;

class RenderPresetRepository {
    constructor() {
        this._presets = new Map();     // name -> RenderPresetModel
        this._categories = new Map();  // groupId -> groupName
        this._customProfilesPath = null;
    }

    static get() {
        if (!_instance) {
            _instance = new RenderPresetRepository();
            _instance.refresh();
        }
        return _instance;
    }

    setCustomProfilesPath(dir) {
        this._customProfilesPath = path.join(dir, CUSTOM_PROFILES_FILENAME);
    }

    refresh() {
        this._presets.clear();
        this._categories.clear();

        // 1. Load built-in profiles
        this._loadBuiltinProfiles();

        // 2. Load custom profiles (override built-in)
        if (this._customProfilesPath && fs.existsSync(this._customProfilesPath)) {
            this._loadCustomProfiles();
        }
    }

    _loadBuiltinProfiles() {
        const data = JSON.parse(fs.readFileSync(BUILTIN_PROFILES_PATH, 'utf8'));
        for (const group of data.groups) {
            this._categories.set(group.id, group.name);
            for (const profile of group.profiles) {
                const model = new RenderPresetModel({
                    ...profile,
                    groupId: group.id,
                    renderer: group.renderer,
                    editable: false
                });
                this._presets.set(model.name, model);
            }
        }
    }

    _loadCustomProfiles() {
        try {
            const data = JSON.parse(fs.readFileSync(this._customProfilesPath, 'utf8'));
            for (const profile of (data.profiles || [])) {
                const model = new RenderPresetModel({ ...profile, editable: true });
                this._presets.set(model.name, model);
            }
        } catch (e) {
            console.warn('Failed to load custom render presets:', e.message);
        }
    }

    getPreset(name) {
        return this._presets.get(name) || null;
    }

    getAllPresets() {
        return Array.from(this._presets.values());
    }

    getAllPresetNames() {
        return Array.from(this._presets.keys());
    }

    getAllCategories() {
        return Object.fromEntries(this._categories);
    }

    getPresetsByCategory(groupId) {
        return this.getAllPresets().filter(p => p.groupId === groupId);
    }

    savePreset(presetData) {
        if (!this._customProfilesPath) return false;

        const model = new RenderPresetModel({ ...presetData, editable: true, groupId: 'custom' });
        this._presets.set(model.name, model);

        // Persist
        const customPresets = this.getAllPresets().filter(p => p.editable).map(p => p.toJSON());
        const dir = path.dirname(this._customProfilesPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this._customProfilesPath, JSON.stringify({ profiles: customPresets }, null, 2));
        return true;
    }

    deletePreset(name) {
        const preset = this._presets.get(name);
        if (!preset || !preset.editable) return false;
        this._presets.delete(name);
        // Re-save custom
        if (this._customProfilesPath) {
            const customPresets = this.getAllPresets().filter(p => p.editable).map(p => p.toJSON());
            fs.writeFileSync(this._customProfilesPath, JSON.stringify({ profiles: customPresets }, null, 2));
        }
        return true;
    }

    /**
     * Resolve a preset into final consumer params (with placeholders replaced).
     * Mirrors Kdenlive's RenderRequest::loadPresetParams().
     */
    resolvePresetParams(presetName, overrides = {}) {
        const preset = this.getPreset(presetName);
        if (!preset) return null;

        const params = preset.params();
        const defaults = preset.defaultValues();

        // Replace placeholders with defaults or overrides
        const quality = overrides.quality || defaults[4];
        const audioQuality = overrides.audioQuality || defaults[2];
        const audioBitrate = overrides.audioBitrate || defaults[1];
        const videoBitrate = overrides.videoBitrate || defaults[3];

        if (quality) params.replacePlaceholder('%quality', quality);
        if (audioQuality) params.replacePlaceholder('%audioquality', audioQuality);
        if (audioBitrate) params.replacePlaceholder('%audiobitrate', audioBitrate);
        if (videoBitrate) params.replacePlaceholder('%bitrate', videoBitrate);

        // Insert speed preset
        const speedStr = overrides.speed || defaults[0];
        if (speedStr && speedStr.includes('=')) {
            params.insertFromString(speedStr, false);
        }

        params.refreshX265Params();
        return params;
    }
}

module.exports = {
    RateControl,
    RenderPresetParams,
    RenderPresetModel,
    RenderPresetRepository
};
