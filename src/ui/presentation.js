import { createDebugOverlay } from '../diagnostics/debug-overlay.js';

function element(root, selector) {
  return root.querySelector(selector);
}

export function createSimulationUI({ root = document, viewport = window, debugEnabled = false } = {}) {
  const canvas = element(root, '#scene');
  if (!canvas) throw new Error('Simulation canvas #scene is required');

  const antNote = element(root, '#ant-note');
  const antNoteTitle = element(root, '#ant-note-title');
  const antNoteTask = element(root, '#ant-note-task');
  const antNoteFacts = element(root, '#ant-note-facts');
  const speedIndicator = element(root, '#speed-indicator');
  const censusNote = element(root, '#census-note');
  const censusYear = element(root, '#census-year');
  const censusTimeline = element(root, '#census-timeline');
  const censusSummary = element(root, '#census-summary');
  const censusEvent = element(root, '#census-event');
  const debugOverlay = createDebugOverlay(element(root, '#debug-note'), { enabled: debugEnabled });
  let speedIndicatorTimer = 0;

  function renderAntNote(note) {
    if (!antNote) return;
    antNote.hidden = !note;
    if (!note) return;
    antNoteTitle.textContent = note.title;
    antNoteTask.textContent = note.task;
    antNoteFacts.replaceChildren();
    for (const fact of note.facts) {
      const term = root.createElement('dt');
      const value = root.createElement('dd');
      term.textContent = fact.label;
      value.textContent = fact.value;
      antNoteFacts.append(term, value);
    }
  }

  function renderCensus(census) {
    if (!censusNote || !censusTimeline || !census) return;
    censusNote.hidden = false;
    censusYear.textContent = census.title;
    censusTimeline.replaceChildren();
    for (const entry of census.timeline) {
      const bar = root.createElement('span');
      bar.className = 'census-bar';
      if (entry.orphaned) bar.classList.add('orphaned');
      if (entry.replaced) bar.classList.add('replaced');
      bar.dataset.year = String(entry.year);
      bar.title = entry.title;
      bar.style.setProperty('--census-height', `${entry.heightPercent}%`);
      censusTimeline.append(bar);
    }
    censusSummary.textContent = census.summary;
    censusEvent.textContent = census.event;
  }

  function showTimeScale(label) {
    if (!speedIndicator) return;
    speedIndicator.textContent = label;
    speedIndicator.classList.add('visible');
    speedIndicatorTimer = 1.7;
  }

  function update(dt) {
    if (speedIndicatorTimer <= 0) return;
    speedIndicatorTimer -= dt;
    if (speedIndicatorTimer <= 0) speedIndicator?.classList.remove('visible');
  }

  function readViewport() {
    return {
      width: viewport.innerWidth,
      height: viewport.innerHeight,
      pixelRatio: viewport.devicePixelRatio,
    };
  }

  return {
    canvas,
    debugOverlay,
    readViewport,
    renderAntNote,
    renderCensus,
    showTimeScale,
    update,
  };
}
