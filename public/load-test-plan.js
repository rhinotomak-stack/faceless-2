/**
 * Run this in DevTools console to load the MG test plan:
 *   fetch('load-test-plan.js').then(r=>r.text()).then(eval)
 *
 * Or simpler — just paste this one-liner:
 *   fetch('test-mg-plan.json').then(r=>r.json()).then(p=>{window._loadTestPlan(p)})
 */
// This gets registered globally from app.js — see below for manual approach
(async function() {
    const resp = await fetch('test-mg-plan.json');
    const plan = await resp.json();
    window._loadTestPlan(plan);
})();
