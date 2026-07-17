// src/categories/talking-head.js
// Talking-head — faceless B-roll PLUS a recurring presenter at a few key beats
// (static image now, avatar clip later). Canonical id stays 'talkingHead' (camelCase)
// to match every existing `productionMode === 'talkingHead'` guard byte-for-byte.
'use strict';

module.exports = {
    id: 'talkingHead',
    label: '🧑‍💼 Talking Head (presenter)',
    aliases: ['talkinghead', 'talking-head', 'talking_head'],
    allowedFormats: ['documentary', 'listicle'],
    hasPresenter: true,
    generation: 'stock',
};
