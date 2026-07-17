/**
 * Title Sanity
 *
 * Non-blocking title pass-through.
 *
 * This module intentionally does not reject candidates. Titles are too weak a
 * signal for archival / YouTube footage, so frame-based vision checks remain
 * the place where footage is accepted or rejected.
 */
'use strict';

async function judgeTitles(results) {
    return {
        kept: Array.isArray(results) ? results : [],
        rejected: [],
        log: '',
    };
}

function resetTitleSanityCache() {
    // Kept for the existing call sites; there is no cache in pass-through mode.
}

module.exports = {
    judgeTitles,
    resetTitleSanityCache,
};
