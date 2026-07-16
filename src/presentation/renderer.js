import * as THREE from '../../vendor/three.module.js';
import { HOME_COLONY_ID } from '../config/simulation.js';

const clamp = THREE.MathUtils.clamp;

export function createRendererRuntime({ canvas, viewport }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(viewport.pixelRatio, 1.75));
  renderer.setSize(viewport.width, viewport.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xc6b584);
  scene.fog = new THREE.FogExp2(0xc6b584, 0.018);
  const surfaceGroup = new THREE.Group();
  surfaceGroup.name = 'surface-world';
  scene.add(surfaceGroup);
  const undergroundGroup = new THREE.Group();
  undergroundGroup.name = 'living-nest-scan';
  undergroundGroup.visible = false;
  scene.add(undergroundGroup);
  const viewState = {
    undergroundBlend: 0,
    surfaceBackground: new THREE.Color(0xc6b584),
    undergroundBackground: new THREE.Color(0x080b13),
    surfaceSun: 4,
    surfaceHemi: 2.25,
  };

  const camera = new THREE.PerspectiveCamera(39, viewport.width / viewport.height, 0.1, 90);
  const cameraRig = {
    target: new THREE.Vector3(-0.5, 0, 0.5),
    yaw: 0.54,
    pitch: 0.78,
    desiredPitch: 0.78,
    distance: 24,
    desiredDistance: 24,
    focusY: 0,
    idle: 0,
    focusedColonyId: HOME_COLONY_ID,
  };
  const hemi = new THREE.HemisphereLight(0xfff1c4, 0x475033, 2.25);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xffd58e, 4.0);
  sun.position.set(-9, 18, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 17;
  sun.shadow.camera.bottom = -17;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 45;
  sun.shadow.bias = -0.0003;
  scene.add(sun);

  function updateCamera({
    dt,
    followingSelected,
    selectedAnt,
    antWorldPosition,
    input,
    groundHeight,
    focusedColony,
  }) {
    cameraRig.idle += dt;
    let following = followingSelected;
    if (following && selectedAnt) {
      const follow = antWorldPosition(selectedAnt);
      const followAmount = Math.min(1, dt * 4.8);
      cameraRig.target.x += (follow.x - cameraRig.target.x) * followAmount;
      cameraRig.target.z += (follow.z - cameraRig.target.z) * followAmount;
      cameraRig.desiredPitch = selectedAnt.insideNest ? -0.32 : 0.72;
      cameraRig.desiredDistance = selectedAnt.insideNest ? 8.8 : 10.5;
    }
    cameraRig.pitch += (cameraRig.desiredPitch - cameraRig.pitch) * Math.min(1, dt * 4.2);
    cameraRig.distance += (cameraRig.desiredDistance - cameraRig.distance) * Math.min(1, dt * 4);
    if (cameraRig.idle > 6) cameraRig.yaw += dt * 0.012;

    const moveSpeed = dt * (input.isHeld('ShiftLeft') || input.isHeld('ShiftRight') ? 9 : 4.6)
      * clamp(cameraRig.distance / 20, 0.62, 1.35);
    const forwardX = -Math.sin(cameraRig.yaw);
    const forwardZ = -Math.cos(cameraRig.yaw);
    const rightX = -Math.cos(cameraRig.yaw);
    const rightZ = Math.sin(cameraRig.yaw);
    let moveX = 0;
    let moveZ = 0;
    if (input.isHeld('KeyW') || input.isHeld('ArrowUp')) { moveX += forwardX; moveZ += forwardZ; }
    if (input.isHeld('KeyS') || input.isHeld('ArrowDown')) { moveX -= forwardX; moveZ -= forwardZ; }
    if (input.isHeld('KeyD') || input.isHeld('ArrowRight')) { moveX += rightX; moveZ += rightZ; }
    if (input.isHeld('KeyA') || input.isHeld('ArrowLeft')) { moveX -= rightX; moveZ -= rightZ; }
    if (moveX || moveZ || input.isHeld('KeyQ') || input.isHeld('KeyE')) following = false;
    const moveLength = Math.hypot(moveX, moveZ) || 1;
    cameraRig.target.x += (moveX / moveLength) * moveSpeed;
    cameraRig.target.z += (moveZ / moveLength) * moveSpeed;
    if (input.isHeld('KeyQ')) cameraRig.desiredPitch -= dt * 0.72;
    if (input.isHeld('KeyE')) cameraRig.desiredPitch += dt * 0.72;
    cameraRig.desiredPitch = clamp(cameraRig.desiredPitch, -1.12, 1.16);
    cameraRig.target.x = clamp(cameraRig.target.x, -12.5, 11.5);
    cameraRig.target.z = clamp(cameraRig.target.z, -9.5, 9.5);

    viewState.undergroundBlend = THREE.MathUtils.smoothstep(clamp((-cameraRig.pitch + 0.08) / 0.4, 0, 1), 0, 1);
    const targetFocusY = THREE.MathUtils.lerp(
      groundHeight(cameraRig.target.x, cameraRig.target.z) * 0.25,
      following && selectedAnt?.insideNest ? selectedAnt.nestPosition.y : (focusedColony()?.undergroundFocusY ?? -5.35),
      viewState.undergroundBlend,
    );
    cameraRig.focusY += (targetFocusY - cameraRig.focusY) * Math.min(1, dt * 5.5);
    const focusY = cameraRig.focusY;
    const horizontal = Math.cos(cameraRig.pitch) * cameraRig.distance;
    camera.position.set(
      cameraRig.target.x + Math.sin(cameraRig.yaw) * horizontal,
      focusY + Math.sin(cameraRig.pitch) * cameraRig.distance,
      cameraRig.target.z + Math.cos(cameraRig.yaw) * horizontal,
    );
    camera.lookAt(cameraRig.target.x, focusY, cameraRig.target.z);

    surfaceGroup.visible = viewState.undergroundBlend < 0.58;
    undergroundGroup.visible = viewState.undergroundBlend > 0.035;
    scene.background.copy(viewState.surfaceBackground).lerp(viewState.undergroundBackground, viewState.undergroundBlend);
    scene.fog.color.copy(scene.background);
    scene.fog.density = THREE.MathUtils.lerp(0.018, 0.008, viewState.undergroundBlend);
    sun.intensity = viewState.surfaceSun * (1 - viewState.undergroundBlend);
    hemi.intensity = viewState.surfaceHemi * (1 - viewState.undergroundBlend) + 0.12 * viewState.undergroundBlend;
    renderer.toneMappingExposure = THREE.MathUtils.lerp(1.08, 1.14, viewState.undergroundBlend);
    return following;
  }

  function updateSurfaceLighting({ simTime, weather, environment, terrain, dt }) {
    const day = (Math.sin(simTime * 0.027) + 1) * 0.5;
    viewState.surfaceSun = 2.15 + day * 2.15 - weather.rain * 1.0;
    viewState.surfaceHemi = 1.25 + day * 1.15;
    sun.color.setHSL(0.09 + day * 0.025, 0.78, 0.67 + day * 0.13);
    const bgDay = new THREE.Color(0xc9bb8c);
    const bgDusk = new THREE.Color(0x6e765d);
    bgDay.lerp(new THREE.Color(environment.season.tint), 0.34);
    terrain.material.color.lerp(new THREE.Color(environment.season.tint), Math.min(1, dt * 0.22));
    viewState.surfaceBackground.copy(bgDusk).lerp(bgDay, day * (1 - weather.rain * 0.46));
  }

  function renderFrame({
    profiler,
    updateAdaptiveVisualDetail,
    renderAnts,
    renderRivals,
    renderRegionalReproductionVisuals,
    adaptiveVisualState,
  }) {
    const profileStartedAt = profiler.begin('render');
    updateAdaptiveVisualDetail();
    if (surfaceGroup.visible) {
      renderAnts();
      renderRivals();
      renderRegionalReproductionVisuals();
    } else {
      adaptiveVisualState.renderedHomeWorkers = 0;
      adaptiveVisualState.renderedRivalWorkers = 0;
      adaptiveVisualState.renderedDescendantWorkers = 0;
    }
    adaptiveVisualState.renderedSurfaceWorkers = adaptiveVisualState.renderedHomeWorkers
      + adaptiveVisualState.renderedRivalWorkers + adaptiveVisualState.renderedDescendantWorkers;
    renderer.render(scene, camera);
    profiler.end('render', profileStartedAt);
  }

  function resize({ width, height, pixelRatio }) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(Math.min(pixelRatio, 1.75));
  }

  return {
    renderer,
    scene,
    surfaceGroup,
    undergroundGroup,
    viewState,
    camera,
    cameraRig,
    updateCamera,
    updateSurfaceLighting,
    renderFrame,
    resize,
  };
}
