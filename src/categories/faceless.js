// src/categories/faceless.js
// Faceless documentary/listicle — normal downloaded B-roll, no on-screen presenter.
// This is the historical default; its descriptor must reproduce today's behavior.
'use strict';

module.exports = {
    id: 'faceless',
    label: '🎞️ Faceless (B-roll only)',
    aliases: ['faceless', 'b-roll', 'broll'],
    allowedFormats: ['documentary', 'listicle'],
    hasPresenter: false,
    generation: 'stock', // footage = downloaded stock / youtube / web-image
};
