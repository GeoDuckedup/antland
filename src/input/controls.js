export function createSimulationInput({
  canvas,
  viewport = window,
  fullscreenDocument = document,
  onPointerStart = () => {},
  onPointerEnd = () => {},
  onPointerTap = () => {},
  onOrbit = () => {},
  onPan = () => {},
  onDoubleClick = () => {},
  onZoom = () => {},
  onRain = () => {},
  onPredator = () => {},
  onSpider = () => {},
  onFlightWindow = () => {},
  onCycleNest = () => {},
  onToggleDepth = () => {},
  onChangeSpeed = () => {},
  onResetSpeed = () => {},
  onReleaseSelection = () => {},
  onTogglePause = () => {},
  onResize = () => {},
} = {}) {
  if (!canvas) throw new Error('Simulation input requires a canvas');

  const heldKeys = new Set();
  const pointer = { down: false, lastX: 0, lastY: 0, moved: 0, button: 0, shift: false };

  const pointerDown = (event) => {
    pointer.down = true;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    pointer.moved = 0;
    pointer.button = event.button;
    pointer.shift = event.shiftKey;
    onPointerStart();
    canvas.setPointerCapture(event.pointerId);
  };

  const pointerMove = (event) => {
    if (!pointer.down) return;
    const dx = event.clientX - pointer.lastX;
    const dy = event.clientY - pointer.lastY;
    pointer.moved += Math.hypot(dx, dy);
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (pointer.button === 2) onPan(dx, dy);
    else if (pointer.moved > 3) onOrbit(dx, dy);
  };

  const pointerUp = (event) => {
    if (pointer.down && pointer.moved < 6 && pointer.button === 0) {
      onPointerTap(event.clientX, event.clientY, pointer.shift || event.shiftKey);
    }
    pointer.down = false;
    onPointerEnd();
  };

  const doubleClick = (event) => onDoubleClick(event.clientX, event.clientY);
  const wheel = (event) => {
    event.preventDefault();
    onZoom(event.deltaY);
  };
  const contextMenu = (event) => event.preventDefault();

  const keyDown = async (event) => {
    heldKeys.add(event.code);
    const key = event.key.toLowerCase();
    if (key === 'r') onRain();
    if (key === 'p' && !event.repeat) onPredator();
    if (key === 'o' && !event.repeat) onSpider();
    if (key === 'l' && !event.repeat) onFlightWindow();
    if (key === 'n' && !event.repeat) onCycleNest();
    if (key === 'b' && !event.repeat) onToggleDepth();
    if (key === 'f') {
      if (!fullscreenDocument.fullscreenElement) await fullscreenDocument.documentElement.requestFullscreen?.();
      else await fullscreenDocument.exitFullscreen?.();
    }
    if ((event.key === ']' || event.key === '=' || event.key === '+') && !event.repeat) {
      event.preventDefault();
      onChangeSpeed(1);
    }
    if ((event.key === '[' || event.key === '-' || event.key === '_') && !event.repeat) {
      event.preventDefault();
      onChangeSpeed(-1);
    }
    if (event.key === '0' && !event.repeat) onResetSpeed();
    if (event.key === 'Escape') onReleaseSelection();
    if (event.key === ' ') {
      event.preventDefault();
      if (!event.repeat) onTogglePause();
    }
  };

  const keyUp = (event) => heldKeys.delete(event.code);
  const resize = () => onResize();

  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('dblclick', doubleClick);
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('contextmenu', contextMenu);
  viewport.addEventListener('keydown', keyDown);
  viewport.addEventListener('keyup', keyUp);
  viewport.addEventListener('resize', resize);
  fullscreenDocument.addEventListener('fullscreenchange', resize);

  return {
    isHeld: (code) => heldKeys.has(code),
    destroy() {
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('dblclick', doubleClick);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', contextMenu);
      viewport.removeEventListener('keydown', keyDown);
      viewport.removeEventListener('keyup', keyUp);
      viewport.removeEventListener('resize', resize);
      fullscreenDocument.removeEventListener('fullscreenchange', resize);
      heldKeys.clear();
    },
  };
}
