const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ai-provider.js'), 'utf8');

function extractArray(name) {
    const re = new RegExp('const ' + name + ' = (?:_dedupeModels\\()?\\[([\\s\\S]*?)\\]\\)?;');
    const m = src.match(re);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : [];
}

const vl = extractArray('QWEN_VL_POOL');
const q357 = extractArray('QWEN_357_VISION_POOL');
const omniHttp = extractArray('QWEN_STATIC_OMNI_HTTP_POOL');
const omniRealtime = extractArray('QWEN_STATIC_OMNI_REALTIME_POOL');
const omniUnsupported = extractArray('QWEN_OMNI_OPENAI_UNSUPPORTED_POOL');
const image = [...new Set([...vl, ...q357])];
const omni = omniHttp;

console.log('=== Qwen pools defined in ai-provider.js ===');
console.log('QWEN_VL_POOL              : ' + vl.length + ' models  (dedicated VL/QVQ/OCR image scoring)');
console.log('QWEN_357_VISION_POOL      : ' + q357.length + ' models  (official Qwen3.5/3.6/3.7 image/video-capable families)');
console.log('QWEN_IMAGE_POOL           : ' + image.length + ' models  (static fallback; generated registry can override)');
console.log('QWEN_OMNI_POOL            : ' + omni.length + ' models  (static HTTP pool; generated registry can override)');
console.log('QWEN_OMNI_HTTP_POOL       : ' + omniHttp.length + ' models  (batch HTTP/OpenAI-compatible)');
console.log('QWEN_OMNI_REALTIME_POOL   : ' + omniRealtime.length + ' models  (WebSocket realtime lane)');
console.log('QWEN_OMNI_UNSUPPORTED     : ' + omniUnsupported.length + ' models  (known not supported by OpenAI-compatible endpoint)');
console.log('');
const allDefined = new Set([...vl, ...q357, ...omni, ...omniRealtime, ...omniUnsupported]);
console.log('Total UNIQUE models DEFINED in file       : ' + allDefined.size);
const runtimeVision = new Set([...image, ...omni, ...omniRealtime]);
console.log('Total UNIQUE static ACTIVE at runtime     : ' + runtimeVision.size + '  (generated registry may replace these pools)');
