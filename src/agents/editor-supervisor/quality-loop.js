'use strict';

const { validateAgentDraft } = require('./workers/quality-guard');

function runQualityLoop(plan, options = {}) {
    const maxPasses = options.effort === 'smart' ? 2 : 1;
    const passes = [];
    let guarded = null;
    let working = plan;
    for (let pass = 1; pass <= maxPasses; pass++) {
        guarded = validateAgentDraft(working, options);
        working = guarded.plan;
        const repairedVisualIndexes = Number(guarded.report?.repairedVisualIndexes) || 0;
        const removedOrphanTransitions = Number(guarded.report?.removedOrphanTransitions) || 0;
        const repairCount = repairedVisualIndexes + removedOrphanTransitions;
        passes.push({
            pass,
            status: guarded.report?.status || 'passed',
            repairCount,
            repairedVisualIndexes,
            removedOrphanTransitions,
            findingCount: Array.isArray(guarded.report?.findings)
                ? guarded.report.findings.length
                : 0,
        });
        if (!repairCount) break;
    }
    return {
        plan: working,
        report: {
            ...(guarded?.report || { status: 'passed', findings: [] }),
            repairPasses: passes,
            automaticRepairCount: passes.reduce((sum, pass) => sum + pass.repairCount, 0),
        },
    };
}

module.exports = {
    runQualityLoop,
};
