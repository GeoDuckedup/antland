function timingLine(label, timing) {
  if (!timing) return `${label.padEnd(12)}  collecting`;
  return `${label.padEnd(12)}  ${timing.p50Ms.toFixed(2)} / ${timing.p95Ms.toFixed(2)} ms`;
}

export function createDebugOverlay(element, { enabled = false, refreshMs = 250 } = {}) {
  if (!element || !enabled) {
    return { enabled: false, update: () => {} };
  }

  element.hidden = false;
  let lastRefresh = -Infinity;

  return {
    enabled: true,
    update(state, now = performance.now()) {
      if (now - lastRefresh < refreshMs) return;
      lastRefresh = now;
      const profile = state.profile;
      const timing = profile.timings || {};
      const renderer = state.renderer || {};
      const transients = state.transients || {};
      const backlogGuard = state.backlogGuard || {};
      const fixedSteps = profile.frameCounters.fixedSteps || 0;
      const spatialBuilds = profile.frameCounters.surfaceIndexBuilds || 0;
      const buildsPerStep = fixedSteps > 0 ? spatialBuilds / fixedSteps : 0;
      element.textContent = [
        'PHASE 9 · DIAGNOSTICS',
        'p50 / p95',
        timingLine('fixed step', timing.fixedStep),
        timingLine('render', timing.render),
        timingLine('spatial', timing.spatialIndex),
        timingLine('pheromones', timing.pheromones),
        timingLine('nest sim', timing.architectureSimulation),
        timingLine('nest present', timing.architecturePresentation),
        timingLine('snapshot', timing.snapshot),
        '',
        `backlog       ${Number(state.backlogMs || 0).toFixed(2)} ms · ${fixedSteps} steps`,
        `catch-up      ${backlogGuard.deferredSteps || 0} deferred · ${Number(backlogGuard.droppedMs || 0).toFixed(1)} ms dropped`,
        `spatial builds ${spatialBuilds}/frame · ${buildsPerStep.toFixed(1)}/step · ${profile.counters.surfaceIndexBuilds || 0} total`,
        `surface ants   ${state.simulatedSurface}/${state.renderedSurface} simulated/rendered`,
        `below-ground   ${state.simulatedUnderground}/${state.renderedUnderground} simulated/rendered`,
        `colonies       ${state.livingColonies} · LOD ${state.visualMode}`,
        `draw calls     ${renderer.calls || 0} · triangles ${renderer.triangles || 0}`,
        `GPU objects    ${renderer.geometries || 0} geometry · ${renderer.textures || 0} textures`,
        `events         ${state.events || 0} · transients ${Object.values(transients).reduce((sum, value) => sum + value, 0)}`,
        `signals ${transients.signals || 0} · remains ${transients.remains || 0} · spoil ${transients.spoil || 0} · wings ${transients.wings || 0}`,
        state.fixtureStatus ? `fixture        ${state.fixtureStatus}` : '',
      ].filter((line) => line !== '').join('\n');
    },
  };
}
